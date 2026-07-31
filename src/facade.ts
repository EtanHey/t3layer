export interface NativeProject {
  readonly projectId: string;
  readonly workspaceRoot: string;
}

export interface NativeThreadSnapshot {
  readonly threadId: string;
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly session: {
    readonly status: string;
    readonly activeTurnId: string | null;
  };
  readonly latestTurn: {
    readonly turnId: string;
    readonly status: string;
    readonly userMessageId?: string;
    readonly assistantMessage?: {
      readonly content: string;
      readonly streaming: boolean;
    } | null;
  } | null;
  readonly pendingApproval?: unknown;
  readonly pendingInput?: unknown;
}

export interface NativeStartThreadInput {
  readonly commandId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly title: string;
  readonly message: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt: string;
  readonly attachments: readonly [];
}

export interface NativeCreateProjectInput {
  readonly commandId: string;
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing: false;
  readonly defaultModelSelection: ModelSelection;
  readonly createdAt: string;
}

export interface NativeStartTurnInput {
  readonly commandId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly message: string;
  readonly createdAt: string;
  readonly attachments: readonly [];
}

export interface NativeRuntime {
  readonly listProjects: () => Promise<readonly NativeProject[]>;
  readonly createProject: (
    input: NativeCreateProjectInput,
  ) => Promise<{ readonly sequence: number }>;
  readonly startThread: (
    input: NativeStartThreadInput,
  ) => Promise<{ readonly sequence: number }>;
  readonly startTurn: (
    input: NativeStartTurnInput,
  ) => Promise<{ readonly sequence: number }>;
  readonly getThread: (
    threadId: string,
  ) => Promise<NativeThreadSnapshot | undefined>;
  readonly subscribeThread: (
    threadId: string,
    input: { readonly afterSequence?: number },
  ) => AsyncIterable<NativeThreadObservation>;
}

export interface NativeThreadObservation {
  readonly sequence: number;
  readonly snapshot: NativeThreadSnapshot;
}

export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly value: string;
  }>;
}

export interface SpawnInput {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly message: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface AgentSnapshot {
  readonly agentId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly native: NativeThreadSnapshot;
}

interface TurnReceiptBase {
  readonly agentId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly sequence: number;
}

export type TurnReceipt =
  | (TurnReceiptBase & {
      readonly recovered: false;
      readonly sequenceSource: "dispatch";
    })
  | (TurnReceiptBase & {
      readonly recovered: true;
      readonly sequenceSource: "projection";
    });

export type AgentLifecycle =
  | "starting"
  | "running"
  | "ready"
  | "awaiting_input"
  | "completed"
  | "interrupted"
  | "stopped"
  | "error"
  | "unknown";

export interface AgentEvent {
  readonly agentId: string;
  readonly sequence: number;
  readonly lifecycle: AgentLifecycle;
  readonly assistantContent?: string;
  readonly native: NativeThreadSnapshot;
}

export interface WaitCondition {
  readonly kind: "terminal";
  readonly timeoutMs: number;
  readonly maxEvidenceBytes: number;
}

export type FacadeErrorCode =
  | "empty_assistant_response"
  | "transport_unavailable"
  | "timeout"
  | "buffer_exhausted"
  | "turn_error";

export class FacadeError extends Error {
  readonly code: FacadeErrorCode;
  readonly sequence: number;
  readonly structuralSnapshot: Readonly<Record<string, unknown>>;

