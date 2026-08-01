import type {
  EnvironmentDescriptor,
  ShellSnapshot,
  StockMessage,
  StockThreadDetail,
  StockThreadShell,
  ThreadDetailSnapshot,
} from "./stockT3Contracts";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import {
  StockT3HttpError,
  createStockT3HttpClient,
  type FetchLike,
  type RequestBoundaryOptions,
} from "./stockT3HttpClient";
import { createAdaptivePoller, PollerError } from "./adaptivePoller";

export interface AgentRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface RuntimeModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: readonly unknown[];
}

export interface StockSpawnInput {
  readonly workspaceRoot: string;
  readonly projectId?: string;
  readonly projectCreateIdentity?: ProjectCreateIdentity;
  readonly title: string;
  readonly message: string;
  readonly modelSelection: RuntimeModelSelection;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly interactionMode: "default" | "plan";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface ProjectCreateIdentity {
  readonly projectId: string;
  readonly commandId: string;
  readonly createdAt: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly defaultModelSelection: RuntimeModelSelection;
  readonly environmentId?: string;
}

export interface WorkspaceCanonicalizationOptions {
  readonly platform?: "darwin" | "linux" | "windows" | "win32";
  readonly cwd?: string;
  readonly homeDirectory?: string;
}

export interface ProjectCreateIdentityInput {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly defaultModelSelection: RuntimeModelSelection;
  readonly environmentId?: string;
}

export interface ProjectCreateIdentityAllocationOptions
  extends WorkspaceCanonicalizationOptions {
  readonly id?: () => string;
  readonly now?: () => string;
}

export interface ProjectCreateIdentityExpectation
  extends WorkspaceCanonicalizationOptions {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
}

export type RetryState =
  | "not_applicable"
  | "eligible_not_sent"
  | "identical_retry_sent_no_response"
  | "identical_retry_accepted"
  | "identical_retry_received_error";

export interface CreateAttemptReceipt {
  readonly commandId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly acceptedSequence: number | null;
  readonly dispatchState: "accepted" | "outcome_unknown";
  readonly retryState: RetryState;
  readonly retryError: SanitizedRetryError | null;
}

export interface SanitizedRetryError {
  readonly status: 400 | 401 | 403 | 500;
  readonly class:
    | "command_rejected"
    | "authentication_failed"
    | "permission_denied"
    | "server_internal";
  readonly code: "invalid_request" | "auth_invalid" | "insufficient_scope" | "internal_error";
  readonly reason: "invalid_command" | "orchestration_dispatch_failed" | null;
}

export interface CreateReconciliationState {
  readonly reason:
    | "projection_pending"
    | "retry_error_after_ambiguous_original"
    | "cancelled"
    | "deadline_exhausted"
    | "transport_exhausted";
  readonly projectionState:
    | "unobserved"
    | "shell_only"
    | "detail_only"
    | "below_required_sequence"
    | "identity_unverified";
  readonly highestShellSequence: number | null;
  readonly highestDetailSequence: number | null;
  readonly deadlineMs: number;
  readonly evidence: readonly Readonly<Record<string, unknown>>[];
}

export interface ThreadCreateReceipt {
  readonly commandId: string;
  readonly threadId: string;
  readonly acceptedSequence: number | null;
  readonly observedSequence: number;
  readonly recovered: boolean;
}

export interface TurnReceipt {
  readonly agentRef: AgentRef;
  readonly leaseId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly acceptedSequence: number | null;
  readonly observedSequence: number;
  readonly leaseExpiresAt: number;
  readonly leaseState: "active" | "released";
  readonly reconciliationEvidence?: readonly Readonly<Record<string, unknown>>[];
}

export type SpawnResult =
  | {
      readonly kind: "spawned";
      readonly agentRef: AgentRef;
      readonly createReceipt: ThreadCreateReceipt;
      readonly turnReceipt: TurnReceipt;
    }
  | {
      readonly kind: "partial";
      readonly agentRef: AgentRef;
      readonly createReceipt: ThreadCreateReceipt;
      readonly initialTurn: {
        readonly commandId: string;
        readonly messageId: string;
        readonly state:
          | "not_attempted"
          | "initial_turn_rejected"
          | "initial_turn_accepted_projection_pending"
          | "initial_turn_outcome_unknown"
          | "contended_before_start"
          | "superseded"
          | "concurrent_writer"
          | "causality_unverifiable"
          | "cancelled"
          | "deadline_exhausted";
        readonly turnReceipt: TurnReceipt | null;
        readonly leaseExpiresAt: number | null;
        readonly safeAction: "new_send" | "wait" | "observe";
        readonly evidence: readonly Readonly<Record<string, unknown>>[];
      };
    }
  | CreateReconciliationPending
  | {
      readonly kind: "create_protocol_failure";
      readonly provisionalRef: AgentRef;
      readonly createAttempt: CreateAttemptReceipt;
      readonly conflict: Readonly<Record<string, unknown>>;
    };

export interface CreateReconciliationPending {
  readonly kind: "create_reconciliation_pending";
  readonly provisionalRef: AgentRef;
  readonly createAttempt: CreateAttemptReceipt;
  readonly reconciliation: CreateReconciliationState;
  readonly initialTurnContinuation: {
    readonly commandId: string;
    readonly messageId: string;
    readonly inputDigest: string;
  };
  readonly safeAction: "resume_create_reconciliation";
}

export type StockRuntimeErrorCode =
  | "command_rejected"
  | "authentication_failed"
  | "permission_denied"
  | "server_internal"
  | "transport_unavailable"
  | "protocol_mismatch"
  | "environment_changed"
  | "identity_conflict"
  | "send_in_progress"
  | "receipt_expired"
  | "correlation_capacity"
  | "cancelled"
  | "timeout"
  | "superseded"
  | "concurrent_writer"
  | "causality_unverifiable"
  | "pending_approval"
  | "pending_input"
  | "turn_interrupted"
  | "turn_error";

export class StockRuntimeError extends Error {
  constructor(
    readonly code: StockRuntimeErrorCode,
    readonly evidence: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = "StockRuntimeError";
  }
}

function identityConflict(reason: string, evidence: Readonly<Record<string, unknown>> = {}): never {
  throw new StockRuntimeError("identity_conflict", {
    reason: "invalid_project_create_identity",
    detail: reason,
    ...evidence,
  });
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) identityConflict(`${field}_required`);
  return value;
}

function identifier(value: unknown, field: string): string {
  const parsed = nonBlank(value, field);
  if (parsed !== parsed.trim()) identityConflict(`${field}_has_surrounding_whitespace`);
  return parsed;
}

function jsonValue(value: unknown, field: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) identityConflict(`${field}_must_be_json`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${field}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) identityConflict(`${field}_must_be_json`);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) identityConflict(`${field}.${key}_must_be_json`);
      result[key] = jsonValue(entry, `${field}.${key}`);
    }
    return result;
  }
  identityConflict(`${field}_must_be_json`);
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) freezeJson(entry);
    return Object.freeze(value);
  }
  return value;
}

/** Stock-compatible workspace ingress canonicalization. */
export function canonicalizeWorkspaceRoot(
  value: unknown,
  options: WorkspaceCanonicalizationOptions = {},
): string {
  const input = nonBlank(value, "workspace_root").trim();
  const path = options.platform === "windows" || options.platform === "win32" ? win32 : posix;
  const home = options.homeDirectory ?? homedir();
  const expanded = input === "~"
    ? home
    : input.startsWith("~/") || input.startsWith("~\\")
      ? path.join(home, input.slice(2))
      : input;
  return path.resolve(options.cwd ?? process.cwd(), expanded);
}

function workspaceComparisonKey(
  value: unknown,
  options: WorkspaceCanonicalizationOptions = {},
): string {
  const canonicalRoot = canonicalizeWorkspaceRoot(value, options);
  return options.platform === "windows" || options.platform === "win32"
    ? canonicalRoot.replaceAll("/", "\\").toLowerCase()
    : canonicalRoot;
}

/** Allocate the one caller-held, exact-replay identity used by project.create. */
export function allocateProjectCreateIdentity(
  input: ProjectCreateIdentityInput,
  options: ProjectCreateIdentityAllocationOptions = {},
): ProjectCreateIdentity {
  const id = options.id ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  return parseProjectCreateIdentity({
    projectId: id(),
    commandId: id(),
    createdAt: now(),
    workspaceRoot: canonicalizeWorkspaceRoot(input.workspaceRoot, options),
    title: input.title,
    defaultModelSelection: input.defaultModelSelection,
    ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
  }, options);
}

/** Parse plain JSON and validate every immutable project.create replay field. */
export function parseProjectCreateIdentity(
  value: unknown,
  expectation: ProjectCreateIdentityExpectation = {},
): ProjectCreateIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    identityConflict("identity_must_be_object");
  }
  const record = value as Record<string, unknown>;
  const selection = record.defaultModelSelection;
  if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
    identityConflict("default_model_selection_required");
  }
  const model = selection as Record<string, unknown>;
  const createdAt = nonBlank(record.createdAt, "created_at");
  if (!Number.isFinite(Date.parse(createdAt))) identityConflict("created_at_invalid");
  const modelOptions = model.options === undefined
    ? undefined
    : freezeJson(jsonValue(model.options, "model_options")) as readonly unknown[];
  if (modelOptions !== undefined && !Array.isArray(modelOptions)) identityConflict("model_options_must_be_array");
  const defaultModelSelection = Object.freeze({
    instanceId: identifier(model.instanceId, "model_instance_id"),
    model: identifier(model.model, "model"),
    ...(modelOptions === undefined ? {} : { options: modelOptions }),
  });
  const parsed: ProjectCreateIdentity = {
    projectId: identifier(record.projectId, "project_id"),
    commandId: identifier(record.commandId, "command_id"),
    createdAt,
    workspaceRoot: canonicalizeWorkspaceRoot(record.workspaceRoot, expectation),
    title: nonBlank(record.title, "title"),
    defaultModelSelection,
    ...(record.environmentId === undefined
      ? {}
      : { environmentId: identifier(record.environmentId, "environment_id") }),
  };
  if (expectation.workspaceRoot !== undefined &&
      workspaceComparisonKey(parsed.workspaceRoot, expectation) !==
        workspaceComparisonKey(expectation.workspaceRoot, expectation)) {
    identityConflict("workspace_root_mismatch", {
      expectedWorkspaceRoot: canonicalizeWorkspaceRoot(expectation.workspaceRoot, expectation),
      actualWorkspaceRoot: parsed.workspaceRoot,
    });
  }
  if (expectation.projectId !== undefined && parsed.projectId !== expectation.projectId) {
    identityConflict("project_id_mismatch", {
      expectedProjectId: expectation.projectId,
      actualProjectId: parsed.projectId,
    });
  }
  return Object.freeze(parsed);
}

