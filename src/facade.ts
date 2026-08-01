import type {
  AgentRef,
  CreateReconciliationPending,
  RuntimeOperationOptions,
  StockSpawnInput,
  T3NativeRuntime,
  TurnReceipt,
} from "./nativeRuntime";

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

/** Public receipt-targeted facade over the stock T3 HTTP runtime. */
export function createStockT3Facade(runtime: T3NativeRuntime) {
  return Object.freeze({
    spawn: (input: StockSpawnInput, options?: RuntimeOperationOptions) =>
      runtime.spawn(input, options),
    resumeCreateReconciliation: (
      pending: CreateReconciliationPending,
      input: StockSpawnInput,
      options?: RuntimeOperationOptions,
    ) => runtime.resumeCreateReconciliation(pending, input, options),
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
