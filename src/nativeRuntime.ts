import {
  ClientOrchestrationCommand,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationSubscribeThreadInput,
  applyShellStreamEvent,
  applyThreadDetailEvent,
  makeRpcSessionFactory,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationSubscribeShellInput,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadStreamItem,
  type RuntimeClientRpcSessionFactory,
} from "@t3tools/runtime-client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import {
  AmbiguousDispatchError,
  type NativeCreateProjectInput,
  type NativeProject,
  type NativeRuntime,
  type NativeStartThreadInput,
  type NativeStartTurnInput,
  type NativeThreadObservation,
  type NativeThreadSnapshot,
} from "./facade";

export type NativeRuntimeAdapterErrorCode =
  | "authorization"
  | "version_mismatch"
  | "command_rejected"
  | "transport_unavailable"
  | "projection_invalid";

export class NativeRuntimeAdapterError extends Error {
  readonly code: NativeRuntimeAdapterErrorCode;

  constructor(code: NativeRuntimeAdapterErrorCode) {
    super(code);
    this.name = "NativeRuntimeAdapterError";
    this.code = code;
  }
}

export interface RuntimeClientSession {
  readonly dispatchCommand: (
    command: ClientOrchestrationCommand,
  ) => Promise<{ readonly sequence: number }>;
  readonly subscribeShell: (
    input: OrchestrationSubscribeShellInput,
  ) => AsyncIterable<OrchestrationShellStreamItem>;
  readonly subscribeThread: (
    input: OrchestrationSubscribeThreadInput,
  ) => AsyncIterable<OrchestrationThreadStreamItem>;
  readonly close: () => Promise<void>;
}

export interface RuntimeClientSessionFactory {
  readonly connect: (connection: {
    readonly environmentId: string;
    readonly label: string;
    readonly socketUrl: string;
  }) => Promise<RuntimeClientSession>;
}

export interface T3NativeRuntimeOptions {
  readonly environmentId: string;
  readonly label: string;
  /**
   * Acquires a one-use authorized WebSocket URL. The adapter passes the value
   * directly into a new scoped session and never retains or reports it.
   */
  readonly acquireSocketUrl: () => Promise<string>;
  readonly sessionFactory?: RuntimeClientSessionFactory;
}

interface VersionedDetail {
  readonly sequence: number;
  readonly thread: OrchestrationThread;
}

interface VersionedShell {
  readonly sequence: number;
  readonly snapshot: OrchestrationShellSnapshot;
  readonly origin: "seed" | "snapshot" | "event";
}

interface ReconciledThreadState {
  readonly observation: NativeThreadObservation;
  readonly detail: OrchestrationThread;
  readonly shellSnapshot: OrchestrationShellSnapshot;
}

interface ReconcileThreadOptions {
  readonly emitAfterSequence?: number;
  readonly resumeFromSequence?: number;
  readonly seed?: ReconciledThreadState;
}

type TaggedNext =
  | {
      readonly source: "detail";
      readonly result: IteratorResult<OrchestrationThreadStreamItem>;
    }
  | {
      readonly source: "shell";
      readonly result: IteratorResult<OrchestrationShellStreamItem>;
    }
  | {
      readonly source: "detail" | "shell";
      readonly error: unknown;
    };

function taggedNext<T>(
  source: "detail" | "shell",
  next: Promise<IteratorResult<T>>,
): Promise<TaggedNext> {
  return next.then(
    (result) => ({ source, result }) as TaggedNext,
    (error) => ({ source, error }),
  );
}

function adapterError(
  error: unknown,
  fallback: NativeRuntimeAdapterErrorCode,
): NativeRuntimeAdapterError {
  if (error instanceof NativeRuntimeAdapterError) return error;
  const tagged = error as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
  };
  if (tagged?._tag === "EnvironmentAuthorizationError") {
    return new NativeRuntimeAdapterError("authorization");
  }
  if (tagged?._tag === "ConnectionBlockedError") {
    return new NativeRuntimeAdapterError(
      tagged.reason === "version_mismatch"
        ? "version_mismatch"
        : "authorization",
    );
  }
  if (tagged?._tag === "OrchestrationDispatchCommandError") {
    return new NativeRuntimeAdapterError("command_rejected");
  }
  return new NativeRuntimeAdapterError(fallback);
}

