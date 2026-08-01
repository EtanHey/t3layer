import type { ShellSnapshot, ThreadDetailSnapshot } from "./stockT3Contracts";
import { StockT3HttpError } from "./stockT3HttpClient";

const POLICY = Object.freeze({
  firstMinuteShellStarts: 32,
  laterMinuteShellStarts: 30,
  detailStartsPerWaitMinute: 4,
  maxActiveWaits: 8,
  maxHttpInFlight: 8,
  firstMinuteAggregateCeiling: 64,
  laterMinuteAggregateCeiling: 62,
  intervalMs(attempt: number): number {
    return [250, 500, 1_000, 2_000][Math.min(Math.max(0, attempt), 3)] ?? 2_000;
  },
  backoffMs(failure: number, retryAfterMs: number): number {
    const base =
      [500, 1_000, 2_000, 4_000, 8_000][Math.min(Math.max(0, failure), 4)] ??
      8_000;
    return Math.min(8_000, Math.max(base, Math.max(0, retryAfterMs)));
  },
});

export class PollerError extends Error {
  constructor(
    readonly code:
      | "cancelled"
      | "timeout"
      | "capacity"
      | "closed"
      | "transport_unavailable",
  ) {
    super(code);
    this.name = "PollerError";
  }
}

type Evaluation<T> =
  | { readonly done: true; readonly value: T }
  | { readonly done: false; readonly detail?: boolean };

export interface PollObservation {
  readonly shell: ShellSnapshot;
  readonly detail?: ThreadDetailSnapshot;
}

export interface WaitForOptions<T> {
  readonly environmentId: string;
  readonly threadId: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly evaluate: (observation: PollObservation) => Evaluation<T>;
}