export interface StockT3RuntimeClient {
  readonly getDescriptor: (options?: RequestBoundaryOptions) => Promise<EnvironmentDescriptor>;
  readonly getShell: (options?: RequestBoundaryOptions) => Promise<ShellSnapshot>;
  readonly getThread: (
    threadId: string,
    options?: RequestBoundaryOptions,
  ) => Promise<ThreadDetailSnapshot | undefined>;
  readonly dispatch: (
    command: Readonly<Record<string, unknown>>,
    options?: RequestBoundaryOptions,
  ) => Promise<{ readonly sequence: number }>;
  readonly observations?: () => {
    readonly requestCount: number;
    readonly inFlight: number;
    readonly peakInFlight: number;
    readonly endpointStatusTrace: readonly {
      readonly method: string;
      readonly path: string;
      readonly status: number | null;
    }[];
  };
}

export interface StockT3NativeRuntimeOptions {
  readonly client?: StockT3RuntimeClient;
  readonly baseUrl?: string | URL;
  readonly bearerToken?: string;
  readonly fetch?: FetchLike;
  readonly connectionProfile?: "local" | "relay" | "tunnel";
  readonly id?: () => string;
  readonly now?: () => string;
  readonly clock?: () => number;
}

export interface RuntimeOperationOptions {
  readonly deadlineMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxReconciliationReads?: number;
}

interface LeaseState {
  readonly receipt: TurnReceipt;
  readonly slotToken: symbol;
  readonly baselineUserIds: readonly string[];
  readonly preflightLatestTurnId: string | null;
  readonly expectedInputDigest: string;
  boundTurnId: string | null;
}

interface TurnSlotClaim {
  readonly token: symbol;
  readonly expiresAt: number;
  readonly generation: number;
}

interface TargetProjection {
  readonly kind: "absent" | "target" | "superseded" | "concurrent_writer" | "causality_unverifiable";
  readonly detail?: ThreadDetailSnapshot;
  readonly evidence?: readonly Readonly<Record<string, unknown>>[];
}

interface ReconciliationObservation {
  readonly shell: ShellSnapshot | null;
  readonly detail: ThreadDetailSnapshot | null;
  readonly projectionState: CreateReconciliationState["projectionState"];
  readonly conflict: Readonly<Record<string, unknown>> | null;
  readonly evidence?: readonly Readonly<Record<string, unknown>>[];
}

interface ProjectCreateAttemptState {
  readonly environmentId: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly command: Readonly<Record<string, unknown>>;
  acceptedSequence: number | null;
  dispatchState: "accepted" | "outcome_unknown";
  retryState: RetryState;
  retryClass: StockRuntimeErrorCode | null;
  readonly readEvidence: Readonly<Record<string, unknown>>[];
}

const DEFAULT_DEADLINE_MS = 15 * 60_000;
const MAX_BASELINE_IDS = 4_096;
const MAX_BASELINE_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 256 * 1024;

function isAmbiguous(error: unknown): boolean {
  return (
    error instanceof StockT3HttpError &&
    error.code === "transport_unavailable" &&
    error.status === null
  );
}

function isAmbiguousDispatch(error: unknown): boolean {
  return (
    isAmbiguous(error) ||
    (error instanceof StockT3HttpError &&
      error.code === "protocol_mismatch" &&
      error.status !== null &&
      error.status >= 200 &&
      error.status < 300)
  );
}

type DispatchFailure =
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "received"; readonly error: StockRuntimeError };

function sanitizeRetry(error: StockT3HttpError): SanitizedRetryError | null {
  if (![400, 401, 403, 500].includes(error.status ?? 0)) return null;
  const status = error.status as 400 | 401 | 403 | 500;
  const detail = error.detail;
  const code = detail.code;
  const reason = detail.reason;
  if (status === 400 && error.code === "command_rejected" && code === "invalid_request" && reason === "invalid_command") {
    return { status, class: error.code, code, reason };
  }
  if (status === 401 && error.code === "authentication_failed" && code === "auth_invalid") {
    return { status, class: error.code, code, reason: null };
  }
  if (status === 403 && error.code === "permission_denied" && code === "insufficient_scope") {
    return { status, class: error.code, code, reason: null };
  }
  if (status === 500 && error.code === "server_internal" && code === "internal_error" && reason === "orchestration_dispatch_failed") {
    return { status, class: error.code, code, reason };
  }
  return null;
}

function mapReceivedError(error: unknown): StockRuntimeError {
  if (error instanceof StockRuntimeError) return error;
  if (error instanceof StockT3HttpError) {
    if (
      error.code === "command_rejected" ||
      error.code === "authentication_failed" ||
      error.code === "permission_denied" ||
      error.code === "server_internal" ||
      error.code === "protocol_mismatch" ||
      error.code === "transport_unavailable"
    ) {
      return new StockRuntimeError(error.code, { status: error.status });
    }
  }
  return new StockRuntimeError("transport_unavailable");
}

function readFailureEvidence(
  error: unknown,
  stage: string,
): Readonly<Record<string, unknown>> {
  const mapped = mapReceivedError(error);
  const status = mapped.evidence.status;
  return status === undefined
    ? { stage, class: mapped.code }
    : { stage, class: mapped.code, status };
}

function turnReceiptError(
  code: StockRuntimeErrorCode,
  receipt: TurnReceipt,
  evidence: Readonly<Record<string, unknown>> = {},
): StockRuntimeError {
  return new StockRuntimeError(code, { ...evidence, receipt });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestSync(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonical(value)).digest("hex");
}

export async function digestStockSpawnInput(input: StockSpawnInput): Promise<string> {
  return digestSync(canonicalizeSpawnInput(input));
}

function canonicalizeSpawnInput(
  input: StockSpawnInput,
  platform?: EnvironmentDescriptor["platform"]["os"],
): StockSpawnInput {
  const canonicalization = { platform: platform === "unknown" ? undefined : platform };
  const workspaceRoot = canonicalizeWorkspaceRoot(input.workspaceRoot, canonicalization);
  const projectCreateIdentity = input.projectCreateIdentity === undefined
    ? undefined
    : parseProjectCreateIdentity(input.projectCreateIdentity, {
        ...canonicalization,
        workspaceRoot,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      });
  return {
    ...input,
    workspaceRoot,
    ...(projectCreateIdentity === undefined ? {} : { projectCreateIdentity }),
  };
}

function sameThreadIdentity(
  thread: StockThreadShell | StockThreadDetail,
  input: StockSpawnInput,
  threadId: string,
  projectId: string,
): boolean {
  return (
    thread.id === threadId &&
    thread.projectId === projectId &&
    thread.title === input.title &&
    thread.runtimeMode === input.runtimeMode &&
    thread.interactionMode === input.interactionMode &&
    thread.branch === input.branch &&
    thread.worktreePath === input.worktreePath &&
    thread.modelSelection.instanceId === input.modelSelection.instanceId &&
    thread.modelSelection.model === input.modelSelection.model
  );
}

function userMessages(detail: ThreadDetailSnapshot): readonly StockMessage[] {
  return detail.thread.messages.filter((entry) => entry.role === "user");
}

