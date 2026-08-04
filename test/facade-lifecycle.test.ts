import { describe, expect, test } from "bun:test";

import {
  StockRuntimeError,
  type AgentRef,
  type RuntimeOperationOptions,
  type StockT3RuntimeClient,
  type T3NativeRuntime,
  type ThreadMetaFields,
} from "../src/nativeRuntime";
import type {
  ShellSnapshot,
  StockThreadShell,
  ThreadDetailSnapshot,
} from "../src/stockT3Contracts";
import { decodeReadModelSnapshot } from "../src/stockT3Contracts";
import { createStockT3NativeRuntime } from "./support/modelCache";
import { createStockT3Facade } from "../src/facade";
import { createStockT3McpFacade } from "../src/mcp";
import { StockT3HttpError } from "../src/stockT3HttpClient";
import { createWorkerOverlay, recordWorkerTerminalState } from "../src/overlay";

const ref: AgentRef = Object.freeze({ environmentId: "env-1", threadId: "thread-1" });
const iso = "2026-08-04T10:00:00.000Z";
const later = "2026-08-05T10:00:00.000Z";
const operation = Object.freeze({ timeoutMs: 100, maxReconciliationReads: 1 });

type LifecycleMethod =
  | "archive"
  | "unarchive"
  | "settle"
  | "unsettle"
  | "snooze"
  | "unsnooze"
  | "updateMeta";

type LifecycleState = {
  archivedAt: string | null;
  settledOverride: "settled" | "active" | null;
  settledAt: string | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  title: string;
  modelSelection: { instanceId: string; model: string };
  branch: string | null;
  worktreePath: string | null;
};

const activeState: LifecycleState = {
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  title: "worker",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  branch: null,
  worktreePath: null,
};

function thread(state: LifecycleState): StockThreadShell {
  return {
    id: ref.threadId,
    projectId: "project-1",
    title: state.title,
    modelSelection: state.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: state.branch,
    worktreePath: state.worktreePath,
    latestTurn: null,
    createdAt: iso,
    updatedAt: iso,
    archivedAt: state.archivedAt,
    settledOverride: state.settledOverride,
    settledAt: state.settledAt,
    snoozedUntil: state.snoozedUntil,
    snoozedAt: state.snoozedAt,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
}

function shell(sequence: number, state: LifecycleState): ShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [],
    threads: [thread(state)],
    updatedAt: iso,
  };
}

function detail(sequence: number, state: LifecycleState): ThreadDetailSnapshot {
  const current = thread(state);
  return {
    snapshotSequence: sequence,
    thread: {
      id: current.id,
      projectId: current.projectId,
      title: current.title,
      modelSelection: current.modelSelection,
      runtimeMode: current.runtimeMode,
      interactionMode: current.interactionMode,
      branch: current.branch,
      worktreePath: current.worktreePath,
      latestTurn: current.latestTurn,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      archivedAt: current.archivedAt,
      settledOverride: current.settledOverride,
      settledAt: current.settledAt,
      snoozedUntil: current.snoozedUntil,
      snoozedAt: current.snoozedAt,
      session: current.session,
      messages: [],
      activities: [],
      checkpoints: [],
    },
  };
}

function readModel(sequence: number, state: LifecycleState) {
  return {
    snapshotSequence: sequence,
    projects: [],
    threads: [detail(sequence, state).thread],
    updatedAt: iso,
  };
}

function descriptor(environmentId = ref.environmentId) {
  return {
    environmentId,
    label: "local",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "stock",
    capabilities: { repositoryIdentity: false },
  };
}

function runtimeClient(input: {
  state: () => LifecycleState;
  sequence?: () => number;
  dispatch?: StockT3RuntimeClient["dispatch"];
  calls?: string[];
}): StockT3RuntimeClient {
  const sequence = input.sequence ?? (() => 1);
  return {
    getDescriptor: async () => {
      input.calls?.push("getDescriptor");
      return descriptor();
    },
    getShell: async () => {
      input.calls?.push("getShell");
      return shell(sequence(), input.state());
    },
    getSnapshot: async () => {
      input.calls?.push("getSnapshot");
      return readModel(sequence(), input.state());
    },
    getThread: async () => {
      input.calls?.push("getThread");
      return detail(sequence(), input.state());
    },
    dispatch: input.dispatch ?? (async () => ({ sequence: 2 })),
  };
}

