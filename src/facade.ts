import type {
  AgentRef,
  CreateReconciliationPending,
  RuntimeOperationOptions,
  SpawnResult,
  StockSpawnInput,
  T3NativeRuntime,
  TurnReceipt,
} from "./nativeRuntime";
import {
  WorkerOverlayError,
  createWorkerOverlay,
  type WorkerOverlay,
  type WorkerOverlayIdentity,
  type WorkerOverlayOptions,
  type WorkerOverlayRecord,
} from "./overlay";

export {
  allocateProjectCreateIdentity,
  canonicalizeWorkspaceRoot,
  parseProjectCreateIdentity,
  StockRuntimeError,
} from "./nativeRuntime";
export type {
  AgentRef,
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

export interface StockFacadeSpawnInput extends StockSpawnInput {
  /** Omit both overlay fields to preserve the stock-only facade behavior. */
  readonly role?: string;
  readonly parentRef?: AgentRef | null;
}

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
  return {
    workspaceRoot: input.workspaceRoot,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.projectCreateIdentity === undefined
      ? {}
      : { projectCreateIdentity: input.projectCreateIdentity }),
    title: input.title,
    message: input.message,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
  };
}

function requestedOverlayIdentity(input: StockFacadeSpawnInput): WorkerOverlayIdentity | null {
  if (!Object.hasOwn(input, "role") && !Object.hasOwn(input, "parentRef")) return null;
  return {
    role: input.role as string,
    parentRef:
      input.parentRef == null
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

function reconciledRef(result: SpawnResult): AgentRef | null {
  return result.kind === "spawned" || result.kind === "partial" ? result.agentRef : null;
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
      if (ref !== null) reservation.commit(ref, { source: "spawn" });
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
      if (ref !== null) reservation.commit(ref, { source: "spawn" });
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
    send: (ref: AgentRef, message: string, options?: RuntimeOperationOptions) =>
      runtime.send(ref, message, options),
    wait: (receipt: TurnReceipt, options?: RuntimeOperationOptions) =>
      runtime.wait(receipt, options),
    observe: (ref: AgentRef, options?: RuntimeOperationOptions) =>
      runtime.observe(ref, options),
    releaseReceipt: (receipt: TurnReceipt) => runtime.releaseReceipt(receipt),
    pollMetrics: () => runtime.pollMetrics(),
    httpObservations: () => runtime.httpObservations(),
    close: () => runtime.close(),
  });
}