function dispatchError(error: unknown): Error {
  const mapped = adapterError(error, "transport_unavailable");
  if (
    mapped.code === "authorization" ||
    mapped.code === "version_mismatch" ||
    mapped.code === "command_rejected"
  ) {
    return mapped;
  }
  return new AmbiguousDispatchError();
}

async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) throw error.value;
  throw new NativeRuntimeAdapterError("transport_unavailable");
}

function loadRuntimeClientFactory(): Promise<RuntimeClientRpcSessionFactory> {
  return runEffect(
    makeRpcSessionFactory.pipe(
      Effect.provideService(
        Socket.WebSocketConstructor,
        (url, protocols) => new globalThis.WebSocket(url, protocols),
      ),
    ),
  );
}

export function createDefaultSessionFactory(
  loadFactory: () => Promise<RuntimeClientRpcSessionFactory> = loadRuntimeClientFactory,
): RuntimeClientSessionFactory {
  let factoryPromise: Promise<RuntimeClientRpcSessionFactory> | undefined;
  const getFactory = () => {
    if (factoryPromise === undefined) {
      const attempt = loadFactory().catch((error) => {
        if (factoryPromise === attempt) factoryPromise = undefined;
        throw error;
      });
      factoryPromise = attempt;
    }
    return factoryPromise;
  };

  return {
    async connect(connection) {
      const factory = await getFactory();
      const scope = await runEffect(Scope.make());
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await runEffect(Scope.close(scope, Exit.succeed(undefined)));
      };
      try {
        const session = await runEffect(
          factory
            .connect({
              environmentId: Schema.decodeUnknownSync(EnvironmentId)(
                connection.environmentId,
              ),
              label: connection.label,
              socketUrl: connection.socketUrl,
            })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        );
        await runEffect(session.ready);
        return {
          dispatchCommand: (command) =>
            runEffect(
              session.client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
            ),
          subscribeShell: (input) =>
            Stream.toAsyncIterable(
              session.client[ORCHESTRATION_WS_METHODS.subscribeShell](input),
            ),
          subscribeThread: (input) =>
            Stream.toAsyncIterable(
              session.client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
            ),
          close,
        };
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    },
  };
}

async function closeQuietly(session: RuntimeClientSession): Promise<void> {
  await session.close().catch(() => undefined);
}

function latestVersionAt<T extends { readonly sequence: number }>(
  versions: readonly T[],
  sequence: number,
): T | undefined {
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index];
    if (version !== undefined && version.sequence <= sequence) return version;
  }
  return undefined;
}

