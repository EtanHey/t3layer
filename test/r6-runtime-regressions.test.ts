import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  type StockSpawnInput,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import { createStockT3NativeRuntime } from "./support/modelCache";
import type {
  EnvironmentDescriptor,
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

function environment(environmentId: string): EnvironmentDescriptor {
  return {
    environmentId,
    label: "local",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "stock",
    capabilities: { repositoryIdentity: false },
  };
}

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
    getDescriptor: async () => environment("env-1"),
    getShell: async () => shell(2, [shellThread()]),
    getThread: async () => detail(2),
    dispatch: async () => ({ sequence: 2 }),
    ...overrides,
  };
}

function ids(...values: string[]) {
  return () => values.shift()!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function expectAcceptedPending(result: unknown, acceptedSequence = 5) {
  expect(result).toMatchObject({
    kind: "partial",
    agentRef: { environmentId: "env-1", threadId: "thread-1" },
    createReceipt: {
      commandId: "create-1",
      threadId: "thread-1",
      acceptedSequence: 2,
    },
    initialTurn: {
      commandId: "turn-1",
      messageId: "message-1",
      state: "initial_turn_accepted_projection_pending",
      turnReceipt: {
        commandId: "turn-1",
        messageId: "message-1",
        leaseState: "released",
      },
      leaseExpiresAt: null,
      safeAction: "observe",
      evidence: [{ acceptedSequence }],
    },
  });
}

describe("round 6 runtime regressions", () => {
  test("P4 preserves an accepted initial turn across concurrent environment invalidation", async () => {
    const targetRead = deferred<ThreadDetailSnapshot>();
    const targetStarted = deferred<void>();
    let descriptorReads = 0;
    let detailReads = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => environment(++descriptorReads === 1 ? "env-1" : "env-2"),
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 3) {
            targetStarted.resolve();
            return targetRead.promise;
          }
          return detail(2);
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: command.type === "thread.create" ? 2 : 5 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });

    const spawning = runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
    await targetStarted.promise;
    await expect(
      runtime.observe({ environmentId: "env-1", threadId: "thread-1" }),
    ).rejects.toMatchObject({ code: "environment_changed" });
    targetRead.resolve(detail(2));

    expectAcceptedPending(await spawning);
    expect(commands.map((entry) => entry.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  });

  test("P6 preserves an ambiguous send receipt when reconciliation loses its lease", async () => {
    const targetRead = deferred<ThreadDetailSnapshot>();
    const targetStarted = deferred<void>();
    let descriptorReads = 0;
    let detailReads = 0;
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => environment(++descriptorReads === 1 ? "env-1" : "env-2"),
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 2) {
            targetStarted.resolve();
            return targetRead.promise;
          }
          return detail(2);
        },
        dispatch: async () => {
          dispatches += 1;
          if (dispatches === 1) throw new StockT3HttpError("transport_unavailable", null);
          throw new StockT3HttpError("server_internal", 500, {
            code: "internal_error",
            reason: "orchestration_dispatch_failed",
          });
        },
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };

    const sending = runtime.send(ref, "target");
    await targetStarted.promise;
    await expect(runtime.observe(ref)).rejects.toMatchObject({ code: "environment_changed" });
    targetRead.resolve(detail(2));

    expect(await sending).toMatchObject({
      agentRef: ref,
      commandId: "command-1",
      messageId: "message-1",
      leaseId: "lease-1",
      acceptedSequence: null,
    });
    expect(dispatches).toBe(2);
  });

  test("P2 preserves accepted identity at the exact inclusive deadline boundary", async () => {
    let detailReads = 0;
    let atBoundary = false;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 3) {
            atBoundary = true;
            await new Promise((resolve) => setTimeout(resolve, 110));
          }
          return detail(2);
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: command.type === "thread.create" ? 2 : 5 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
      clock: () => (atBoundary ? 100 : 0),
    });

    const result = await runtime.spawn(spawnInput, {
      deadlineMs: 100,
      maxReconciliationReads: 1,
    });

    expectAcceptedPending(result);
    expect(commands.map((entry) => entry.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  });

  test("P1-A preserves first-dispatch acceptance when projection reaches the deadline", async () => {
    let detailReads = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 3) await new Promise((resolve) => setTimeout(resolve, 60));
          return detail(2);
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: command.type === "thread.create" ? 2 : 5 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });

    expectAcceptedPending(await runtime.spawn(spawnInput, {
      timeoutMs: 40,
      maxReconciliationReads: 1,
    }));
    expect(commands.map((entry) => entry.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  });

  test("P1-B preserves first-dispatch acceptance when projection is cancelled", async () => {
    const controller = new AbortController();
    let detailReads = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 3) controller.abort();
          return detail(2);
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: command.type === "thread.create" ? 2 : 5 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });

    expectAcceptedPending(await runtime.spawn(spawnInput, {
      signal: controller.signal,
      maxReconciliationReads: 1,
    }));
    expect(commands.map((entry) => entry.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  });

  test("preserves the create receipt when the deadline crosses inside slot claim", async () => {
    let returnedCreateDetail = false;
    let clocksAfterDetail = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          returnedCreateDetail = true;
          return detail(2);
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 2 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1"),
      now: () => iso,
      clock: () => {
        if (!returnedCreateDetail) return 0;
        clocksAfterDetail += 1;
        return clocksAfterDetail >= 4 ? 100 : 0;
      },
    });

    const result = await runtime.spawn(spawnInput, {
      deadlineMs: 100,
      maxReconciliationReads: 1,
    });

    expect(result).toMatchObject({
      kind: "partial",
      agentRef: { environmentId: "env-1", threadId: "thread-1" },
      createReceipt: {
        commandId: "create-1",
        threadId: "thread-1",
        acceptedSequence: 2,
      },
      initialTurn: {
        commandId: "turn-1",
        messageId: "message-1",
        state: "deadline_exhausted",
        turnReceipt: null,
        leaseExpiresAt: null,
        safeAction: "observe",
        evidence: [],
      },
    });
    expect(commands.map((entry) => entry.type)).toEqual(["thread.create"]);
  });

  test("contains no throwing lease-state accessor", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/nativeRuntime.ts")).text();
    expect(source).not.toMatch(/\bleaseState\s*\(/);
  });
});
