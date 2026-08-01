import type { PollObservation } from "./adaptivePoller";
import type {
  AgentRef,
  RuntimeOperationOptions,
} from "./nativeRuntime";
import type { ThreadDetailSnapshot } from "./stockT3Contracts";

export type QueuePolicy = "fifo" | "fail";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class PolicyError extends Error {
  constructor(
    readonly code:
      | "cancelled"
      | "capacity"
      | "closed"
      | "identity_not_found"
      | "protocol_mismatch"
      | "timeout",
    readonly reason?:
      | "active_limit"
      | "completion_capacity"
      | "fifo_order"
      | "queue_full",
  ) {
    super(code);
    this.name = "PolicyError";
  }
}

export interface OrchestrationPolicyOptions {
  readonly maxActive: number;
  readonly maxActivePerScope: number;
  readonly maxQueued: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface PolicyDispatchOptions {
  readonly scopeId: string;
  readonly queue: QueuePolicy;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export interface PolicyDispatchContext {
  readonly signal: AbortSignal;
  readonly deadlineMs?: number;
}

interface DispatchTask<T> {
  readonly scopeId: string;
  readonly operation: (context: PolicyDispatchContext) => Promise<T> | T;
  readonly controller: AbortController;
  readonly sourceSignal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
  state: "queued" | "running" | "settled";
  timer: unknown;
}

function boundedInteger(value: number, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${field} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return value;
}

function abortReason(code: "cancelled" | "closed" | "timeout"): PolicyError {
  return new PolicyError(code);
}

export function createOrchestrationPolicy(options: OrchestrationPolicyOptions) {
  const maxActive = boundedInteger(options.maxActive, "maxActive");
  const maxActivePerScope = boundedInteger(
    options.maxActivePerScope,
    "maxActivePerScope",
  );
  const maxQueued = boundedInteger(options.maxQueued, "maxQueued", true);
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const queue: DispatchTask<unknown>[] = [];
  const running = new Set<DispatchTask<unknown>>();
  const activeByScope = new Map<string, number>();
  let active = 0;
  let peakActive = 0;
  let peakQueued = 0;
  let closed = false;

  function canStart(task: DispatchTask<unknown>): boolean {
    return (
      active < maxActive &&
      (activeByScope.get(task.scopeId) ?? 0) < maxActivePerScope
    );
  }

  function cleanup(task: DispatchTask<unknown>): void {
    task.sourceSignal?.removeEventListener("abort", task.onAbort);
    if (task.timer !== undefined) {
      clearTimer(task.timer);
      task.timer = undefined;
    }
  }

  function removeQueued(task: DispatchTask<unknown>): boolean {
    const index = queue.indexOf(task);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  function rejectQueued(task: DispatchTask<unknown>, error: PolicyError): void {
    if (task.state !== "queued" || !removeQueued(task)) return;
    task.state = "settled";
    cleanup(task);
    task.controller.abort(error);
    task.reject(error);
  }

  function expireDeadline(task: DispatchTask<unknown>): void {
    const error = abortReason("timeout");
    if (task.state === "queued") {
      rejectQueued(task, error);
      pump();
    } else if (task.state === "running") {
      task.controller.abort(error);
    }
  }

  function scheduleDeadline(task: DispatchTask<unknown>): void {
    if (task.deadlineMs === undefined || task.state === "settled") return;
    const remainingMs = task.deadlineMs - now();
    if (remainingMs <= 0) {
      expireDeadline(task);
      return;
    }
    task.timer = setTimer(() => {
      task.timer = undefined;
      scheduleDeadline(task);
    }, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  }

  function finishRunning(
    task: DispatchTask<unknown>,
    result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown },
  ): void {
    if (task.state !== "running") return;
    task.state = "settled";
    cleanup(task);
    running.delete(task);
    active -= 1;
    const scopedActive = (activeByScope.get(task.scopeId) ?? 1) - 1;
    if (scopedActive === 0) activeByScope.delete(task.scopeId);
    else activeByScope.set(task.scopeId, scopedActive);
    if (result.ok) task.resolve(result.value);
    else task.reject(result.error);
    pump();
  }

  function runningStop(task: DispatchTask<unknown>): PolicyError | null {
    if (task.controller.signal.aborted) {
      return task.controller.signal.reason instanceof PolicyError
        ? task.controller.signal.reason
        : abortReason("cancelled");
    }
    if (task.deadlineMs !== undefined && now() >= task.deadlineMs) {
      const error = abortReason("timeout");
      task.controller.abort(error);
      return error;
    }
    return null;
  }

  function start(task: DispatchTask<unknown>): void {
    task.state = "running";
    active += 1;
    peakActive = Math.max(peakActive, active);
    activeByScope.set(task.scopeId, (activeByScope.get(task.scopeId) ?? 0) + 1);
    running.add(task);
    void Promise.resolve()
      .then(() => {
        if (task.controller.signal.aborted) throw task.controller.signal.reason;
        return task.operation({
          signal: task.controller.signal,
          ...(task.deadlineMs === undefined ? {} : { deadlineMs: task.deadlineMs }),
        });
      })
      .then(
        (value) => {
          const stopped = runningStop(task);
          finishRunning(
            task,
            stopped === null
              ? { ok: true, value }
              : { ok: false, error: stopped },
          );
        },
        (error) => {
          const stopped = runningStop(task);
          finishRunning(task, {
            ok: false,
            error: stopped ?? error,
          });
        },
      );
  }

  function pump(): void {
    if (closed) return;
    for (;;) {
      const task = queue[0];
      if (task === undefined) return;
      if (task.sourceSignal?.aborted) {
        rejectQueued(task, abortReason("cancelled"));
        continue;
      }
      if (task.deadlineMs !== undefined && now() >= task.deadlineMs) {
        rejectQueued(task, abortReason("timeout"));
        continue;
      }
      if (!canStart(task)) return;
      queue.shift();
      start(task);
    }
  }

  function dispatch<T>(
    dispatchOptions: PolicyDispatchOptions,
    operation: (context: PolicyDispatchContext) => Promise<T> | T,
  ): Promise<T> {
    if (closed) return Promise.reject(abortReason("closed"));
    if (dispatchOptions.scopeId.trim().length === 0) {
      return Promise.reject(new TypeError("scopeId must be non-empty"));
    }
    if (dispatchOptions.signal?.aborted) {
      return Promise.reject(abortReason("cancelled"));
    }
    if (
      dispatchOptions.deadlineMs !== undefined &&
      now() >= dispatchOptions.deadlineMs
    ) {
      return Promise.reject(abortReason("timeout"));
    }

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const task: DispatchTask<T> = {
        scopeId: dispatchOptions.scopeId,
        operation,
        controller,
        sourceSignal: dispatchOptions.signal,
        deadlineMs: dispatchOptions.deadlineMs,
        resolve,
        reject,
        onAbort: () => {
          const error = abortReason("cancelled");
          if (task.state === "queued") {
            rejectQueued(task as DispatchTask<unknown>, error);
            pump();
          } else if (task.state === "running") {
            task.controller.abort(error);
          }
        },
        state: "queued",
        timer: undefined,
      };
      dispatchOptions.signal?.addEventListener("abort", task.onAbort, { once: true });

      if (queue.length === 0 && canStart(task as DispatchTask<unknown>)) {
        start(task as DispatchTask<unknown>);
        scheduleDeadline(task as DispatchTask<unknown>);
        return;
      }
      if (dispatchOptions.queue === "fail") {
        task.state = "settled";
        cleanup(task as DispatchTask<unknown>);
        reject(
          new PolicyError(
            "capacity",
            canStart(task as DispatchTask<unknown>)
              ? "fifo_order"
              : "active_limit",
          ),
        );
        return;
      }
      if (queue.length >= maxQueued) {
        task.state = "settled";
        cleanup(task as DispatchTask<unknown>);
        reject(new PolicyError("capacity", "queue_full"));
        return;
      }
      queue.push(task as DispatchTask<unknown>);
      peakQueued = Math.max(peakQueued, queue.length);
      scheduleDeadline(task as DispatchTask<unknown>);
      pump();
    });
  }

  return {
    dispatch,
    fanOut<T, R>(
      items: readonly T[],
      fanOutOptions: {
        readonly scopeId: (item: T, index: number) => string;
        readonly queue: QueuePolicy;
        readonly signal?: AbortSignal;
        readonly deadlineMs?: number;
      },
      operation: (
        item: T,
        context: PolicyDispatchContext,
        index: number,
      ) => Promise<R> | R,
    ): Promise<PromiseSettledResult<R>[]> {
      return Promise.allSettled(
        items.map((item, index) =>
          dispatch(
            {
              scopeId: fanOutOptions.scopeId(item, index),
              queue: fanOutOptions.queue,
              ...(fanOutOptions.signal === undefined
                ? {}
                : { signal: fanOutOptions.signal }),
              ...(fanOutOptions.deadlineMs === undefined
                ? {}
                : { deadlineMs: fanOutOptions.deadlineMs }),
            },
            (context) => operation(item, context, index),
          ),
        ),
      );
    },
    metrics: () => ({
      active,
      queued: queue.length,
      peakActive,
      peakQueued,
      capacity: {
        active: maxActive,
        activePerScope: maxActivePerScope,
        queued: maxQueued,
      },
    }),
    close(): void {
      if (closed) return;
      closed = true;
      const error = abortReason("closed");
      for (const task of [...queue]) rejectQueued(task, error);
      for (const task of running) task.controller.abort(error);
    },
  };
}

const UNKNOWN_AFTER_RESTART = Object.freeze({
  kind: "unknown_after_restart" as const,
});

export async function reattachCanonicalAgent(input: {
  readonly agentRef: AgentRef;
  readonly observe: (
    ref: AgentRef,
    options?: RuntimeOperationOptions,
  ) => Promise<ThreadDetailSnapshot | undefined>;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}): Promise<{
  readonly kind: "reattached";
  readonly agentRef: AgentRef;
  readonly snapshot: ThreadDetailSnapshot;
  readonly overlay: { readonly kind: "unknown_after_restart" };
}> {
  if (input.signal?.aborted) throw abortReason("cancelled");
  if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
    throw abortReason("timeout");
  }
  const snapshot = await input.observe(input.agentRef, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
  });
  if (input.signal?.aborted) throw abortReason("cancelled");
  if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
    throw abortReason("timeout");
  }
  if (snapshot === undefined) throw new PolicyError("identity_not_found");
  if (
    !Number.isSafeInteger(snapshot.snapshotSequence) ||
    snapshot.snapshotSequence < 0 ||
    snapshot.thread.id !== input.agentRef.threadId ||
    (snapshot.thread.session !== null &&
      snapshot.thread.session.threadId !== input.agentRef.threadId)
  ) {
    throw new PolicyError("protocol_mismatch");
  }
  return Object.freeze({
    kind: "reattached" as const,
    agentRef: input.agentRef,
    snapshot,
    overlay: UNKNOWN_AFTER_RESTART,
  });
}

