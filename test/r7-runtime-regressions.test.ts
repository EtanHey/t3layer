import { describe, expect, test } from "bun:test";

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

function environment(environmentId = "env-1"): EnvironmentDescriptor {
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

function shell(sequence: number, threads: readonly StockThreadShell[] = [shellThread()]): ShellSnapshot {
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
    getDescriptor: async () => environment(),
    getShell: async () => shell(2),
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

function receivedError(code: "server_internal" | "protocol_mismatch") {
  return code === "server_internal"
    ? new StockT3HttpError("server_internal", 500, {
        code: "internal_error",
        reason: "orchestration_dispatch_failed",
      })
    : new StockT3HttpError("protocol_mismatch", 200);
}

function expectAcceptedPartial(result: unknown, errorClass: string) {
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
      safeAction: "wait",
      turnReceipt: {
        commandId: "turn-1",
        messageId: "message-1",
        acceptedSequence: 5,
      },
      evidence: [
        { acceptedSequence: 5 },
        { stage: "target_reconciliation", class: errorClass },
      ],
    },
  });
}

describe("round 7 post-mutation result invariant", () => {
  test.each([
    ["N2-A received detail 500", "server_internal"],
    ["N2-C detail protocol mismatch", "protocol_mismatch"],
  ] as const)("%s preserves accepted create and initial-turn evidence", async (_label, errorClass) => {
    let detailReads = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 3) throw receivedError(errorClass);
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

    const result = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });

    expectAcceptedPartial(result, errorClass);
    expect(commands.map((entry) => entry.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  });

  test("N2-B accepted create plus received shell 500 returns reconciliation pending", async () => {
    let shellReads = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          shellReads += 1;
          if (shellReads === 2) throw receivedError("server_internal");
          return shell(2);
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 2 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1"),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
      kind: "create_reconciliation_pending",
      provisionalRef: { environmentId: "env-1", threadId: "thread-1" },
      createAttempt: {
        commandId: "create-1",
        threadId: "thread-1",
        acceptedSequence: 2,
      },
      reconciliation: {
        reason: "transport_exhausted",
        evidence: [{ stage: "create_shell_reconciliation", class: "server_internal", status: 500 }],
      },
      initialTurnContinuation: { commandId: "turn-1", messageId: "message-1" },
      safeAction: "resume_create_reconciliation",
    });
    expect(commands.map((entry) => entry.type)).toEqual(["thread.create"]);
  });

  test("N2-D ambiguous send plus received detail 500 preserves the receipt identity", async () => {
    let detailReads = 0;
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 2) throw receivedError("server_internal");
          return detail(2);
        },
        dispatch: async () => {
          dispatches += 1;
          throw new StockT3HttpError("transport_unavailable", null);
        },
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };

    await expect(runtime.send(ref, "target", { maxReconciliationReads: 1 })).resolves.toMatchObject({
      agentRef: ref,
      commandId: "command-1",
      messageId: "message-1",
      leaseId: "lease-1",
      acceptedSequence: null,
    });
    expect(dispatches).toBe(2);
  });

  test("N1-A create-time claim invalidation returns a ref-preserving partial", async () => {
    const freshRead = deferred<ThreadDetailSnapshot>();
    const freshStarted = deferred<void>();
    let descriptorReads = 0;
    let detailReads = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => environment(++descriptorReads === 1 ? "env-1" : "env-2"),
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 2) {
            freshStarted.resolve();
            return freshRead.promise;
          }
          return detail(2);
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 2 };
        },
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1"),
      now: () => iso,
    });

    const spawning = runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
    await freshStarted.promise;
    await expect(runtime.observe({ environmentId: "env-1", threadId: "thread-1" })).rejects.toMatchObject({
      code: "environment_changed",
    });
    freshRead.resolve(detail(2));

    await expect(spawning).resolves.toMatchObject({
      kind: "partial",
      agentRef: { environmentId: "env-1", threadId: "thread-1" },
      createReceipt: { commandId: "create-1", threadId: "thread-1", acceptedSequence: 2 },
      initialTurn: {
        commandId: "turn-1",
        messageId: "message-1",
        state: "not_attempted",
        safeAction: "observe",
        evidence: [{ stage: "lease_promotion", class: "environment_changed" }],
      },
    });
    expect(commands.map((entry) => entry.type)).toEqual(["thread.create"]);
  });

  test("N1-B send claim invalidation reports environment_changed without dispatch", async () => {
    const preflight = deferred<ThreadDetailSnapshot>();
    const preflightStarted = deferred<void>();
    let descriptorReads = 0;
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => environment(++descriptorReads === 1 ? "env-1" : "env-2"),
        getThread: async () => {
          preflightStarted.resolve();
          return preflight.promise;
        },
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 2 };
        },
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };

    const sending = runtime.send(ref, "target");
    await preflightStarted.promise;
    await expect(runtime.observe(ref)).rejects.toMatchObject({ code: "environment_changed" });
    preflight.resolve(detail(2));

    await expect(sending).rejects.toMatchObject({ code: "environment_changed" });
    expect(dispatches).toBe(0);
  });

  test("inclusive deadline crossing before lease promotion preserves the create receipt", async () => {
    let detailReads = 0;
    let freshReturned = false;
    let clocksAfterFresh = 0;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 2) freshReturned = true;
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
        if (!freshReturned) return 0;
        clocksAfterFresh += 1;
        return clocksAfterFresh >= 2 ? 100 : 0;
      },
    });

    await expect(runtime.spawn(spawnInput, {
      deadlineMs: 100,
      maxReconciliationReads: 1,
    })).resolves.toMatchObject({
      kind: "partial",
      agentRef: { environmentId: "env-1", threadId: "thread-1" },
      createReceipt: { commandId: "create-1", threadId: "thread-1", acceptedSequence: 2 },
      initialTurn: {
        commandId: "turn-1",
        messageId: "message-1",
        state: "deadline_exhausted",
        safeAction: "observe",
      },
    });
    expect(commands.map((entry) => entry.type)).toEqual(["thread.create"]);
  });

  test("resume descriptor failure retains the possibly durable create attempt", async () => {
    let descriptorReads = 0;
    let shellReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => {
          descriptorReads += 1;
          if (descriptorReads === 2) throw receivedError("server_internal");
          return environment();
        },
        getShell: async () => {
          shellReads += 1;
          if (shellReads === 2) throw receivedError("server_internal");
          return shell(2);
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: ids("create-1", "thread-1", "turn-1", "message-1"),
      now: () => iso,
    });

    const first = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
    if (first.kind !== "create_reconciliation_pending") {
      throw new Error("expected pending create reconciliation");
    }

    await expect(runtime.resumeCreateReconciliation(first, spawnInput, {
      maxReconciliationReads: 1,
    })).resolves.toMatchObject({
      kind: "create_reconciliation_pending",
      provisionalRef: { environmentId: "env-1", threadId: "thread-1" },
      createAttempt: { commandId: "create-1", threadId: "thread-1", acceptedSequence: 2 },
      reconciliation: {
        reason: "transport_exhausted",
        evidence: [{ stage: "resume_descriptor", class: "server_internal", status: 500 }],
      },
      initialTurnContinuation: { commandId: "turn-1", messageId: "message-1" },
    });
  });

  test("ambiguous send terminal rejection carries full receipt identity", async () => {
    let detailReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          return detail(detailReads === 1 ? 2 : 3, detailReads === 1 ? [] : [message("foreign", "other")]);
        },
        dispatch: async () => {
          throw new StockT3HttpError("transport_unavailable", null);
        },
      }),
      id: ids("command-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };

    await expect(runtime.send(ref, "target", { maxReconciliationReads: 1 })).rejects.toMatchObject({
      code: "superseded",
      evidence: {
        stage: "send_reconciliation",
        receipt: {
          agentRef: ref,
          commandId: "command-1",
          messageId: "message-1",
          leaseId: "lease-1",
          acceptedSequence: null,
        },
      },
    });
  });

});
