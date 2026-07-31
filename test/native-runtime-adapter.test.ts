import { describe, expect, test } from "bun:test";
import type {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationThreadStreamItem,
  RuntimeClientRpcSessionFactory,
} from "@t3tools/runtime-client";
import * as Effect from "effect/Effect";
import {
  createDefaultSessionFactory,
  createT3NativeRuntime,
  type RuntimeClientSession,
  type RuntimeClientSessionFactory,
} from "../src/nativeRuntime";

const NOW = "2026-07-31T00:00:00.000Z";
const MODEL = {
  instanceId: "codex",
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
} as const;
const BOOLEAN_MODEL = {
  instanceId: "codex",
  model: "gpt-5.6-sol",
  options: [{ id: "fastMode", value: true }],
} as const;

function project(
  id = "project-1",
  workspaceRoot = "/repo",
): OrchestrationProjectShell {
  return {
    id,
    title: "Project",
    workspaceRoot,
    defaultModelSelection: MODEL,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as OrchestrationProjectShell;
}

function thread(
  sequence: number,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Worker",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: NOW,
    updatedAt: `${NOW.slice(0, -5)}${String(sequence).padStart(3, "0")}Z`,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: "message-user",
        role: "user",
        text: "work",
        turnId: "turn-1",
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: "thread-1",
      status: "running",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt: NOW,
    },
    ...overrides,
  } as unknown as OrchestrationThread;
}

function shellThread(
  sequence: number,
  options: {
    readonly pendingApproval?: boolean;
    readonly pendingInput?: boolean;
    readonly status?: "running" | "ready";
  } = {},
): OrchestrationThreadShell {
  const status = options.status ?? "running";
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Worker",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1",
      state: status === "ready" ? "completed" : "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: status === "ready" ? NOW : null,
      assistantMessageId: status === "ready" ? "message-assistant" : null,
    },
    createdAt: NOW,
    updatedAt: `${NOW.slice(0, -5)}${String(sequence).padStart(3, "0")}Z`,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: "thread-1",
      status,
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: status === "running" ? "turn-1" : null,
      lastError: null,
      updatedAt: NOW,
    },
    latestUserMessageAt: NOW,
    hasPendingApprovals: options.pendingApproval ?? false,
    hasPendingUserInput: options.pendingInput ?? false,
    hasActionableProposedPlan: false,
  } as unknown as OrchestrationThreadShell;
}

function shellSnapshot(
  sequence: number,
  threads: readonly OrchestrationThreadShell[] = [],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [project()],
    threads: [...threads],
    updatedAt: NOW,
  };
}

