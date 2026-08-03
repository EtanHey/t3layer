import { describe, expect, test } from "bun:test";

import {
  digestStockSpawnInput,
  type CreateReconciliationPending,
  type StockSpawnInput,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import { createStockT3NativeRuntime } from "./support/modelCache";
import type {
  ShellSnapshot,
  StockMessage,
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

function userMessage(id = "message-1"): StockMessage {
  return {
    id,
    role: "user",
    text: "initial",
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
  overrides: Partial<ThreadDetailSnapshot["thread"]> = {},
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
      latestTurn: null,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
      session: null,
      messages,
      activities: [],
      checkpoints: [],
      ...overrides,
    },
  };
}

function baseClient(overrides: Partial<StockT3RuntimeClient> = {}): StockT3RuntimeClient {
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

function ids() {
  const values = ["create-1", "thread-1", "turn-1", "message-1", "lease-1"];
  return () => values.shift()!;
}

async function pendingReceipt(
  runtime: ReturnType<typeof createStockT3NativeRuntime>,
  overrides: Partial<CreateReconciliationPending["createAttempt"]> = {},
): Promise<CreateReconciliationPending> {
  return {
    kind: "create_reconciliation_pending",
    provisionalRef: { environmentId: "env-1", threadId: "thread-1" },
    createAttempt: {
      commandId: "create-1",
      threadId: "thread-1",
      projectId: "project-1",
      acceptedSequence: 9,
      dispatchState: "accepted",
      retryState: "not_applicable",
      retryError: null,
      ...overrides,
    },
    reconciliation: {
      reason: "projection_pending",
      projectionState: "unobserved",
      highestShellSequence: null,
      highestDetailSequence: null,
      deadlineMs: 1_000,
      evidence: [],
    },
    initialTurnContinuation: {
      commandId: "turn-1",
      messageId: "message-1",
      inputDigest: await digestStockSpawnInput(spawnInput),
    },
    safeAction: "resume_create_reconciliation",
  };
}

describe("stock native runtime create state machine", () => {
  test("requires a public stock HTTP client or base URL", () => {
    expect(() => createStockT3NativeRuntime({})).toThrow("client or baseUrl is required");
  });

  test("preserves an accepted create when cancellation follows its response", async () => {
    const controller = new AbortController();
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createStockT3NativeRuntime({
      client: baseClient({
        dispatch: async (command) => {
          commands.push(command);
          controller.abort();
          return { sequence: 2 };
        },
      }),
      id: ids(),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput, { signal: controller.signal });
    expect(result).toMatchObject({
      kind: "create_reconciliation_pending",
      createAttempt: { acceptedSequence: 2, retryState: "not_applicable" },
      reconciliation: { reason: "cancelled" },
    });
    expect(commands.map((entry) => entry.type)).toEqual(["thread.create"]);
  });

  test("does not retry an ambiguous create when cancellation wins during first reconciliation", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    let shellReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: baseClient({
        getShell: async () => {
          shellReads += 1;
          if (shellReads > 1) controller.abort();
          return shell(1);
        },
        dispatch: async () => {
          dispatches += 1;
          throw new StockT3HttpError("transport_unavailable", null);
        },
      }),
      id: ids(),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput, {
      signal: controller.signal,
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "create_reconciliation_pending",
      createAttempt: { retryState: "eligible_not_sent" },
      reconciliation: { reason: "cancelled" },
    });
    expect(dispatches).toBe(1);
  });

  test("records a no-response retry and never mutates again when cancellation follows it", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: baseClient({
        getShell: async () => shell(1),
        getThread: async () => undefined,
        dispatch: async () => {
          dispatches += 1;
          if (dispatches === 2) controller.abort();
          throw new StockT3HttpError("transport_unavailable", null);
        },
      }),
      id: ids(),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput, {
      signal: controller.signal,
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "create_reconciliation_pending",
      createAttempt: { retryState: "identical_retry_sent_no_response" },
      reconciliation: { reason: "cancelled" },
    });
    expect(dispatches).toBe(2);
  });

  test("preserves retry acceptance when reconciliation is interrupted", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: baseClient({
        getShell: async () => shell(1),
        getThread: async () => undefined,
        dispatch: async () => {
          dispatches += 1;
          if (dispatches === 1) throw new StockT3HttpError("transport_unavailable", null);
          controller.abort();
          return { sequence: 7 };
        },
      }),
      id: ids(),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput, {
      signal: controller.signal,
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "create_reconciliation_pending",
      createAttempt: {
        dispatchState: "accepted",
        acceptedSequence: 7,
        retryState: "identical_retry_accepted",
      },
      reconciliation: { reason: "cancelled" },
    });
    expect(dispatches).toBe(2);
  });

  test.each([
    [400, "command_rejected", "invalid_request", "invalid_command"],
    [401, "authentication_failed", "auth_invalid", null],
    [403, "permission_denied", "insufficient_scope", null],
    [500, "server_internal", "internal_error", "orchestration_dispatch_failed"],
  ] as const)(
    "recovers a durable original read-only after its identical retry returns %i",
    async (status, errorClass, code, reason) => {
      let visible = false;
      let turnAccepted = false;
      const commands: Array<Record<string, unknown>> = [];
      const runtime = createStockT3NativeRuntime({
        client: baseClient({
          getShell: async () =>
            shell(9, visible ? [shellThread()] : []),
          getThread: async () =>
            visible
              ? detail(9, turnAccepted ? [userMessage()] : [])
              : undefined,
          dispatch: async (command) => {
            commands.push(command);
            if (commands.length === 1) {
              throw new StockT3HttpError("transport_unavailable", null);
            }
            if (commands.length === 2) {
              throw new StockT3HttpError(errorClass, status, { code, reason });
            }
            turnAccepted = true;
            return { sequence: 10 };
          },
        }),
        id: ids(),
        now: () => iso,
      });

      const first = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
      expect(first).toMatchObject({
        kind: "create_reconciliation_pending",
        createAttempt: {
          projectId: "project-1",
          dispatchState: "outcome_unknown",
          acceptedSequence: null,
          retryState: "identical_retry_received_error",
          retryError: { status, class: errorClass, code, reason },
        },
      });
      if (first.kind !== "create_reconciliation_pending") {
        throw new Error("expected pending create");
      }
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);

      visible = true;
      const resumed = await runtime.resumeCreateReconciliation(first, spawnInput, {
        maxReconciliationReads: 1,
      });
      expect(resumed.kind).toBe("spawned");
      expect(commands.map((entry) => entry.type)).toEqual([
        "thread.create",
        "thread.create",
        "thread.turn.start",
      ]);
      expect(commands).not.toContainEqual(expect.objectContaining({ type: "thread.delete" }));
    },
  );
});

