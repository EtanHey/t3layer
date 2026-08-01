import { describe, expect, test } from "bun:test";

import {
  PolicyError,
  createCompletionReactor,
  reattachCanonicalAgent,
} from "../src/policy";
import {
  createStockT3NativeRuntime,
  type AgentRef,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import type {
  PollObservation,
} from "../src/adaptivePoller";
import type {
  ShellSnapshot,
  StockLatestTurn,
  StockThreadDetail,
  StockThreadShell,
  ThreadDetailSnapshot,
} from "../src/stockT3Contracts";

const agentRef: AgentRef = {
  environmentId: "env-stock",
  threadId: "thread-worker",
};

function latestTurn(overrides: Partial<StockLatestTurn> = {}): StockLatestTurn {
  return {
    turnId: "turn-worker",
    state: "completed",
    requestedAt: "2026-08-01T18:00:00.000Z",
    startedAt: "2026-08-01T18:00:01.000Z",
    completedAt: "2026-08-01T18:00:02.000Z",
    assistantMessageId: "assistant-worker",
    ...overrides,
  };
}

function threadDetail(overrides: Partial<StockThreadDetail> = {}): StockThreadDetail {
  const turn = overrides.latestTurn ?? latestTurn();
  return {
    id: agentRef.threadId,
    projectId: "project-stock",
    title: "Canonical stock worker",
    modelSelection: { instanceId: "provider", model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: turn,
    createdAt: "2026-08-01T17:59:00.000Z",
    updatedAt: "2026-08-01T18:00:02.000Z",
    session: {
      threadId: agentRef.threadId,
      status: "ready",
      providerName: "provider",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-01T18:00:02.000Z",
    },
    messages: [
      {
        id: "user-worker",
        role: "user",
        text: "work",
        attachments: [],
        turnId: turn?.turnId ?? null,
        streaming: false,
        createdAt: "2026-08-01T18:00:00.000Z",
        updatedAt: "2026-08-01T18:00:00.000Z",
      },
      {
        id: "assistant-worker",
        role: "assistant",
        text: "",
        attachments: [],
        turnId: turn?.turnId ?? null,
        streaming: false,
        createdAt: "2026-08-01T18:00:02.000Z",
        updatedAt: "2026-08-01T18:00:02.000Z",
      },
    ],
    activities: [],
    checkpoints: [],
    ...overrides,
  };
}

function observation(input: {
  readonly detail?: ThreadDetailSnapshot;
  readonly shellOverrides?: Partial<StockThreadShell>;
} = {}): PollObservation {
  const detail = input.detail ?? {
    snapshotSequence: 7,
    thread: threadDetail(),
  };
  const detailThread = detail.thread;
  const shellThread: StockThreadShell = {
    id: detailThread.id,
    projectId: detailThread.projectId,
    title: detailThread.title,
    modelSelection: detailThread.modelSelection,
    runtimeMode: detailThread.runtimeMode,
    interactionMode: detailThread.interactionMode,
    branch: detailThread.branch,
    worktreePath: detailThread.worktreePath,
    latestTurn: detailThread.latestTurn,
    createdAt: detailThread.createdAt,
    updatedAt: detailThread.updatedAt,
    session: detailThread.session,
    latestUserMessageAt: "2026-08-01T18:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...input.shellOverrides,
  };
  const shell: ShellSnapshot = {
    snapshotSequence: 7,
    projects: [],
    threads: [shellThread],
    updatedAt: "2026-08-01T18:00:02.000Z",
  };
  return { shell, detail };
}

describe("stock canonical restart recovery", () => {
  test("reattaches the canonical ref and snapshot without dispatching durable state", async () => {
    const canonicalSnapshot: ThreadDetailSnapshot = {
      snapshotSequence: 7,
      thread: threadDetail(),
    };
    let dispatches = 0;
    const client: StockT3RuntimeClient = {
      getDescriptor: async () => ({
        environmentId: agentRef.environmentId,
        label: "stock",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "stock",
        capabilities: { repositoryIdentity: true },
      }),
      getShell: async () => observation().shell,
      getThread: async (threadId) =>
        threadId === agentRef.threadId ? canonicalSnapshot : undefined,
      dispatch: async () => {
        dispatches += 1;
        return { sequence: 8 };
      },
    };

    const beforeCrash = createStockT3NativeRuntime({ client });
    await expect(beforeCrash.observe(agentRef)).resolves.toBe(canonicalSnapshot);
    beforeCrash.close();

    const restarted = createStockT3NativeRuntime({ client });
    const recovered = await reattachCanonicalAgent({
      agentRef,
      observe: (ref, options) => restarted.observe(ref, options),
    });

    expect(recovered.kind).toBe("reattached");
    expect(recovered.agentRef).toBe(agentRef);
    expect(recovered.snapshot).toBe(canonicalSnapshot);
    expect(recovered.overlay).toEqual({ kind: "unknown_after_restart" });
    expect(Object.keys(recovered.overlay)).toEqual(["kind"]);
    expect(dispatches).toBe(0);
    restarted.close();
  });

  test("fails closed when the recovered stock identity conflicts", async () => {
    await expect(
      reattachCanonicalAgent({
        agentRef,
        observe: async () => ({
          snapshotSequence: 7,
          thread: threadDetail({ id: "different-thread" }),
        }),
      }),
    ).rejects.toMatchObject({ code: "protocol_mismatch" });
  });
});

describe("idempotent structural completion recovery", () => {
  test("emits one completion for duplicate and replayed terminal observations", () => {
    const reactor = createCompletionReactor({ maxCompletions: 4 });
    const first = reactor.observe({ agentRef, observation: observation() });
    const duplicate = reactor.observe({ agentRef, observation: observation() });
    const replay = reactor.observe({
      agentRef,
      observation: observation({
        detail: { snapshotSequence: 8, thread: threadDetail() },
      }),
    });

    expect(first).toMatchObject({
      kind: "completion",
      agentRef,
      turnId: "turn-worker",
      terminalSequence: 7,
      outcome: "completed",
      assistantContent: "",
    });
    expect(duplicate).toBeNull();
    expect(replay).toBeNull();
    expect(reactor.metrics()).toEqual({ completions: 1, duplicates: 2, capacity: 4 });
  });

  test("does not emit from pending or incomplete structural evidence", () => {
    const reactor = createCompletionReactor({ maxCompletions: 4 });
    const pendingApproval = reactor.observe({
      agentRef,
      observation: observation({ shellOverrides: { hasPendingApprovals: true } }),
    });
    const pendingInput = reactor.observe({
      agentRef,
      observation: observation({ shellOverrides: { hasPendingUserInput: true } }),
    });
    const incomplete = reactor.observe({
      agentRef,
      observation: observation({
        detail: {
          snapshotSequence: 7,
          thread: threadDetail({ messages: [] }),
        },
      }),
    });

    expect(pendingApproval).toBeNull();
    expect(pendingInput).toBeNull();
    expect(incomplete).toBeNull();
    expect(reactor.metrics().completions).toBe(0);
  });

  test("fails closed on conflicting shell and detail identities", () => {
    const reactor = createCompletionReactor({ maxCompletions: 4 });
    const conflicting = observation({
      detail: {
        snapshotSequence: 7,
        thread: threadDetail({ projectId: "different-project" }),
      },
      shellOverrides: { projectId: "project-stock" },
    });

    expect(() => reactor.observe({ agentRef, observation: conflicting })).toThrow(
      PolicyError,
    );
    try {
      reactor.observe({ agentRef, observation: conflicting });
    } catch (error) {
      expect(error).toMatchObject({ code: "protocol_mismatch" });
    }
    expect(reactor.metrics().completions).toBe(0);
  });

  test("fails closed at the bounded completion capacity", () => {
    const reactor = createCompletionReactor({ maxCompletions: 1 });
    expect(reactor.observe({ agentRef, observation: observation() })).not.toBeNull();
    const secondRef: AgentRef = {
      environmentId: agentRef.environmentId,
      threadId: "thread-second",
    };
    const secondDetail = threadDetail({
      id: secondRef.threadId,
      latestTurn: latestTurn({ turnId: "turn-second" }),
      messages: [
        {
          id: "assistant-worker",
          role: "assistant",
          text: "done",
          attachments: [],
          turnId: "turn-second",
          streaming: false,
          createdAt: "2026-08-01T18:00:02.000Z",
          updatedAt: "2026-08-01T18:00:02.000Z",
        },
      ],
    });

    expect(() =>
      reactor.observe({
        agentRef: secondRef,
        observation: observation({
          detail: { snapshotSequence: 8, thread: secondDetail },
        }),
      }),
    ).toThrow(PolicyError);
    expect(reactor.metrics().completions).toBe(1);
  });
});