export function createStockT3NativeRuntime(options: StockT3NativeRuntimeOptions) {
  if (options.client === undefined && options.baseUrl === undefined) {
    throw new TypeError("client or baseUrl is required");
  }
  const client: StockT3RuntimeClient =
    options.client ??
    createStockT3HttpClient({
      baseUrl: options.baseUrl!,
      bearerToken: options.bearerToken,
      fetch: options.fetch,
      connectionProfile: options.connectionProfile,
      clock: options.clock,
    });
  const id = options.id ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const clock = options.clock ?? Date.now;
  const leases = new Map<string, LeaseState>();
  const turnSlotClaims = new Map<string, TurnSlotClaim>();
  const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const leaseGenerations = new Map<string, number>();
  let pinnedEnvironmentId: string | null = null;
  const poller = createAdaptivePoller({
    getShell: (boundary) => client.getShell(boundary),
    getThread: (threadId, boundary) => client.getThread(threadId, boundary),
    now: clock,
  });

  function scopedThreadKey(ref: AgentRef): string {
    return `${ref.environmentId}\u0000${ref.threadId}`;
  }

  function environmentLeaseGeneration(environmentId: string): number {
    return leaseGenerations.get(environmentId) ?? 0;
  }

  function invalidateEnvironmentLeases(environmentId: string): void {
    leaseGenerations.set(
      environmentId,
      environmentLeaseGeneration(environmentId) + 1,
    );
    for (const state of [...leases.values()]) {
      if (state.receipt.agentRef.environmentId === environmentId) {
        releaseLease(state.receipt.agentRef, state.receipt.leaseId);
      }
    }
    const prefix = `${environmentId}\u0000`;
    for (const key of turnSlotClaims.keys()) {
      if (key.startsWith(prefix)) turnSlotClaims.delete(key);
    }
  }

  async function descriptor(boundary: RequestBoundaryOptions = {}): Promise<EnvironmentDescriptor> {
    const current = await client.getDescriptor(boundary).catch((error) => {
      throw mapReceivedError(error);
    });
    if (pinnedEnvironmentId !== null && current.environmentId !== pinnedEnvironmentId) {
      const expectedEnvironmentId = pinnedEnvironmentId;
      pinnedEnvironmentId = current.environmentId;
      invalidateEnvironmentLeases(expectedEnvironmentId);
      throw new StockRuntimeError("environment_changed", {
        expectedEnvironmentId,
        actualEnvironmentId: current.environmentId,
      });
    }
    pinnedEnvironmentId = current.environmentId;
    return current;
  }

  function operationDeadline(input: RuntimeOperationOptions): number {
    return input.deadlineMs ?? clock() + (input.timeoutMs ?? DEFAULT_DEADLINE_MS);
  }

  function boundedOperation(input: RuntimeOperationOptions): RuntimeOperationOptions & {
    readonly deadlineMs: number;
  } {
    return { ...input, deadlineMs: operationDeadline(input) };
  }

  function stopCode(
    operation: RuntimeOperationOptions & { readonly deadlineMs: number },
  ): "cancelled" | "timeout" | null {
    if (operation.signal?.aborted) return "cancelled";
    if (clock() >= operation.deadlineMs) return "timeout";
    return null;
  }

  function classifyDispatchFailure(
    error: unknown,
    operation: RuntimeOperationOptions & { readonly deadlineMs: number },
  ): DispatchFailure {
    if (operation.signal?.aborted) return { kind: "cancelled" };
    if (clock() >= operation.deadlineMs) return { kind: "timeout" };
    if (isAmbiguousDispatch(error)) return { kind: "ambiguous" };
    return { kind: "received", error: mapReceivedError(error) };
  }

  function releaseLeaseAndSnapshot(receipt: TurnReceipt): TurnReceipt {
    const key = scopedThreadKey(receipt.agentRef);
    const state = leases.get(key);
    const matchingLeaseState = state?.receipt.leaseId === receipt.leaseId ? state : undefined;
    const matchingState =
      matchingLeaseState !== undefined &&
      matchingLeaseState.receipt.commandId === receipt.commandId &&
      matchingLeaseState.receipt.messageId === receipt.messageId
        ? matchingLeaseState
        : undefined;
    const current = matchingState === undefined
      ? receipt
      : {
          ...matchingState.receipt,
          acceptedSequence:
            receipt.acceptedSequence ?? matchingState.receipt.acceptedSequence,
          observedSequence: Math.max(
            receipt.observedSequence,
            matchingState.receipt.observedSequence,
          ),
          ...(receipt.reconciliationEvidence === undefined
            ? {}
            : { reconciliationEvidence: receipt.reconciliationEvidence }),
        };
    if (matchingLeaseState !== undefined) {
      leases.delete(key);
      const timer = leaseTimers.get(key);
      if (timer !== undefined) clearTimeout(timer);
      leaseTimers.delete(key);
    }
    return current.leaseState === "released"
      ? current
      : { ...current, leaseState: "released" };
  }

  function releaseLease(ref: AgentRef, leaseId?: string): void {
    const state = leases.get(scopedThreadKey(ref));
    if (state === undefined || (leaseId !== undefined && state.receipt.leaseId !== leaseId)) return;
    releaseLeaseAndSnapshot(state.receipt);
  }

  function releaseTurnSlot(ref: AgentRef, token: symbol): void {
    const key = scopedThreadKey(ref);
    const claim = turnSlotClaims.get(key);
    if (claim?.token === token) turnSlotClaims.delete(key);
    const lease = leases.get(key);
    if (lease?.slotToken === token) releaseLease(ref, lease.receipt.leaseId);
  }

  function claimTurnSlot(ref: AgentRef, deadlineMs: number): TurnSlotClaim {
    const key = scopedThreadKey(ref);
    const existingLease = leases.get(key);
    if (existingLease !== undefined) {
      if (existingLease.receipt.leaseExpiresAt <= clock()) {
        releaseLease(ref, existingLease.receipt.leaseId);
      } else {
        throw new StockRuntimeError("send_in_progress", { threadId: ref.threadId });
      }
    }
    const existingClaim = turnSlotClaims.get(key);
    if (existingClaim !== undefined && existingClaim.expiresAt > clock()) {
      throw new StockRuntimeError("send_in_progress", { threadId: ref.threadId });
    }
    if (existingClaim !== undefined) turnSlotClaims.delete(key);
    if (deadlineMs <= clock()) throw new StockRuntimeError("timeout");
    const token = Symbol(ref.threadId);
    const claim = {
      token,
      expiresAt: deadlineMs,
      generation: environmentLeaseGeneration(ref.environmentId),
    };
    turnSlotClaims.set(key, claim);
    return claim;
  }

  function updateLeaseReceipt(
    ref: AgentRef,
    slotToken: symbol,
    receipt: TurnReceipt,
  ): boolean {
    const key = scopedThreadKey(ref);
    const state = leases.get(key);
    if (
      state === undefined ||
      state.slotToken !== slotToken ||
      state.receipt.leaseExpiresAt <= clock()
    ) {
      if (state?.slotToken === slotToken) {
        releaseLease(ref, state.receipt.leaseId);
      }
      return false;
    }
    leases.set(key, { ...state, receipt });
    return true;
  }

  function pending(
    ref: AgentRef,
    attempt: CreateAttemptReceipt,
    continuation: CreateReconciliationPending["initialTurnContinuation"],
    reason: CreateReconciliationState["reason"],
    observation: ReconciliationObservation,
    deadlineMs: number,
  ): CreateReconciliationPending {
    return {
      kind: "create_reconciliation_pending",
      provisionalRef: ref,
      createAttempt: attempt,
      reconciliation: {
        reason,
        projectionState: observation.projectionState,
        highestShellSequence: observation.shell?.snapshotSequence ?? null,
        highestDetailSequence: observation.detail?.snapshotSequence ?? null,
        deadlineMs,
        evidence: observation.evidence ?? [],
      },
      initialTurnContinuation: continuation,
      safeAction: "resume_create_reconciliation",
    };
  }

  async function observeReconciliation(
    ref: AgentRef,
    projectId: string,
    input: StockSpawnInput,
    minimumSequence: number | null,
    boundary: RequestBoundaryOptions & { readonly deadlineMs: number },
  ): Promise<ReconciliationObservation> {
    let shell: ShellSnapshot | null = null;
    let detail: ThreadDetailSnapshot | null = null;
    const evidence: Readonly<Record<string, unknown>>[] = [];
    try {
      shell = await client.getShell(boundary);
    } catch (error) {
      if (!isAmbiguous(error)) {
        evidence.push(readFailureEvidence(error, "create_shell_reconciliation"));
      }
    }
    if (!boundary.signal?.aborted && clock() < boundary.deadlineMs) {
      try {
        const received = (await client.getThread(ref.threadId, boundary)) ?? null;
        if (clock() <= boundary.deadlineMs) detail = received;
      } catch (error) {
        if (!isAmbiguous(error)) {
          evidence.push(readFailureEvidence(error, "create_detail_reconciliation"));
        }
      }
    }
    const shellThread = shell?.threads.find((entry) => entry.id === ref.threadId) ?? null;
    if (shellThread !== null && !sameThreadIdentity(shellThread, input, ref.threadId, projectId)) {
      return {
        shell,
        detail,
        projectionState: "identity_unverified",
        conflict: { source: "shell", threadId: ref.threadId },
        evidence,
      };
    }
    if (detail !== null && !sameThreadIdentity(detail.thread, input, ref.threadId, projectId)) {
      return {
        shell,
        detail,
        projectionState: "identity_unverified",
        conflict: { source: "detail", threadId: ref.threadId },
        evidence,
      };
    }
    const required = minimumSequence ?? 0;
    const shellReady = shellThread !== null && shell!.snapshotSequence >= required;
    const detailReady = detail !== null && detail.snapshotSequence >= required;
    return {
      shell,
      detail,
      projectionState:
        shellReady && detailReady
          ? "identity_unverified"
          : shellReady
            ? "shell_only"
            : detailReady
              ? "detail_only"
              : shellThread !== null || detail !== null
                ? "below_required_sequence"
                : "unobserved",
      conflict: null,
      evidence,
    };
  }

  function reconciled(
    observation: ReconciliationObservation,
    threadId: string,
    minimumSequence: number | null,
  ): ThreadCreateReceipt | null {
    const shellThread = observation.shell?.threads.find((entry) => entry.id === threadId);
    if (shellThread === undefined || observation.detail === null) return null;
    const required = minimumSequence ?? 0;
    if (
      observation.shell!.snapshotSequence < required ||
      observation.detail.snapshotSequence < required
    ) {
      return null;
    }
    return {
      commandId: "",
      threadId,
      acceptedSequence: minimumSequence,
      observedSequence: Math.max(
        observation.shell!.snapshotSequence,
        observation.detail.snapshotSequence,
      ),
      recovered: minimumSequence === null,
    };
  }

  async function reconcileCreate(
    ref: AgentRef,
    projectId: string,
    input: StockSpawnInput,
    attempt: CreateAttemptReceipt,
    operation: RuntimeOperationOptions & { readonly deadlineMs: number },
  ): Promise<
    | { readonly kind: "reconciled"; readonly receipt: ThreadCreateReceipt; readonly detail: ThreadDetailSnapshot }
    | { readonly kind: "pending"; readonly observation: ReconciliationObservation }
    | { readonly kind: "conflict"; readonly observation: ReconciliationObservation }
  > {
    const deadlineMs = operation.deadlineMs;
    const reads = Math.max(1, operation.maxReconciliationReads ?? 4);
    let last: ReconciliationObservation = {
      shell: null,
      detail: null,
      projectionState: "unobserved",
      conflict: null,
    };
    for (let index = 0; index < reads; index += 1) {
      if (operation.signal?.aborted || clock() >= deadlineMs) {
        return { kind: "pending", observation: last };
      }
      last = await observeReconciliation(ref, projectId, input, attempt.acceptedSequence, {
        deadlineMs,
        signal: operation.signal,
      });
      if (last.conflict !== null) return { kind: "conflict", observation: last };
      const receipt = reconciled(last, ref.threadId, attempt.acceptedSequence);
      if (receipt !== null && last.detail !== null && clock() <= deadlineMs) {
        return {
          kind: "reconciled",
          receipt: { ...receipt, commandId: attempt.commandId },
          detail: last.detail,
        };
      }
      if (clock() >= deadlineMs) break;
    }
    return { kind: "pending", observation: last };
  }

  function makeLease(
    ref: AgentRef,
    slotClaim: TurnSlotClaim,
    commandId: string,
    messageId: string,
    acceptedSequence: number | null,
    observedSequence: number,
    inputText: string,
    preflight: ThreadDetailSnapshot,
    deadlineMs: number,
    leaseId = id(),
  ): TurnReceipt {
    if (deadlineMs <= clock()) throw new StockRuntimeError("timeout");
    if (slotClaim.generation !== environmentLeaseGeneration(ref.environmentId)) {
      throw new StockRuntimeError("environment_changed", { threadId: ref.threadId });
    }
    const key = scopedThreadKey(ref);
    const claim = turnSlotClaims.get(key);
    if (claim?.token !== slotClaim.token || claim.expiresAt <= clock()) {
      throw new StockRuntimeError("send_in_progress", { threadId: ref.threadId });
    }
    const baselineUserIds = userMessages(preflight).map((entry) => entry.id);
    if (
      baselineUserIds.length > MAX_BASELINE_IDS ||
      new TextEncoder().encode(JSON.stringify(baselineUserIds)).byteLength > MAX_BASELINE_BYTES
    ) {
      throw new StockRuntimeError("correlation_capacity");
    }
    const receipt: TurnReceipt = {
      agentRef: ref,
      leaseId,
      commandId,
      messageId,
      acceptedSequence,
      observedSequence,
      leaseExpiresAt: deadlineMs,
      leaseState: "active",
    };
    turnSlotClaims.delete(key);
    leases.set(key, {
      receipt,
      slotToken: slotClaim.token,
      baselineUserIds,
      preflightLatestTurnId: preflight.thread.latestTurn?.turnId ?? null,
      expectedInputDigest: digestSync({ text: inputText, attachments: [] }),
      boundTurnId: null,
    });
    const delay = Math.max(0, Math.min(2_147_483_647, deadlineMs - clock()));
    const timer = setTimeout(() => releaseLease(ref, leaseId), delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    leaseTimers.set(key, timer);
    return receipt;
  }

  function classifyTargetProjection(
    detail: ThreadDetailSnapshot,
    state: LeaseState,
  ): TargetProjection {
    const observedUsers = userMessages(detail);
    if (observedUsers.length < state.baselineUserIds.length) {
      return { kind: "concurrent_writer", detail };
    }
    for (let index = 0; index < state.baselineUserIds.length; index += 1) {
      if (observedUsers[index]?.id !== state.baselineUserIds[index]) {
        return { kind: "concurrent_writer", detail };
      }
    }
    const post = observedUsers.slice(state.baselineUserIds.length);
    const targetIndex = post.findIndex(
      (entry) => entry.id === state.receipt.messageId,
    );
    if (targetIndex === -1) {
      return post.length === 0
        ? { kind: "absent", detail }
        : post.length === 1
          ? { kind: "superseded", detail }
          : { kind: "concurrent_writer", detail };
    }
    if (targetIndex > 0) return { kind: "superseded", detail };
    if (post.length > 1) return { kind: "concurrent_writer", detail };
    const target = post[0]!;
    if (
      digestSync({ text: target.text, attachments: target.attachments }) !==
      state.expectedInputDigest
    ) {
      return { kind: "causality_unverifiable", detail };
    }
    return { kind: "target", detail };
  }

  async function reconcileTarget(
    ref: AgentRef,
    operation: RuntimeOperationOptions & { readonly deadlineMs: number },
    maximumReads: number,
  ): Promise<TargetProjection> {
    let last: TargetProjection = { kind: "absent" };
    for (let index = 0; index < Math.max(1, maximumReads); index += 1) {
      if (stopCode(operation) !== null) return last;
      let detail: ThreadDetailSnapshot | undefined;
      try {
        detail = await client.getThread(ref.threadId, {
          deadlineMs: operation.deadlineMs,
          signal: operation.signal,
        });
      } catch (error) {
        if (!isAmbiguous(error)) {
          last = {
            ...last,
            evidence: [
              ...(last.evidence ?? []),
              readFailureEvidence(error, "target_reconciliation"),
            ],
          };
        }
        continue;
      }
      if (clock() >= operation.deadlineMs) return last;
      if (detail === undefined) continue;
      const state = leases.get(scopedThreadKey(ref));
      if (state === undefined) return last;
      const classified = classifyTargetProjection(detail, state);
      last = { ...classified, evidence: last.evidence };
      if (last.kind !== "absent") return last;
    }
    return last;
  }

  function boundedUtf8(value: string): {
    readonly text: string;
    readonly truncated: boolean;
    readonly originalBytes: number;
    readonly retainedBytes: number;
  } {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(value);
    if (bytes.byteLength <= MAX_EVIDENCE_BYTES) {
      return {
        text: value,
        truncated: false,
        originalBytes: bytes.byteLength,
        retainedBytes: bytes.byteLength,
      };
    }
    let end = MAX_EVIDENCE_BYTES;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (end > 0) {
      try {
        const text = decoder.decode(bytes.subarray(0, end));
        return {
          text,
          truncated: true,
          originalBytes: bytes.byteLength,
          retainedBytes: end,
        };
      } catch {
        end -= 1;
      }
    }
    return {
      text: "",
      truncated: true,
      originalBytes: bytes.byteLength,
      retainedBytes: 0,
    };
  }

  async function continueInitialTurn(
    ref: AgentRef,
    slotClaim: TurnSlotClaim,
    input: StockSpawnInput,
    createReceipt: ThreadCreateReceipt,
    continuation: CreateReconciliationPending["initialTurnContinuation"],
    preflight: ThreadDetailSnapshot,
    operation: RuntimeOperationOptions & { readonly deadlineMs: number },
  ): Promise<SpawnResult> {
    const partial = (
      state:
        | "not_attempted"
        | "initial_turn_rejected"
        | "initial_turn_accepted_projection_pending"
        | "initial_turn_outcome_unknown"
        | "contended_before_start"
        | "superseded"
        | "concurrent_writer"
        | "causality_unverifiable"
        | "cancelled"
        | "deadline_exhausted",
      leaseExpiresAt: number | null,
      safeAction: "new_send" | "wait" | "observe",
      evidence: readonly Readonly<Record<string, unknown>>[] = [],
      turnReceipt: TurnReceipt | null = null,
    ): SpawnResult => ({
      kind: "partial",
      agentRef: ref,
      createReceipt,
      initialTurn: {
        commandId: continuation.commandId,
        messageId: continuation.messageId,
        state,
        turnReceipt,
        leaseExpiresAt,
        safeAction,
        evidence,
      },
    });
    if (
      userMessages(preflight).length !== 0 ||
      preflight.thread.latestTurn !== null ||
      (preflight.thread.session !== null && preflight.thread.session.status !== "idle")
    ) {
      return partial("contended_before_start", null, "observe");
    }
    const stopped = stopCode(operation);
    if (stopped !== null) {
      return partial(
        stopped === "cancelled" ? "cancelled" : "deadline_exhausted",
        null,
        "observe",
      );
    }
    const deadlineMs = operation.deadlineMs;
    let lease: TurnReceipt;
    try {
      lease = makeLease(
        ref,
        slotClaim,
        continuation.commandId,
        continuation.messageId,
        null,
        preflight.snapshotSequence,
        input.message,
        preflight,
        deadlineMs,
      );
    } catch (error) {
      if (error instanceof StockRuntimeError) {
        if (error.code === "timeout") {
          return partial("deadline_exhausted", null, "observe");
        }
        if (error.code === "environment_changed") {
          return partial("not_attempted", null, "observe", [
            { stage: "lease_promotion", class: "environment_changed" },
          ]);
        }
        if (error.code === "send_in_progress") {
          return partial("contended_before_start", null, "observe", [
            { stage: "lease_promotion", class: "send_in_progress" },
          ]);
        }
        if (error.code === "correlation_capacity") {
          return partial("not_attempted", null, "observe", [
            { stage: "lease_promotion", class: "correlation_capacity" },
          ]);
        }
      }
      return partial("not_attempted", null, "observe", [
        { stage: "lease_promotion", class: mapReceivedError(error).code },
      ]);
    }
    const command = {
      type: "thread.turn.start",
      commandId: continuation.commandId,
      threadId: ref.threadId,
      message: {
        messageId: continuation.messageId,
        role: "user",
        text: input.message,
        attachments: [],
      },
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: now(),
    };
    let acceptedSequence: number | null = null;
    let ambiguous = false;
    try {
      acceptedSequence = (await client.dispatch(command, { deadlineMs, signal: operation.signal })).sequence;
      poller.dispatchObserved(ref.environmentId);
    } catch (error) {
      const failure = classifyDispatchFailure(error, operation);
      if (failure.kind !== "ambiguous") {
        const terminalReceipt = releaseLeaseAndSnapshot({ ...lease, acceptedSequence });
        if (failure.kind === "cancelled" || failure.kind === "timeout") {
          return partial(
            failure.kind === "cancelled" ? "cancelled" : "deadline_exhausted",
            null,
            "observe",
            [{ stage: "initial_turn_dispatch", class: failure.kind }],
            terminalReceipt,
          );
        }
        return partial(
          "initial_turn_rejected",
          null,
          "new_send",
          [{ stage: "initial_turn_dispatch", class: failure.error.code }],
          terminalReceipt,
        );
      }
      ambiguous = true;
    }

    const updateReceipt = (
      projection: TargetProjection,
    ): { readonly receipt: TurnReceipt; readonly retained: boolean } => {
      const updated: TurnReceipt = {
        ...lease,
        acceptedSequence,
        observedSequence: projection.detail?.snapshotSequence ?? lease.observedSequence,
        ...((projection.evidence?.length ?? 0) === 0
          ? {}
          : { reconciliationEvidence: projection.evidence }),
      };
      return {
        receipt: updated,
        retained: updateLeaseReceipt(ref, slotClaim.token, updated),
      };
    };
    const classifyProjection = (projection: TargetProjection): SpawnResult | null => {
      if (projection.kind === "target") {
        const updated = updateReceipt(projection);
        return {
          kind: "spawned",
          agentRef: ref,
          createReceipt,
          turnReceipt: updated.receipt,
        };
      }
      if (
        projection.kind === "superseded" ||
        projection.kind === "concurrent_writer" ||
        projection.kind === "causality_unverifiable"
      ) {
        const updated = updateReceipt(projection);
        const terminalReceipt = releaseLeaseAndSnapshot(updated.receipt);
        return partial(
          projection.kind,
          null,
          "observe",
          [{ reason: projection.kind }, ...(projection.evidence ?? [])],
          terminalReceipt,
        );
      }
      return null;
    };

    const firstProjection = await reconcileTarget(
      ref,
      operation,
      ambiguous ? 1 : operation.maxReconciliationReads ?? 4,
    );
    const firstResult = classifyProjection(firstProjection);
    if (firstResult !== null) return firstResult;

    const afterObservationStop = stopCode(operation);
    if (acceptedSequence !== null) {
      if (afterObservationStop !== null) {
        const terminalReceipt = releaseLeaseAndSnapshot({ ...lease, acceptedSequence });
        return partial(
          "initial_turn_accepted_projection_pending",
          null,
          "observe",
          [{ acceptedSequence }, ...(firstProjection.evidence ?? [])],
          terminalReceipt,
        );
      }
      const updated = updateReceipt(firstProjection);
      if (!updated.retained) {
        const terminalReceipt = releaseLeaseAndSnapshot(updated.receipt);
        return partial(
          "initial_turn_accepted_projection_pending",
          null,
          "observe",
          [{ acceptedSequence }, ...(firstProjection.evidence ?? [])],
          terminalReceipt,
        );
      }
      return partial(
        "initial_turn_accepted_projection_pending",
        updated.receipt.leaseExpiresAt,
        "wait",
        [{ acceptedSequence }, ...(firstProjection.evidence ?? [])],
        updated.receipt,
      );
    }
    if (afterObservationStop !== null) {
      const terminalReceipt = releaseLeaseAndSnapshot({ ...lease, acceptedSequence });
      return partial(
        afterObservationStop === "cancelled" ? "cancelled" : "deadline_exhausted",
        null,
        "observe",
        firstProjection.evidence ?? [],
        terminalReceipt,
      );
    }

    let retryEvidence: Readonly<Record<string, unknown>> | null = null;
    try {
      const retry = await client.dispatch(command, {
        deadlineMs,
        signal: operation.signal,
      });
      acceptedSequence = retry.sequence;
      poller.dispatchObserved(ref.environmentId);
    } catch (error) {
      const failure = classifyDispatchFailure(error, operation);
      if (failure.kind === "cancelled" || failure.kind === "timeout") {
        const terminalReceipt = releaseLeaseAndSnapshot({ ...lease, acceptedSequence });
        return partial(
          failure.kind === "cancelled" ? "cancelled" : "deadline_exhausted",
          null,
          "observe",
          [{ stage: "identical_retry", class: failure.kind }],
          terminalReceipt,
        );
      }
      if (failure.kind === "received") {
        retryEvidence = { retryClass: failure.error.code };
      }
    }

    const secondProjection = await reconcileTarget(
      ref,
      operation,
      operation.maxReconciliationReads ?? 4,
    );
    const secondResult = classifyProjection(secondProjection);
    if (secondResult !== null) return secondResult;
    const evidence = [
      ...(acceptedSequence === null ? [] : [{ acceptedSequence }]),
      ...(retryEvidence === null ? [] : [retryEvidence]),
      ...(secondProjection.evidence ?? []),
    ];
    const afterRetryObservationStop = stopCode(operation);
    if (afterRetryObservationStop !== null) {
      const terminalReceipt = releaseLeaseAndSnapshot({ ...lease, acceptedSequence });
      return partial(
        acceptedSequence === null
          ? "initial_turn_outcome_unknown"
          : "initial_turn_accepted_projection_pending",
        null,
        "observe",
        evidence,
        terminalReceipt,
      );
    }
    const updated = updateReceipt(secondProjection);
    if (!updated.retained) {
      const terminalReceipt = releaseLeaseAndSnapshot(updated.receipt);
      return partial(
        acceptedSequence === null
          ? "initial_turn_outcome_unknown"
          : "initial_turn_accepted_projection_pending",
        null,
        "observe",
        evidence,
        terminalReceipt,
      );
    }
    return partial(
      acceptedSequence === null
        ? "initial_turn_outcome_unknown"
        : "initial_turn_accepted_projection_pending",
      updated.receipt.leaseExpiresAt,
      "wait",
      evidence,
      updated.receipt,
    );
  }

  function freshPreflightPartial(
    ref: AgentRef,
    createReceipt: ThreadCreateReceipt,
    continuation: CreateReconciliationPending["initialTurnContinuation"],
    state: "not_attempted" | "contended_before_start" | "cancelled" | "deadline_exhausted",
    evidence: readonly Readonly<Record<string, unknown>>[] = [],
  ): SpawnResult {
    return {
      kind: "partial",
      agentRef: ref,
      createReceipt,
      initialTurn: {
        commandId: continuation.commandId,
        messageId: continuation.messageId,
        state,
        turnReceipt: null,
        leaseExpiresAt: null,
        safeAction: "observe",
        evidence,
      },
    };
  }

  async function continueAfterFreshPreflight(
    ref: AgentRef,
    input: StockSpawnInput,
    createReceipt: ThreadCreateReceipt,
    continuation: CreateReconciliationPending["initialTurnContinuation"],
    operation: RuntimeOperationOptions & { readonly deadlineMs: number },
  ): Promise<SpawnResult> {
    const stopped = stopCode(operation);
    if (stopped !== null) {
      return freshPreflightPartial(
        ref,
        createReceipt,
        continuation,
        stopped === "cancelled" ? "cancelled" : "deadline_exhausted",
      );
    }
    let slotClaim: TurnSlotClaim;
    try {
      slotClaim = claimTurnSlot(ref, operation.deadlineMs);
    } catch (error) {
      if (error instanceof StockRuntimeError && error.code === "send_in_progress") {
        return freshPreflightPartial(
          ref,
          createReceipt,
          continuation,
          "contended_before_start",
          [{ reason: "send_in_progress" }],
        );
      }
      if (error instanceof StockRuntimeError && error.code === "timeout") {
        return freshPreflightPartial(
          ref,
          createReceipt,
          continuation,
          "deadline_exhausted",
        );
      }
      return freshPreflightPartial(ref, createReceipt, continuation, "not_attempted", [
        { stage: "slot_claim", class: mapReceivedError(error).code },
      ]);
    }
    let retainSlot = false;
    try {
      let fresh: ThreadDetailSnapshot | undefined;
      try {
        fresh = await client.getThread(ref.threadId, {
          deadlineMs: operation.deadlineMs,
          signal: operation.signal,
        });
      } catch (error) {
        const stoppedAfterRead = stopCode(operation);
        if (stoppedAfterRead !== null) {
          return freshPreflightPartial(
            ref,
            createReceipt,
            continuation,
            stoppedAfterRead === "cancelled" ? "cancelled" : "deadline_exhausted",
          );
        }
        return freshPreflightPartial(ref, createReceipt, continuation, "not_attempted", [
          { stage: "fresh_preflight", class: mapReceivedError(error).code },
        ]);
      }
      if (fresh === undefined) {
        return freshPreflightPartial(ref, createReceipt, continuation, "not_attempted", [
          { stage: "fresh_preflight", class: "not_found" },
        ]);
      }
      const result = await continueInitialTurn(
        ref,
        slotClaim,
        input,
        createReceipt,
        continuation,
        fresh,
        operation,
      );
      retainSlot =
        result.kind === "spawned" ||
        (result.kind === "partial" &&
          result.initialTurn.turnReceipt?.leaseState === "active");
      return result;
    } finally {
      if (!retainSlot) releaseTurnSlot(ref, slotClaim.token);
    }
  }

  async function resolveProject(
    input: StockSpawnInput,
    operation: RuntimeOperationOptions & { readonly deadlineMs: number },
    environmentId: string,
    platform: EnvironmentDescriptor["platform"]["os"],
  ): Promise<string> {
    const deadlineMs = operation.deadlineMs;
    const identity = input.projectCreateIdentity;
    if (
      identity !== undefined &&
      identity.environmentId !== undefined &&
      identity.environmentId !== environmentId
    ) {
      throw new StockRuntimeError("environment_changed", {
        expectedEnvironmentId: identity.environmentId,
        actualEnvironmentId: environmentId,
        provisionalProjectId: identity.projectId,
      });
    }
    const workspaceMatches = (value: string): boolean =>
      workspaceComparisonKey(value, { platform: platform === "unknown" ? undefined : platform }) ===
      workspaceComparisonKey(input.workspaceRoot, { platform: platform === "unknown" ? undefined : platform });
    let attempt: ProjectCreateAttemptState | undefined =
      identity === undefined
        ? undefined
        : {
            environmentId,
            workspaceRoot: input.workspaceRoot,
            projectId: identity.projectId,
            commandId: identity.commandId,
            command: {
              type: "project.create",
              commandId: identity.commandId,
              projectId: identity.projectId,
              title: identity.title,
              workspaceRoot: identity.workspaceRoot,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: identity.defaultModelSelection,
              createdAt: identity.createdAt,
            },
            acceptedSequence: null,
            dispatchState: "outcome_unknown",
            retryState: "eligible_not_sent",
            retryClass: null,
            readEvidence: [],
          };

    const recordReadFailure = (
      currentAttempt: ProjectCreateAttemptState,
      error: unknown,
    ): void => {
      currentAttempt.readEvidence.push(
        readFailureEvidence(error, "project_create_reconciliation"),
      );
      if (currentAttempt.readEvidence.length > 8) currentAttempt.readEvidence.shift();
    };
    const attemptEvidence = (currentAttempt: ProjectCreateAttemptState) => ({
      provisionalProjectId: currentAttempt.projectId,
      acceptedSequence: currentAttempt.acceptedSequence,
      projectAttempt: {
        environmentId: currentAttempt.environmentId,
        commandId: currentAttempt.commandId,
        projectId: currentAttempt.projectId,
        createdAt: currentAttempt.command.createdAt,
        workspaceRoot: currentAttempt.command.workspaceRoot,
        title: currentAttempt.command.title,
        defaultModelSelection: currentAttempt.command.defaultModelSelection,
        acceptedSequence: currentAttempt.acceptedSequence,
        dispatchState: currentAttempt.dispatchState,
        retryState: currentAttempt.retryState,
        retryClass: currentAttempt.retryClass,
      },
      readEvidence: currentAttempt.readEvidence.map((entry) => ({ ...entry })),
    });
    const attemptError = (
      currentAttempt: ProjectCreateAttemptState,
      code: StockRuntimeErrorCode,
      reason: string,
      extra: Readonly<Record<string, unknown>> = {},
    ) =>
      new StockRuntimeError(code, {
        reason,
        ...attemptEvidence(currentAttempt),
        ...extra,
      });

    let current: ShellSnapshot;
    try {
      current = await client.getShell({ deadlineMs, signal: operation.signal });
    } catch (error) {
      if (attempt === undefined) throw mapReceivedError(error);
      if (!isAmbiguous(error)) recordReadFailure(attempt, error);
      const stopped = stopCode(operation);
      throw attemptError(
        attempt,
        stopped ?? "transport_unavailable",
        stopped === "cancelled"
          ? "project_reconciliation_cancelled"
          : stopped === "timeout"
            ? "project_reconciliation_deadline_exhausted"
            : "project_projection_pending",
      );
    }
    if (input.projectId !== undefined) {
      const exact = current.projects.find((entry) => entry.id === input.projectId);
      if (exact !== undefined) {
        if (!workspaceMatches(exact.workspaceRoot)) {
          throw new StockRuntimeError("identity_conflict", {
            reason: "project_workspace_mismatch",
            projectId: input.projectId,
          });
        }
        return exact.id;
      }
      if (attempt === undefined) {
        throw new StockRuntimeError("identity_conflict", {
          reason: "project_not_found",
          projectId: input.projectId,
        });
      }
    }
    const matches = current.projects.filter((entry) => workspaceMatches(entry.workspaceRoot));
    if (matches.length > 1) {
      if (attempt !== undefined) {
        throw attemptError(attempt, "identity_conflict", "multiple_workspace_projects", {
          workspaceRoot: input.workspaceRoot,
        });
      }
      throw new StockRuntimeError("identity_conflict", { workspaceRoot: input.workspaceRoot });
    }
    if (matches[0] !== undefined) {
      if (attempt !== undefined && matches[0].id !== attempt.projectId) {
        throw attemptError(attempt, "identity_conflict", "workspace_project_changed", {
          actualProjectId: matches[0].id,
        });
      }
      return matches[0].id;
    }
    const stopped = stopCode(operation);
    if (stopped !== null) {
      if (attempt !== undefined) {
        throw attemptError(
          attempt,
          stopped,
          stopped === "cancelled"
            ? "project_reconciliation_cancelled"
            : "project_reconciliation_deadline_exhausted",
        );
      }
      throw new StockRuntimeError(stopped);
    }

    if (attempt === undefined) {
      throw new StockRuntimeError("identity_conflict", {
        reason: "project_create_identity_required",
        workspaceRoot: input.workspaceRoot,
      });
    }

    const reconcile = async (currentAttempt: ProjectCreateAttemptState): Promise<boolean> => {
      const reads = Math.max(1, operation.maxReconciliationReads ?? 4);
      let lastObservedSequence: number | null = null;
      for (let index = 0; index < reads; index += 1) {
        if (stopCode(operation) !== null) return false;
        let observed: ShellSnapshot;
        try {
          observed = await client.getShell({
            deadlineMs,
            signal: operation.signal,
          });
        } catch (error) {
          if (stopCode(operation) !== null) return false;
          if (!isAmbiguous(error)) recordReadFailure(currentAttempt, error);
          continue;
        }
        if (
          lastObservedSequence !== null &&
          observed.snapshotSequence < lastObservedSequence
        ) {
          throw attemptError(currentAttempt, "protocol_mismatch", "shell_sequence_regression");
        }
        lastObservedSequence = observed.snapshotSequence;
        const byId = observed.projects.find((entry) => entry.id === currentAttempt.projectId);
        if (byId !== undefined) {
          if (!workspaceMatches(byId.workspaceRoot)) {
            throw attemptError(currentAttempt, "identity_conflict", "project_identity_changed", {
              source: "project_create_reconciliation",
            });
          }
          if (
            currentAttempt.acceptedSequence !== null &&
            observed.snapshotSequence < currentAttempt.acceptedSequence
          ) {
            continue;
          }
          return true;
        }
        const byRoot = observed.projects.filter(
          (entry) => workspaceMatches(entry.workspaceRoot),
        );
        if (byRoot.length > 0) {
          throw attemptError(currentAttempt, "identity_conflict", "workspace_project_changed", {
            source: "project_create_reconciliation",
          });
        }
      }
      return false;
    };

    let originalWasAmbiguous = false;
    try {
      attempt.acceptedSequence = (
        await client.dispatch(attempt.command, { deadlineMs, signal: operation.signal })
      ).sequence;
      attempt.dispatchState = "accepted";
      attempt.retryState = "not_applicable";
    } catch (error) {
      const failure = classifyDispatchFailure(error, operation);
      if (failure.kind === "received") {
        throw attemptError(
          attempt,
          failure.error.code,
          "project_create_received_error",
          failure.error.evidence,
        );
      }
      if (failure.kind === "cancelled" || failure.kind === "timeout") {
        throw attemptError(
          attempt,
          failure.kind,
          failure.kind === "cancelled"
            ? "project_reconciliation_cancelled"
            : "project_reconciliation_deadline_exhausted",
        );
      }
      originalWasAmbiguous = true;
    }
    if (await reconcile(attempt)) {
      return attempt.projectId;
    }
    const stoppedAfterReconcile = stopCode(operation);
    if (stoppedAfterReconcile !== null) {
      throw attemptError(
        attempt,
        stoppedAfterReconcile,
        stoppedAfterReconcile === "cancelled"
          ? "project_reconciliation_cancelled"
          : "project_reconciliation_deadline_exhausted",
      );
    }
    if (!originalWasAmbiguous) {
      throw attemptError(attempt, "transport_unavailable", "project_projection_pending");
    }

    try {
      attempt.acceptedSequence = (
        await client.dispatch(attempt.command, { deadlineMs, signal: operation.signal })
      ).sequence;
      attempt.dispatchState = "accepted";
      attempt.retryState = "identical_retry_accepted";
    } catch (error) {
      const failure = classifyDispatchFailure(error, operation);
      if (failure.kind === "cancelled" || failure.kind === "timeout") {
        attempt.retryState = "identical_retry_sent_no_response";
        throw attemptError(
          attempt,
          failure.kind,
          failure.kind === "cancelled"
            ? "project_reconciliation_cancelled"
            : "project_reconciliation_deadline_exhausted",
        );
      }
      if (failure.kind === "received") {
        attempt.retryState = "identical_retry_received_error";
        attempt.retryClass = failure.error.code;
      } else {
        attempt.retryState = "identical_retry_sent_no_response";
      }
    }
    if (await reconcile(attempt)) {
      return attempt.projectId;
    }
    throw attemptError(attempt, "transport_unavailable", "project_create_outcome_unknown");
  }

  async function spawn(input: StockSpawnInput, operation: RuntimeOperationOptions = {}): Promise<SpawnResult> {
    const bounded = boundedOperation(operation);
    const initialStop = stopCode(bounded);
    if (initialStop !== null) throw new StockRuntimeError(initialStop);
    const environment = await descriptor({ deadlineMs: bounded.deadlineMs, signal: bounded.signal });
    input = canonicalizeSpawnInput(input, environment.platform.os);
    const projectId = await resolveProject(
      input,
      bounded,
      environment.environmentId,
      environment.platform.os,
    );
    const createCommandId = id();
    const threadId = id();
    const turnCommandId = id();
    const messageId = id();
    const ref = { environmentId: environment.environmentId, threadId };
    const continuation = {
      commandId: turnCommandId,
      messageId,
      inputDigest: await digestStockSpawnInput(input),
    };
    const deadlineMs = bounded.deadlineMs;
    const createCommand = {
      type: "thread.create",
      commandId: createCommandId,
      threadId,
      projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
      createdAt: now(),
    };
    const beforeCreateStop = stopCode(bounded);
    if (beforeCreateStop !== null) throw new StockRuntimeError(beforeCreateStop);
    let attempt: CreateAttemptReceipt;
    try {
      const accepted = await client.dispatch(createCommand, { deadlineMs, signal: operation.signal });
      poller.dispatchObserved(ref.environmentId);
      attempt = {
        commandId: createCommandId,
        threadId,
        projectId,
        acceptedSequence: accepted.sequence,
        dispatchState: "accepted",
        retryState: "not_applicable",
        retryError: null,
      };
    } catch (error) {
      const failure = classifyDispatchFailure(error, bounded);
      if (failure.kind === "received") throw failure.error;
      attempt = {
        commandId: createCommandId,
        threadId,
        projectId,
        acceptedSequence: null,
        dispatchState: "outcome_unknown",
        retryState: "eligible_not_sent",
        retryError: null,
      };
      if (failure.kind === "cancelled" || failure.kind === "timeout") {
        return pending(
          ref,
          attempt,
          continuation,
          failure.kind === "cancelled" ? "cancelled" : "deadline_exhausted",
          { shell: null, detail: null, projectionState: "unobserved", conflict: null },
          deadlineMs,
        );
      }
      const beforeRetry = await reconcileCreate(ref, projectId, input, attempt, bounded);
      if (beforeRetry.kind === "conflict") {
        return { kind: "create_protocol_failure", provisionalRef: ref, createAttempt: attempt, conflict: beforeRetry.observation.conflict ?? {} };
      }
      if (beforeRetry.kind === "reconciled") {
        return continueAfterFreshPreflight(
          ref,
          input,
          beforeRetry.receipt,
          continuation,
          bounded,
        );
      }
      const beforeRetryStop = stopCode(bounded);
      if (beforeRetryStop !== null) {
        return pending(
          ref,
          attempt,
          continuation,
          beforeRetryStop === "cancelled" ? "cancelled" : "deadline_exhausted",
          beforeRetry.observation,
          deadlineMs,
        );
      }
      try {
        const retry = await client.dispatch(createCommand, { deadlineMs, signal: bounded.signal });
        poller.dispatchObserved(ref.environmentId);
        attempt = {
          ...attempt,
          acceptedSequence: retry.sequence,
          dispatchState: "accepted",
          retryState: "identical_retry_accepted",
        };
      } catch (retryError) {
        const retryFailure = classifyDispatchFailure(retryError, bounded);
        if (
          retryFailure.kind === "ambiguous" ||
          retryFailure.kind === "cancelled" ||
          retryFailure.kind === "timeout"
        ) {
          attempt = { ...attempt, retryState: "identical_retry_sent_no_response" };
          if (retryFailure.kind === "cancelled" || retryFailure.kind === "timeout") {
            return pending(
              ref,
              attempt,
              continuation,
              retryFailure.kind === "cancelled" ? "cancelled" : "deadline_exhausted",
              beforeRetry.observation,
              deadlineMs,
            );
          }
        } else if (retryError instanceof StockT3HttpError) {
          const sanitized = sanitizeRetry(retryError);
          if (sanitized !== null) {
            attempt = {
              ...attempt,
              retryState: "identical_retry_received_error",
              retryError: sanitized,
            };
            return pending(
              ref,
              attempt,
              continuation,
              "retry_error_after_ambiguous_original",
              beforeRetry.observation,
              deadlineMs,
            );
          }
          if (retryFailure.error.code === "protocol_mismatch") {
            return {
              kind: "create_protocol_failure",
              provisionalRef: ref,
              createAttempt: attempt,
              conflict: { stage: "identical_retry", class: "protocol_mismatch" },
            };
          }
          return pending(ref, attempt, continuation, "transport_exhausted", beforeRetry.observation, deadlineMs);
        } else {
          return pending(ref, attempt, continuation, "transport_exhausted", beforeRetry.observation, deadlineMs);
        }
      }
    }
    const result = await reconcileCreate(ref, projectId, input, attempt, bounded);
    if (result.kind === "conflict") {
      return { kind: "create_protocol_failure", provisionalRef: ref, createAttempt: attempt, conflict: result.observation.conflict ?? {} };
    }
    if (result.kind === "pending") {
      return pending(
        ref,
        attempt,
        continuation,
        bounded.signal?.aborted
          ? "cancelled"
          : clock() >= deadlineMs
            ? "deadline_exhausted"
            : (result.observation.evidence?.length ?? 0) > 0
              ? "transport_exhausted"
            : attempt.retryState === "identical_retry_sent_no_response"
              ? "transport_exhausted"
              : "projection_pending",
        result.observation,
        deadlineMs,
      );
    }
    return continueAfterFreshPreflight(
      ref,
      input,
      result.receipt,
      continuation,
      bounded,
    );
  }

  async function resumeCreateReconciliation(
    pendingResult: CreateReconciliationPending,
    input: StockSpawnInput,
    operation: RuntimeOperationOptions = {},
  ): Promise<SpawnResult> {
    const bounded = boundedOperation(operation);
    const resumeStop = stopCode(bounded);
    if (resumeStop !== null) {
      return pending(
        pendingResult.provisionalRef,
        pendingResult.createAttempt,
        pendingResult.initialTurnContinuation,
        resumeStop === "cancelled" ? "cancelled" : "deadline_exhausted",
        {
          shell: null,
          detail: null,
          projectionState: pendingResult.reconciliation.projectionState,
          conflict: null,
        },
        bounded.deadlineMs,
      );
    }
    let environment: EnvironmentDescriptor;
    try {
      environment = await descriptor({
        deadlineMs: bounded.deadlineMs,
        signal: bounded.signal,
      });
    } catch (error) {
      const stoppedAfterDescriptor = stopCode(bounded);
      return pending(
        pendingResult.provisionalRef,
        pendingResult.createAttempt,
        pendingResult.initialTurnContinuation,
        stoppedAfterDescriptor === "cancelled"
          ? "cancelled"
          : stoppedAfterDescriptor === "timeout"
            ? "deadline_exhausted"
            : "transport_exhausted",
        {
          shell: null,
          detail: null,
          projectionState: pendingResult.reconciliation.projectionState,
          conflict: null,
          evidence: [readFailureEvidence(error, "resume_descriptor")],
        },
        bounded.deadlineMs,
      );
    }
    if (environment.environmentId !== pendingResult.provisionalRef.environmentId) {
      return pending(
        pendingResult.provisionalRef,
        pendingResult.createAttempt,
        pendingResult.initialTurnContinuation,
        "transport_exhausted",
        {
          shell: null,
          detail: null,
          projectionState: pendingResult.reconciliation.projectionState,
          conflict: null,
          evidence: [{
            stage: "resume_descriptor",
            class: "environment_changed",
            expectedEnvironmentId: pendingResult.provisionalRef.environmentId,
            actualEnvironmentId: environment.environmentId,
          }],
        },
        bounded.deadlineMs,
      );
    }
    input = canonicalizeSpawnInput(input, environment.platform.os);
    if ((await digestStockSpawnInput(input)) !== pendingResult.initialTurnContinuation.inputDigest) {
      throw new StockRuntimeError("identity_conflict", {
        reason: "input_digest_mismatch",
        provisionalRef: pendingResult.provisionalRef,
        createAttempt: pendingResult.createAttempt,
      });
    }
    const result = await reconcileCreate(
      pendingResult.provisionalRef,
      pendingResult.createAttempt.projectId,
      input,
      pendingResult.createAttempt,
      bounded,
    );
    if (result.kind === "conflict") {
      return {
        kind: "create_protocol_failure",
        provisionalRef: pendingResult.provisionalRef,
        createAttempt: pendingResult.createAttempt,
        conflict: result.observation.conflict ?? {},
      };
    }
    if (result.kind === "pending") {
      return pending(
        pendingResult.provisionalRef,
        pendingResult.createAttempt,
        pendingResult.initialTurnContinuation,
        bounded.signal?.aborted
          ? "cancelled"
          : clock() >= bounded.deadlineMs
            ? "deadline_exhausted"
            : (result.observation.evidence?.length ?? 0) > 0
              ? "transport_exhausted"
              : "projection_pending",
        result.observation,
        bounded.deadlineMs,
      );
    }
    return continueAfterFreshPreflight(
      pendingResult.provisionalRef,
      input,
      result.receipt,
      pendingResult.initialTurnContinuation,
      bounded,
    );
  }

  async function send(
    ref: AgentRef,
    text: string,
    operation: RuntimeOperationOptions = {},
  ): Promise<TurnReceipt> {
    const bounded = boundedOperation(operation);
    const initialStop = stopCode(bounded);
    if (initialStop !== null) throw new StockRuntimeError(initialStop);
    const deadlineMs = bounded.deadlineMs;
    const slotClaim = claimTurnSlot(ref, deadlineMs);
    const slotToken = slotClaim.token;
    let retainSlot = false;
    const retain = (receipt: TurnReceipt): TurnReceipt => {
      retainSlot = true;
      return receipt;
    };
    try {
      const [environment, preflight] = await Promise.all([
        descriptor({ deadlineMs, signal: bounded.signal }),
        client.getThread(ref.threadId, { deadlineMs, signal: bounded.signal }),
      ] as const);
      if (environment.environmentId !== ref.environmentId) {
        throw new StockRuntimeError("environment_changed");
      }
      if (preflight === undefined || preflight.thread.id !== ref.threadId) {
        throw new StockRuntimeError("identity_conflict", { threadId: ref.threadId });
      }
      if (
        preflight.thread.latestTurn?.state === "running" ||
        preflight.thread.session?.status === "starting" ||
        preflight.thread.session?.status === "running"
      ) {
        throw new StockRuntimeError("send_in_progress", { source: "stock" });
      }
      const preDispatchStop = stopCode(bounded);
      if (preDispatchStop !== null) throw new StockRuntimeError(preDispatchStop);
      const commandId = id();
      const messageId = id();
      const leaseId = id();
      let receipt = makeLease(
        ref,
        slotClaim,
        commandId,
        messageId,
        null,
        preflight.snapshotSequence,
        text,
        preflight,
        deadlineMs,
        leaseId,
      );
      const command = {
        type: "thread.turn.start",
        commandId,
        threadId: ref.threadId,
        message: { messageId, role: "user", text, attachments: [] },
        runtimeMode: preflight.thread.runtimeMode,
        interactionMode: preflight.thread.interactionMode,
        createdAt: now(),
      };
      try {
        const accepted = await client.dispatch(command, {
          deadlineMs,
          signal: bounded.signal,
        });
        poller.dispatchObserved(ref.environmentId);
        receipt = { ...receipt, acceptedSequence: accepted.sequence };
        updateLeaseReceipt(ref, slotToken, receipt);
        return retain(receipt);
      } catch (error) {
        const failure = classifyDispatchFailure(error, bounded);
        if (failure.kind !== "ambiguous") {
          const terminalReceipt = releaseLeaseAndSnapshot(receipt);
          if (failure.kind === "cancelled" || failure.kind === "timeout") {
            throw turnReceiptError(failure.kind, terminalReceipt, { stage: "turn_dispatch" });
          }
          throw turnReceiptError(failure.error.code, terminalReceipt, {
            stage: "turn_dispatch",
            ...failure.error.evidence,
          });
        }
      }

      const projection = await reconcileTarget(ref, bounded, 1);
      if (projection.kind === "target") {
        receipt = {
          ...receipt,
          observedSequence: projection.detail?.snapshotSequence ?? receipt.observedSequence,
          ...((projection.evidence?.length ?? 0) === 0
            ? {}
            : { reconciliationEvidence: projection.evidence }),
        };
        updateLeaseReceipt(ref, slotToken, receipt);
        return retain(receipt);
      }
      if (projection.kind !== "absent") {
        const terminalReceipt = releaseLeaseAndSnapshot(receipt);
        throw turnReceiptError(projection.kind, terminalReceipt, { stage: "send_reconciliation" });
      }
      const beforeRetryStop = stopCode(bounded);
      if (beforeRetryStop !== null) {
        const terminalReceipt = releaseLeaseAndSnapshot(receipt);
        throw turnReceiptError(beforeRetryStop, terminalReceipt, { stage: "before_identical_retry" });
      }
      try {
        const retried = await client.dispatch(command, {
          deadlineMs,
          signal: bounded.signal,
        });
        poller.dispatchObserved(ref.environmentId);
        receipt = { ...receipt, acceptedSequence: retried.sequence };
        updateLeaseReceipt(ref, slotToken, receipt);
        return retain(receipt);
      } catch (error) {
        const failure = classifyDispatchFailure(error, bounded);
        if (failure.kind === "ambiguous") return retain(receipt);
        if (
          failure.kind === "received" &&
          failure.error.code !== "protocol_mismatch" &&
          error instanceof StockT3HttpError &&
          [400, 401, 403, 500].includes(error.status ?? 0)
        ) {
          return retain(receipt);
        }
        const terminalReceipt = releaseLeaseAndSnapshot(receipt);
        if (failure.kind === "cancelled" || failure.kind === "timeout") {
          throw turnReceiptError(failure.kind, terminalReceipt, { stage: "identical_retry" });
        }
        throw turnReceiptError(failure.error.code, terminalReceipt, {
          stage: "identical_retry",
          ...failure.error.evidence,
        });
      }
    } finally {
      if (!retainSlot) releaseTurnSlot(ref, slotToken);
    }
  }

  function validateReceipt(receipt: TurnReceipt): LeaseState {
    const state = leases.get(scopedThreadKey(receipt.agentRef));
    if (
      receipt.leaseState !== "active" ||
      state === undefined ||
      state.receipt.leaseId !== receipt.leaseId ||
      state.receipt.leaseExpiresAt <= clock()
    ) {
      releaseLease(receipt.agentRef, receipt.leaseId);
      throw new StockRuntimeError("receipt_expired");
    }
    return state;
  }

  async function wait(
    receipt: TurnReceipt,
    operation: RuntimeOperationOptions = {},
  ): Promise<{
    readonly kind: "completed";
    readonly receipt: TurnReceipt;
    readonly assistantContent: string;
    readonly snapshotSequence: number;
    readonly evidence: {
      readonly truncated: boolean;
      readonly originalBytes: number;
      readonly retainedBytes: number;
    };
  }> {
    const bounded = boundedOperation(operation);
    const deadlineMs = Math.min(bounded.deadlineMs, receipt.leaseExpiresAt);
    try {
      validateReceipt(receipt);
      const environment = await descriptor({ deadlineMs, signal: bounded.signal });
      if (environment.environmentId !== receipt.agentRef.environmentId) {
        throw new StockRuntimeError("environment_changed", {
          expectedEnvironmentId: receipt.agentRef.environmentId,
          actualEnvironmentId: environment.environmentId,
        });
      }
      validateReceipt(receipt);
      return await poller.waitFor({
        environmentId: receipt.agentRef.environmentId,
        threadId: receipt.agentRef.threadId,
        deadlineMs,
        signal: bounded.signal,
        evaluate: ({ shell: shellSnapshot, detail: detailSnapshot }) => {
          const state = validateReceipt(receipt);
          const shellThread = shellSnapshot.threads.find(
            (entry) => entry.id === receipt.agentRef.threadId,
          );
          if (shellThread === undefined) {
            throw new StockRuntimeError("protocol_mismatch", { reason: "shell_thread_missing" });
          }
          if (detailSnapshot === undefined) return { done: false, detail: true };
          if (
            detailSnapshot.thread.id !== shellThread.id ||
            detailSnapshot.thread.projectId !== shellThread.projectId
          ) {
            throw new StockRuntimeError("protocol_mismatch", {
              reason: "shell_detail_identity_conflict",
            });
          }
          if (detailSnapshot.snapshotSequence < shellSnapshot.snapshotSequence) {
            return { done: false, detail: true };
          }
          const targetProjection = classifyTargetProjection(detailSnapshot, state);
          if (targetProjection.kind === "absent") return { done: false, detail: true };
          if (targetProjection.kind !== "target") {
            throw new StockRuntimeError(targetProjection.kind);
          }
          const observedUsers = userMessages(detailSnapshot);
          const post = observedUsers.slice(state.baselineUserIds.length);
          const target = post[0]!;
          const latest = detailSnapshot.thread.latestTurn;
          if (
            state.boundTurnId === null &&
            latest !== null &&
            latest.turnId !== state.preflightLatestTurnId &&
            latest.requestedAt === target.createdAt
          ) {
            state.boundTurnId = latest.turnId;
          } else if (
            state.boundTurnId === null &&
            latest !== null &&
            latest.requestedAt > target.createdAt
          ) {
            throw new StockRuntimeError("superseded");
          }
          if (state.boundTurnId !== null && latest?.turnId !== state.boundTurnId) {
            throw new StockRuntimeError("concurrent_writer", { reason: "turn_changed" });
          }
          if (state.boundTurnId === null) return { done: false, detail: true };
          const shellLatest = shellThread.latestTurn;
          if (
            state.boundTurnId !== null &&
            shellLatest !== null &&
            (shellLatest.turnId !== state.boundTurnId ||
              shellLatest.requestedAt !== target.createdAt)
          ) {
            throw new StockRuntimeError("concurrent_writer", {
              reason: "shell_detail_turn_conflict",
            });
          }
          if (shellThread.hasPendingApprovals) throw new StockRuntimeError("pending_approval");
          if (shellThread.hasPendingUserInput) throw new StockRuntimeError("pending_input");
          if (latest?.state === "interrupted") throw new StockRuntimeError("turn_interrupted");
          if (latest?.state === "error") throw new StockRuntimeError("turn_error");
          if (
            latest?.state !== "completed" ||
            state.boundTurnId === null ||
            shellLatest?.turnId !== state.boundTurnId ||
            shellLatest.requestedAt !== target.createdAt ||
            shellLatest.state !== "completed"
          ) {
            return { done: false, detail: true };
          }
          const assistant = detailSnapshot.thread.messages.find(
            (entry) =>
              entry.id === latest.assistantMessageId &&
              entry.role === "assistant" &&
              entry.turnId === state.boundTurnId &&
              !entry.streaming,
          );
          if (assistant === undefined) return { done: false, detail: true };
          const retained = boundedUtf8(assistant.text);
          const terminalReceipt = releaseLeaseAndSnapshot(receipt);
          return {
            done: true,
            value: {
              kind: "completed" as const,
              receipt: terminalReceipt,
              assistantContent: retained.text,
              snapshotSequence: detailSnapshot.snapshotSequence,
              evidence: {
                truncated: retained.truncated,
                originalBytes: retained.originalBytes,
                retainedBytes: retained.retainedBytes,
              },
            },
          };
        },
      });
    } catch (error) {
      if (error instanceof StockRuntimeError) {
        if (
          error.code === "environment_changed" ||
          error.code === "receipt_expired" ||
          error.code === "cancelled" ||
          error.code === "superseded" ||
          error.code === "concurrent_writer" ||
          error.code === "causality_unverifiable" ||
          error.code === "turn_interrupted" ||
          error.code === "turn_error"
        ) {
          const terminalReceipt = releaseLeaseAndSnapshot(receipt);
          throw turnReceiptError(error.code, terminalReceipt, error.evidence);
        }
        throw error;
      }
      if (error instanceof PollerError) {
        if (error.code === "cancelled" || error.code === "closed") {
          const terminalReceipt = releaseLeaseAndSnapshot(receipt);
          throw turnReceiptError("cancelled", terminalReceipt, { reason: error.code });
        }
        if (error.code === "timeout") {
          if (clock() >= receipt.leaseExpiresAt) {
            const terminalReceipt = releaseLeaseAndSnapshot(receipt);
            throw turnReceiptError("receipt_expired", terminalReceipt);
          }
          throw new StockRuntimeError("timeout", { receipt });
        }
        throw new StockRuntimeError("transport_unavailable", { reason: error.code });
      }
      throw mapReceivedError(error);
    }
  }

  return {
    client,
    spawn,
    resumeCreateReconciliation,
    send,
    wait,
    async observe(ref: AgentRef, operation: RuntimeOperationOptions = {}) {
      const bounded = boundedOperation(operation);
      const stopped = stopCode(bounded);
      if (stopped !== null) throw new StockRuntimeError(stopped);
      const environment = await descriptor({ deadlineMs: bounded.deadlineMs, signal: bounded.signal });
      if (environment.environmentId !== ref.environmentId) {
        throw new StockRuntimeError("environment_changed", {
          expectedEnvironmentId: ref.environmentId,
          actualEnvironmentId: environment.environmentId,
        });
      }
      return client.getThread(ref.threadId, {
        deadlineMs: bounded.deadlineMs,
        signal: bounded.signal,
      });
    },
    releaseReceipt(receipt: TurnReceipt): void {
      const state = leases.get(scopedThreadKey(receipt.agentRef));
      if (state?.receipt.leaseId === receipt.leaseId) {
        releaseLease(receipt.agentRef, receipt.leaseId);
      }
    },
    pollMetrics: () => poller.metrics(),
    httpObservations: () =>
      client.observations?.() ?? {
        requestCount: 0,
        inFlight: 0,
        peakInFlight: 0,
        endpointStatusTrace: [],
      },
    close(): void {
      poller.close();
      for (const state of leases.values()) {
        releaseLease(state.receipt.agentRef, state.receipt.leaseId);
      }
    },
  };
}

export const createT3NativeRuntime = createStockT3NativeRuntime;
export type T3NativeRuntime = ReturnType<typeof createStockT3NativeRuntime>;
