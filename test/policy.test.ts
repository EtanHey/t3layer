import { describe, expect, test } from "bun:test";

import {
  PolicyError,
  createOrchestrationPolicy,
} from "../src/policy";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("bounded orchestration policy", () => {
  test("enforces global and per-scope caps before dispatch", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 2,
      maxActivePerScope: 1,
      maxQueued: 3,
    });
    const firstGate = deferred();
    const secondGate = deferred();
    const thirdGate = deferred();
    const started: string[] = [];

    const first = policy.dispatch(
      { scopeId: "lead-a", queue: "fifo" },
      async () => {
        started.push("a-1");
        await firstGate.promise;
        return "a-1";
      },
    );
    const third = policy.dispatch(
      { scopeId: "lead-b", queue: "fifo" },
      async () => {
        started.push("b-1");
        await thirdGate.promise;
        return "b-1";
      },
    );
    const second = policy.dispatch(
      { scopeId: "lead-a", queue: "fifo" },
      async () => {
        started.push("a-2");
        await secondGate.promise;
        return "a-2";
      },
    );

    await nextTurn();
    expect(started).toEqual(["a-1", "b-1"]);
    expect(policy.metrics()).toMatchObject({ active: 2, queued: 1, peakActive: 2 });

    firstGate.resolve();
    await expect(first).resolves.toBe("a-1");
    await nextTurn();
    expect(started).toEqual(["a-1", "b-1", "a-2"]);

    secondGate.resolve();
    thirdGate.resolve();
    await expect(Promise.all([second, third])).resolves.toEqual(["a-2", "b-1"]);
    expect(policy.metrics()).toMatchObject({ active: 0, queued: 0, peakActive: 2 });
    policy.close();
  });

  test("starts queued work in FIFO order", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 2,
    });
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const work = gates.map((gate, index) =>
      policy.dispatch({ scopeId: `scope-${index}`, queue: "fifo" }, async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );

    await nextTurn();
    expect(started).toEqual([0]);
    gates[0]!.resolve();
    await work[0];
    await nextTurn();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve();
    await work[1];
    await nextTurn();
    expect(started).toEqual([0, 1, 2]);
    gates[2]!.resolve();
    await expect(Promise.all(work)).resolves.toEqual([0, 1, 2]);
    policy.close();
  });

  test("fails explicitly without dispatch when the caller selects fail", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 1,
    });
    const gate = deferred();
    let refusedDispatches = 0;
    const active = policy.dispatch({ scopeId: "lead", queue: "fifo" }, async () => {
      await gate.promise;
      return "active";
    });

    await expect(
      policy.dispatch({ scopeId: "other", queue: "fail" }, async () => {
        refusedDispatches += 1;
        return "refused";
      }),
    ).rejects.toMatchObject({ code: "capacity", reason: "active_limit" });
    expect(refusedDispatches).toBe(0);

    gate.resolve();
    await active;
    policy.close();
  });

  test("reports FIFO ordering when fail-fast work cannot bypass queued work", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 2,
      maxActivePerScope: 1,
      maxQueued: 2,
    });
    const gate = deferred();
    const active = policy.dispatch({ scopeId: "lead", queue: "fifo" }, async () => {
      await gate.promise;
    });
    const queued = policy.dispatch({ scopeId: "lead", queue: "fifo" }, async () => {});
    let bypassDispatches = 0;

    await expect(
      policy.dispatch({ scopeId: "other", queue: "fail" }, async () => {
        bypassDispatches += 1;
      }),
    ).rejects.toMatchObject({ code: "capacity", reason: "fifo_order" });
    expect(bypassDispatches).toBe(0);

    gate.resolve();
    await active;
    await queued;
    policy.close();
  });

  test("caps the FIFO queue before dispatch", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 1,
    });
    const activeGate = deferred();
    const queuedGate = deferred();
    let overflowDispatches = 0;
    const active = policy.dispatch({ scopeId: "one", queue: "fifo" }, async () => {
      await activeGate.promise;
    });
    const queued = policy.dispatch({ scopeId: "two", queue: "fifo" }, async () => {
      await queuedGate.promise;
    });

    await expect(
      policy.dispatch({ scopeId: "three", queue: "fifo" }, async () => {
        overflowDispatches += 1;
      }),
    ).rejects.toMatchObject({ code: "capacity", reason: "queue_full" });
    expect(overflowDispatches).toBe(0);

    activeGate.resolve();
    await active;
    queuedGate.resolve();
    await queued;
    policy.close();
  });

  test("removes a cancelled queued dispatch and never starts it", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 2,
    });
    const gate = deferred();
    const controller = new AbortController();
    let cancelledDispatches = 0;
    const active = policy.dispatch({ scopeId: "active", queue: "fifo" }, async () => {
      await gate.promise;
    });
    const cancelled = policy.dispatch(
      { scopeId: "queued", queue: "fifo", signal: controller.signal },
      async () => {
        cancelledDispatches += 1;
      },
    );

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelledDispatches).toBe(0);
    expect(policy.metrics().queued).toBe(0);

    gate.resolve();
    await active;
    policy.close();
  });

  test("propagates cancellation to an active dispatch", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 0,
    });
    const controller = new AbortController();
    let observedAbort = false;
    const active = policy.dispatch(
      { scopeId: "lead", queue: "fail", signal: controller.signal },
      ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        }),
    );

    await nextTurn();
    controller.abort();
    await expect(active).rejects.toBeInstanceOf(PolicyError);
    expect(observedAbort).toBe(true);
    expect(policy.metrics().active).toBe(0);
    policy.close();
  });

  test("expires a queued dispatch without starting it", async () => {
    let now = 0;
    let fireDeadline: (() => void) | undefined;
    const policy = createOrchestrationPolicy({
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 1,
      now: () => now,
      setTimer: (callback) => {
        fireDeadline = callback;
        return "deadline-timer";
      },
      clearTimer: () => {
        fireDeadline = undefined;
      },
    });
    const gate = deferred();
    let expiredDispatches = 0;
    const active = policy.dispatch({ scopeId: "active", queue: "fifo" }, async () => {
      await gate.promise;
    });
    const expired = policy.dispatch(
      { scopeId: "queued", queue: "fifo", deadlineMs: 100 },
      async () => {
        expiredDispatches += 1;
      },
    );

    now = 100;
    expect(fireDeadline).toBeDefined();
    fireDeadline!();
    await expect(expired).rejects.toMatchObject({ code: "timeout" });
    expect(expiredDispatches).toBe(0);
    gate.resolve();
    await active;
    policy.close();
  });

  test("rejects a result that resolves after its deadline before the timer fires", async () => {
    let now = 0;
    const policy = createOrchestrationPolicy({
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 0,
      now: () => now,
      setTimer: () => "deadline-timer",
      clearTimer: () => {},
    });

    const late = policy.dispatch(
      { scopeId: "lead", queue: "fail", deadlineMs: 100 },
      async () => {
        now = 100;
        return "late success";
      },
    );

    await expect(late).rejects.toMatchObject({ code: "timeout" });
    expect(policy.metrics().active).toBe(0);
    policy.close();
  });

  test("returns partial fan-out outcomes without exceeding policy caps", async () => {
    const policy = createOrchestrationPolicy({
      maxActive: 2,
      maxActivePerScope: 2,
      maxQueued: 2,
    });
    const results = await policy.fanOut(
      [1, 2, 3],
      { scopeId: () => "lead", queue: "fifo" },
      async (value) => {
        await Bun.sleep(1);
        if (value === 2) throw new Error("child failed");
        return value * 10;
      },
    );

    expect(results.map((entry) => entry.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
    expect(policy.metrics().peakActive).toBe(2);
    policy.close();
  });
});
