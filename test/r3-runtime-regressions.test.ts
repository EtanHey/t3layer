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
import { StockT3HttpError } from "../src/stockT3HttpClient";

const iso = "2026-07-31T18:00:00.000Z";
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const project = {
  id: "project-1",
  title: "project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: modelSelection,
  createdAt: iso,
  updatedAt: iso,
};
const spawnInput: StockSpawnInput = {
  workspaceRoot: project.workspaceRoot,
  title: "worker",
  message: "initial",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
};
const newProjectInput: StockSpawnInput = {
  ...spawnInput,
  projectCreateIdentity: {
    projectId: "project-new",
    commandId: "project-command",
    createdAt: iso,
    workspaceRoot: project.workspaceRoot,
    title: "project",
    defaultModelSelection: modelSelection,
  },
};

function shellThread(overrides: Partial<StockThreadShell> = {}): StockThreadShell {
  return {
    id: "thread-1",
    projectId: project.id,
    title: "worker",
    modelSelection,
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
  return { snapshotSequence: sequence, projects: [project], threads, updatedAt: iso };
}

function message(id: string, text: string, createdAt = iso): StockMessage {
  return {
    id,
    role: "user",
    text,
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
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
      messages,
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

describe("round 3 runtime regressions", () => {
  test("reconciles an accepted project.create before dispatching thread.create", async () => {
    const createdProject = { ...project, id: "project-new" };
    let shellReads = 0;
    let turnStarted = false;
    const commands: Record<string, unknown>[] = [];
    const projectThread = { ...shellThread(), projectId: createdProject.id };
    const projectDetail = (sequence: number, messages: readonly StockMessage[] = []) => {
      const value = detail(sequence, messages);
      return { ...value, thread: { ...value.thread, projectId: createdProject.id } };
    };
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          shellReads += 1;
          if (shellReads === 1) return { ...shell(1), projects: [] };
          if (shellReads === 2) return { ...shell(2), projects: [createdProject] };
          return { ...shell(4, [projectThread]), projects: [createdProject] };
        },
        getThread: async () =>
          projectDetail(4, turnStarted ? [message("message-1", "initial")] : []),
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "thread.turn.start") turnStarted = true;
          return { sequence: commands.length + 1 };
        },
      }),
      id: ids(
        "create-command", "thread-1",
        "turn-command", "message-1", "lease-1",
      ),
      now: () => iso,
    });

    await expect(runtime.spawn(newProjectInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
      kind: "spawned",
      createReceipt: { threadId: "thread-1" },
    });
    expect(shellReads).toBeGreaterThanOrEqual(3);
    expect(commands.map((entry) => entry.type)).toEqual([
      "project.create", "thread.create", "thread.turn.start",
    ]);
  });

  test("retries an ambiguous project.create once with byte-identical identity", async () => {
    const createdProject = { ...project, id: "project-new" };
    let shellReads = 0;
    let projectDispatches = 0;
    let turnStarted = false;
    const commands: Record<string, unknown>[] = [];
    const projectThread = { ...shellThread(), projectId: createdProject.id };
    const projectDetail = (sequence: number, messages: readonly StockMessage[] = []) => {
      const value = detail(sequence, messages);
      return { ...value, thread: { ...value.thread, projectId: createdProject.id } };
    };
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          shellReads += 1;
          if (shellReads <= 2) return { ...shell(1), projects: [] };
          if (shellReads === 3) return { ...shell(2), projects: [createdProject] };
          return { ...shell(4, [projectThread]), projects: [createdProject] };
        },
        getThread: async () =>
          projectDetail(4, turnStarted ? [message("message-1", "initial")] : []),
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "project.create") {
            projectDispatches += 1;
            if (projectDispatches === 1) throw new StockT3HttpError("transport_unavailable", null);
            return { sequence: 2 };
          }
          if (command.type === "thread.turn.start") turnStarted = true;
          return { sequence: command.type === "thread.create" ? 3 : 4 };
        },
      }),
      id: ids(
        "create-command", "thread-1",
        "turn-command", "message-1", "lease-1",
      ),
      now: () => iso,
    });

    await expect(runtime.spawn(newProjectInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
      kind: "spawned",
    });
    expect(commands[1]).toEqual(commands[0]);
    expect(commands.map((entry) => entry.type)).toEqual([
      "project.create", "project.create", "thread.create", "thread.turn.start",
    ]);
  });

  test("a fresh 404 after reconciled create preserves the ref and never starts the turn", async () => {
    let detailReads = 0;
    const commands: Record<string, unknown>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(2, [shellThread()]),
        getThread: async () => {
          detailReads += 1;
          return detailReads === 1 ? detail(2) : undefined;
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 2 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1"),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
    expect(result).toMatchObject({
      kind: "partial",
      agentRef: { environmentId: "env-1", threadId: "thread-1" },
      initialTurn: { state: "not_attempted", safeAction: "observe" },
    });
    expect(commands.map((entry) => entry.type)).toEqual(["thread.create"]);
  });

  test("a fresh transport failure after reconciled create returns a ref-preserving partial", async () => {
    let detailReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(2, [shellThread()]),
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 1) return detail(2);
          throw new StockT3HttpError("transport_unavailable", null);
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1"),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
      kind: "partial",
      agentRef: { environmentId: "env-1", threadId: "thread-1" },
      initialTurn: {
        state: "not_attempted",
        evidence: [{ stage: "fresh_preflight", class: "transport_unavailable" }],
      },
    });
  });

  test("wait revalidates the receipt environment before polling", async () => {
    let descriptorReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => ({
          environmentId: ++descriptorReads === 1 ? "env-1" : "env-2",
          label: "local",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "stock",
          capabilities: { repositoryIdentity: false },
        }),
        getThread: async () => detail(1),
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const receipt = await runtime.send({ environmentId: "env-1", threadId: "thread-1" }, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "environment_changed",
    });
    expect(descriptorReads).toBe(2);
  });

  test("observe rejects a ref from a changed environment", async () => {
    let descriptorReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => ({
          environmentId: ++descriptorReads === 1 ? "env-1" : "env-2",
          label: "local",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "stock",
          capabilities: { repositoryIdentity: false },
        }),
        getThread: async () => detail(1),
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const receipt = await runtime.send({ environmentId: "env-1", threadId: "thread-1" }, "target");
    runtime.releaseReceipt(receipt);

    await expect(runtime.observe(receipt.agentRef)).rejects.toMatchObject({ code: "environment_changed" });
  });

  test.each([
    ["pending approval", { hasPendingApprovals: true }],
    ["pending input", { hasPendingUserInput: true }],
  ] as const)("does not attribute foreign %s before target binding", async (_label, pending) => {
    let detailReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(3, [{ ...shellThread(), ...pending }]),
        getThread: async () => {
          detailReads += 1;
          return detailReads === 1 ? detail(1) : detail(3);
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const receipt = await runtime.send({ environmentId: "env-1", threadId: "thread-1" }, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
  });

  test("does not attribute a pre-existing interrupted turn before target binding", async () => {
    const oldTurn = {
      turnId: "old-turn",
      state: "interrupted" as const,
      requestedAt: "2026-07-31T17:59:00.000Z",
      startedAt: null,
      completedAt: iso,
      assistantMessageId: null,
    };
    let detailReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(3, [{ ...shellThread(), latestTurn: oldTurn }]),
        getThread: async () => {
          detailReads += 1;
          return detailReads === 1
            ? detail(1, [], oldTurn)
            : detail(3, [message("message-1", "target")], oldTurn);
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const receipt = await runtime.send({ environmentId: "env-1", threadId: "thread-1" }, "target");

    await expect(runtime.wait(receipt, { timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
  });

  test("cancellation during the identical send retry releases the lease", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => detail(1),
        dispatch: async () => {
          dispatches += 1;
          if (dispatches === 2) controller.abort();
          if (dispatches <= 2) throw new StockT3HttpError("transport_unavailable", null);
          return { sequence: 3 };
        },
      }),
      id: ids(
        "command-1", "message-1", "lease-1",
        "command-2", "message-2", "lease-2",
      ),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };

    await expect(runtime.send(ref, "first", { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(runtime.send(ref, "second")).resolves.toMatchObject({ messageId: "message-2" });
  });

  test("a malformed successful identical-send response preserves the possibly durable receipt", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => detail(1),
        dispatch: async () => {
          dispatches += 1;
          if (dispatches === 1) throw new StockT3HttpError("transport_unavailable", null);
          if (dispatches === 2) throw new StockT3HttpError("protocol_mismatch", 200);
          return { sequence: 3 };
        },
      }),
      id: ids(
        "command-1", "message-1", "lease-1",
        "command-2", "message-2", "lease-2",
      ),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };

    const first = await runtime.send(ref, "first");
    expect(first).toMatchObject({
      commandId: "command-1",
      messageId: "message-1",
      acceptedSequence: null,
    });
    await expect(runtime.send(ref, "second")).rejects.toMatchObject({ code: "send_in_progress" });
    runtime.releaseReceipt(first);
    await expect(runtime.send(ref, "second")).resolves.toMatchObject({ messageId: "message-2" });
  });
});