function invoke(
  runtime: ReturnType<typeof createStockT3NativeRuntime>,
  method: LifecycleMethod,
  target: AgentRef = ref,
  options: RuntimeOperationOptions = operation,
) {
  switch (method) {
    case "archive": return runtime.archive(target, options);
    case "unarchive": return runtime.unarchive(target, options);
    case "settle": return runtime.settle(target, options);
    case "unsettle": return runtime.unsettle(target, options);
    case "snooze": return runtime.snooze(target, later, options);
    case "unsnooze": return runtime.unsnooze(target, options);
    case "updateMeta": return runtime.updateMeta(
      target,
      {
        title: "renamed",
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
        branch: "feat/lifecycle",
        worktreePath: "/tmp/lifecycle",
      },
      options,
    );
  }
}

const cases: readonly {
  method: LifecycleMethod;
  command: string;
  initial: LifecycleState;
  applied: LifecycleState;
  noOpReason: string;
  expectedPayload?: Readonly<Record<string, unknown>>;
}[] = [
  {
    method: "archive",
    command: "thread.archive",
    initial: activeState,
    applied: { ...activeState, archivedAt: later },
    noOpReason: "already_archived",
  },
  {
    method: "unarchive",
    command: "thread.unarchive",
    initial: { ...activeState, archivedAt: iso },
    applied: activeState,
    noOpReason: "already_unarchived",
  },
  {
    method: "settle",
    command: "thread.settle",
    initial: activeState,
    applied: { ...activeState, settledOverride: "settled", settledAt: later },
    noOpReason: "already_settled",
  },
  {
    method: "unsettle",
    command: "thread.unsettle",
    initial: { ...activeState, settledOverride: "settled", settledAt: iso },
    applied: { ...activeState, settledOverride: "active" },
    noOpReason: "already_unsettled",
    expectedPayload: { reason: "user" },
  },
  {
    method: "snooze",
    command: "thread.snooze",
    initial: activeState,
    applied: { ...activeState, snoozedUntil: later, snoozedAt: iso },
    noOpReason: "already_snoozed_until_target",
    expectedPayload: { snoozedUntil: later },
  },
  {
    method: "unsnooze",
    command: "thread.unsnooze",
    initial: { ...activeState, snoozedUntil: later, snoozedAt: iso },
    applied: activeState,
    noOpReason: "not_snoozed",
    expectedPayload: { reason: "user" },
  },
  {
    method: "updateMeta",
    command: "thread.meta.update",
    initial: activeState,
    applied: {
      ...activeState,
      title: "renamed",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
      branch: "feat/lifecycle",
      worktreePath: "/tmp/lifecycle",
    },
    noOpReason: "metadata_unchanged",
    expectedPayload: {
      title: "renamed",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
      branch: "feat/lifecycle",
      worktreePath: "/tmp/lifecycle",
    },
  },
];

