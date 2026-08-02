import { describe, expect, test } from "bun:test";

import {
  createStockT3NativeRuntime,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import type {
  ShellSnapshot,
  StockLatestTurn,
  StockMessage,
  StockSession,
  StockThreadShell,
  ThreadDetailSnapshot,
} from "../src/stockT3Contracts";

const requestedAt = "2026-08-02T16:13:16.955Z";
const laterAt = "2026-08-02T16:13:29.676Z";
const selection = { instanceId: "claudeAgent", model: "claude-sonnet-4-5" };
const project = {
  id: "project-1",
  title: "project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: selection,
  createdAt: requestedAt,
  updatedAt: requestedAt,
};
const ref = { environmentId: "env-1", threadId: "thread-1" };

const boundTurn: StockLatestTurn = {
  turnId: "turn-a",
  state: "running",
  requestedAt,
  startedAt: requestedAt,
  completedAt: null,
  assistantMessageId: "assistant-a",
};
const newerTurn: StockLatestTurn = {
  turnId: "turn-b",
  state: "running",
  requestedAt: laterAt,
  startedAt: laterAt,
  completedAt: null,
  assistantMessageId: null,
};
const runningSession: StockSession = {
  threadId: ref.threadId,
  status: "running",
  providerName: "claudeAgent",
  activeTurnId: boundTurn.turnId,
  lastError: null,
  updatedAt: requestedAt,
};
const readySession: StockSession = {
  ...runningSession,
  status: "ready",
  activeTurnId: null,
  updatedAt: laterAt,
};
const messages: readonly StockMessage[] = [
  {
    id: "message-1",
    role: "user",
    text: "target",
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  },
  {
    id: "assistant-a",
    role: "assistant",
    text: "done",
    attachments: [],
    turnId: boundTurn.turnId,
    streaming: false,
    createdAt: laterAt,
    updatedAt: laterAt,
  },
];

function shellThread(
  latestTurn: StockLatestTurn | null,
  session: StockSession | null,
): StockThreadShell {
  return {
    id: ref.threadId,
    projectId: project.id,
    title: "worker",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn,
    createdAt: requestedAt,
    updatedAt: laterAt,
    session,
    latestUserMessageAt: requestedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
}

function shell(
  sequence: number,
  latestTurn: StockLatestTurn | null,
  session: StockSession | null,
): ShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [project],
    threads: [shellThread(latestTurn, session)],
    updatedAt: laterAt,
  };
}

function detail(
  sequence: number,
  latestTurn: StockLatestTurn | null,
  session: StockSession | null,
  projectedMessages: readonly StockMessage[] = messages,
): ThreadDetailSnapshot {
  const identity = shellThread(latestTurn, session);
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
      session,
      messages: [...projectedMessages],
      activities: [],
      checkpoints: [],
    },
  };
}

function clientForTerminalProjection(
  terminalLatest: StockLatestTurn | null,
  terminalSession: StockSession,
): StockT3RuntimeClient {
  let shellReads = 0;
  let detailReads = 0;
  return {
    getDescriptor: async () => ({
      environmentId: ref.environmentId,
      label: "local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "stock",
      capabilities: { repositoryIdentity: false },
    }),
    getShell: async () => {
      shellReads += 1;
      return shellReads === 1
        ? shell(9, boundTurn, runningSession)
        : shell(16, terminalLatest, terminalSession);
    },
    getThread: async () => {
      detailReads += 1;
      if (detailReads === 1) return detail(1, null, null, []);
      return detailReads === 2
        ? detail(9, boundTurn, runningSession)
        : detail(16, terminalLatest, terminalSession);
    },
    dispatch: async () => ({ sequence: 4 }),
  };
}

function runtimeFor(
  terminalLatest: StockLatestTurn | null,
  terminalSession: StockSession,
) {
  const ids = ["command-1", "message-1", "lease-1"];
  return createStockT3NativeRuntime({
    client: clientForTerminalProjection(terminalLatest, terminalSession),
    id: () => ids.shift()!,
    now: () => requestedAt,
  });
}

describe("criterion-4 terminal projection rollover", () => {
  test("completes from the bound finalized assistant after stock clears latestTurn", async () => {
    const runtime = runtimeFor(null, readySession);
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "completed",
      assistantContent: "done",
    });
    runtime.close();
  });

  test("still rejects a genuinely newer non-null turn after binding", async () => {
    const runtime = runtimeFor(newerTurn, {
      ...runningSession,
      activeTurnId: newerTurn.turnId,
      updatedAt: laterAt,
    });
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "concurrent_writer",
      evidence: { reason: "turn_changed" },
    });
    runtime.close();
  });
});
