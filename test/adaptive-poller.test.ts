import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import { createAdaptivePoller } from "../src/adaptivePoller";
import { StockT3HttpError } from "../src/stockT3HttpClient";

function fakeClock(start = 0) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
    sleeps,
    sleep: async (milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) throw signal.reason;
      sleeps.push(milliseconds);
      current += milliseconds;
      await Promise.resolve();
    },
  };
}

const emptyDetail = {
  snapshotSequence: 1,
  thread: {
    id: "thread-1",
    projectId: "project-1",
    title: "worker",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-31T18:00:00.000Z",
    updatedAt: "2026-07-31T18:00:00.000Z",
    session: null,
    messages: [],
    activities: [],
    checkpoints: [],
  },
};

describe("environment-coalesced adaptive poller", () => {
  test("coalesces eight waiters onto one shell request per cycle", async () => {
    let shellStarts = 0;
    const poller = createAdaptivePoller({
      getShell: async () => {
        shellStarts += 1;
        return { snapshotSequence: shellStarts, projects: [], threads: [], updatedAt: new Date().toISOString() };
      },
      getThread: async () => undefined,
    });

    const waiters = Array.from({ length: 8 }, (_, index) =>
      poller.waitFor({
        environmentId: "env-1",
        threadId: `thread-${index}`,
        deadlineMs: Date.now() + 2_000,
        evaluate: ({ shell }) =>
          shell.snapshotSequence >= 2 ? { done: true, value: shell.snapshotSequence } : { done: false },
      }),
    );

    expect(await Promise.all(waiters)).toEqual(Array(8).fill(2));
    expect(shellStarts).toBe(2);
    expect(poller.metrics()).toMatchObject({ shellStarts: 2, peakActiveWaits: 8, peakHttpInFlight: 1 });
    poller.close();
  });

  test("uses 250/500/1000/2000 cadence and bounds first/later minute starts", () => {
    const policy = createAdaptivePoller.policy();
    expect([0, 1, 2, 3, 4, 5].map((attempt) => policy.intervalMs(attempt))).toEqual([
      250, 500, 1_000, 2_000, 2_000, 2_000,
    ]);
    expect(policy.firstMinuteShellStarts).toBe(32);
    expect(policy.laterMinuteShellStarts).toBe(30);
    expect(policy.detailStartsPerWaitMinute).toBe(4);
    expect(policy.maxActiveWaits).toBe(8);
    expect(policy.maxHttpInFlight).toBe(8);
    expect("firstMinuteAggregateCeiling" in policy).toBe(false);
    expect("laterMinuteAggregateCeiling" in policy).toBe(false);
  });

  test("enforces the global eight-request in-flight cap across environments", async () => {
    let active = 0;
    let peak = 0;
    const poller = createAdaptivePoller({
      getShell: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          snapshotSequence: 1,
          projects: [],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        };
      },
      getThread: async () => undefined,
    });
    const waits = Array.from({ length: 8 }, (_, index) =>
      poller.waitFor({
        environmentId: `env-${index}`,
        threadId: `thread-${index}`,
        deadlineMs: Date.now() + 2_000,
        evaluate: () => ({ done: true, value: "done" }),
      }),
    );

    await expect(Promise.all(waits)).resolves.toEqual(Array(8).fill("done"));
    expect(peak).toBeLessThanOrEqual(8);
    expect(poller.metrics().peakHttpInFlight).toBe(peak);
    poller.close();
  });

  test("cancels one subscriber without aborting the shared environment poll", async () => {
    const first = new AbortController();
    let shellStarts = 0;
    const poller = createAdaptivePoller({
      getShell: async () => {
        shellStarts += 1;
        return { snapshotSequence: shellStarts, projects: [], threads: [], updatedAt: new Date().toISOString() };
      },
      getThread: async () => undefined,
    });
    const cancelled = poller.waitFor({
      environmentId: "env-1",
      threadId: "one",
      deadlineMs: Date.now() + 2_000,
      signal: first.signal,
      evaluate: () => ({ done: false }),
    });
    const survivor = poller.waitFor({
      environmentId: "env-1",
      threadId: "two",
      deadlineMs: Date.now() + 2_000,
      evaluate: ({ shell }) => shell.snapshotSequence >= 2 ? { done: true, value: "ok" } : { done: false },
    });
    first.abort();

    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    await expect(survivor).resolves.toBe("ok");
    expect(shellStarts).toBe(2);
    poller.close();
  });

  test("restarts a same-environment poll after last-waiter cancellation and same-tick rewait", async () => {
    const first = new AbortController();
    let releaseFirstSleep!: () => void;
    const firstSleepStarted = new Promise<void>((resolve) => {
      releaseFirstSleep = resolve;
    });
    let sleepStarts = 0;
    let shellStarts = 0;
    const poller = createAdaptivePoller({
      sleep: (_milliseconds, signal) => {
        sleepStarts += 1;
        if (sleepStarts > 1) return Promise.resolve();
        releaseFirstSleep();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      getShell: async () => {
        shellStarts += 1;
        return {
          snapshotSequence: 1,
          projects: [],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        };
      },
      getThread: async () => undefined,
    });
    const cancelled = poller.waitFor({
      environmentId: "env-1",
      threadId: "thread-1",
      deadlineMs: Date.now() + 1_000,
      signal: first.signal,
      evaluate: () => ({ done: false }),
    });
    await firstSleepStarted;

    first.abort();
    const replacement = poller.waitFor({
      environmentId: "env-1",
      threadId: "thread-1",
      deadlineMs: Date.now() + 1_000,
      evaluate: ({ shell }) => ({ done: true, value: shell.snapshotSequence }),
    });

    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    await expect(replacement).resolves.toBe(1);
    expect(shellStarts).toBe(1);
    poller.close();
  }, 1_000);

  test("uses bounded snapshot backoff without overlapping requests", () => {
    const policy = createAdaptivePoller.policy();
    expect([0, 1, 2, 3, 4, 5].map((failure) => policy.backoffMs(failure, 0))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 8_000,
    ]);
    expect(policy.backoffMs(4, 20_000)).toBe(8_000);
  });

  test("removes each resolved default-sleep abort listener", async () => {
    let sequence = 0;
    let maximumAbortListeners = 0;
    const poller = createAdaptivePoller({
      getShell: async ({ signal }) => {
        maximumAbortListeners = Math.max(
          maximumAbortListeners,
          signal === undefined ? 0 : getEventListeners(signal, "abort").length,
        );
        sequence += 1;
        return {
          snapshotSequence: sequence,
          projects: [],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        };
      },
      getThread: async () => undefined,
    });

    await expect(
      poller.waitFor({
        environmentId: "env-listeners",
        threadId: "thread-listeners",
        deadlineMs: Date.now() + 2_000,
        evaluate: ({ shell }) =>
          shell.snapshotSequence >= 2 ? { done: true, value: "done" } : { done: false },
      }),
    ).resolves.toBe("done");
    expect(maximumAbortListeners).toBeLessThanOrEqual(1);
    poller.close();
  }, 3_000);

  test("dispatch observation interrupts stale failure backoff and resumes fast cadence", async () => {
    let sleepCount = 0;
    let shellCount = 0;
    let backoffStarted!: () => void;
    const enteredBackoff = new Promise<void>((resolve) => {
      backoffStarted = resolve;
    });
    const poller = createAdaptivePoller({
      sleep: (milliseconds, signal) => {
        sleepCount += 1;
        if (sleepCount === 1 || sleepCount >= 3) return Promise.resolve();
        expect(milliseconds).toBe(500);
        backoffStarted();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      jitter: () => 0,
      getShell: async () => {
        shellCount += 1;
        if (shellCount === 1) {
          throw new StockT3HttpError("transport_unavailable", 503, { transient: true });
        }
        return {
          snapshotSequence: shellCount,
          projects: [],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        };
      },
      getThread: async () => undefined,
    });
    const wait = poller.waitFor({
      environmentId: "env-dispatch-wake",
      threadId: "thread-dispatch-wake",
      deadlineMs: Date.now() + 2_000,
      evaluate: ({ shell }) =>
        shell.snapshotSequence >= 2 ? { done: true, value: "done" } : { done: false },
    });
    await enteredBackoff;
    poller.dispatchObserved("env-dispatch-wake");

    try {
      const outcome = await Promise.race([
        wait,
        new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 100)),
      ]);
      expect(outcome).toBe("done");
      expect(sleepCount).toBe(2);
    } finally {
      poller.close();
      await Promise.allSettled([wait]);
    }
  });

  test("a detail-slot timeout expires only the earliest subscriber", async () => {
    let current = 0;
    let scriptedNow: number[] = [];
    let shellSequence = 0;
    const now = () => {
      const next = scriptedNow.shift();
      if (next !== undefined) current = next;
      return current;
    };
    const poller = createAdaptivePoller({
      now,
      sleep: async (milliseconds) => {
        current += milliseconds;
      },
      getShell: async () => ({
        snapshotSequence: ++shellSequence,
        projects: [],
        threads: [],
        updatedAt: "2026-07-31T18:00:00.000Z",
      }),
      getThread: async () => ({ ...emptyDetail, snapshotSequence: shellSequence }),
    });
    const earliest = poller.waitFor({
      environmentId: "env-detail-deadline",
      threadId: "thread-1",
      deadlineMs: 251,
      evaluate: ({ detail }) =>
        detail === undefined ? { done: false, detail: true } : { done: true, value: "earliest" },
    }).catch((error) => error);
    const survivor = poller.waitFor({
      environmentId: "env-detail-deadline",
      threadId: "thread-1",
      deadlineMs: 2_000,
      evaluate: ({ detail }) => {
        if (detail === undefined) {
          if (shellSequence === 1) scriptedNow = [250, 250, 250, 251];
          return { done: false, detail: true };
        }
        return { done: true, value: "survivor" };
      },
    });

    await expect(earliest).resolves.toMatchObject({ code: "timeout" });
    await expect(survivor).resolves.toBe("survivor");
    poller.close();
  });

  test("coalesces same-thread detail work and fans one observation to every waiter", async () => {
    const clock = fakeClock();
    let detailStarts = 0;
    let detailInFlight = 0;
    let peakDetailInFlight = 0;
    const poller = createAdaptivePoller({
      now: clock.now,
      sleep: clock.sleep,
      getShell: async () => ({
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-07-31T18:00:00.000Z",
      }),
      getThread: async () => {
        detailStarts += 1;
        detailInFlight += 1;
        peakDetailInFlight = Math.max(peakDetailInFlight, detailInFlight);
        await Promise.resolve();
        detailInFlight -= 1;
        return emptyDetail;
      },
    });

    const waits = ["first", "second"].map((value) =>
      poller.waitFor({
        environmentId: "env-1",
        threadId: "thread-1",
        deadlineMs: 2_000,
        evaluate: ({ detail }) =>
          detail === undefined ? { done: false, detail: true } : { done: true, value },
      }),
    );

    expect(await Promise.all(waits)).toEqual(["first", "second"]);
    expect(detailStarts).toBe(1);
    expect(peakDetailInFlight).toBe(1);
    expect(poller.metrics()).toMatchObject({ detailStarts: 1, peakHttpInFlight: 1 });
    poller.close();
  });

  test("does not refresh detail when the shell sequence has not advanced", async () => {
    const clock = fakeClock();
    let detailStarts = 0;
    const poller = createAdaptivePoller({
      now: clock.now,
      sleep: clock.sleep,
      getShell: async () => ({
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-07-31T18:00:00.000Z",
      }),
      getThread: async () => {
        detailStarts += 1;
        return emptyDetail;
      },
    });

    await expect(
      poller.waitFor({
        environmentId: "env-1",
        threadId: "thread-1",
        deadlineMs: 2_000,
        evaluate: () => ({ done: false, detail: true }),
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(detailStarts).toBe(1);
    poller.close();
  });

  test("clamps sleep to the inclusive operation deadline", async () => {
    const clock = fakeClock();
    const poller = createAdaptivePoller({
      now: clock.now,
      sleep: clock.sleep,
      getShell: async () => {
        throw new Error("request must not start at the deadline");
      },
      getThread: async () => undefined,
    });

    await expect(
      poller.waitFor({
        environmentId: "env-1",
        threadId: "thread-1",
        deadlineMs: 100,
        evaluate: () => ({ done: false }),
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(clock.sleeps).toEqual([100]);
    poller.close();
  });

  test("honors Retry-After with injectable deterministic jitter", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const poller = createAdaptivePoller({
      now: clock.now,
      sleep: clock.sleep,
      jitter: (delayMs: number) => Math.round(delayMs * 0.1),
      getShell: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new StockT3HttpError("transport_unavailable", 503, {
            transient: true,
            retryAfterMs: 3_000,
          });
        }
        return {
          snapshotSequence: 2,
          projects: [],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        };
      },
      getThread: async () => undefined,
    } as Parameters<typeof createAdaptivePoller>[0] & {
      jitter: (delayMs: number) => number;
    });

    await expect(
      poller.waitFor({
        environmentId: "env-1",
        threadId: "thread-1",
        deadlineMs: 10_000,
        evaluate: ({ shell }) =>
          shell.snapshotSequence === 2 ? { done: true, value: "done" } : { done: false },
      }),
    ).resolves.toBe("done");
    expect(clock.sleeps).toEqual([250, 3_300]);
    poller.close();
  });

  test("fails closed without retrying a protocol mismatch", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const failure = new StockT3HttpError("protocol_mismatch", 200, {
      reason: "schema",
    });
    const poller = createAdaptivePoller({
      now: clock.now,
      sleep: clock.sleep,
      getShell: async () => {
        attempts += 1;
        throw failure;
      },
      getThread: async () => undefined,
    });

    await expect(
      poller.waitFor({
        environmentId: "env-1",
        threadId: "thread-1",
        deadlineMs: 10_000,
        evaluate: () => ({ done: false }),
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
    poller.close();
  });

  test("enforces the 64/62 aggregate ceilings with eight concurrent waits", async () => {
    const clock = fakeClock();
    const starts: Array<{ kind: "shell" | "detail"; at: number }> = [];
    let shellSequence = 0;
    const poller = createAdaptivePoller({
      now: clock.now,
      sleep: clock.sleep,
      getShell: async () => {
        starts.push({ kind: "shell", at: clock.now() });
        shellSequence += 1;
        return {
          snapshotSequence: shellSequence,
          projects: [],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        };
      },
      getThread: async (threadId) => {
        starts.push({ kind: "detail", at: clock.now() });
        return {
          ...emptyDetail,
          snapshotSequence: shellSequence,
          thread: { ...emptyDetail.thread, id: threadId },
        };
      },
    });

    const waits = Array.from({ length: 8 }, (_, index) =>
      poller
        .waitFor({
          environmentId: `env-${index}`,
          threadId: `thread-${index}`,
          deadlineMs: 120_000,
          evaluate: () => ({ done: false, detail: true }),
        })
        .catch((error) => error),
    );
    const results = await Promise.all(waits);
    expect(
      results.every(
        (entry) => (entry as { readonly code?: unknown })?.code === "timeout",
      ),
    ).toBe(true);
    const firstMinute = starts.filter((entry) => entry.at < 60_000);
    const laterMinute = starts.filter((entry) => entry.at >= 60_000 && entry.at < 120_000);
    expect(firstMinute.length).toBeLessThanOrEqual(64);
    expect(laterMinute.length).toBeLessThanOrEqual(62);
    expect(firstMinute.filter((entry) => entry.kind === "shell").length).toBeLessThanOrEqual(32);
    expect(laterMinute.filter((entry) => entry.kind === "shell").length).toBeLessThanOrEqual(30);
    poller.close();
  });
});