function stream<T>(
  items: readonly T[],
  onReturn?: () => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= items.length) return { done: true, value: undefined };
          return { done: false, value: items[index++]! };
        },
        async return() {
          onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function scriptedStream<T>(
  script: ReadonlyArray<{
    readonly delayMs: number;
    readonly item: T;
  }>,
  onReturn?: () => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          const entry = script[index++];
          if (entry === undefined) return { done: true, value: undefined };
          if (entry.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
          }
          return { done: false, value: entry.item };
        },
        async return() {
          onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

type PromiseOutcome<T> =
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "pending" };

async function outcomeWithin<T>(
  promise: Promise<T>,
  timeoutMs = 100,
): Promise<PromiseOutcome<T>> {
  return Promise.race([
    promise.then(
      (value): PromiseOutcome<T> => ({ kind: "resolved", value }),
      (error): PromiseOutcome<T> => ({ kind: "rejected", error }),
    ),
    new Promise<PromiseOutcome<T>>((resolve) => {
      setTimeout(() => resolve({ kind: "pending" }), timeoutMs);
    }),
  ]);
}

describe("T3 native runtime adapter", () => {
  test("maps project and turn operations onto canonical RPC commands", async () => {
    const commands: unknown[] = [];
    const connections: Array<{
      readonly environmentId: string;
      readonly label: string;
      readonly socketUrl: string;
    }> = [];
    let closes = 0;
    const sessionFactory: RuntimeClientSessionFactory = {
      async connect(connection) {
        connections.push(connection);
        return {
          async dispatchCommand(command) {
            commands.push(command);
            return { sequence: commands.length };
          },
          subscribeShell: () =>
            stream<OrchestrationShellStreamItem>([
              { kind: "snapshot", snapshot: shellSnapshot(4) },
              { kind: "synchronized" },
            ]),
          subscribeThread: () => stream([]),
          async close() {
            closes += 1;
          },
        };
      },
    };
    let socketAcquisitions = 0;
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () =>
        `ws://127.0.0.1/socket?token=${++socketAcquisitions}`,
      sessionFactory,
    });

    expect(await runtime.listProjects()).toEqual([
      { projectId: "project-1", workspaceRoot: "/repo" },
    ]);
    expect(
      await runtime.createProject({
        commandId: "command-project",
        projectId: "project-new",
        title: "New Project",
        workspaceRoot: "/new",
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: MODEL,
        createdAt: NOW,
      }),
    ).toEqual({ sequence: 1 });
    expect(
      await runtime.startThread({
        commandId: "command-spawn",
        projectId: "project-1",
        threadId: "thread-1",
        messageId: "message-user",
        title: "Worker",
        message: "Do the work",
        modelSelection: BOOLEAN_MODEL,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        attachments: [],
      }),
    ).toEqual({ sequence: 2 });
    expect(
      await runtime.startTurn({
        commandId: "command-send",
        threadId: "thread-1",
        messageId: "message-follow-up",
        message: "Continue",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
        attachments: [],
      }),
    ).toEqual({ sequence: 3 });

    expect(commands).toEqual([
      {
        type: "project.create",
        commandId: "command-project",
        projectId: "project-new",
        title: "New Project",
        workspaceRoot: "/new",
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: MODEL,
        createdAt: NOW,
      },
      {
        type: "thread.turn.start",
        commandId: "command-spawn",
        threadId: "thread-1",
        message: {
          messageId: "message-user",
          role: "user",
          text: "Do the work",
          attachments: [],
        },
        modelSelection: BOOLEAN_MODEL,
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: "project-1",
            title: "Worker",
            modelSelection: BOOLEAN_MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          },
        },
        createdAt: NOW,
      },
      {
        type: "thread.turn.start",
        commandId: "command-send",
        threadId: "thread-1",
        message: {
          messageId: "message-follow-up",
          role: "user",
          text: "Continue",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
      },
    ]);
    expect(connections).toHaveLength(4);
    expect(socketAcquisitions).toBe(4);
    expect(closes).toBe(4);
  });

  test("sanitizes unsent command projection failures without opening a session", async () => {
    const secret = "projection-super-secret";
    const invalidCreatedAt = "not-an-iso-date";
    let connects = 0;
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: {
        async connect() {
          connects += 1;
          throw new Error("must not connect");
        },
      },
    });
    const invalidCalls = [
      () =>
        runtime.createProject({
          commandId: "",
          projectId: "project-new",
          title: secret,
          workspaceRoot: "/new",
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: MODEL,
          createdAt: invalidCreatedAt,
        }),
      () =>
        runtime.startThread({
          commandId: "",
          projectId: "project-1",
          threadId: "thread-1",
          messageId: "message-user",
          title: "Worker",
          message: secret,
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: invalidCreatedAt,
          attachments: [],
        }),
      () =>
        runtime.startTurn({
          commandId: "",
          threadId: "thread-1",
          messageId: "message-follow-up",
          message: secret,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: invalidCreatedAt,
          attachments: [],
        }),
    ];

    for (const call of invalidCalls) {
      const outcome = await outcomeWithin(Promise.resolve().then(call));
      expect(outcome).toMatchObject({
        kind: "rejected",
        error: {
          name: "NativeRuntimeAdapterError",
          code: "command_rejected",
        },
      });
      if (outcome.kind !== "rejected") {
        throw new Error("expected rejected command projection");
      }
      expect(String(outcome.error)).toBe(
        "NativeRuntimeAdapterError: command_rejected",
      );
      expect((outcome.error as Error).message).toBe("command_rejected");
      expect(String(outcome.error)).not.toContain(secret);
      expect(String(outcome.error)).not.toContain("ParseError");
      expect((outcome.error as Error).name).not.toBe("AmbiguousDispatchError");
    }
    expect(connects).toBe(0);
  });

  test("reconciles a pending-only shell snapshot ahead of a synchronized detail snapshot", async () => {
    const subscriptionInputs: unknown[] = [];
    let closes = 0;
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell(input) {
        subscriptionInputs.push(["shell", input]);
        return stream([
          {
            kind: "snapshot",
            snapshot: shellSnapshot(11, [
              shellThread(11, { pendingApproval: true }),
            ]),
          },
          { kind: "synchronized" },
        ]);
      },
      subscribeThread(input) {
        subscriptionInputs.push(["thread", input]);
        return stream([
          {
            kind: "snapshot",
            snapshot: { snapshotSequence: 10, thread: thread(10) },
          },
          { kind: "synchronized" },
        ]);
      },
      async close() {
        closes += 1;
      },
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    const snapshot = await runtime.getThread("thread-1");

    expect(snapshot).toMatchObject({
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 11,
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: {
        turnId: "turn-1",
        status: "running",
        userMessageId: "message-user",
      },
      pendingApproval: true,
      pendingInput: null,
    });
    expect(subscriptionInputs).toHaveLength(3);
    expect(subscriptionInputs).toContainEqual([
      "shell",
      { requestCompletionMarker: true },
    ]);
    expect(subscriptionInputs).toContainEqual([
      "thread",
      { threadId: "thread-1", requestCompletionMarker: true },
    ]);
    expect(subscriptionInputs).toContainEqual([
      "thread",
      {
        threadId: "thread-1",
        afterSequence: 10,
        requestCompletionMarker: true,
      },
    ]);
    expect(closes).toBe(1);
  });

  test("preserves initial user-message identity before a provider turn is assigned", async () => {
    const unassignedThread = thread(4, {
      latestTurn: null,
      messages: [
        {
          id: "message-pending",
          role: "user",
          text: "start",
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      session: {
        threadId: "thread-1",
        status: "starting",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    } as unknown as Partial<OrchestrationThread>);
    const unassignedShell = {
      ...shellThread(4),
      latestTurn: null,
      session: unassignedThread.session,
    } as unknown as OrchestrationThreadShell;
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: {
        async connect() {
          return {
            async dispatchCommand() {
              return { sequence: 1 };
            },
            subscribeShell() {
              return stream([
                {
                  kind: "snapshot",
                  snapshot: shellSnapshot(4, [unassignedShell]),
                },
                { kind: "synchronized" },
              ]);
            },
            subscribeThread() {
              return stream([
                {
                  kind: "snapshot",
                  snapshot: {
                    snapshotSequence: 4,
                    thread: unassignedThread,
                  },
                },
                { kind: "synchronized" },
              ]);
            },
            async close() {},
          };
        },
      },
    });

    const snapshot = await runtime.getThread("thread-1");

    expect(snapshot).toMatchObject({
      threadId: "thread-1",
      projectId: "project-1",
      snapshotSequence: 4,
      session: { status: "starting", activeTurnId: null },
      latestUserMessageId: "message-pending",
      latestTurn: null,
    });
  });

  test("reconciles a synchronized detail snapshot ahead of a compatible shell snapshot", async () => {
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: {
        async connect() {
          return {
            async dispatchCommand() {
              return { sequence: 1 };
            },
            subscribeShell: () =>
              stream([
                {
                  kind: "snapshot",
                  snapshot: shellSnapshot(10, [shellThread(10)]),
                },
                { kind: "synchronized" },
              ]),
            subscribeThread: () =>
              stream([
                {
                  kind: "snapshot",
                  snapshot: { snapshotSequence: 11, thread: thread(11) },
                },
                { kind: "synchronized" },
              ]),
            async close() {},
          };
        },
      },
    });

    expect(await runtime.getThread("thread-1")).toMatchObject({
      threadId: "thread-1",
      snapshotSequence: 11,
      session: { status: "running", activeTurnId: "turn-1" },
      pendingApproval: null,
      pendingInput: null,
    });
  });

  test("returns undefined for a synchronized missing shell thread even if detail lookup rejects", async () => {
    let closes = 0;
    const missingDetail: AsyncIterable<OrchestrationThreadStreamItem> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<OrchestrationThreadStreamItem>> {
            throw { _tag: "OrchestrationGetSnapshotError" };
          },
        };
      },
    };
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell() {
        return scriptedStream([
          {
            delayMs: 5,
            item: { kind: "snapshot", snapshot: shellSnapshot(10) },
          },
          { delayMs: 0, item: { kind: "synchronized" } },
        ]);
      },
      subscribeThread() {
        return missingDetail;
      },
      async close() {
        closes += 1;
      },
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    expect(await runtime.getThread("missing-thread")).toBeUndefined();
    expect(closes).toBe(1);
  });

  test("does not swallow a detail failure when shell absence was never synchronized", async () => {
    const failingDetail: AsyncIterable<OrchestrationThreadStreamItem> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<OrchestrationThreadStreamItem>> {
            throw { _tag: "OrchestrationGetSnapshotError" };
          },
        };
      },
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: {
        async connect() {
          return {
            async dispatchCommand() {
              return { sequence: 1 };
            },
            subscribeShell: () => stream([]),
            subscribeThread: () => failingDetail,
            async close() {},
          };
        },
      },
    });

    await expect(runtime.getThread("thread-1")).rejects.toMatchObject({
      name: "NativeRuntimeAdapterError",
      code: "transport_unavailable",
    });
  });

  test("waits for a same-sequence detail update when a detail-relevant shell update arrives first", async () => {
    const readyEvent = {
      ...eventBase(11, "thread.session-set"),
      payload: {
        threadId: "thread-1",
        session: {
          ...thread(11).session!,
          status: "ready",
          activeTurnId: null,
          updatedAt: NOW,
        },
      },
    } as OrchestrationEvent;
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell() {
        return scriptedStream([
          {
            delayMs: 0,
            item: {
              kind: "snapshot",
              snapshot: shellSnapshot(10, [shellThread(10)]),
            },
          },
          { delayMs: 0, item: { kind: "synchronized" } },
          {
            delayMs: 1,
            item: {
              kind: "thread-upserted",
              sequence: 11,
              thread: shellThread(11, { status: "ready" }),
            },
          },
        ]);
      },
      subscribeThread() {
        return scriptedStream([
          {
            delayMs: 0,
            item: {
              kind: "snapshot",
              snapshot: { snapshotSequence: 10, thread: thread(10) },
            },
          },
          { delayMs: 0, item: { kind: "synchronized" } },
          { delayMs: 15, item: { kind: "event", event: readyEvent } },
        ]);
      },
      async close() {},
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    const observations = [];
    for await (const observation of runtime.subscribeThread("thread-1", {})) {
      observations.push(observation);
      if (observation.sequence === 11) break;
    }

    expect(observations.map(({ sequence }) => sequence)).toEqual([10, 11]);
    expect(observations[1]?.snapshot.session).toEqual({
      status: "ready",
      activeTurnId: null,
    });
  });

  test("does not let a shell-first same-sequence upsert suppress a detail-only message update", async () => {
    const assistantEvent = {
      ...eventBase(11, "thread.message-sent"),
      payload: {
        threadId: "thread-1",
        messageId: "message-assistant",
        role: "assistant",
        text: "AB",
        turnId: "turn-1",
        streaming: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as OrchestrationEvent;
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell: () =>
        scriptedStream([
          {
            delayMs: 0,
            item: {
              kind: "snapshot",
              snapshot: shellSnapshot(10, [shellThread(10)]),
            },
          },
          { delayMs: 0, item: { kind: "synchronized" } },
          {
            delayMs: 1,
            item: {
              kind: "thread-upserted",
              sequence: 11,
              thread: shellThread(11),
            },
          },
        ]),
      subscribeThread: () =>
        scriptedStream([
          {
            delayMs: 0,
            item: {
              kind: "snapshot",
              snapshot: { snapshotSequence: 10, thread: thread(10) },
            },
          },
          { delayMs: 0, item: { kind: "synchronized" } },
          { delayMs: 15, item: { kind: "event", event: assistantEvent } },
        ]),
      async close() {},
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    const observations = [];
    for await (const observation of runtime.subscribeThread("thread-1", {})) {
      observations.push(observation);
      if (observation.sequence === 11) break;
    }

    expect(observations.map(({ sequence }) => sequence)).toEqual([10, 11]);
    expect(
      observations[1]?.snapshot.latestTurn?.assistantMessage,
    ).toMatchObject({
      content: "AB",
      streaming: true,
    });
  });

  test("replays an initially lagging detail stream before emitting a newer shell snapshot sequence", async () => {
    const assistantEvent = {
      ...eventBase(11, "thread.message-sent"),
      payload: {
        threadId: "thread-1",
        messageId: "message-assistant",
        role: "assistant",
        text: "AB",
        turnId: "turn-1",
        streaming: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as OrchestrationEvent;
    const detailInputs: unknown[] = [];
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell: () =>
        stream([
          {
            kind: "snapshot",
            snapshot: shellSnapshot(11, [shellThread(11)]),
          },
          { kind: "synchronized" },
        ]),
      subscribeThread(input) {
        detailInputs.push(input);
        if (input.afterSequence === 10) {
          return stream([
            { kind: "event", event: assistantEvent },
            { kind: "synchronized" },
          ]);
        }
        return scriptedStream([
          {
            delayMs: 0,
            item: {
              kind: "snapshot",
              snapshot: { snapshotSequence: 10, thread: thread(10) },
            },
          },
          { delayMs: 0, item: { kind: "synchronized" } },
          { delayMs: 25, item: { kind: "event", event: assistantEvent } },
        ]);
      },
      async close() {},
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    const snapshot = await runtime.getThread("thread-1");

    expect(snapshot?.snapshotSequence).toBe(11);
    expect(snapshot?.latestTurn?.assistantMessage).toMatchObject({
      content: "AB",
      streaming: true,
    });
    expect(detailInputs).toContainEqual({
      threadId: "thread-1",
      afterSequence: 10,
      requestCompletionMarker: true,
    });
  });

  test("times out a hanging initial alignment replay without awaiting a hanging iterator return", async () => {
    let replayReturns = 0;
    let detailReturns = 0;
    let shellReturns = 0;
    const hangingReplay: AsyncIterable<OrchestrationThreadStreamItem> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<OrchestrationThreadStreamItem>>(
              () => undefined,
            ),
          return() {
            replayReturns += 1;
            return new Promise<IteratorResult<OrchestrationThreadStreamItem>>(
              () => undefined,
            );
          },
        };
      },
    };
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell: () =>
        stream(
          [
            {
              kind: "snapshot",
              snapshot: shellSnapshot(11, [shellThread(11)]),
            },
            { kind: "synchronized" },
          ],
          () => {
            shellReturns += 1;
          },
        ),
      subscribeThread(input) {
        if (input.afterSequence === 10) return hangingReplay;
        return stream(
          [
            {
              kind: "snapshot",
              snapshot: { snapshotSequence: 10, thread: thread(10) },
            },
            { kind: "synchronized" },
          ],
          () => {
            detailReturns += 1;
          },
        );
      },
      async close() {},
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      alignmentTimeoutMs: 10,
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    const outcome = await outcomeWithin(runtime.getThread("thread-1"));

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "NativeRuntimeAdapterError",
        code: "transport_unavailable",
      },
    });
    expect(replayReturns).toBe(1);
    expect(detailReturns).toBe(1);
    expect(shellReturns).toBe(1);
  });

  test("returns missing when aligned shell replay removes the target thread", async () => {
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell(input) {
        if (input.afterSequence === 10) {
          return stream([
            {
              kind: "snapshot",
              snapshot: shellSnapshot(12, []),
            },
            { kind: "synchronized" },
          ]);
        }
        return stream([
          {
            kind: "snapshot",
            snapshot: shellSnapshot(10, [shellThread(10)]),
          },
          { kind: "synchronized" },
        ]);
      },
      subscribeThread(input) {
        if (input.afterSequence === 11) {
          return stream([{ kind: "synchronized" }]);
        }
        return stream([
          {
            kind: "snapshot",
            snapshot: { snapshotSequence: 11, thread: thread(11) },
          },
          { kind: "synchronized" },
        ]);
      },
      async close() {},
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    expect(await runtime.getThread("thread-1")).toBeUndefined();
  });

  test("terminates fallback alignment after one shell catch-up and one detail catch-up", async () => {
    let shellSubscriptions = 0;
    let detailSubscriptions = 0;
    let iteratorReturns = 0;
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell(input) {
        shellSubscriptions += 1;
        if (input.afterSequence === 10) {
          return stream(
            [
              {
                kind: "snapshot",
                snapshot: shellSnapshot(20, [shellThread(20)]),
              },
              { kind: "synchronized" },
            ],
            () => {
              iteratorReturns += 1;
            },
          );
        }
        return stream(
          [
            {
              kind: "snapshot",
              snapshot: shellSnapshot(10, [shellThread(10)]),
            },
            { kind: "synchronized" },
          ],
          () => {
            iteratorReturns += 1;
          },
        );
      },
      subscribeThread(input) {
        detailSubscriptions += 1;
        if (input.afterSequence === 11) {
          return stream([{ kind: "synchronized" }], () => {
            iteratorReturns += 1;
          });
        }
        return stream(
          [
            {
              kind: "snapshot",
              snapshot: { snapshotSequence: 11, thread: thread(11) },
            },
            { kind: "synchronized" },
          ],
          () => {
            iteratorReturns += 1;
          },
        );
      },
      async close() {},
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    expect(await runtime.getThread("thread-1")).toMatchObject({
      threadId: "thread-1",
      snapshotSequence: 20,
    });
    expect(shellSubscriptions).toBe(2);
    expect(detailSubscriptions).toBe(2);
    expect(iteratorReturns).toBe(4);
  });

  test("reconciles interleaved reducers at a common monotonic watermark and preserves pending precedence", async () => {
    let shellReturns = 0;
    let detailReturns = 0;
    let closes = 0;
    const assistantEvent = {
      ...eventBase(12, "thread.message-sent"),
      payload: {
        threadId: "thread-1",
        messageId: "message-assistant",
        role: "assistant",
        text: "Done",
        turnId: "turn-1",
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as OrchestrationEvent;
    const readyEvent = {
      ...eventBase(13, "thread.session-set"),
      payload: {
        threadId: "thread-1",
        session: {
          threadId: "thread-1",
          status: "ready",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    } as OrchestrationEvent;
    const session: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell() {
        return scriptedStream<OrchestrationShellStreamItem>(
          [
            {
              delayMs: 5,
              item: {
                kind: "snapshot",
                snapshot: shellSnapshot(10, [shellThread(10)]),
              },
            },
            { delayMs: 0, item: { kind: "synchronized" } },
            {
              delayMs: 5,
              item: {
                kind: "thread-upserted",
                sequence: 11,
                thread: shellThread(11, { pendingApproval: true }),
              },
            },
            {
              delayMs: 5,
              item: {
                kind: "thread-upserted",
                sequence: 11,
                thread: shellThread(11, { pendingApproval: true }),
              },
            },
            {
              delayMs: 40,
              item: {
                kind: "thread-upserted",
                sequence: 13,
                thread: shellThread(13, { status: "ready" }),
              },
            },
          ],
          () => {
            shellReturns += 1;
          },
        );
      },
      subscribeThread() {
        return scriptedStream<OrchestrationThreadStreamItem>(
          [
            {
              delayMs: 0,
              item: {
                kind: "snapshot",
                snapshot: { snapshotSequence: 10, thread: thread(10) },
              },
            },
            { delayMs: 0, item: { kind: "synchronized" } },
            { delayMs: 20, item: { kind: "event", event: assistantEvent } },
            { delayMs: 20, item: { kind: "event", event: readyEvent } },
          ],
          () => {
            detailReturns += 1;
          },
        );
      },
      async close() {
        closes += 1;
      },
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => session },
    });

    const observations = [];
    for await (const observation of runtime.subscribeThread("thread-1", {})) {
      observations.push(observation);
      if (observation.sequence === 13) break;
    }

    expect(observations.map(({ sequence }) => sequence)).toEqual([10, 11, 13]);
    expect(observations[1]?.snapshot).toMatchObject({
      snapshotSequence: 11,
      pendingApproval: true,
      pendingInput: null,
      latestTurn: { status: "running", assistantMessage: null },
    });
    expect(observations[2]?.snapshot).toMatchObject({
      snapshotSequence: 13,
      pendingApproval: null,
      pendingInput: null,
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        status: "completed",
        assistantMessage: { content: "Done", streaming: false },
      },
    });
    expect(shellReturns).toBe(1);
    expect(detailReturns).toBe(1);
    expect(closes).toBe(1);
  });

  test("requests synchronized subscription markers, filters the resume boundary, and sanitizes connection failures", async () => {
    const inputs: unknown[] = [];
    let closes = 0;
    const healthy: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell(input) {
        inputs.push(["shell", input]);
        if (input.afterSequence === 8) {
          return stream([
            {
              kind: "thread-upserted",
              sequence: 9,
              thread: shellThread(9),
            },
            { kind: "synchronized" },
          ]);
        }
        return stream([
          { kind: "snapshot", snapshot: shellSnapshot(8, [shellThread(8)]) },
          { kind: "synchronized" },
        ]);
      },
      subscribeThread(input) {
        inputs.push(["thread", input]);
        if (input.afterSequence === 8) {
          return stream([
            {
              kind: "event",
              event: {
                ...eventBase(9, "thread.session-set"),
                payload: {
                  threadId: "thread-1",
                  session: {
                    ...thread(9).session!,
                    updatedAt: NOW,
                  },
                },
              } as OrchestrationEvent,
            },
            { kind: "synchronized" },
          ]);
        }
        return stream([
          {
            kind: "snapshot",
            snapshot: { snapshotSequence: 8, thread: thread(8) },
          },
          { kind: "synchronized" },
        ]);
      },
      async close() {
        closes += 1;
      },
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: { connect: async () => healthy },
    });

    const iterator = runtime
      .subscribeThread("thread-1", { afterSequence: 8 })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.sequence).toBe(9);
    await iterator.return?.();

    expect(inputs).toHaveLength(4);
    expect(inputs).toContainEqual(["shell", { requestCompletionMarker: true }]);
    expect(inputs).toContainEqual([
      "thread",
      { threadId: "thread-1", requestCompletionMarker: true },
    ]);
    expect(inputs).toContainEqual([
      "shell",
      { afterSequence: 8, requestCompletionMarker: true },
    ]);
    expect(inputs).toContainEqual([
      "thread",
      {
        threadId: "thread-1",
        afterSequence: 8,
        requestCompletionMarker: true,
      },
    ]);
    expect(closes).toBe(1);

    const secret = "ws://127.0.0.1/socket?authorization=super-secret";
    const broken = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => secret,
      sessionFactory: {
        async connect() {
          throw new Error(`could not dial ${secret}`);
        },
      },
    });
    let failure: unknown;
    try {
      await broken.listProjects();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "NativeRuntimeAdapterError",
      code: "transport_unavailable",
    });
    expect(String(failure)).not.toContain("super-secret");
    expect(JSON.stringify(failure)).not.toContain("super-secret");
  });

  test("bounds socket acquisition and injected session connection hangs", async () => {
    let socketFactoryConnects = 0;
    const socketHang = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      connectionTimeoutMs: 10,
      acquireSocketUrl: () => new Promise<string>(() => undefined),
      sessionFactory: {
        async connect() {
          socketFactoryConnects += 1;
          throw new Error("must not connect");
        },
      },
    });
    const socketOutcome = await outcomeWithin(socketHang.listProjects());
    expect(socketOutcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "NativeRuntimeAdapterError",
        code: "transport_unavailable",
      },
    });
    expect(socketFactoryConnects).toBe(0);

    const connectHang = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      connectionTimeoutMs: 10,
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: {
        connect: () => new Promise<RuntimeClientSession>(() => undefined),
      },
    });
    const connectOutcome = await outcomeWithin(connectHang.listProjects());
    expect(connectOutcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "NativeRuntimeAdapterError",
        code: "transport_unavailable",
      },
    });
  });

  test("closes a late injected session exactly once after the caller times out", async () => {
    let resolveConnect: ((session: RuntimeClientSession) => void) | undefined;
    let closes = 0;
    const lateSession: RuntimeClientSession = {
      async dispatchCommand() {
        return { sequence: 1 };
      },
      subscribeShell: () => stream([]),
      subscribeThread: () => stream([]),
      async close() {
        closes += 1;
      },
    };
    const runtime = createT3NativeRuntime({
      environmentId: "environment-1",
      label: "MacBook Pro",
      connectionTimeoutMs: 10,
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
      sessionFactory: {
        connect: () =>
          new Promise<RuntimeClientSession>((resolve) => {
            resolveConnect = resolve;
          }),
      },
    });

    const outcome = await outcomeWithin(runtime.listProjects());
    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "NativeRuntimeAdapterError",
        code: "transport_unavailable",
      },
    });

    resolveConnect?.(lateSession);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closes).toBe(1);
  });

  test("rejects timeout values larger than the platform timer limit", () => {
    const options = {
      environmentId: "environment-1",
      label: "MacBook Pro",
      acquireSocketUrl: async () => "ws://127.0.0.1/ephemeral",
    };

    for (const oversized of [
      { connectionTimeoutMs: 2_147_483_648 },
      { alignmentTimeoutMs: 2_147_483_648 },
    ]) {
      expect(() => createT3NativeRuntime({ ...options, ...oversized })).toThrow(
        expect.objectContaining({
          name: "NativeRuntimeAdapterError",
          code: "transport_unavailable",
        }),
      );
    }
  });

  test("bounds hanging default factory effects without awaiting their cleanup finalizers", async () => {
    const connection = {
      environmentId: "environment-1",
      label: "MacBook Pro",
      socketUrl: "ws://127.0.0.1/ephemeral",
    };
    let connectScopeCloses = 0;
    const connectHang = createDefaultSessionFactory(
      async () =>
        ({
          connect: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  connectScopeCloses += 1;
                }).pipe(Effect.andThen(Effect.never)),
              );
              return yield* Effect.never;
            }),
        }) as unknown as RuntimeClientRpcSessionFactory,
      10,
    );
    const connectOutcome = await outcomeWithin(connectHang.connect(connection));
    expect(connectOutcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "NativeRuntimeAdapterError",
        code: "transport_unavailable",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connectScopeCloses).toBe(1);

    let readyInterrupts = 0;
    let readyScopeCloses = 0;
    const readyHang = createDefaultSessionFactory(
      async () =>
        ({
          connect: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  readyScopeCloses += 1;
                }).pipe(Effect.andThen(Effect.never)),
              );
              return {
                ready: Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      readyInterrupts += 1;
                    }).pipe(Effect.andThen(Effect.never)),
                  ),
                ),
                client: {},
              };
            }),
        }) as unknown as RuntimeClientRpcSessionFactory,
      10,
    );
    const readyOutcome = await outcomeWithin(readyHang.connect(connection));
    expect(readyOutcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "NativeRuntimeAdapterError",
        code: "transport_unavailable",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readyInterrupts).toBe(1);
    expect(readyScopeCloses).toBe(1);
  });

  test("retries runtime-client factory initialization after a rejected attempt", async () => {
    let loads = 0;
    const sessionFactory = createDefaultSessionFactory(async () => {
      loads += 1;
      if (loads === 1) throw new Error("temporary initialization failure");
      return {
        connect: () =>
          Effect.succeed({
            ready: Effect.succeed(undefined),
            client: {},
          }),
      } as unknown as RuntimeClientRpcSessionFactory;
    });
    const connection = {
      environmentId: "environment-1",
      label: "MacBook Pro",
      socketUrl: "ws://127.0.0.1/ephemeral",
    };

    await expect(sessionFactory.connect(connection)).rejects.toThrow(
      "temporary initialization failure",
    );
    const session = await sessionFactory.connect(connection);
    await session.close();

    expect(loads).toBe(2);
  });
});

function eventBase(sequence: number, type: string) {
  return {
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
  };
}
