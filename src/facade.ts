import type {
  AgentRef,
  ApprovalResponse,
  ControlOperationResult,
  CreateReconciliationPending,
  RuntimeOperationOptions,
  SpawnResult,
  StockSpawnInput,
  T3NativeRuntime,
  TurnReceipt,
  UserInputResponse,
} from "./nativeRuntime";
import { StockRuntimeError } from "./nativeRuntime";
import {
  WorkerOverlayError,
  createWorkerOverlay,
  type WorkerOverlay,
  type WorkerOverlayIdentity,
  type WorkerOverlayOptions,
  type WorkerOverlayRecord,
  type WorkerOverlayReservation,
  recordWorkerTerminalState,
} from "./overlay";
import type { ThreadDetailSnapshot } from "./stockT3Contracts";

export {
  allocateProjectCreateIdentity,
  canonicalizeWorkspaceRoot,
  parseProjectCreateIdentity,
} from "./nativeRuntime";
export { StockRuntimeError };
export type {
  AgentRef,
  ApprovalDecision,
  ApprovalResponse,
  ControlOperationName,
  ControlOperationResult,
  ControlReceipt,
  CreateAttemptReceipt,
  CreateReconciliationPending,
  CreateReconciliationState,
  ProjectCreateIdentity,
  ProjectCreateIdentityAllocationOptions,
  ProjectCreateIdentityExpectation,
  ProjectCreateIdentityInput,
  RetryState,
  RuntimeModelSelection,
  RuntimeOperationOptions,
  SanitizedRetryError,
  SpawnResult,
  StockRuntimeErrorCode,
  StockSpawnInput,
  T3NativeRuntime,
  ThreadCreateReceipt,
  TurnReceipt,
  UserInputResponse,
  WorkspaceCanonicalizationOptions,
} from "./nativeRuntime";
export {
  DEFAULT_OVERLAY_MAX_DEPTH,
  DEFAULT_OVERLAY_MAX_WORKERS,
  WorkerOverlayError,
  createWorkerOverlay,
} from "./overlay";
export type {
  WorkerOverlay,
  WorkerOverlayErrorCode,
  WorkerOverlayIdentity,
  WorkerOverlayOptions,
  WorkerOverlayRecord,
  WorkerOverlayReservation,
} from "./overlay";

export type StockFacadeSpawnInput = StockSpawnInput &
  (
    | {
        /** Omit both overlay fields to preserve the stock-only facade behavior. */
        readonly role?: never;
        readonly parentRef?: never;
      }
    | {
        readonly role: string;
        readonly parentRef: AgentRef | null;
      }
  );

export interface StockT3FacadeOptions {
  readonly overlay?: WorkerOverlay | WorkerOverlayOptions;
}

function isWorkerOverlay(value: WorkerOverlay | WorkerOverlayOptions): value is WorkerOverlay {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<WorkerOverlay>).reserve === "function" &&
    typeof (value as Partial<WorkerOverlay>).attach === "function"
  );
}

function stockSpawnInput(input: StockFacadeSpawnInput): StockSpawnInput {
  const { role: _role, parentRef: _parentRef, ...native } = input;
  return native;
}

function requestedOverlayIdentity(input: StockFacadeSpawnInput): WorkerOverlayIdentity | null {
  const hasRole = Object.hasOwn(input, "role");
  const hasParentRef = Object.hasOwn(input, "parentRef");
  if (!hasRole && !hasParentRef) return null;
  if (typeof input.role !== "string") {
    throw new WorkerOverlayError("overlay_invalid_role", {
      reason: "overlay_fields_incomplete",
    });
  }
  if (!hasParentRef || input.parentRef === undefined) {
    throw new WorkerOverlayError("overlay_invalid_ref", {
      reason: "overlay_fields_incomplete",
    });
  }
  return {
    role: input.role,
    parentRef:
      input.parentRef === null
        ? null
        : Object.freeze({
            environmentId: input.parentRef.environmentId,
            threadId: input.parentRef.threadId,
          }),
  };
}

function stableRef(ref: AgentRef): AgentRef {
  return Object.freeze({ environmentId: ref.environmentId, threadId: ref.threadId });
}

function stableIdentity(identity: WorkerOverlayIdentity): WorkerOverlayIdentity {
  return Object.freeze({
    role: identity.role,
    parentRef: identity.parentRef === null ? null : stableRef(identity.parentRef),
  });
}

function commitSpawnIdentity(
  reservation: WorkerOverlayReservation,
  agentRef: AgentRef,
  result: SpawnResult,
): void {
  try {
    reservation.commit(agentRef, { source: "spawn" });
  } catch (error) {
    if (error instanceof WorkerOverlayError) {
      throw new WorkerOverlayError(error.code, {
        ...error.details,
        agentRef: stableRef(agentRef),
        result,
      });
    }
    throw error;
  }
}