export interface AdaptivePollerOptions {
  readonly getShell: (options: {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<ShellSnapshot>;
  readonly getThread: (
    threadId: string,
    options: {
      readonly deadlineMs: number;
      readonly signal?: AbortSignal;
      readonly minimumSequence?: number;
    },
  ) => Promise<ThreadDetailSnapshot | undefined>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Returns a signed jitter delta. It is clamped to +/-10% of the delay. */
  readonly jitter?: (delayMs: number, failureIndex: number) => number;
}

interface Subscriber<T = unknown> {
  readonly id: number;
  readonly threadId: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly evaluate: (observation: PollObservation) => Evaluation<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
  detailWindowStartedAt: number;
  detailStarts: number;
}

interface ThreadDetailState {
  detail: ThreadDetailSnapshot | undefined;
  shellSequence: number | null;
}

interface EnvironmentState {
  readonly environmentId: string;
  readonly subscribers: Map<number, Subscriber<any>>;
  readonly details: Map<string, ThreadDetailState>;
  controller: AbortController;
  running: boolean;
  cadenceIndex: number;
  failureIndex: number;
  failureDelayMs: number | null;
  shellStartTimes: number[];
  firstStartAt: number | null;
  lastScheduledStart: number | null;
  lastCompletionAt: number;
  lastShellSequence: number | null;
}

interface SlotWaiter {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: PollerError) => void;
  readonly onAbort: () => void;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PollerError("cancelled"));
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PollerError("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryMetadata(error: unknown): { retryAfterMs: number } | null {
  if (!(error instanceof StockT3HttpError) || error.code !== "transport_unavailable") {
    return null;
  }
  if (
    error.status !== null &&
    ![429, 502, 503, 504].includes(error.status) &&
    error.detail.transient !== true
  ) {
    return null;
  }
  const retryAfterMs =
    typeof error.detail.retryAfterMs === "number" &&
    Number.isFinite(error.detail.retryAfterMs)
      ? Math.max(0, error.detail.retryAfterMs)
      : 0;
  return { retryAfterMs };
}

export function createAdaptivePoller(options: AdaptivePollerOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const jitter =
    options.jitter ??
    ((delayMs: number) => delayMs * (Math.random() * 0.2 - 0.1));
  const environments = new Map<string, EnvironmentState>();
  let nextSubscriberId = 1;
  let closed = false;
  let activeWaits = 0;
  let peakActiveWaits = 0;
  let httpInFlight = 0;
  let peakHttpInFlight = 0;
  let shellStarts = 0;
  let detailStarts = 0;
  let throttledCycles = 0;
  const slotWaiters: SlotWaiter[] = [];

  function pumpSlots(): void {
    while (httpInFlight < POLICY.maxHttpInFlight && slotWaiters.length > 0) {
      const waiter = slotWaiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(new PollerError("cancelled"));
        continue;
      }
      if (now() >= waiter.deadlineMs) {
        waiter.reject(new PollerError("timeout"));
        continue;
      }
      httpInFlight += 1;
      peakHttpInFlight = Math.max(peakHttpInFlight, httpInFlight);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        httpInFlight -= 1;
        pumpSlots();
      });
    }
  }

  function acquireSlot(deadlineMs: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new PollerError("cancelled"));
    if (now() >= deadlineMs) return Promise.reject(new PollerError("timeout"));
    return new Promise((resolve, reject) => {
      const waiter: SlotWaiter = {
        deadlineMs,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = slotWaiters.indexOf(waiter);
          if (index >= 0) slotWaiters.splice(index, 1);
          reject(new PollerError("cancelled"));
        },
      };
      slotWaiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      pumpSlots();
    });
  }

  function finish<T>(
    state: EnvironmentState,
    subscriber: Subscriber<T>,
    error?: Error,
    value?: T,
  ): void {
    if (!state.subscribers.delete(subscriber.id)) return;
    activeWaits -= 1;
    subscriber.signal?.removeEventListener("abort", subscriber.onAbort);
    if (error !== undefined) subscriber.reject(error);
    else subscriber.resolve(value as T);
    if (state.subscribers.size === 0) state.controller.abort();
  }

  function expireSubscribers(state: EnvironmentState): void {
    for (const subscriber of [...state.subscribers.values()]) {
      if (subscriber.signal?.aborted) {
        finish(state, subscriber, new PollerError("cancelled"));
      } else if (now() >= subscriber.deadlineMs) {
        finish(state, subscriber, new PollerError("timeout"));
      }
    }
  }

  function rateDelay(state: EnvironmentState, instant: number): number {
    state.shellStartTimes = state.shellStartTimes.filter(
      (start) => instant - start < 60_000,
    );
    const firstMinute =
      state.firstStartAt === null || instant - state.firstStartAt < 60_000;
    const cap = firstMinute
      ? POLICY.firstMinuteShellStarts
      : POLICY.laterMinuteShellStarts;
    if (state.shellStartTimes.length < cap) return 0;
    throttledCycles += 1;
    return Math.max(0, 60_000 - (instant - state.shellStartTimes[0]!));
  }

  async function tracked<T>(
    operation: () => Promise<T>,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await acquireSlot(deadlineMs, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function evaluate<T>(
    state: EnvironmentState,
    subscriber: Subscriber<T>,
    observation: PollObservation,
  ): Evaluation<T> | null {
    if (!state.subscribers.has(subscriber.id)) return null;
    if (subscriber.signal?.aborted) {
      finish(state, subscriber, new PollerError("cancelled"));
      return null;
    }
    if (now() > subscriber.deadlineMs) {
      finish(state, subscriber, new PollerError("timeout"));
      return null;
    }
    try {
      const result = subscriber.evaluate(observation);
      if (result.done) finish(state, subscriber, undefined, result.value);
      return result;
    } catch (error) {
      finish(
        state,
        subscriber,
        error instanceof Error ? error : new PollerError("transport_unavailable"),
      );
      return null;
    }
  }

  function admitDetail(subscriber: Subscriber): boolean {
    const instant = now();
    if (instant - subscriber.detailWindowStartedAt >= 60_000) {
      subscriber.detailWindowStartedAt = instant;
      subscriber.detailStarts = 0;
    }
    if (subscriber.detailStarts >= POLICY.detailStartsPerWaitMinute) return false;
    subscriber.detailStarts += 1;
    return true;
  }

  async function detailCycle(
    state: EnvironmentState,
    shell: ShellSnapshot,
    threadId: string,
    subscribers: readonly Subscriber[],
  ): Promise<void> {
    const cached = state.details.get(threadId);
    if (cached?.shellSequence === shell.snapshotSequence) {
      if (cached.detail !== undefined) {
        for (const subscriber of subscribers) {
          evaluate(state, subscriber, { shell, detail: cached.detail });
        }
      }
      return;
    }
    const admitted = subscribers.filter(admitDetail);
    if (admitted.length === 0) return;
    const deadlineMs = Math.min(...admitted.map((entry) => entry.deadlineMs));
    if (now() >= deadlineMs) {
      expireSubscribers(state);
      return;
    }
    detailStarts += 1;
    try {
      const detail = await tracked(
        () =>
          options.getThread(threadId, {
            deadlineMs,
            signal: state.controller.signal,
          }),
        deadlineMs,
        state.controller.signal,
      );
      state.details.set(threadId, {
        detail,
        shellSequence: shell.snapshotSequence,
      });
      if (detail === undefined) return;
      for (const subscriber of subscribers) {
        evaluate(state, subscriber, { shell, detail });
      }
    } catch (error) {
      if (state.controller.signal.aborted) return;
      if (retryMetadata(error) !== null) {
        state.details.delete(threadId);
        return;
      }
      const failure =
        error instanceof Error ? error : new PollerError("transport_unavailable");
      for (const subscriber of subscribers) finish(state, subscriber, failure);
    }
  }

  async function processShell(
    state: EnvironmentState,
    shell: ShellSnapshot,
  ): Promise<void> {
    if (
      state.lastShellSequence !== null &&
      shell.snapshotSequence < state.lastShellSequence
    ) {
      throw new StockT3HttpError("protocol_mismatch", 200, {
        reason: "shell_sequence_regression",
      });
    }
    state.lastShellSequence = shell.snapshotSequence;
    const detailGroups = new Map<string, Subscriber[]>();
    for (const subscriber of [...state.subscribers.values()]) {
      const result = evaluate(state, subscriber, { shell });
      if (result?.done === false && result.detail === true) {
        const group = detailGroups.get(subscriber.threadId) ?? [];
        group.push(subscriber);
        detailGroups.set(subscriber.threadId, group);
      }
    }
    await Promise.all(
      [...detailGroups].map(([threadId, subscribers]) =>
        detailCycle(state, shell, threadId, subscribers),
      ),
    );
  }

  function nextDelay(state: EnvironmentState): number {
    const instant = now();
    if (state.failureDelayMs !== null) return state.failureDelayMs;
    const interval = POLICY.intervalMs(state.cadenceIndex);
    const scheduled =
      state.lastScheduledStart === null
        ? instant + interval
        : Math.max(state.lastScheduledStart + interval, state.lastCompletionAt);
    return Math.max(0, scheduled - instant);
  }

  async function run(state: EnvironmentState): Promise<void> {
    state.running = true;
    try {
      while (!closed && state.subscribers.size > 0) {
        expireSubscribers(state);
        if (state.subscribers.size === 0) break;
        const earliestDeadline = Math.min(
          ...[...state.subscribers.values()].map((entry) => entry.deadlineMs),
        );
        const desiredDelay = Math.max(nextDelay(state), rateDelay(state, now()));
        const delay = Math.min(desiredDelay, Math.max(0, earliestDeadline - now()));
        try {
          await sleep(delay, state.controller.signal);
        } catch {
          if (state.subscribers.size === 0 || closed) break;
        }
        expireSubscribers(state);
        if (state.subscribers.size === 0 || closed) break;

        const requestDeadline = Math.min(
          ...[...state.subscribers.values()].map((entry) => entry.deadlineMs),
        );
        if (now() >= requestDeadline) continue;
        const startedAt = now();
        if (state.firstStartAt === null) state.firstStartAt = startedAt;
        state.lastScheduledStart = startedAt;
        state.shellStartTimes.push(startedAt);
        shellStarts += 1;
        try {
          const shell = await tracked(
            () =>
              options.getShell({
                deadlineMs: requestDeadline,
                signal: state.controller.signal,
              }),
            requestDeadline,
            state.controller.signal,
          );
          state.lastCompletionAt = now();
          await processShell(state, shell);
          state.failureIndex = 0;
          state.failureDelayMs = null;
          state.cadenceIndex = Math.min(3, state.cadenceIndex + 1);
        } catch (error) {
          state.lastCompletionAt = now();
          if (state.controller.signal.aborted) break;
          const retry = retryMetadata(error);
          if (retry === null) {
            const failure =
              error instanceof Error
                ? error
                : new PollerError("transport_unavailable");
            for (const subscriber of [...state.subscribers.values()]) {
              finish(state, subscriber, failure);
            }
            break;
          }
          state.failureIndex = Math.min(5, state.failureIndex + 1);
          const base = POLICY.backoffMs(
            state.failureIndex - 1,
            retry.retryAfterMs,
          );
          const maximumJitter = base * 0.1;
          const delta = Math.max(
            -maximumJitter,
            Math.min(maximumJitter, jitter(base, state.failureIndex)),
          );
          state.failureDelayMs = Math.max(0, base + delta);
        }
      }
    } finally {
      state.running = false;
      if (state.subscribers.size === 0) {
        environments.delete(state.environmentId);
      } else if (!closed) {
        if (state.controller.signal.aborted) state.controller = new AbortController();
        void run(state);
      }
    }
  }

  function getEnvironment(environmentId: string): EnvironmentState {
    const existing = environments.get(environmentId);
    if (existing !== undefined) return existing;
    const state: EnvironmentState = {
      environmentId,
      subscribers: new Map(),
      details: new Map(),
      controller: new AbortController(),
      running: false,
      cadenceIndex: 0,
      failureIndex: 0,
      failureDelayMs: null,
      shellStartTimes: [],
      firstStartAt: null,
      lastScheduledStart: null,
      lastCompletionAt: now(),
      lastShellSequence: null,
    };
    environments.set(environmentId, state);
    return state;
  }

  return {
    waitFor<T>(input: WaitForOptions<T>): Promise<T> {
      if (closed) return Promise.reject(new PollerError("closed"));
      if (activeWaits >= POLICY.maxActiveWaits) {
        return Promise.reject(new PollerError("capacity"));
      }
      const state = getEnvironment(input.environmentId);
      if (state.controller.signal.aborted) state.controller = new AbortController();
      return new Promise<T>((resolve, reject) => {
        const id = nextSubscriberId++;
        const subscriber: Subscriber<T> = {
          id,
          threadId: input.threadId,
          deadlineMs: input.deadlineMs,
          signal: input.signal,
          evaluate: input.evaluate,
          resolve,
          reject,
          onAbort: () => finish(state, subscriber, new PollerError("cancelled")),
          detailWindowStartedAt: now(),
          detailStarts: 0,
        };
        state.subscribers.set(id, subscriber);
        activeWaits += 1;
        peakActiveWaits = Math.max(peakActiveWaits, activeWaits);
        input.signal?.addEventListener("abort", subscriber.onAbort, { once: true });
        if (input.signal?.aborted) subscriber.onAbort();
        if (!state.running && state.subscribers.size > 0) void run(state);
      });
    },

    dispatchObserved(environmentId: string): void {
      const state = environments.get(environmentId);
      if (state !== undefined) {
        state.cadenceIndex = 0;
        state.failureIndex = 0;
        state.failureDelayMs = null;
      }
    },

    metrics() {
      return {
        shellStarts,
        detailStarts,
        throttledCycles,
        activeWaits,
        activeEnvironments: environments.size,
        peakActiveWaits,
        httpInFlight,
        peakHttpInFlight,
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const state of environments.values()) {
        for (const subscriber of [...state.subscribers.values()]) {
          finish(state, subscriber, new PollerError("closed"));
        }
        state.controller.abort();
      }
      for (const waiter of slotWaiters.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.reject(new PollerError("closed"));
      }
      environments.clear();
    },
  };
}

createAdaptivePoller.policy = () => POLICY;

export type AdaptivePoller = ReturnType<typeof createAdaptivePoller>;