  constructor(code: FacadeErrorCode, snapshot: NativeThreadSnapshot) {
    super(code);
    this.name = "FacadeError";
    this.code = code;
    this.sequence = snapshot.snapshotSequence;
    this.structuralSnapshot = {
      threadId: snapshot.threadId,
      projectId: snapshot.projectId,
      snapshotSequence: snapshot.snapshotSequence,
      session: {
        status: snapshot.session.status,
        activeTurnId: snapshot.session.activeTurnId,
      },
      latestTurn:
        snapshot.latestTurn === null
          ? null
          : {
              turnId: snapshot.latestTurn.turnId,
              status: snapshot.latestTurn.status,
              userMessageId: snapshot.latestTurn.userMessageId,
              assistantMessage:
                snapshot.latestTurn.assistantMessage == null
                  ? null
                  : {
                      streaming: snapshot.latestTurn.assistantMessage.streaming,
                      contentBytes: new TextEncoder().encode(
                        snapshot.latestTurn.assistantMessage.content,
                      ).byteLength,
                    },
            },
      hasPendingApproval: snapshot.pendingApproval != null,
      hasPendingInput: snapshot.pendingInput != null,
    };
  }
}

export interface FacadeOptions {
  readonly id?: () => string;
  readonly now?: () => string;
  readonly evidence?: (record: Readonly<Record<string, unknown>>) => void;
}

export class AmbiguousDispatchError extends Error {
  constructor() {
    super("native dispatch outcome is ambiguous");
    this.name = "AmbiguousDispatchError";
  }
}

function defaultId(): string {
  return crypto.randomUUID();
}

function unavailableSnapshot(
  threadId: string,
  projectId = "",
): NativeThreadSnapshot {
  return {
    threadId,
    projectId,
    snapshotSequence: 0,
    session: { status: "unknown", activeTurnId: null },
    latestTurn: null,
    pendingApproval: null,
    pendingInput: null,
  };
}

async function callRuntime<T>(
  operation: () => Promise<T>,
  snapshot: NativeThreadSnapshot,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof FacadeError ||
      error instanceof AmbiguousDispatchError
    ) {
      throw error;
    }
    throw new FacadeError("transport_unavailable", snapshot);
  }
}

function toAgentSnapshot(snapshot: NativeThreadSnapshot): AgentSnapshot {
  return {
    agentId: snapshot.threadId,
    projectId: snapshot.projectId,
    sequence: snapshot.snapshotSequence,
    native: snapshot,
  };
}

function matchesSpawnIdentity(
  snapshot: NativeThreadSnapshot,
  threadId: string,
  projectId: string,
  messageId: string,
): boolean {
  return (
    snapshot.threadId === threadId &&
    snapshot.projectId === projectId &&
    snapshot.latestTurn?.userMessageId === messageId
  );
}

function toAgentEvent(snapshot: NativeThreadSnapshot): AgentEvent {
  const assistant = snapshot.latestTurn?.assistantMessage;
  let lifecycle: AgentLifecycle;
  if (
    snapshot.session.status === "interrupted" ||
    snapshot.latestTurn?.status === "interrupted"
  ) {
    lifecycle = "interrupted";
  } else if (
    snapshot.session.status === "error" ||
    snapshot.latestTurn?.status === "error"
  ) {
    lifecycle = "error";
  } else if (
    snapshot.pendingApproval != null ||
    snapshot.pendingInput != null
  ) {
    lifecycle = "awaiting_input";
  } else if (snapshot.session.status === "stopped") {
    lifecycle = "stopped";
  } else if (
    snapshot.session.status === "ready" &&
    snapshot.latestTurn?.status === "completed" &&
    assistant !== null &&
    assistant !== undefined &&
    !assistant.streaming &&
    assistant.content.trim().length > 0
  ) {
    lifecycle = "completed";
  } else if (
    snapshot.session.status === "starting" &&
    snapshot.session.activeTurnId === null
  ) {
    lifecycle = "starting";
  } else if (
    snapshot.session.status === "running" ||
    snapshot.session.activeTurnId !== null ||
    assistant?.streaming === true
  ) {
    lifecycle = "running";
  } else if (snapshot.session.status === "ready") {
    lifecycle = "ready";
  } else {
    lifecycle = "unknown";
  }

  return {
    agentId: snapshot.threadId,
    sequence: snapshot.snapshotSequence,
    lifecycle,
    ...(assistant !== null &&
    assistant !== undefined &&
    !assistant.streaming &&
    assistant.content.trim().length > 0
      ? { assistantContent: assistant.content }
      : {}),
    native: snapshot,
  };
}

