import { describe, expect, test } from "bun:test";

import {
  StockRuntimeError,
  type StockSpawnInput,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import { createStockT3NativeRuntime } from "./support/modelCache";
import type {
  ShellSnapshot,
  StockMessage,
  StockThreadDetail,
  StockThreadShell,
  ThreadDetailSnapshot,
} from "../src/stockT3Contracts";

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

function message(
  id: string,
  text: string,
  role: StockMessage["role"] = "user",
  turnId: string | null = null,
): StockMessage {
  return {
    id,
    role,
    text,
    attachments: [],
    turnId,
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
    getShell: async () => shell(1),
    getThread: async () => undefined,
    dispatch: async () => ({ sequence: 1 }),
    ...overrides,
  };
}

function ids(...values: string[]) {
  return () => values.shift()!;
}

describe("round 4 runtime regressions", () => {
  test("atomically admits only one concurrent same-thread send", async () => {
    let releasePreflight!: (value: ThreadDetailSnapshot) => void;
    const preflight = new Promise<ThreadDetailSnapshot>((resolve) => {
      releasePreflight = resolve;
    });
    let detailReads = 0;
    let descriptorReads = 0;
    let dispatches = 0;
  const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => {
          descriptorReads += 1;
          return {
            environmentId: "env-1",
            label: "local",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "stock",
            capabilities: { repositoryIdentity: false },
          };
        },
        getThread: async () => {
          detailReads += 1;
          return preflight;
        },
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 2 };
        },
      }),
      id: ids("command-1", "message-1", "lease-1", "command-2", "message-2", "lease-2"),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };

    const outcomesPromise = Promise.allSettled([
      runtime.send(ref, "first"),
      runtime.send(ref, "second"),
    ]);
    for (let index = 0; index < 20 && detailReads < 1; index += 1) {
      await Promise.resolve();
    }
    expect(detailReads).toBe(1);
    releasePreflight(detail(1));
    const outcomes = await outcomesPromise;

    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((entry) => entry.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "send_in_progress" } });
    expect(descriptorReads).toBe(1);
    expect(detailReads).toBe(1);
    expect(dispatches).toBe(1);
  });

  test("returns an executable receipt for accepted-but-unprojected initial turns", async () => {
    let detailReads = 0;
    let waiting = false;
    const completedTurn = {
      turnId: "turn-id-1",
      state: "completed" as const,
      requestedAt: iso,
      startedAt: iso,
      completedAt: iso,
      assistantMessageId: "assistant-1",
    };
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () =>
          waiting
            ? shell(5, [shellThread({ latestTurn: completedTurn })])
            : shell(2, [shellThread()]),
        getThread: async () => {
          detailReads += 1;
          if (!waiting) return detail(2);
          return detail(5, [
            message("message-1", "initial"),
            message("assistant-1", "done", "assistant", "turn-id-1"),
          ], completedTurn);
        },
        dispatch: async (command) => ({ sequence: command.type === "thread.create" ? 2 : 4 }),
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
    expect(result).toMatchObject({
      kind: "partial",
      initialTurn: {
        state: "initial_turn_accepted_projection_pending",
        safeAction: "wait",
        turnReceipt: { commandId: "turn-1", messageId: "message-1", leaseId: "lease-1" },
      },
    });
    if (result.kind !== "partial" || result.initialTurn.turnReceipt === null) {
      throw new Error("expected executable partial receipt");
    }
    waiting = true;
    await expect(runtime.wait(result.initialTurn.turnReceipt, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "completed",
      assistantContent: "done",
    });
    await expect(runtime.wait(result.initialTurn.turnReceipt, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "receipt_expired",
    });
    expect(detailReads).toBeGreaterThanOrEqual(4);
  });

  test.each(["release", "expiry"] as const)(
    "the %s path clears an accepted-but-unprojected initial-turn receipt",
    async (mode) => {
      let current = 0;
      const runtime = createStockT3NativeRuntime({
        client: client({
          getShell: async () => shell(2, [shellThread()]),
          getThread: async () => detail(2),
          dispatch: async (command) => ({ sequence: command.type === "thread.create" ? 2 : 4 }),
        }),
        id: ids(
          "create-1",
          "thread-1",
          "turn-1",
          "message-1",
          "lease-1",
          "command-2",
          "message-2",
          "lease-2",
        ),
        now: () => iso,
        clock: () => current,
      });
      const result = await runtime.spawn(spawnInput, {
        timeoutMs: 100,
        maxReconciliationReads: 1,
      });
      if (result.kind !== "partial" || result.initialTurn.turnReceipt === null) {
        throw new Error("expected executable partial receipt");
      }
      if (mode === "release") runtime.releaseReceipt(result.initialTurn.turnReceipt);
      else current = 100;

      await expect(runtime.wait(result.initialTurn.turnReceipt, { timeoutMs: 100 })).rejects.toMatchObject({
        code: "receipt_expired",
      });
      await expect(runtime.send(result.agentRef, "next")).resolves.toMatchObject({
        commandId: "command-2",
        messageId: "message-2",
        leaseId: "lease-2",
      });
    },
  );

  test("classifies below-accepted project projection as lag through the real HTTP decoder", async () => {
    let shellReads = 0;
    let dispatches = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/.well-known/t3/environment") {
        return Response.json({
          environmentId: "env-1",
          label: "local",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "stock",
          capabilities: { repositoryIdentity: false },
        });
      }
      if (url.pathname === "/api/orchestration/shell") {
        shellReads += 1;
        return Response.json({
          snapshotSequence: shellReads === 1 ? 1 : 3,
          projects:
            shellReads === 1
              ? []
              : [{ ...project, id: "project-new", workspaceRoot: "/tmp/new-project" }],
          threads: [],
          updatedAt: iso,
        });
      }
      if (url.pathname === "/api/orchestration/dispatch" && init?.method === "POST") {
        dispatches += 1;
        return Response.json({ sequence: 5 });
      }
      throw new Error(`unexpected route ${init?.method ?? "GET"} ${url.pathname}`);
    };
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://127.0.0.1:3773",
      fetch,
      id: ids(),
      now: () => iso,
    });

    const error = await runtime
      .spawn({
        ...spawnInput,
        workspaceRoot: "/tmp/new-project",
        projectCreateIdentity: {
          projectId: "project-new",
          commandId: "project-command",
          createdAt: iso,
          workspaceRoot: "/tmp/new-project",
          title: "project",
          defaultModelSelection: selection,
        },
      }, { maxReconciliationReads: 1 })
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(StockRuntimeError);
    expect(error).toMatchObject({
      code: "transport_unavailable",
      evidence: {
        reason: "project_projection_pending",
        provisionalProjectId: "project-new",
        acceptedSequence: 5,
      },
    });
    expect(dispatches).toBe(1);
  });

  test("still fails closed when lagging project observations regress", async () => {
    let shellReads = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/.well-known/t3/environment") {
        return Response.json({
          environmentId: "env-1",
          label: "local",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "stock",
          capabilities: { repositoryIdentity: false },
        });
      }
      if (url.pathname === "/api/orchestration/shell") {
        shellReads += 1;
        const sequence = shellReads === 1 ? 1 : shellReads === 2 ? 4 : 3;
        return Response.json({
          snapshotSequence: sequence,
          projects:
            shellReads === 1
              ? []
              : [{ ...project, id: "project-new", workspaceRoot: "/tmp/new-project" }],
          threads: [],
          updatedAt: iso,
        });
      }
      if (url.pathname === "/api/orchestration/dispatch" && init?.method === "POST") {
        return Response.json({ sequence: 5 });
      }
      throw new Error(`unexpected route ${init?.method ?? "GET"} ${url.pathname}`);
    };
  const runtime = createStockT3NativeRuntime({
      baseUrl: "http://127.0.0.1:3773",
      fetch,
      id: ids(),
      now: () => iso,
    });

    await expect(
      runtime.spawn(
        {
          ...spawnInput,
          workspaceRoot: "/tmp/new-project",
          projectCreateIdentity: {
            projectId: "project-new",
            commandId: "project-command",
            createdAt: iso,
            workspaceRoot: "/tmp/new-project",
            title: "project",
            defaultModelSelection: selection,
          },
        },
        { maxReconciliationReads: 2 },
      ),
    ).rejects.toMatchObject({
      code: "protocol_mismatch",
      evidence: { reason: "shell_sequence_regression" },
    });
  });

  test.each([
    ["pending_approval", { hasPendingApprovals: true }],
    ["pending_input", { hasPendingUserInput: true }],
  ] as const)("reports %s only after target binding and retains its lease", async (code, pending) => {
    const boundTurn = {
      turnId: "turn-id-1",
      state: "running" as const,
      requestedAt: iso,
      startedAt: iso,
      completedAt: null,
      assistantMessageId: null,
    };
    let preflight = true;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(3, [{ ...shellThread({ latestTurn: boundTurn }), ...pending }]),
        getThread: async () => {
          if (preflight) {
            preflight = false;
            return detail(1);
          }
          return detail(3, [message("message-1", "target")], boundTurn);
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: ids("command-1", "message-1", "lease-1", "command-2", "message-2", "lease-2"),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };
    const receipt = await runtime.send(ref, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).rejects.toMatchObject({ code });
    await expect(runtime.send(ref, "second")).rejects.toMatchObject({ code: "send_in_progress" });
    runtime.releaseReceipt(receipt);
  });
});