describe("stock facade lifecycle commands", () => {
  for (const entry of cases) {
    test(`${entry.method} refuses an invalid scoped ref before any HTTP`, async () => {
      const calls: string[] = [];
      const runtime = createStockT3NativeRuntime({
        client: runtimeClient({ state: () => entry.initial, calls }),
      });

      await expect(invoke(runtime, entry.method, { environmentId: " ", threadId: ref.threadId }))
        .rejects.toMatchObject({ code: "identity_conflict" });
      expect(calls).toEqual([]);
      runtime.close();
    });

    test(`${entry.method} returns a typed no-op when the target state is already projected`, async () => {
      let dispatches = 0;
      const runtime = createStockT3NativeRuntime({
        client: runtimeClient({
          state: () => entry.applied,
          dispatch: async () => {
            dispatches += 1;
            return { sequence: 2 };
          },
        }),
      });

      await expect(invoke(runtime, entry.method)).resolves.toMatchObject({
        kind: "no_op",
        operation: entry.method,
        reason: entry.noOpReason,
        agentRef: ref,
      });
      expect(dispatches).toBe(0);
      runtime.close();
    });

    test(`${entry.method} returns typed pending after acceptance without projection`, async () => {
      const commands: Array<Readonly<Record<string, unknown>>> = [];
      const runtime = createStockT3NativeRuntime({
        client: runtimeClient({
          state: () => entry.initial,
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 2 };
          },
        }),
        id: () => `${entry.method}-command`,
      });

      await expect(invoke(runtime, entry.method)).resolves.toMatchObject({
        kind: "pending",
        operation: entry.method,
        reason: "projection_pending",
        agentRef: ref,
        receipt: {
          commandId: `${entry.method}-command`,
          acceptedSequence: 2,
        },
      });
      expect(commands).toEqual([{
        type: entry.command,
        commandId: `${entry.method}-command`,
        threadId: ref.threadId,
        ...(entry.expectedPayload ?? {}),
      }]);
      runtime.close();
    });
  }

  test("confirms all seven operations only after aligned projection evidence", async () => {
    for (const entry of cases) {
      let state = entry.initial;
      let sequence = 1;
      const runtime = createStockT3NativeRuntime({
        client: runtimeClient({
          state: () => state,
          sequence: () => sequence,
          dispatch: async () => {
            state = entry.applied;
            sequence = 2;
            return { sequence: 2 };
          },
        }),
        id: () => `${entry.method}-command`,
      });

      await expect(invoke(runtime, entry.method, ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
        kind: "applied",
        operation: entry.method,
        receipt: { acceptedSequence: 2, observedSequence: 2 },
      });
      runtime.close();
    }
  });

  test("validates snooze and metadata inputs before any HTTP", async () => {
    const calls: string[] = [];
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({ state: () => activeState, calls }),
    });

    await expect(runtime.snooze(ref, "not-a-date")).rejects.toMatchObject({
      code: "protocol_mismatch",
      evidence: { field: "snoozedUntil" },
    });
    await expect(runtime.updateMeta(ref, {})).rejects.toMatchObject({
      code: "protocol_mismatch",
      evidence: { field: "fields" },
    });
    await expect(runtime.updateMeta(ref, { regenerateTitle: true } as ThreadMetaFields))
      .rejects.toMatchObject({ code: "protocol_mismatch", evidence: { field: "fields.regenerateTitle" } });
    expect(calls).toEqual([]);
    runtime.close();
  });

  test("never emits thread.delete", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    for (const entry of cases) {
      const runtime = createStockT3NativeRuntime({
        client: runtimeClient({
          state: () => entry.initial,
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 2 };
          },
        }),
      });
      await invoke(runtime, entry.method);
      runtime.close();
    }
    expect(commands.every((command) => command.type !== "thread.delete")).toBeTrue();
  });

  test("derives an expired snooze as not snoozed and performs no dispatch", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({
        state: () => ({ ...activeState, snoozedUntil: "2026-08-03T10:00:00.000Z", snoozedAt: iso }),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 2 };
        },
      }),
      now: () => iso,
    });

    await expect(runtime.unsnooze(ref)).resolves.toMatchObject({
      kind: "no_op",
      operation: "unsnooze",
      reason: "not_snoozed",
    });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("reconciles an ambiguous lifecycle dispatch before one byte-identical retry", async () => {
    let state = activeState;
    let sequence = 1;
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({
        state: () => state,
        sequence: () => sequence,
        dispatch: async (command) => {
          commands.push(command);
          if (commands.length === 1) throw new StockT3HttpError("transport_unavailable", null);
          state = { ...activeState, archivedAt: later };
          sequence = 2;
          return { sequence: 2 };
        },
      }),
      id: () => "archive-command",
    });

    await expect(runtime.archive(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      operation: "archive",
      receipt: {
        commandId: "archive-command",
        retryState: "identical_retry_accepted",
      },
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    runtime.close();
  });

  test("caps ambiguous lifecycle dispatch at one byte-identical retry and returns pending", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({
        state: () => activeState,
        dispatch: async (command) => {
          commands.push(command);
          throw new StockT3HttpError("transport_unavailable", null);
        },
      }),
      id: () => "archive-command",
    });

    await expect(runtime.archive(ref, { timeoutMs: 1_000, maxReconciliationReads: 1 }))
      .resolves.toMatchObject({
        kind: "pending",
        operation: "archive",
        receipt: {
          commandId: "archive-command",
          acceptedSequence: null,
          retryState: "identical_retry_outcome_unknown",
        },
      });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    runtime.close();
  });

  test("treats a lagging decoded read model as pending instead of a protocol failure", async () => {
    const runtime = createStockT3NativeRuntime({
      client: {
        ...runtimeClient({ state: () => activeState }),
        getSnapshot: async (boundary = {}) => decodeReadModelSnapshot(
          readModel(1, activeState),
          { minimumSequence: boundary.minimumSequence },
        ),
        dispatch: async () => ({ sequence: 2 }),
      },
    });

    await expect(runtime.archive(ref, { timeoutMs: 1_000, maxReconciliationReads: 1 }))
      .resolves.toMatchObject({
        kind: "pending",
        operation: "archive",
        receipt: { acceptedSequence: 2, observedSequence: 1 },
      });
    runtime.close();
  });

  test("fails closed when archive cannot access the stock full snapshot", async () => {
    const { getSnapshot: _getSnapshot, ...withoutSnapshot } = runtimeClient({
      state: () => activeState,
    });
    const runtime = createStockT3NativeRuntime({ client: withoutSnapshot });

    await expect(runtime.archive(ref)).rejects.toMatchObject({
      code: "protocol_mismatch",
      evidence: { reason: "full_snapshot_unavailable" },
    });
    runtime.close();
  });

  test("refuses archive for a soft-deleted full-snapshot tombstone", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: {
        ...runtimeClient({ state: () => activeState }),
        getSnapshot: async () => ({
          ...readModel(1, activeState),
          threads: [{ ...detail(1, activeState).thread, deletedAt: iso }],
        }),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 2 };
        },
      },
    });

    await expect(runtime.archive(ref)).rejects.toMatchObject({
      code: "identity_conflict",
      evidence: { reason: "thread_not_found", threadId: ref.threadId },
    });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("confirms archive from stock's full snapshot after active shell/detail disappearance", async () => {
    let archived = false;
    let sequence = 1;
    const runtime = createStockT3NativeRuntime({
      client: {
        getDescriptor: async () => descriptor(),
        getSnapshot: async () => readModel(
          sequence,
          archived ? { ...activeState, archivedAt: later } : activeState,
        ),
        getShell: async () => archived
          ? { ...shell(sequence, activeState), threads: [] }
          : shell(sequence, activeState),
        getThread: async () => archived ? undefined : detail(sequence, activeState),
        dispatch: async () => {
          archived = true;
          sequence = 2;
          return { sequence: 2 };
        },
      } as StockT3RuntimeClient,
      id: () => "archive-command",
    });
    await expect(runtime.archive(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      operation: "archive",
      receipt: { acceptedSequence: 2, observedSequence: 2 },
      snapshot: { thread: { archivedAt: later } },
    });
    runtime.close();
  });

  test("preflights and confirms unarchive through the full snapshot", async () => {
    let archived = true;
    let sequence = 1;
    const runtime = createStockT3NativeRuntime({
      client: {
        getDescriptor: async () => descriptor(),
        getSnapshot: async () => readModel(
          sequence,
          archived ? { ...activeState, archivedAt: iso } : activeState,
        ),
        getShell: async () => archived
          ? { ...shell(sequence, activeState), threads: [] }
          : shell(sequence, activeState),
        getThread: async () => archived ? undefined : detail(sequence, activeState),
        dispatch: async () => {
          archived = false;
          sequence = 2;
          return { sequence: 2 };
        },
      } as StockT3RuntimeClient,
      id: () => "unarchive-command",
    });

    await expect(runtime.unarchive(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      operation: "unarchive",
      receipt: { acceptedSequence: 2, observedSequence: 2 },
      snapshot: { thread: { archivedAt: null } },
    });
    runtime.close();
  });

  test("dispatches unsettle for an auto-settled thread without an explicit settled override", async () => {
    let state = activeState;
    let sequence = 1;
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({
        state: () => state,
        sequence: () => sequence,
        dispatch: async () => {
          dispatches += 1;
          state = { ...activeState, settledOverride: "active" };
          sequence = 2;
          return { sequence: 2 };
        },
      }),
    });

    await expect(runtime.unsettle(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      operation: "unsettle",
    });
    expect(dispatches).toBe(1);
    runtime.close();
  });

  test("refuses settle for a running thread and snooze for pending user work", async () => {
    let dispatches = 0;
    const baseClient = runtimeClient({
      state: () => activeState,
      dispatch: async () => {
        dispatches += 1;
        return { sequence: 2 };
      },
    });
    const running = createStockT3NativeRuntime({
      client: {
        ...baseClient,
        getShell: async () => ({
          ...shell(1, activeState),
          threads: [{
            ...thread(activeState),
            session: {
              threadId: ref.threadId,
              status: "running",
              providerName: "claudeAgent",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: iso,
            },
          }],
        }),
      },
    });
    await expect(running.settle(ref)).rejects.toMatchObject({
      code: "command_rejected",
      evidence: { reason: "thread_not_settleable" },
    });
    running.close();

    const pending = createStockT3NativeRuntime({
      client: {
        ...baseClient,
        getShell: async () => ({
          ...shell(1, activeState),
          threads: [{ ...thread(activeState), hasPendingUserInput: true }],
        }),
      },
      now: () => iso,
    });
    await expect(pending.snooze(ref, later)).rejects.toMatchObject({
      code: "command_rejected",
      evidence: { reason: "thread_not_snoozable" },
    });
    pending.close();
    expect(dispatches).toBe(0);
  });

  test("fails closed when required lifecycle projection fields are absent", async () => {
    const projected = thread(activeState);
    const { settledAt: _settledAt, ...withoutSettledAt } = projected;
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: {
        ...runtimeClient({ state: () => activeState }),
        getShell: async () => ({
          ...shell(1, activeState),
          threads: [withoutSettledAt as StockThreadShell],
        }),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 2 };
        },
      },
    });

    await expect(runtime.settle(ref)).rejects.toMatchObject({
      code: "protocol_mismatch",
      evidence: { reason: "lifecycle_projection_unavailable", field: "settledAt" },
    });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("rejects null metadata strings and past snoozes locally", async () => {
    const calls: string[] = [];
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({ state: () => activeState, calls }),
      now: () => iso,
    });

    for (const fields of [
      { title: null },
      { modelSelection: { instanceId: null, model: "claude-opus-5" } },
      { modelSelection: { instanceId: "claudeAgent", model: null } },
    ]) {
      await expect(runtime.updateMeta(
        ref,
        fields as unknown as ThreadMetaFields,
        { timeoutMs: 100, maxReconciliationReads: 1 },
      ))
        .rejects.toMatchObject({ code: "protocol_mismatch" });
    }
    await expect(runtime.snooze(ref, iso)).rejects.toMatchObject({
      code: "command_rejected",
      evidence: { reason: "snooze_not_in_future" },
    });
    expect(calls).toEqual([]);
    runtime.close();
  });

  test("confirms equivalent model options independent of object key order", async () => {
    const requested = {
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      options: [{ id: "thinking", value: { enabled: true, budget: 8_000 } }],
    };
    const projected = {
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      options: [{ value: { budget: 8_000, enabled: true }, id: "thinking" }],
    };
    let state: LifecycleState = activeState;
    let sequence = 1;
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({
        state: () => state,
        sequence: () => sequence,
        dispatch: async () => {
          state = { ...activeState, modelSelection: projected };
          sequence = 2;
          return { sequence: 2 };
        },
      }),
    });

    await expect(runtime.updateMeta(ref, { modelSelection: requested }, { timeoutMs: 1_000 }))
      .resolves.toMatchObject({ kind: "applied", operation: "updateMeta" });
    runtime.close();
  });

  test("restores terminal overlay state when a lifecycle result remains pending", async () => {
    const overlay = createWorkerOverlay({ maxWorkers: 1 });
    overlay.attach(ref, { role: "worker", parentRef: null });
    recordWorkerTerminalState(overlay, ref, true);
    const pending = {
      kind: "pending" as const,
      operation: "archive" as const,
      reason: "projection_pending" as const,
      agentRef: ref,
      receipt: {
        operation: "archive" as const,
        commandId: "archive-command",
        acceptedSequence: 2,
        observedSequence: 1,
        retryState: "not_needed" as const,
      },
      snapshot: detail(1, activeState),
    };
    const facade = createStockT3Facade({
      archive: async () => pending,
    } as unknown as T3NativeRuntime, { overlay });

    await expect(facade.archive(ref)).resolves.toEqual(pending);
    const replacement = { environmentId: ref.environmentId, threadId: "thread-2" };
    expect(() => overlay.attach(replacement, { role: "worker", parentRef: null })).not.toThrow();
    expect(overlay.getWorker(replacement)?.ref).toEqual(replacement);
  });
});

