import { describe, expect, test } from "bun:test";

import {
  StockRuntimeError,
  createStockT3NativeRuntime,
  digestStockSpawnInput,
  type CreateReconciliationPending,
  type StockSpawnInput,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import type {
  ShellSnapshot,
  StockMessage,
  StockThreadDetail,
  StockThreadShell,
  ThreadDetailSnapshot,
} from "../src/stockT3Contracts";
import { StockT3HttpError } from "../src/stockT3HttpClient";

const iso = "2026-07-31T18:00:00.000Z";
const selection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const project = {
  id: "project-1",
  title: "project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: selection,
  createdAt: iso,
  updatedAt: iso,
};
const spawnInput: StockSpawnInput = {
  workspaceRoot: project.workspaceRoot,
  title: "worker",
  message: "initial",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
};

function shellThread(overrides: Partial<StockThreadShell> = {}): StockThreadShell {
  return {
    id: "thread-1",
    projectId: project.id,
    title: "worker",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: iso,
    updatedAt: iso,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function shell(sequence: number, threads: readonly StockThreadShell[] = []): ShellSnapshot {
  return { snapshotSequence: sequence, projects: [project], threads: [...threads], updatedAt: iso };
}

function message(id: string, text: string): StockMessage {
  return {
    id,
    role: "user",
    text,
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt: iso,
    updatedAt: iso,
  };
}

function detail(
  sequence: number,
  messages: readonly StockMessage[] = [],
  latestTurn: StockThreadDetail["latestTurn"] = null,
): ThreadDetailSnapshot {
  const identity = shellThread();
  return {
    snapshotSequence: sequence,
    thread: {
      id: identity.id,
      projectId: identity.projectId,
      title: identity.title,
      modelSelection: identity.modelSelection,
      runtimeMode: identity.runtimeMode,
      interactionMode: identity.interactionMode,
      branch: identity.branch,
      worktreePath: identity.worktreePath,
      latestTurn,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
      session: null,
      messages: [...messages],
      activities: [],
      checkpoints: [],
    },
  };
}

function client(overrides: Partial<StockT3RuntimeClient> = {}): StockT3RuntimeClient {
  return {
    getDescriptor: async () => ({
      environmentId: "env-1",
      label: "local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "stock",
      capabilities: { repositoryIdentity: false },
    }),
    getShell: async () => shell(2, [shellThread()]),
    getThread: async () => detail(2),
    dispatch: async () => ({ sequence: 2 }),
    ...overrides,
  };
}

function ids(...values: string[]) {
  return () => values.shift()!;
}

async function delayedInitialTurnResult(
  retry: "received_500" | "accepted_9",
) {
  let detailReads = 0;
  const commands: Readonly<Record<string, unknown>>[] = [];
  const runtime = createStockT3NativeRuntime({
    client: client({
      getThread: async () => {
        detailReads += 1;
        if (detailReads === 4) {
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return detail(2);
      },
      dispatch: async (command) => {
        commands.push(command);
        if (command.type === "thread.create") return { sequence: 2 };
        const turnStarts = commands.filter((entry) => entry.type === "thread.turn.start").length;
        if (turnStarts === 1) {
          throw new StockT3HttpError("transport_unavailable", null);
        }
        if (retry === "accepted_9") return { sequence: 9 };
        throw new StockT3HttpError("server_internal", 500, {
          code: "internal_error",
          reason: "orchestration_dispatch_failed",
        });
      },
    }),
    id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
    now: () => iso,
  });

  const result = await runtime.spawn(spawnInput, {
    timeoutMs: 40,
    maxReconciliationReads: 1,
  });
  return { result, commands };
}

describe("round 5 runtime regressions", () => {
  test("preserves ambiguous initial-turn identity when retry 500 projection overruns expiry", async () => {
    const { result, commands } = await delayedInitialTurnResult("received_500");

    expect(result).toMatchObject({
      kind: "partial",
      agentRef: { environmentId: "env-1", threadId: "thread-1" },
      createReceipt: { commandId: "create-1", threadId: "thread-1", acceptedSequence: 2 },
      initialTurn: {
        commandId: "turn-1",
        messageId: "message-1",
        state: "initial_turn_outcome_unknown",
        turnReceipt: {
          commandId: "turn-1",
          messageId: "message-1",
          acceptedSequence: null,
          leaseState: "released",
        },
        leaseExpiresAt: null,
        safeAction: "observe",
        evidence: [{ retryClass: "server_internal" }],
      },
    });
    expect(commands.map((entry) => entry.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.turn.start",
    ]);
  });

  test("preserves accepted retry sequence when projection overruns expiry", async () => {
    const { result } = await delayedInitialTurnResult("accepted_9");

    expect(result).toMatchObject({
      kind: "partial",
      agentRef: { environmentId: "env-1", threadId: "thread-1" },
      createReceipt: { commandId: "create-1", threadId: "thread-1", acceptedSequence: 2 },
      initialTurn: {
        commandId: "turn-1",
        messageId: "message-1",
        state: "initial_turn_accepted_projection_pending",
        turnReceipt: {
          commandId: "turn-1",
          messageId: "message-1",
          acceptedSequence: 9,
          leaseState: "released",
        },
        leaseExpiresAt: null,
        safeAction: "observe",
        evidence: [{ acceptedSequence: 9 }],
      },
    });
  });

  test("returns accepted send identity when post-dispatch promotion occurs after expiry", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => detail(1),
        dispatch: async () => {
          dispatches += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { sequence: 7 };
        },
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });

    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-1" },
      "target",
      { timeoutMs: 40 },
    );

    expect(receipt).toMatchObject({
      commandId: "command-1",
      messageId: "message-1",
      leaseId: "lease-1",
      acceptedSequence: 7,
    });
    expect(dispatches).toBe(1);
    await expect(runtime.wait(receipt)).rejects.toMatchObject({ code: "receipt_expired" });
  });

  test("resume slot contention preserves its earned create receipt and remains retryable", async () => {
    let releaseSendPreflight!: (value: ThreadDetailSnapshot) => void;
    const sendPreflight = new Promise<ThreadDetailSnapshot>((resolve) => {
      releaseSendPreflight = resolve;
    });
    let detailReads = 0;
    let turnStarts = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          return detailReads === 1 ? sendPreflight : detail(2);
        },
        dispatch: async (command) => {
          if (command.type === "thread.turn.start") turnStarts += 1;
          return { sequence: turnStarts + 2 };
        },
      }),
      id: ids("send-command", "other-message", "send-lease", "resume-lease"),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };
    const pending: CreateReconciliationPending = {
      kind: "create_reconciliation_pending",
      provisionalRef: ref,
      createAttempt: {
        commandId: "create-1",
        threadId: "thread-1",
        projectId: "project-1",
        acceptedSequence: 2,
        dispatchState: "accepted",
        retryState: "not_applicable",
        retryError: null,
      },
      reconciliation: {
        reason: "projection_pending",
        projectionState: "unobserved",
        highestShellSequence: null,
        highestDetailSequence: null,
        deadlineMs: Date.now() + 1_000,
        evidence: [],
      },
      initialTurnContinuation: {
        commandId: "turn-1",
        messageId: "message-1",
        inputDigest: await digestStockSpawnInput(spawnInput),
      },
      safeAction: "resume_create_reconciliation",
    };

    const activeSend = runtime.send(ref, "other");
    const contended = await runtime
      .resumeCreateReconciliation(pending, spawnInput, { maxReconciliationReads: 1 })
      .catch((cause) => cause);

    expect(contended).toMatchObject({
      kind: "partial",
      agentRef: ref,
      createReceipt: { commandId: "create-1", threadId: "thread-1", acceptedSequence: 2 },
      initialTurn: {
        commandId: "turn-1",
        messageId: "message-1",
        state: "contended_before_start",
        turnReceipt: null,
        safeAction: "observe",
      },
    });
    expect(turnStarts).toBe(0);

    releaseSendPreflight(detail(2));
    const sendReceipt = await activeSend;
    expect(turnStarts).toBe(1);
    runtime.releaseReceipt(sendReceipt);

    const recovered = await runtime.resumeCreateReconciliation(pending, spawnInput, {
      maxReconciliationReads: 1,
    });
    expect(recovered).toMatchObject({
      kind: "partial",
      createReceipt: { commandId: "create-1", threadId: "thread-1" },
      initialTurn: {
        state: "initial_turn_accepted_projection_pending",
        turnReceipt: { commandId: "turn-1", messageId: "message-1" },
      },
    });
    expect(turnStarts).toBe(2);
  });
});