export interface CompletionOutcome {
  readonly kind: "completion";
  readonly dedupeKey: string;
  readonly agentRef: AgentRef;
  readonly turnId: string;
  readonly terminalSequence: number;
  readonly outcome: "completed" | "error" | "interrupted";
  readonly assistantContent?: string;
}

function completionFromObservation(input: {
  readonly agentRef: AgentRef;
  readonly observation: PollObservation;
}): CompletionOutcome | null {
  const shellThread = input.observation.shell.threads.find(
    (entry) => entry.id === input.agentRef.threadId,
  );
  const detail = input.observation.detail;
  if (shellThread === undefined || detail === undefined) return null;
  if (
    detail.thread.id !== input.agentRef.threadId ||
    detail.thread.id !== shellThread.id ||
    detail.thread.projectId !== shellThread.projectId
  ) {
    throw new PolicyError("protocol_mismatch");
  }
  if (detail.snapshotSequence < input.observation.shell.snapshotSequence) return null;
  if (shellThread.hasPendingApprovals || shellThread.hasPendingUserInput) return null;
  const shellTurn = shellThread.latestTurn;
  const detailTurn = detail.thread.latestTurn;
  if (shellTurn === null || detailTurn === null) return null;
  if (
    shellTurn.turnId !== detailTurn.turnId ||
    shellTurn.requestedAt !== detailTurn.requestedAt ||
    shellTurn.state !== detailTurn.state
  ) {
    return null;
  }
  if (detailTurn.state === "running") return null;

  let assistantContent: string | undefined;
  if (detailTurn.state === "completed") {
    if (detailTurn.completedAt === null || detailTurn.assistantMessageId === null) {
      return null;
    }
    const assistant = detail.thread.messages.find(
      (message) =>
        message.id === detailTurn.assistantMessageId &&
        message.role === "assistant" &&
        message.turnId === detailTurn.turnId &&
        !message.streaming,
    );
    if (assistant === undefined) return null;
    assistantContent = assistant.text;
  }

  const terminalSequence = detail.snapshotSequence;
  return Object.freeze({
    kind: "completion" as const,
    dedupeKey: `${input.agentRef.environmentId}\u0000${input.agentRef.threadId}\u0000${detailTurn.turnId}\u0000${terminalSequence}`,
    agentRef: input.agentRef,
    turnId: detailTurn.turnId,
    terminalSequence,
    outcome: detailTurn.state,
    ...(assistantContent === undefined ? {} : { assistantContent }),
  });
}

export function createCompletionReactor(options: {
  readonly maxCompletions: number;
}) {
  const capacity = boundedInteger(options.maxCompletions, "maxCompletions");
  const completions = new Map<string, CompletionOutcome>();
  let duplicates = 0;

  return {
    observe(input: {
      readonly agentRef: AgentRef;
      readonly observation: PollObservation;
    }): CompletionOutcome | null {
      const completion = completionFromObservation(input);
      if (completion === null) return null;
      const turnKey = `${completion.agentRef.environmentId}\u0000${completion.agentRef.threadId}\u0000${completion.turnId}`;
      const previous = completions.get(turnKey);
      if (previous !== undefined) {
        if (
          previous.outcome !== completion.outcome ||
          previous.assistantContent !== completion.assistantContent
        ) {
          throw new PolicyError("protocol_mismatch");
        }
        duplicates += 1;
        return null;
      }
      if (completions.size >= capacity) {
        throw new PolicyError("capacity", "completion_capacity");
      }
      completions.set(turnKey, completion);
      return completion;
    },
    metrics: () => ({ completions: completions.size, duplicates, capacity }),
  };
}