describe("stock facade lifecycle MCP parity", () => {
  test("publishes exact schemas and routes all seven methods without drift", async () => {
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const snapshot = detail(2, activeState);
    const fake = {
      archive: async (...args: readonly unknown[]) => (calls.push({ method: "archive", args }), snapshot),
      unarchive: async (...args: readonly unknown[]) => (calls.push({ method: "unarchive", args }), snapshot),
      settle: async (...args: readonly unknown[]) => (calls.push({ method: "settle", args }), snapshot),
      unsettle: async (...args: readonly unknown[]) => (calls.push({ method: "unsettle", args }), snapshot),
      snooze: async (...args: readonly unknown[]) => (calls.push({ method: "snooze", args }), snapshot),
      unsnooze: async (...args: readonly unknown[]) => (calls.push({ method: "unsnooze", args }), snapshot),
      updateMeta: async (...args: readonly unknown[]) => (calls.push({ method: "updateMeta", args }), snapshot),
    } as unknown as ReturnType<typeof createStockT3Facade>;
    const mcp = createStockT3McpFacade(fake);
    const names = mcp.listTools().map((tool) => tool.name);
    expect([
      "archive", "unarchive", "settle", "unsettle", "snooze", "unsnooze", "updateMeta",
    ].every((name) => names.includes(name as (typeof names)[number]))).toBeTrue();

    for (const name of ["archive", "unarchive", "settle", "unsettle", "unsnooze"] as const) {
      const result = await mcp.callTool(name, { ref, operation });
      expect(result.isError).toBeFalse();
    }
    expect((await mcp.callTool("snooze", { ref, until: later, operation })).isError).toBeFalse();
    const fields: ThreadMetaFields = { title: "renamed", branch: null };
    expect((await mcp.callTool("updateMeta", { ref, fields, operation })).isError).toBeFalse();
    expect(calls).toEqual([
      { method: "archive", args: [ref, operation] },
      { method: "unarchive", args: [ref, operation] },
      { method: "settle", args: [ref, operation] },
      { method: "unsettle", args: [ref, operation] },
      { method: "unsnooze", args: [ref, operation] },
      { method: "snooze", args: [ref, later, operation] },
      { method: "updateMeta", args: [ref, fields, operation] },
    ]);

    const updateMeta = mcp.listTools().find((tool) => tool.name === "updateMeta")!;
    const fieldsSchema = updateMeta.inputSchema.properties.fields as {
      additionalProperties: boolean;
      properties: Readonly<Record<string, unknown>>;
    };
    expect(fieldsSchema.additionalProperties).toBeFalse();
    expect(Object.keys(fieldsSchema.properties)).toEqual([
      "title", "modelSelection", "branch", "worktreePath",
    ]);
  });

  test("keeps lifecycle validation evidence identical across direct and MCP with zero HTTP", async () => {
    const calls: string[] = [];
    const runtime = createStockT3NativeRuntime({
      client: runtimeClient({ state: () => activeState, calls }),
    });
    const facade = createStockT3Facade(runtime);
    const mcp = createStockT3McpFacade(facade);

    const direct = await runtime.snooze(ref, "invalid").catch((error) => error);
    expect(direct).toBeInstanceOf(StockRuntimeError);
    const throughMcp = await mcp.callTool("snooze", { ref, until: "invalid" });
    expect(throughMcp).toMatchObject({
      isError: true,
      structuredContent: {
        error: { type: "stock_runtime", code: direct.code, evidence: direct.evidence },
      },
    });

    const forbidden = await mcp.callTool("updateMeta", {
      ref,
      fields: { regenerateTitle: true },
    });
    expect(forbidden).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          type: "stock_runtime",
          code: "protocol_mismatch",
          evidence: { field: "fields.regenerateTitle" },
        },
      },
    });
    expect(calls).toEqual([]);
    runtime.close();
  });
});
