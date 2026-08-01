export type ConnectionProfile = "local" | "relay" | "tunnel";

export class ProtocolMismatchError extends TypeError {
  readonly code = "protocol_mismatch" as const;

  constructor(readonly path: string) {
    super(`stock T3 protocol mismatch at ${path}`);
    this.name = "ProtocolMismatchError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolMismatchError(path);
  }
  return value as JsonObject;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new ProtocolMismatchError(path);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ProtocolMismatchError(path);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolMismatchError(path);
  }
  return value as number;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

export function nullableOptional(value: unknown, path: string): string | null | undefined {
  return value === undefined ? undefined : nullableString(value, path);
}

function iso(value: unknown, path: string): string {
  const decoded = string(value, path);
  if (!Number.isFinite(Date.parse(decoded))) throw new ProtocolMismatchError(path);
  return decoded;
}

function array<T>(value: unknown, path: string, decode: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ProtocolMismatchError(path);
  return value.map((entry, index) => decode(entry, `${path}[${index}]`));
}

export interface EnvironmentDescriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly platform: { readonly os: "darwin" | "linux" | "windows" | "unknown"; readonly arch: "arm64" | "x64" | "other" };
  readonly serverVersion: string;
  readonly capabilities: { readonly repositoryIdentity: boolean };
}

export interface StockModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: readonly unknown[];
}