function pruneVersionsThrough<T extends { readonly sequence: number }>(
  versions: T[],
  sequence: number,
): void {
  let retainedIndex = 0;
  for (let index = 1; index < versions.length; index += 1) {
    if (versions[index]!.sequence > sequence) break;
    retainedIndex = index;
  }
  if (retainedIndex > 0) versions.splice(0, retainedIndex);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellCanAdvanceDetail(
  detail: OrchestrationThread,
  shell: OrchestrationThreadShell,
): boolean {
  return (
    detail.id === shell.id &&
    detail.projectId === shell.projectId &&
    detail.title === shell.title &&
    sameValue(detail.modelSelection, shell.modelSelection) &&
    detail.runtimeMode === shell.runtimeMode &&
    detail.interactionMode === shell.interactionMode &&
    detail.branch === shell.branch &&
    detail.worktreePath === shell.worktreePath &&
    detail.archivedAt === shell.archivedAt &&
    detail.settledOverride === shell.settledOverride &&
    detail.settledAt === shell.settledAt &&
    sameValue(detail.latestTurn, shell.latestTurn) &&
    (detail.session === null ||
      sameValue(
        {
          status: detail.session.status,
          providerName: detail.session.providerName,
          providerInstanceId: detail.session.providerInstanceId,
          runtimeMode: detail.session.runtimeMode,
          activeTurnId: detail.session.activeTurnId,
          lastError: detail.session.lastError,
        },
        shell.session === null
          ? null
          : {
              status: shell.session.status,
              providerName: shell.session.providerName,
              providerInstanceId: shell.session.providerInstanceId,
              runtimeMode: shell.session.runtimeMode,
              activeTurnId: shell.session.activeTurnId,
              lastError: shell.session.lastError,
            },
      ))
  );
}

function shellDeltaIsPendingOnly(
  previous: OrchestrationThreadShell,
  current: OrchestrationThreadShell,
): boolean {
  const {
    updatedAt: _previousUpdatedAt,
    hasPendingApprovals: previousPendingApprovals,
    hasPendingUserInput: previousPendingInput,
    hasActionableProposedPlan: previousActionablePlan,
    ...previousStructural
  } = previous;
  const {
    updatedAt: _currentUpdatedAt,
    hasPendingApprovals: currentPendingApprovals,
    hasPendingUserInput: currentPendingInput,
    hasActionableProposedPlan: currentActionablePlan,
    ...currentStructural
  } = current;
  const pendingChanged =
    previousPendingApprovals !== currentPendingApprovals ||
    previousPendingInput !== currentPendingInput ||
    previousActionablePlan !== currentActionablePlan;
  return pendingChanged && sameValue(previousStructural, currentStructural);
}

function toNativeSnapshot(
  sequence: number,
  detail: OrchestrationThread,
  shell: OrchestrationThreadShell,
): NativeThreadSnapshot {
  const latestTurn = detail.latestTurn;
  const userMessage =
    latestTurn === null
      ? undefined
      : [...detail.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "user" && message.turnId === latestTurn.turnId,
          );
  const assistantMessage =
    latestTurn?.assistantMessageId == null
      ? undefined
      : detail.messages.find(
          (message) => message.id === latestTurn.assistantMessageId,
        );
  const session = detail.session ?? shell.session;

  return {
    threadId: detail.id,
    projectId: detail.projectId,
    snapshotSequence: sequence,
    session: {
      status: session?.status ?? "unknown",
      activeTurnId: session?.activeTurnId ?? null,
    },
    latestTurn:
      latestTurn === null
        ? null
        : {
            turnId: latestTurn.turnId,
            status: latestTurn.state,
            ...(userMessage === undefined
              ? {}
              : { userMessageId: userMessage.id }),
            assistantMessage:
              assistantMessage === undefined
                ? null
                : {
                    content: assistantMessage.text,
                    streaming: assistantMessage.streaming,
                  },
          },
    pendingApproval: shell.hasPendingApprovals ? true : null,
    pendingInput: shell.hasPendingUserInput ? true : null,
  };
}

function updateDetail(
  versions: VersionedDetail[],
  item: OrchestrationThreadStreamItem,
): { readonly synchronized: boolean; readonly deleted: boolean } {
  if (item.kind === "synchronized") {
    return { synchronized: true, deleted: false };
  }
  if (item.kind === "snapshot") {
    const latest = versions.at(-1);
    if (
      latest === undefined ||
      item.snapshot.snapshotSequence > latest.sequence
    ) {
      versions.push({
        sequence: item.snapshot.snapshotSequence,
        thread: item.snapshot.thread,
      });
    }
    return { synchronized: false, deleted: false };
  }
  const latest = versions.at(-1);
  if (latest === undefined) {
    throw new NativeRuntimeAdapterError("projection_invalid");
  }
  if (item.event.sequence <= latest.sequence) {
    return { synchronized: false, deleted: false };
  }
  const reduced = applyThreadDetailEvent(latest.thread, item.event);
  if (reduced.kind === "deleted") {
    return { synchronized: false, deleted: true };
  }
  versions.push({
    sequence: item.event.sequence,
    thread: reduced.kind === "updated" ? reduced.thread : latest.thread,
  });
  return { synchronized: false, deleted: false };
}

function updateShell(
  versions: VersionedShell[],
  item: OrchestrationShellStreamItem,
): boolean {
  if (item.kind === "synchronized") return true;
  if (item.kind === "snapshot") {
    const latest = versions.at(-1);
    if (
      latest === undefined ||
      item.snapshot.snapshotSequence > latest.sequence
    ) {
      versions.push({
        sequence: item.snapshot.snapshotSequence,
        snapshot: item.snapshot,
        origin: "snapshot",
      });
    }
    return false;
  }
  const latest = versions.at(-1);
  if (latest === undefined) {
    throw new NativeRuntimeAdapterError("projection_invalid");
  }
  if (item.sequence <= latest.sequence) return false;
  const snapshot = applyShellStreamEvent(latest.snapshot, item);
  versions.push({ sequence: item.sequence, snapshot, origin: "event" });
  return false;
}

async function catchUpDetailThrough(
  session: RuntimeClientSession,
  threadId: string,
  afterSequence: number,
  versions: VersionedDetail[],
): Promise<{ readonly deleted: boolean }> {
  const iterator = session
    .subscribeThread(
      Schema.decodeUnknownSync(OrchestrationSubscribeThreadInput)({
        threadId,
        afterSequence,
        requestCompletionMarker: true,
      }),
    )
    [Symbol.asyncIterator]();
  try {
    while (true) {
      let next: IteratorResult<OrchestrationThreadStreamItem>;
      try {
        next = await iterator.next();
      } catch (error) {
        throw adapterError(error, "transport_unavailable");
      }
      if (next.done) {
        throw new NativeRuntimeAdapterError("transport_unavailable");
      }
      const update = updateDetail(versions, next.value);
      if (update.deleted) return { deleted: true };
      if (update.synchronized) return { deleted: false };
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

async function catchUpShellThrough(
  session: RuntimeClientSession,
  afterSequence: number,
  versions: VersionedShell[],
): Promise<{ readonly snapshotSequence: number | undefined }> {
  const iterator = session
    .subscribeShell({
      afterSequence,
      requestCompletionMarker: true,
    })
    [Symbol.asyncIterator]();
  let snapshotSequence: number | undefined;
  try {
    while (true) {
      let next: IteratorResult<OrchestrationShellStreamItem>;
      try {
        next = await iterator.next();
      } catch (error) {
        throw adapterError(error, "transport_unavailable");
      }
      if (next.done) {
        throw new NativeRuntimeAdapterError("transport_unavailable");
      }
      if (next.value.kind === "snapshot") {
        snapshotSequence = Math.max(
          snapshotSequence ?? -1,
          next.value.snapshot.snapshotSequence,
        );
      }
      if (updateShell(versions, next.value)) {
        return { snapshotSequence };
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

async function alignInitialVersions(
  session: RuntimeClientSession,
  threadId: string,
  detailVersions: VersionedDetail[],
  shellVersions: VersionedShell[],
): Promise<{ readonly sequence: number; readonly deleted: boolean }> {
  let detailValidatedThrough = detailVersions.at(-1)!.sequence;
  let shellValidatedThrough = shellVersions.at(-1)!.sequence;
  let targetSequence = Math.max(detailValidatedThrough, shellValidatedThrough);

  while (
    detailValidatedThrough < targetSequence ||
    shellValidatedThrough < targetSequence
  ) {
    if (detailValidatedThrough < targetSequence) {
      const result = await catchUpDetailThrough(
        session,
        threadId,
        detailValidatedThrough,
        detailVersions,
      );
      if (result.deleted) {
        return { sequence: targetSequence, deleted: true };
      }
      detailValidatedThrough = targetSequence;
    }
    if (shellValidatedThrough < targetSequence) {
      const result = await catchUpShellThrough(
        session,
        shellValidatedThrough,
        shellVersions,
      );
      shellValidatedThrough = targetSequence;
      if (
        result.snapshotSequence !== undefined &&
        result.snapshotSequence > targetSequence
      ) {
        targetSequence = result.snapshotSequence;
        shellValidatedThrough = result.snapshotSequence;
      }
    }
  }

  return { sequence: targetSequence, deleted: false };
}

async function* reconcileThread(
  session: RuntimeClientSession,
  threadId: string,
  options: ReconcileThreadOptions = {},
): AsyncIterable<ReconciledThreadState> {
  const resumeFromSequence = options.resumeFromSequence;
  const detailIterator = session
    .subscribeThread(
      Schema.decodeUnknownSync(OrchestrationSubscribeThreadInput)({
        threadId,
        ...(resumeFromSequence === undefined
          ? {}
          : { afterSequence: resumeFromSequence }),
        requestCompletionMarker: true,
      }),
    )
    [Symbol.asyncIterator]();
  const shellIterator = session
    .subscribeShell({
      ...(resumeFromSequence === undefined
        ? {}
        : { afterSequence: resumeFromSequence }),
      requestCompletionMarker: true,
    })
    [Symbol.asyncIterator]();
  const detailVersions: VersionedDetail[] =
    options.seed === undefined
      ? []
      : [
          {
            sequence: options.seed.observation.sequence,
            thread: options.seed.detail,
          },
        ];
  const shellVersions: VersionedShell[] =
    options.seed === undefined
      ? []
      : [
          {
            sequence: options.seed.observation.sequence,
            snapshot: {
              ...options.seed.shellSnapshot,
              snapshotSequence: options.seed.observation.sequence,
            },
            origin: "seed",
          },
        ];
  let detailSynchronized = false;
  let shellSynchronized = false;
  let detailDeleted = false;
  let detailFailure: NativeRuntimeAdapterError | undefined;
  let lastEmitted = options.emitAfterSequence ?? -1;
  let initialAlignmentComplete = options.seed !== undefined;
  let alignedInitialSequence: number | undefined;
  let detailDone = false;
  let shellDone = false;
  let detailNext: Promise<TaggedNext> | undefined = taggedNext(
    "detail",
    detailIterator.next(),
  );
  let shellNext: Promise<TaggedNext> | undefined = taggedNext(
    "shell",
    shellIterator.next(),
  );

  try {
    while (!detailDone || !shellDone) {
      const pending = [detailNext, shellNext].filter(
        (entry): entry is Promise<TaggedNext> => entry !== undefined,
      );
      if (pending.length === 0) return;
      const next = await Promise.race(pending);
      if ("error" in next) {
        if (next.source === "shell") {
          throw adapterError(next.error, "transport_unavailable");
        }
        detailFailure = adapterError(next.error, "transport_unavailable");
        detailDone = true;
        detailNext = undefined;
      } else if (next.source === "detail") {
        detailNext = undefined;
        if (next.result.done) {
          detailDone = true;
        } else {
          const update = updateDetail(detailVersions, next.result.value);
          if (update.synchronized) detailSynchronized = true;
          if (update.deleted) detailDeleted = true;
          detailNext = taggedNext("detail", detailIterator.next());
        }
      } else {
        shellNext = undefined;
        if (next.result.done) {
          shellDone = true;
        } else {
          if (updateShell(shellVersions, next.result.value)) {
            shellSynchronized = true;
          }
          shellNext = taggedNext("shell", shellIterator.next());
        }
      }

      if (shellSynchronized && shellVersions.length > 0) {
        const targetExists = shellVersions
          .at(-1)!
          .snapshot.threads.some((candidate) => candidate.id === threadId);
        if (!targetExists) return;
        if (detailFailure !== undefined) throw detailFailure;
        if (detailDone && !detailSynchronized) {
          throw new NativeRuntimeAdapterError("transport_unavailable");
        }
      }

      if (
        !detailSynchronized ||
        !shellSynchronized ||
        detailDeleted ||
        detailVersions.length === 0 ||
        shellVersions.length === 0
      ) {
        continue;
      }
      if (!initialAlignmentComplete) {
        const alignment = await alignInitialVersions(
          session,
          threadId,
          detailVersions,
          shellVersions,
        );
        if (alignment.deleted) return;
        alignedInitialSequence = alignment.sequence;
        initialAlignmentComplete = true;
      }

      let detail: VersionedDetail;
      let shell: VersionedShell;
      let commonSequence: number;
      if (alignedInitialSequence !== undefined) {
        commonSequence = alignedInitialSequence;
        const alignedDetail = latestVersionAt(detailVersions, commonSequence);
        const alignedShell = latestVersionAt(shellVersions, commonSequence);
        if (alignedDetail === undefined || alignedShell === undefined) {
          throw new NativeRuntimeAdapterError("projection_invalid");
        }
        detail = alignedDetail;
        shell = alignedShell;
      } else {
        const latestDetail = detailVersions.at(-1)!;
        const latestShell = shellVersions.at(-1)!;
        const latestShellThread = latestShell.snapshot.threads.find(
          (candidate) => candidate.id === threadId,
        );
        if (latestShellThread === undefined) return;
        if (latestDetail.sequence === latestShell.sequence) {
          commonSequence = latestDetail.sequence;
          detail = latestDetail;
          shell = latestShell;
        } else {
          const overlappingStateMatches = shellCanAdvanceDetail(
            latestDetail.thread,
            latestShellThread,
          );
          const previousShell = shellVersions
            .at(-2)
            ?.snapshot.threads.find((candidate) => candidate.id === threadId);
          const provenPendingOnlyShellAdvance =
            latestShell.sequence > latestDetail.sequence &&
            latestShell.origin === "event" &&
            previousShell !== undefined &&
            shellDeltaIsPendingOnly(previousShell, latestShellThread);
          if (!overlappingStateMatches || !provenPendingOnlyShellAdvance) {
            continue;
          }
          // After initial replay alignment, carry detail forward only for a
          // shell delta proven to change pending/actionable flags and nothing
          // else. Any other skew waits for the matching canonical stream.
          commonSequence = latestShell.sequence;
          detail = latestDetail;
          shell = latestShell;
        }
      }
      if (commonSequence <= lastEmitted) {
        alignedInitialSequence = undefined;
        continue;
      }
      const shellThread = shell.snapshot.threads.find(
        (candidate) => candidate.id === threadId,
      );
      if (shellThread === undefined || detail.thread.id !== threadId) return;

      const snapshot = toNativeSnapshot(
        commonSequence,
        detail.thread,
        shellThread,
      );
      const shellSnapshot = {
        ...shell.snapshot,
        snapshotSequence: commonSequence,
      };
      pruneVersionsThrough(detailVersions, commonSequence);
      pruneVersionsThrough(shellVersions, commonSequence);
      lastEmitted = commonSequence;
      alignedInitialSequence = undefined;
      yield {
        observation: { sequence: commonSequence, snapshot },
        detail: detail.thread,
        shellSnapshot,
      };
    }
    if (detailFailure !== undefined) throw detailFailure;
  } finally {
    await Promise.allSettled([
      detailIterator.return?.(),
      shellIterator.return?.(),
    ]);
  }
}

async function readShellSnapshot(
  session: RuntimeClientSession,
): Promise<OrchestrationShellSnapshot> {
  const iterator = session
    .subscribeShell({ requestCompletionMarker: true })
    [Symbol.asyncIterator]();
  let snapshot: OrchestrationShellSnapshot | undefined;
  try {
    while (true) {
      let next: IteratorResult<OrchestrationShellStreamItem>;
      try {
        next = await iterator.next();
      } catch (error) {
        throw adapterError(error, "transport_unavailable");
      }
      if (next.done) {
        throw new NativeRuntimeAdapterError("transport_unavailable");
      }
      if (next.value.kind === "synchronized") {
        if (snapshot === undefined) {
          throw new NativeRuntimeAdapterError("projection_invalid");
        }
        return snapshot;
      }
      if (next.value.kind === "snapshot") {
        snapshot = next.value.snapshot;
      } else if (snapshot !== undefined) {
        snapshot = applyShellStreamEvent(snapshot, next.value);
      } else {
        throw new NativeRuntimeAdapterError("projection_invalid");
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

function projectCommand(
  input: NativeCreateProjectInput,
): ClientOrchestrationCommand {
  return Schema.decodeUnknownSync(ClientOrchestrationCommand)({
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
    defaultModelSelection: input.defaultModelSelection,
    createdAt: input.createdAt,
  });
}

function spawnCommand(
  input: NativeStartThreadInput,
): ClientOrchestrationCommand {
  return Schema.decodeUnknownSync(ClientOrchestrationCommand)({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.message,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  });
}

function turnCommand(input: NativeStartTurnInput): ClientOrchestrationCommand {
  return Schema.decodeUnknownSync(ClientOrchestrationCommand)({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.message,
      attachments: [],
    },
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: input.createdAt,
  });
}

export function createT3NativeRuntime(
  options: T3NativeRuntimeOptions,
): NativeRuntime {
  const sessionFactory =
    options.sessionFactory ?? createDefaultSessionFactory();

  const openSession = async (): Promise<RuntimeClientSession> => {
    try {
      const socketUrl = await options.acquireSocketUrl();
      return await sessionFactory.connect({
        environmentId: options.environmentId,
        label: options.label,
        socketUrl,
      });
    } catch (error) {
      throw adapterError(error, "transport_unavailable");
    }
  };

  const dispatch = async (
    command: ClientOrchestrationCommand,
  ): Promise<{ readonly sequence: number }> => {
    const session = await openSession();
    try {
      return await session.dispatchCommand(command);
    } catch (error) {
      throw dispatchError(error);
    } finally {
      await closeQuietly(session);
    }
  };

  return {
    async listProjects(): Promise<readonly NativeProject[]> {
      const session = await openSession();
      try {
        const snapshot = await readShellSnapshot(session);
        return snapshot.projects.map((entry) => ({
          projectId: entry.id,
          workspaceRoot: entry.workspaceRoot,
        }));
      } finally {
        await closeQuietly(session);
      }
    },
    createProject: (input) => dispatch(projectCommand(input)),
    startThread: (input) => dispatch(spawnCommand(input)),
    startTurn: (input) => dispatch(turnCommand(input)),
    async getThread(threadId): Promise<NativeThreadSnapshot | undefined> {
      const session = await openSession();
      try {
        for await (const state of reconcileThread(session, threadId)) {
          return state.observation.snapshot;
        }
        return undefined;
      } finally {
        await closeQuietly(session);
      }
    },
    async *subscribeThread(
      threadId,
      input,
    ): AsyncIterable<NativeThreadObservation> {
      const session = await openSession();
      try {
        if (input.afterSequence === undefined) {
          for await (const state of reconcileThread(session, threadId)) {
            yield state.observation;
          }
          return;
        }

        let initial: ReconciledThreadState | undefined;
        for await (const state of reconcileThread(session, threadId)) {
          initial = state;
          break;
        }
        if (initial === undefined) return;
        if (initial.observation.sequence > input.afterSequence) {
          yield initial.observation;
        }
        const resumeFromSequence = initial.observation.sequence;
        for await (const state of reconcileThread(session, threadId, {
          seed: initial,
          resumeFromSequence,
          emitAfterSequence: Math.max(input.afterSequence, resumeFromSequence),
        })) {
          yield state.observation;
        }
      } finally {
        await closeQuietly(session);
      }
    },
  };
}