function reconciledRef(result: SpawnResult): AgentRef | null {
  return result.kind === "spawned" || result.kind === "partial" ? result.agentRef : null;
}

function isTerminalSnapshot(snapshot: ThreadDetailSnapshot): boolean {
  return (
    snapshot.thread.latestTurn?.state === "completed" ||
    snapshot.thread.latestTurn?.state === "interrupted" ||
    snapshot.thread.latestTurn?.state === "error" ||
    snapshot.thread.session?.status === "stopped" ||
    snapshot.thread.session?.status === "error"
  );
}

/** Public receipt-targeted facade over the stock T3 HTTP runtime. */
export function createStockT3Facade(
  runtime: T3NativeRuntime,
  options: StockT3FacadeOptions = {},
) {
  const overlay =
    options.overlay === undefined
      ? createWorkerOverlay()
      : isWorkerOverlay(options.overlay)
        ? options.overlay
        : createWorkerOverlay(options.overlay);
  const lifecycleSequenceByRef = new Map<string, number>();
  const lifecycleMutationsByRef = new Map<string, number>();

  function lifecycleKey(ref: AgentRef): string {
    return JSON.stringify([ref.environmentId, ref.threadId]);
  }

  function beginLifecycleMutation(ref: AgentRef): string {
    const key = lifecycleKey(ref);
    lifecycleMutationsByRef.set(key, (lifecycleMutationsByRef.get(key) ?? 0) + 1);
    return key;
  }

  function endLifecycleMutation(key: string): void {
    const remaining = (lifecycleMutationsByRef.get(key) ?? 1) - 1;
    if (remaining === 0) lifecycleMutationsByRef.delete(key);
    else lifecycleMutationsByRef.set(key, remaining);
  }

  async function requireCanonical(
    ref: AgentRef,
    operation?: RuntimeOperationOptions,
  ): Promise<void> {
    const snapshot = await runtime.observe(ref, operation);
    if (snapshot === undefined || snapshot.thread.id !== ref.threadId) {
      throw new WorkerOverlayError("overlay_canonical_not_found", { ref: { ...ref } });
    }
  }

  async function spawn(
    input: StockFacadeSpawnInput,
    operation?: RuntimeOperationOptions,
  ): Promise<SpawnResult> {
    const identity = requestedOverlayIdentity(input);
    const nativeInput = stockSpawnInput(input);
    if (identity === null) return runtime.spawn(nativeInput, operation);

    const reservation = overlay.reserve(null, identity);
    try {
      if (identity.parentRef !== null) {
        await requireCanonical(identity.parentRef, operation);
      }
      const result = await runtime.spawn(nativeInput, operation);
      const ref = reconciledRef(result);
      if (ref !== null) commitSpawnIdentity(reservation, ref, result);
      return result;
    } finally {
      reservation.release();
    }
  }

  async function resumeCreateReconciliation(
    pending: CreateReconciliationPending,
    input: StockFacadeSpawnInput,
    operation?: RuntimeOperationOptions,
  ): Promise<SpawnResult> {
    const identity = requestedOverlayIdentity(input);
    const nativeInput = stockSpawnInput(input);
    if (identity === null) {
      return runtime.resumeCreateReconciliation(pending, nativeInput, operation);
    }

    const reservation = overlay.reserve(pending.provisionalRef, identity);
    try {
      if (identity.parentRef !== null) {
        await requireCanonical(identity.parentRef, operation);
      }
      const result = await runtime.resumeCreateReconciliation(pending, nativeInput, operation);
      const ref = reconciledRef(result);
      if (ref !== null) commitSpawnIdentity(reservation, ref, result);
      return result;
    } finally {
      reservation.release();
    }
  }

  return Object.freeze({
    spawn,
    resumeCreateReconciliation,
    async attach(
      ref: AgentRef,
      identity: WorkerOverlayIdentity,
      operation?: RuntimeOperationOptions,
    ): Promise<WorkerOverlayRecord> {
      const attachedRef = stableRef(ref);
      const attachedIdentity = stableIdentity(identity);
      const reservation = overlay.reserve(attachedRef, attachedIdentity);
      try {
        if (attachedIdentity.parentRef !== null) {
          await requireCanonical(attachedIdentity.parentRef, operation);
        }
        await requireCanonical(attachedRef, operation);
        return reservation.commit(attachedRef, { source: "attach" });
      } finally {
        reservation.release();
      }
    },
    getWorker: (ref: AgentRef) => overlay.getWorker(ref),
    listChildren: (parentRef: AgentRef) => overlay.listChildren(parentRef),
    listWorkers: () => overlay.listWorkers(),
    async send(ref: AgentRef, message: string, options?: RuntimeOperationOptions) {
      const mutationKey = beginLifecycleMutation(ref);
      let wasTerminal: boolean;
      try {
        wasTerminal = recordWorkerTerminalState(overlay, ref, false);
      } catch (error) {
        endLifecycleMutation(mutationKey);
        throw error;
      }
      try {
        const receipt = await runtime.send(ref, message, options);
        lifecycleSequenceByRef.set(
          mutationKey,
          Math.max(receipt.observedSequence, receipt.acceptedSequence ?? 0),
        );
        endLifecycleMutation(mutationKey);
        return receipt;
      } catch (error) {
        endLifecycleMutation(mutationKey);
        if (wasTerminal) recordWorkerTerminalState(overlay, ref, true);
        throw error;
      }
    },
    async wait(receipt: TurnReceipt, options?: RuntimeOperationOptions) {
      try {
        const result = await runtime.wait(receipt, options);
        recordWorkerTerminalState(overlay, receipt.agentRef, true);
        return result;
      } catch (error) {
        if (
          error instanceof StockRuntimeError &&
          (error.code === "turn_interrupted" || error.code === "turn_error")
        ) {
          recordWorkerTerminalState(overlay, receipt.agentRef, true);
        }
        throw error;
      }
    },
    async interrupt(
      ref: AgentRef,
      options?: RuntimeOperationOptions,
    ): Promise<ControlOperationResult> {
      const mutationKey = beginLifecycleMutation(ref);
      let wasTerminal: boolean;
      try {
        wasTerminal = recordWorkerTerminalState(overlay, ref, false);
      } catch (error) {
        endLifecycleMutation(mutationKey);
        throw error;
      }
      try {
        const result = await runtime.interrupt(ref, options);
        lifecycleSequenceByRef.set(mutationKey, result.snapshot.snapshotSequence);
        recordWorkerTerminalState(overlay, ref, isTerminalSnapshot(result.snapshot));
        endLifecycleMutation(mutationKey);
        return result;
      } catch (error) {
        endLifecycleMutation(mutationKey);
        if (wasTerminal) recordWorkerTerminalState(overlay, ref, true);
        throw error;
      }
    },
    async stop(
      ref: AgentRef,
      options?: RuntimeOperationOptions,
    ): Promise<ControlOperationResult> {
      const mutationKey = beginLifecycleMutation(ref);
      let wasTerminal: boolean;
      try {
        wasTerminal = recordWorkerTerminalState(overlay, ref, false);
      } catch (error) {
        endLifecycleMutation(mutationKey);
        throw error;
      }
      try {
        const result = await runtime.stop(ref, options);
        lifecycleSequenceByRef.set(mutationKey, result.snapshot.snapshotSequence);
        recordWorkerTerminalState(overlay, ref, isTerminalSnapshot(result.snapshot));
        endLifecycleMutation(mutationKey);
        return result;
      } catch (error) {
        endLifecycleMutation(mutationKey);
        if (wasTerminal) recordWorkerTerminalState(overlay, ref, true);
        throw error;
      }
    },
    respondToApproval: (
      ref: AgentRef,
      response: ApprovalResponse,
      options?: RuntimeOperationOptions,
    ) => runtime.respondToApproval(ref, response, options),
    respondToUserInput: (
      ref: AgentRef,
      response: UserInputResponse,
      options?: RuntimeOperationOptions,
    ) => runtime.respondToUserInput(ref, response, options),
    async observe(ref: AgentRef, options?: RuntimeOperationOptions) {
      const snapshot = await runtime.observe(ref, options);
      if (snapshot !== undefined) {
        const key = lifecycleKey(ref);
        const minimumSequence = lifecycleSequenceByRef.get(key);
        if (
          !lifecycleMutationsByRef.has(key) &&
          (minimumSequence === undefined || snapshot.snapshotSequence >= minimumSequence)
        ) {
          lifecycleSequenceByRef.set(key, snapshot.snapshotSequence);
          if (isTerminalSnapshot(snapshot)) {
            recordWorkerTerminalState(overlay, ref, true);
          }
        }
      }
      return snapshot;
    },
    releaseReceipt: (receipt: TurnReceipt) => runtime.releaseReceipt(receipt),
    pollMetrics: () => runtime.pollMetrics(),
    httpObservations: () => runtime.httpObservations(),
    close: () => runtime.close(),
  });
}