export interface StockProjectShell {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: StockModelSelection | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StockLatestTurn {
  readonly turnId: string;
  readonly state: "running" | "interrupted" | "completed" | "error";
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: string | null;
}

export interface StockSession {
  readonly threadId: string;
  readonly status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  readonly providerName: string | null;
  readonly activeTurnId: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface StockThreadIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: StockModelSelection;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly interactionMode: "default" | "plan";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurn: StockLatestTurn | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly session: StockSession | null;
}

export interface StockThreadShell extends StockThreadIdentity {
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

export interface StockMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments: readonly unknown[];
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StockThreadDetail extends StockThreadIdentity {
  readonly messages: readonly StockMessage[];
  readonly activities: readonly unknown[];
  readonly checkpoints: readonly unknown[];
}

export interface ShellSnapshot {
  readonly snapshotSequence: number;
  readonly projects: readonly StockProjectShell[];
  readonly threads: readonly StockThreadShell[];
  readonly updatedAt: string;
}

export interface ThreadDetailSnapshot {
  readonly snapshotSequence: number;
  readonly thread: StockThreadDetail;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolMismatchError(path);
  }
  return value as T;
}

function decodeModelSelection(value: unknown, path: string): StockModelSelection {
  const input = object(value, path);
  const result: StockModelSelection = {
    instanceId: string(input.instanceId ?? input.provider, `${path}.instanceId`),
    model: string(input.model, `${path}.model`),
    ...(input.options === undefined
      ? {}
      : { options: array(input.options, `${path}.options`, (entry) => entry) }),
  };
  return result;
}

function decodeLatestTurn(value: unknown, path: string): StockLatestTurn | null {
  if (value === null) return null;
  const input = object(value, path);
  return {
    turnId: string(input.turnId, `${path}.turnId`),
    state: literal(input.state, ["running", "interrupted", "completed", "error"], `${path}.state`),
    requestedAt: iso(input.requestedAt, `${path}.requestedAt`),
    startedAt: input.startedAt === null ? null : iso(input.startedAt, `${path}.startedAt`),
    completedAt: input.completedAt === null ? null : iso(input.completedAt, `${path}.completedAt`),
    assistantMessageId: nullableString(input.assistantMessageId, `${path}.assistantMessageId`),
  };
}

function decodeSession(value: unknown, path: string): StockSession | null {
  if (value === null) return null;
  const input = object(value, path);
  return {
    threadId: string(input.threadId, `${path}.threadId`),
    status: literal(input.status, ["idle", "starting", "running", "ready", "interrupted", "stopped", "error"], `${path}.status`),
    providerName: nullableString(input.providerName, `${path}.providerName`),
    activeTurnId: nullableString(input.activeTurnId, `${path}.activeTurnId`),
    lastError: nullableString(input.lastError, `${path}.lastError`),
    updatedAt: iso(input.updatedAt, `${path}.updatedAt`),
  };
}

function decodeThreadIdentity(input: JsonObject, path: string): StockThreadIdentity {
  return {
    id: string(input.id, `${path}.id`),
    projectId: string(input.projectId, `${path}.projectId`),
    title: string(input.title, `${path}.title`),
    modelSelection: decodeModelSelection(input.modelSelection, `${path}.modelSelection`),
    runtimeMode: literal(input.runtimeMode, ["approval-required", "auto-accept-edits", "auto", "full-access"], `${path}.runtimeMode`),
    interactionMode: literal(input.interactionMode ?? "default", ["default", "plan"], `${path}.interactionMode`),
    branch: nullableString(input.branch, `${path}.branch`),
    worktreePath: nullableString(input.worktreePath, `${path}.worktreePath`),
    latestTurn: decodeLatestTurn(input.latestTurn, `${path}.latestTurn`),
    createdAt: iso(input.createdAt, `${path}.createdAt`),
    updatedAt: iso(input.updatedAt, `${path}.updatedAt`),
    session: decodeSession(input.session, `${path}.session`),
  };
}

function assertSequence(sequence: number, minimumSequence: number | undefined, path: string): void {
  if (minimumSequence !== undefined && sequence < minimumSequence) {
    throw new ProtocolMismatchError(path);
  }
}

export function decodeDescriptor(value: unknown): EnvironmentDescriptor {
  const input = object(value, "descriptor");
  const platform = object(input.platform, "descriptor.platform");
  const capabilities = object(input.capabilities, "descriptor.capabilities");
  return {
    environmentId: string(input.environmentId, "descriptor.environmentId"),
    label: string(input.label, "descriptor.label"),
    platform: {
      os: literal(platform.os, ["darwin", "linux", "windows", "unknown"], "descriptor.platform.os"),
      arch: literal(platform.arch, ["arm64", "x64", "other"], "descriptor.platform.arch"),
    },
    serverVersion: string(input.serverVersion, "descriptor.serverVersion"),
    capabilities: {
      repositoryIdentity:
        capabilities.repositoryIdentity === undefined
          ? false
          : boolean(capabilities.repositoryIdentity, "descriptor.capabilities.repositoryIdentity"),
    },
  };
}

export function decodeDispatchResult(value: unknown): { readonly sequence: number } {
  const input = object(value, "dispatch");
  return { sequence: integer(input.sequence, "dispatch.sequence") };
}

function decodeProject(value: unknown, path: string): StockProjectShell {
  const input = object(value, path);
  return {
    id: string(input.id, `${path}.id`),
    title: string(input.title, `${path}.title`),
    workspaceRoot: string(input.workspaceRoot, `${path}.workspaceRoot`),
    defaultModelSelection:
      input.defaultModelSelection === null
        ? null
        : decodeModelSelection(input.defaultModelSelection, `${path}.defaultModelSelection`),
    createdAt: iso(input.createdAt, `${path}.createdAt`),
    updatedAt: iso(input.updatedAt, `${path}.updatedAt`),
  };
}

function decodeThreadShell(value: unknown, path: string): StockThreadShell {
  const input = object(value, path);
  return {
    ...decodeThreadIdentity(input, path),
    latestUserMessageAt:
      input.latestUserMessageAt === null ? null : iso(input.latestUserMessageAt, `${path}.latestUserMessageAt`),
    hasPendingApprovals: boolean(input.hasPendingApprovals, `${path}.hasPendingApprovals`),
    hasPendingUserInput: boolean(input.hasPendingUserInput, `${path}.hasPendingUserInput`),
  };
}

export function decodeShellSnapshot(
  value: unknown,
  options: { readonly minimumSequence?: number } = {},
): ShellSnapshot {
  const input = object(value, "shell");
  const snapshotSequence = integer(input.snapshotSequence, "shell.snapshotSequence");
  assertSequence(snapshotSequence, options.minimumSequence, "shell.snapshotSequence");
  return {
    snapshotSequence,
    projects: array(input.projects, "shell.projects", decodeProject),
    threads: array(input.threads, "shell.threads", decodeThreadShell),
    updatedAt: iso(input.updatedAt, "shell.updatedAt"),
  };
}

function decodeMessage(value: unknown, path: string): StockMessage {
  const input = object(value, path);
  return {
    id: string(input.id, `${path}.id`),
    role: literal(input.role, ["user", "assistant", "system"], `${path}.role`),
    text: string(input.text, `${path}.text`, true),
    attachments:
      input.attachments === undefined
        ? []
        : array(input.attachments, `${path}.attachments`, (entry) => entry),
    turnId: nullableString(input.turnId, `${path}.turnId`),
    streaming: boolean(input.streaming, `${path}.streaming`),
    createdAt: iso(input.createdAt, `${path}.createdAt`),
    updatedAt: iso(input.updatedAt, `${path}.updatedAt`),
  };
}

export function decodeThreadDetailSnapshot(
  value: unknown,
  options: { readonly minimumSequence?: number } = {},
): ThreadDetailSnapshot {
  const input = object(value, "detail");
  const snapshotSequence = integer(input.snapshotSequence, "detail.snapshotSequence");
  assertSequence(snapshotSequence, options.minimumSequence, "detail.snapshotSequence");
  const threadInput = object(input.thread, "detail.thread");
  return {
    snapshotSequence,
    thread: {
      ...decodeThreadIdentity(threadInput, "detail.thread"),
      messages: array(threadInput.messages, "detail.thread.messages", decodeMessage),
      activities: array(threadInput.activities, "detail.thread.activities", (entry) => entry),
      checkpoints: array(threadInput.checkpoints, "detail.thread.checkpoints", (entry) => entry),
    },
  };
}

export type SanitizedDispatchError =
  | { readonly status: 400; readonly class: "command_rejected"; readonly code: "invalid_request"; readonly reason: "invalid_command" }
  | { readonly status: 401; readonly class: "authentication_failed"; readonly code: "auth_invalid"; readonly reason: "missing_credential" | "invalid_credential" }
  | { readonly status: 403; readonly class: "permission_denied"; readonly code: "insufficient_scope"; readonly reason: null }
  | { readonly status: 500; readonly class: "server_internal"; readonly code: "internal_error"; readonly reason: "orchestration_dispatch_failed" };

export function decodeDispatchError(status: number, value: unknown): SanitizedDispatchError {
  const input = object(value, "dispatchError");
  if (status === 400 && input.code === "invalid_request" && input.reason === "invalid_command") {
    return { status, class: "command_rejected", code: input.code, reason: input.reason };
  }
  if (
    status === 401 &&
    input.code === "auth_invalid" &&
    (input.reason === "missing_credential" || input.reason === "invalid_credential")
  ) {
    return { status, class: "authentication_failed", code: input.code, reason: input.reason };
  }
  if (status === 403 && input.code === "insufficient_scope") {
    return { status, class: "permission_denied", code: input.code, reason: null };
  }
  if (
    status === 500 &&
    input.code === "internal_error" &&
    input.reason === "orchestration_dispatch_failed"
  ) {
    return { status, class: "server_internal", code: input.code, reason: input.reason };
  }
  throw new ProtocolMismatchError("dispatchError");
}

export function decodeTokenResult(value: unknown): {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
} {
  const input = object(value, "token");
  return {
    accessToken: string(input.accessToken, "token.accessToken"),
    tokenType: literal(input.tokenType, ["Bearer"], "token.tokenType"),
    expiresIn: integer(input.expiresIn, "token.expiresIn"),
  };
}