function requireSendableThread(
  snapshot: NativeThreadSnapshot | undefined,
  agentId: string,
  unavailableBoundary: NativeThreadSnapshot,
): NativeThreadSnapshot {
  if (snapshot === undefined) {
    throw new FacadeError("transport_unavailable", unavailableBoundary);
  }
  if (snapshot.threadId !== agentId) {
    throw new FacadeError("transport_unavailable", snapshot);
  }
  if (
    snapshot.session.activeTurnId !== null ||
    snapshot.session.status === "starting" ||
    snapshot.session.status === "running" ||
    snapshot.latestTurn?.status === "running" ||
    snapshot.pendingApproval != null ||
    snapshot.pendingInput != null
  ) {
    throw new FacadeError("turn_error", snapshot);
  }
  return snapshot;
}

function isTerminal(event: AgentEvent): boolean {
  return (
    event.lifecycle === "completed" ||
    event.lifecycle === "interrupted" ||
    event.lifecycle === "stopped" ||
    event.lifecycle === "error" ||
    event.lifecycle === "awaiting_input"
  );
}

function eventEvidenceBytes(event: AgentEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

function assertNonEmptyTerminal(snapshot: NativeThreadSnapshot): void {
  const assistant = snapshot.latestTurn?.assistantMessage;
  if (
    snapshot.session.status === "ready" &&
    snapshot.latestTurn?.status === "completed" &&
    (assistant == null ||
      (!assistant.streaming && assistant.content.trim().length === 0))
  ) {
    throw new FacadeError("empty_assistant_response", snapshot);
  }
}

export function createT3Facade(
  runtime: NativeRuntime,
  options: FacadeOptions = {},
) {
  const id = options.id ?? defaultId;
  const now = options.now ?? (() => new Date().toISOString());
  const evidence = options.evidence ?? (() => undefined);

  return {
    async spawn(input: SpawnInput): Promise<AgentSnapshot> {
      const projectBoundary = unavailableSnapshot("unallocated");
      const projects = await callRuntime(
        () => runtime.listProjects(),
        projectBoundary,
      );
      let project = projects.find(
        (candidate) => candidate.workspaceRoot === input.workspaceRoot,
      );
      const createdAt = now();
      if (project === undefined) {
        const projectId = id();
        const projectCommand: NativeCreateProjectInput = {
          commandId: id(),
          projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: input.modelSelection,
          createdAt,
        };
        const requestedProject = {
          projectId,
          workspaceRoot: input.workspaceRoot,
        };
        try {
          await callRuntime(
            () => runtime.createProject(projectCommand),
            projectBoundary,
          );
          project = requestedProject;
        } catch (error) {
          if (!(error instanceof AmbiguousDispatchError)) throw error;
          project = (
            await callRuntime(() => runtime.listProjects(), projectBoundary)
          ).find(
            (candidate) => candidate.workspaceRoot === input.workspaceRoot,
          );
          if (project === undefined) {
            try {
              await callRuntime(
                () => runtime.createProject(projectCommand),
                projectBoundary,
              );
              project = requestedProject;
            } catch (retryError) {
              if (!(retryError instanceof AmbiguousDispatchError)) {
                throw retryError;
              }
              project = (
                await callRuntime(() => runtime.listProjects(), projectBoundary)
              ).find(
                (candidate) => candidate.workspaceRoot === input.workspaceRoot,
              );
              if (project === undefined) throw retryError;
            }
          }
        }
      }

      const threadId = id();
      const commandId = id();
      const messageId = id();
      const command: NativeStartThreadInput = {
        commandId,
        projectId: project.projectId,
        threadId,
        messageId,
        title: input.title,
        message: input.message,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt,
        attachments: [],
      };
      const threadBoundary = unavailableSnapshot(threadId, project.projectId);

      evidence({
        operation: "spawn",
        commandId,
        projectId: project.projectId,
        threadId,
        messageId,
        workspaceRoot: input.workspaceRoot,
        modelSelection: {
          instanceId: input.modelSelection.instanceId,
          model: input.modelSelection.model,
          optionCount: input.modelSelection.options.length,
        },
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt,
        attachments: 0,
        messageBytes: new TextEncoder().encode(input.message).byteLength,
      });
      try {
        await callRuntime(() => runtime.startThread(command), threadBoundary);
      } catch (error) {
        if (!(error instanceof AmbiguousDispatchError)) throw error;
        const recovered = await callRuntime(
          () => runtime.getThread(threadId),
          threadBoundary,
        );
        if (recovered !== undefined) {
          if (
            !matchesSpawnIdentity(
              recovered,
              threadId,
              project.projectId,
              messageId,
            )
          ) {
            throw error;
          }
          return toAgentSnapshot(recovered);
        }
        try {
          await callRuntime(() => runtime.startThread(command), threadBoundary);
        } catch (retryError) {
          if (!(retryError instanceof AmbiguousDispatchError)) {
            throw retryError;
          }
          const finalSnapshot = await callRuntime(
            () => runtime.getThread(threadId),
            threadBoundary,
          );
          if (
            finalSnapshot === undefined ||
            !matchesSpawnIdentity(
              finalSnapshot,
              threadId,
              project.projectId,
              messageId,
            )
          ) {
            throw retryError;
          }
          return toAgentSnapshot(finalSnapshot);
        }
      }

      const snapshot = await callRuntime(
        () => runtime.getThread(threadId),
        threadBoundary,
      );
      if (snapshot === undefined) {
        throw new FacadeError("transport_unavailable", threadBoundary);
      }
      if (
        !matchesSpawnIdentity(snapshot, threadId, project.projectId, messageId)
      ) {
        throw new FacadeError("transport_unavailable", snapshot);
      }
      return toAgentSnapshot(snapshot);
    },

    async send(agentId: string, message: string): Promise<TurnReceipt> {
      const sendBoundary = unavailableSnapshot(agentId);
      const current = requireSendableThread(
        await callRuntime(() => runtime.getThread(agentId), sendBoundary),
        agentId,
        sendBoundary,
      );

      const commandId = id();
      const messageId = id();
      const createdAt = now();
      const command: NativeStartTurnInput = {
        commandId,
        threadId: agentId,
        messageId,
        message,
        createdAt,
        attachments: [],
      };
      evidence({
        operation: "send",
        commandId,
        threadId: agentId,
        messageId,
        createdAt,
        attachments: 0,
        messageBytes: new TextEncoder().encode(message).byteLength,
      });
      let receipt: { readonly sequence: number };
      try {
        receipt = await callRuntime(() => runtime.startTurn(command), current);
      } catch (error) {
        if (!(error instanceof AmbiguousDispatchError)) throw error;
        const snapshot = await callRuntime(
          () => runtime.getThread(agentId),
          current,
        );
        if (
          snapshot?.threadId === agentId &&
          snapshot.latestTurn?.userMessageId === messageId
        ) {
          return {
            agentId,
            commandId,
            messageId,
            sequence: snapshot.snapshotSequence,
            sequenceSource: "projection",
            recovered: true,
          };
        }
        requireSendableThread(snapshot, agentId, current);
        try {
          receipt = await callRuntime(
            () => runtime.startTurn(command),
            current,
          );
        } catch (retryError) {
          if (!(retryError instanceof AmbiguousDispatchError)) {
            throw retryError;
          }
          const finalSnapshot = await callRuntime(
            () => runtime.getThread(agentId),
            current,
          );
          if (
            finalSnapshot?.threadId !== agentId ||
            finalSnapshot.latestTurn?.userMessageId !== messageId
          ) {
            throw retryError;
          }
          return {
            agentId,
            commandId,
            messageId,
            sequence: finalSnapshot.snapshotSequence,
            sequenceSource: "projection",
            recovered: true,
          };
        }
      }
      return {
        agentId,
        commandId,
        messageId,
        sequence: receipt.sequence,
        sequenceSource: "dispatch",
        recovered: false,
      };
    },

    async *wait(
      agentId: string,
      condition: WaitCondition,
    ): AsyncIterable<AgentEvent> {
      const deadline = Date.now() + condition.timeoutMs;
      const initialBoundary = unavailableSnapshot(agentId);
      let initialTimer: ReturnType<typeof setTimeout> | undefined;
      const initialTimeout = new Promise<never>((_, reject) => {
        initialTimer = setTimeout(
          () => reject(new FacadeError("timeout", initialBoundary)),
          Math.max(0, deadline - Date.now()),
        );
      });
      let initial: NativeThreadSnapshot | undefined;
      try {
        initial = await Promise.race([
          callRuntime(() => runtime.getThread(agentId), initialBoundary),
          initialTimeout,
        ]);
      } finally {
        if (initialTimer !== undefined) clearTimeout(initialTimer);
      }
      if (initial === undefined) {
        throw new FacadeError("transport_unavailable", initialBoundary);
      }
      if (initial.threadId !== agentId) {
        throw new FacadeError("transport_unavailable", initial);
      }

      assertNonEmptyTerminal(initial);
      const initialEvent = toAgentEvent(initial);
      let evidenceBytes = eventEvidenceBytes(initialEvent);
      if (evidenceBytes > condition.maxEvidenceBytes) {
        throw new FacadeError("buffer_exhausted", initial);
      }
      yield initialEvent;
      if (isTerminal(initialEvent)) return;

      let lastSnapshot = initial;
      let lastObservationSequence = initial.snapshotSequence;
      let iterator: AsyncIterator<NativeThreadObservation>;
      try {
        iterator = runtime
          .subscribeThread(agentId, {
            afterSequence: initial.snapshotSequence,
          })
          [Symbol.asyncIterator]();
      } catch {
        throw new FacadeError("transport_unavailable", lastSnapshot);
      }
      try {
        while (true) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw new FacadeError("timeout", lastSnapshot);
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new FacadeError("timeout", lastSnapshot)),
              remainingMs,
            );
          });
          let next: IteratorResult<NativeThreadObservation>;
          try {
            try {
              next = await Promise.race([iterator.next(), timeout]);
            } catch (error) {
              if (error instanceof FacadeError) throw error;
              throw new FacadeError("transport_unavailable", lastSnapshot);
            }
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (next.done) {
            throw new FacadeError("transport_unavailable", lastSnapshot);
          }
          if (next.value.snapshot.threadId !== agentId) {
            throw new FacadeError("transport_unavailable", next.value.snapshot);
          }
          if (next.value.sequence <= lastObservationSequence) {
            throw new FacadeError("transport_unavailable", lastSnapshot);
          }
          lastObservationSequence = next.value.sequence;
          lastSnapshot = next.value.snapshot;
          assertNonEmptyTerminal(lastSnapshot);
          const event = toAgentEvent(lastSnapshot);
          evidenceBytes += eventEvidenceBytes(event);
          if (evidenceBytes > condition.maxEvidenceBytes) {
            throw new FacadeError("buffer_exhausted", lastSnapshot);
          }
          yield event;
          if (isTerminal(event)) return;
        }
      } finally {
        try {
          const teardown = iterator.return?.();
          if (teardown !== undefined) {
            void teardown.catch(() => undefined);
          }
        } catch {
          // Teardown must not replace the caller-visible wait outcome.
        }
      }
    },
  };
}