describe("stock native runtime read-only resume", () => {
  test.each([
    ["shell_only", shell(9, [shellThread()]), undefined],
    ["detail_only", shell(9), detail(9)],
    ["below_required_sequence", shell(8, [shellThread()]), detail(8)],
  ] as const)(
    "keeps valid %s evidence pending without mutation",
    async (projectionState, shellValue, detailValue) => {
      let dispatches = 0;
      const runtime = createStockT3NativeRuntime({
        client: baseClient({
          getShell: async () => shellValue,
          getThread: async () => detailValue,
          dispatch: async () => {
            dispatches += 1;
            return { sequence: 10 };
          },
        }),
        id: ids(),
        now: () => iso,
      });
      const pending = await pendingReceipt(runtime);
      const result = await runtime.resumeCreateReconciliation(pending, spawnInput, {
        maxReconciliationReads: 1,
      });
      expect(result).toMatchObject({
        kind: "create_reconciliation_pending",
        reconciliation: { projectionState },
      });
      expect(dispatches).toBe(0);
    },
  );

  test("retains the provisional ref on a true detail identity conflict", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: baseClient({
        getShell: async () => shell(9),
        getThread: async () => detail(9, [], { projectId: "foreign-project" }),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 10 };
        },
      }),
      id: ids(),
      now: () => iso,
    });
    const pending = await pendingReceipt(runtime);
    const result = await runtime.resumeCreateReconciliation(pending, spawnInput, {
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "create_protocol_failure",
      provisionalRef: pending.provisionalRef,
      conflict: { source: "detail" },
    });
    expect(dispatches).toBe(0);
  });

  test("treats different model options as a true thread identity conflict", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: baseClient({
        getShell: async () => shell(9),
        getThread: async () => detail(9, [], {
          modelSelection: { ...modelSelection, options: [{ temperature: 1 }] },
        }),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 10 };
        },
      }),
      id: ids(),
      now: () => iso,
    });
    const pending = await pendingReceipt(runtime);
    const result = await runtime.resumeCreateReconciliation(pending, spawnInput, {
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "create_protocol_failure",
      provisionalRef: pending.provisionalRef,
      conflict: { source: "detail" },
    });
    expect(dispatches).toBe(0);
  });
});

describe("stock native runtime inclusive create deadline", () => {
  test.each([
    [99, "spawned"],
    [100, "partial"],
    [101, "create_reconciliation_pending"],
  ] as const)("classifies complete create evidence arriving at t=%i", async (arrival, expectedKind) => {
    let current = 0;
    let shellReads = 0;
    let turnAccepted = false;
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createStockT3NativeRuntime({
      client: baseClient({
        getShell: async () => {
          shellReads += 1;
          if (shellReads > 1) current = 98;
          return shell(2, shellReads > 1 ? [shellThread()] : []);
        },
        getThread: async () => {
          if (!turnAccepted) current = arrival;
          return detail(2, turnAccepted ? [userMessage()] : []);
        },
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "thread.turn.start") turnAccepted = true;
          return { sequence: command.type === "thread.create" ? 2 : 3 };
        },
      }),
      id: ids(),
      now: () => iso,
      clock: () => current,
    });

    const result = await runtime.spawn(spawnInput, {
      deadlineMs: 100,
      maxReconciliationReads: 1,
    });
    expect(result.kind).toBe(expectedKind);
    expect(commands.map((entry) => entry.type)).toEqual(
      arrival < 100 ? ["thread.create", "thread.turn.start"] : ["thread.create"],
    );
    if (arrival === 100) {
      expect(result).toMatchObject({
        kind: "partial",
        initialTurn: { state: "deadline_exhausted" },
      });
    }
    if (arrival === 101) {
      expect(result).toMatchObject({
        kind: "create_reconciliation_pending",
        reconciliation: { reason: "deadline_exhausted" },
      });
    }
  });
});
