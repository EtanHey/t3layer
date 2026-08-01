import { describe, expect, test } from "bun:test";

import {
  StockRuntimeError,
  createStockT3NativeRuntime,
  digestStockSpawnInput,
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
import { createStockT3Facade } from "../src/facade";
import { WorkerOverlayError } from "../src/overlay";

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

function threadIdentity(id = "thread-1"): StockThreadShell {
  return {
    id,
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
  };
}

function shell(sequence: number, threads: StockThreadShell[] = []): ShellSnapshot {
  return { snapshotSequence: sequence, projects: [project], threads, updatedAt: iso };
}

function detail(
  sequence: number,
  messages: StockMessage[] = [],
  latestTurn: StockThreadDetail["latestTurn"] = null,
): ThreadDetailSnapshot {
  const identity = threadIdentity();
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

function detailFor(threadId: string, sequence = 1): ThreadDetailSnapshot {
  const snapshot = detail(sequence);
  return {
    ...snapshot,
    thread: { ...snapshot.thread, id: threadId },
  };
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

const spawnInput = {
  workspaceRoot: project.workspaceRoot,
  title: "worker",
  message: "initial",
  modelSelection: selection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
};

describe("stock HTTP runtime state machine", () => {
  test("exposes the stock runtime through the public facade seam", async () => {
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(1, [threadIdentity()]),
        getThread: async () => detail(1),
      }),
    });
    const facade = createStockT3Facade(runtime);

    await expect(
      facade.observe({ environmentId: "env-1", threadId: "thread-1" }),
    ).resolves.toMatchObject({ snapshotSequence: 1 });
    expect(runtime.pollMetrics()).toMatchObject({ shellStarts: 0, activeWaits: 0 });
  });

  test("spawns with reconciled thread.create then bootstrap-free thread.turn.start", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const details = [
      detail(2),
      detail(2),
      detail(4, [message("message-1", "initial")]),
    ];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(4, [threadIdentity()]),
        getThread: async () => details.shift(),
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length === 1 ? 2 : 4 };
        },
      }),
      id: (() => {
        const ids = ["thread-create-1", "thread-1", "turn-command-1", "message-1", "lease-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput);

    expect(result.kind).toBe("spawned");
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    expect(commands[0]?.commandId).not.toBe(commands[1]?.commandId);
    expect(commands[1]).not.toHaveProperty("bootstrap");
    if (result.kind === "spawned") {
      expect(result.agentRef).toEqual({ environmentId: "env-1", threadId: "thread-1" });
      expect(result.turnReceipt.messageId).toBe("message-1");
    }
  });

  test("preserves an accepted create as reconciliation-pending after projection absence", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(1),
        getThread: async () => undefined,
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 7 };
        },
      }),
      id: (() => {
        const ids = ["create-1", "thread-1", "turn-1", "message-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });

    expect(result).toMatchObject({
      kind: "create_reconciliation_pending",
      provisionalRef: { environmentId: "env-1", threadId: "thread-1" },
      createAttempt: {
        commandId: "create-1",
        threadId: "thread-1",
        acceptedSequence: 7,
        dispatchState: "accepted",
        retryState: "not_applicable",
      },
      reconciliation: { reason: "projection_pending" },
      initialTurnContinuation: { commandId: "turn-1", messageId: "message-1" },
      safeAction: "resume_create_reconciliation",
    });
    expect(commands).toHaveLength(1);
  });

  test.each([
    [400, "command_rejected", "invalid_request", "invalid_command"],
    [401, "authentication_failed", "auth_invalid", null],
    [403, "permission_denied", "insufficient_scope", null],
    [500, "server_internal", "internal_error", "orchestration_dispatch_failed"],
  ] as const)(
    "keeps ambiguous original create pending when identical retry returns %i",
    async (status, errorClass, code, reason) => {
      let dispatches = 0;
      const runtime = createStockT3NativeRuntime({
        client: client({
          getShell: async () => shell(0),
          getThread: async () => undefined,
          dispatch: async () => {
            dispatches += 1;
            if (dispatches === 1) {
              throw new StockT3HttpError("transport_unavailable", null);
            }
            throw new StockT3HttpError(errorClass, status, { code, reason });
          },
        }),
        id: (() => {
          const ids = ["create-1", "thread-1", "turn-1", "message-1"];
          return () => ids.shift()!;
        })(),
        now: () => iso,
      });

      const result = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });

      expect(result).toMatchObject({
        kind: "create_reconciliation_pending",
        createAttempt: {
          dispatchState: "outcome_unknown",
          acceptedSequence: null,
          retryState: "identical_retry_received_error",
          retryError: { status, class: errorClass, code, reason },
        },
        reconciliation: { reason: "retry_error_after_ambiguous_original" },
        safeAction: "resume_create_reconciliation",
      });
      expect(dispatches).toBe(2);
    },
  );

  test("resume performs reads only before reconciliation and preserves initial-turn IDs", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(9, [threadIdentity()]),
        getThread: async () =>
          commands.length === 0
            ? detail(9)
            : detail(10, [message("message-1", "initial")]),
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 10 };
        },
      }),
      id: () => "lease-1",
      now: () => iso,
    });
    const pending = {
      kind: "create_reconciliation_pending" as const,
      provisionalRef: { environmentId: "env-1", threadId: "thread-1" },
      createAttempt: {
        commandId: "create-1",
        threadId: "thread-1",
        projectId: "project-1",
        acceptedSequence: 9,
        dispatchState: "accepted" as const,
        retryState: "not_applicable" as const,
        retryError: null,
      },
      reconciliation: {
        reason: "projection_pending" as const,
        projectionState: "unobserved" as const,
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
      safeAction: "resume_create_reconciliation" as const,
    };

    const result = await runtime.resumeCreateReconciliation(pending, spawnInput);

    expect(result.kind).toBe("spawned");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      commandId: "turn-1",
      threadId: "thread-1",
      message: { messageId: "message-1", text: "initial" },
    });
  });

  test("serializes sends with an expiring per-thread lease", async () => {
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(2, [threadIdentity()]),
        getThread: async () => detail(2),
        dispatch: async () => ({ sequence: 3 }),
      }),
      id: (() => {
        const ids = ["command-1", "message-1", "lease-1", "command-2", "message-2", "lease-2"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });

    const first = await runtime.send({ environmentId: "env-1", threadId: "thread-1" }, "one");
    expect(first.messageId).toBe("message-1");
    await expect(
      runtime.send({ environmentId: "env-1", threadId: "thread-1" }, "two"),
    ).rejects.toMatchObject({ code: "send_in_progress" });
    runtime.releaseReceipt(first);
    await expect(
      runtime.send({ environmentId: "env-1", threadId: "thread-1" }, "two"),
    ).resolves.toMatchObject({ messageId: "message-2" });
  });

  test("fails causal wait when a distinct-ID writer appears before the target", async () => {
    let detailReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(4, [threadIdentity()]),
        getThread: async () => {
          detailReads += 1;
          return detailReads === 1
            ? detail(2)
            : detail(4, [message("foreign", "foreign")]);
        },
        dispatch: async () => ({ sequence: 3 }),
      }),
      id: (() => {
        const ids = ["command-1", "target", "lease-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-1" },
      "target text",
    );

    const error = await runtime.wait(receipt, { timeoutMs: 1_000 }).catch((cause) => cause);
    expect(error).toBeInstanceOf(StockRuntimeError);
    expect(error.code).toBe("superseded");
  });

  test("retries an ambiguous initial turn exactly once with byte-identical command identity", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const details = [
      detail(2),
      detail(2),
      detail(2),
      detail(4, [message("message-1", "initial")]),
    ];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(4, [threadIdentity()]),
        getThread: async () => details.shift(),
        dispatch: async (command) => {
          commands.push(command);
          if (commands.length === 1) return { sequence: 2 };
          if (commands.length === 2) {
            throw new StockT3HttpError("transport_unavailable", null, {
              reason: "request_failed",
            });
          }
          return { sequence: 4 };
        },
      }),
      id: (() => {
        const ids = ["create-1", "thread-1", "turn-1", "message-1", "lease-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });

    const result = await runtime.spawn(spawnInput);

    expect(result.kind).toBe("spawned");
    expect(commands.map((entry) => entry.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.turn.start",
    ]);
    expect(commands[2]).toEqual(commands[1]);
  });

  test.each([
    [400, "command_rejected"],
    [401, "authentication_failed"],
    [403, "permission_denied"],
    [500, "server_internal"],
  ] as const)(
    "preserves ambiguous initial-turn identity when its identical retry returns %i",
    async (status, errorClass) => {
      const commands: Array<Record<string, unknown>> = [];
      const runtime = createStockT3NativeRuntime({
        client: client({
          getShell: async () => shell(4, [threadIdentity()]),
          getThread: async () => detail(4),
          dispatch: async (command) => {
            commands.push(command);
            if (commands.length === 1) return { sequence: 2 };
            if (commands.length === 2) throw new StockT3HttpError("transport_unavailable", null);
            throw new StockT3HttpError(errorClass, status);
          },
        }),
        id: (() => {
          const ids = ["create-1", "thread-1", "turn-1", "message-1", "lease-1"];
          return () => ids.shift()!;
        })(),
        now: () => iso,
      });

      const result = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });

      expect(result).toMatchObject({
        kind: "partial",
        initialTurn: {
          commandId: "turn-1",
          messageId: "message-1",
          state: "initial_turn_outcome_unknown",
          safeAction: "wait",
          turnReceipt: {
            commandId: "turn-1",
            messageId: "message-1",
            leaseId: "lease-1",
          },
          evidence: [{ retryClass: errorClass }],
        },
      });
      expect(commands).toHaveLength(3);
      expect(commands[2]).toEqual(commands[1]);
    },
  );

  test.each([
    [400, "command_rejected"],
    [401, "authentication_failed"],
    [403, "permission_denied"],
    [500, "server_internal"],
  ] as const)(
    "preserves an ambiguous send receipt when its identical retry returns %i",
    async (status, errorClass) => {
      const commands: Array<Record<string, unknown>> = [];
      const runtime = createStockT3NativeRuntime({
        client: client({
          getThread: async () => detail(2),
          dispatch: async (command) => {
            commands.push(command);
            if (commands.length === 1) throw new StockT3HttpError("transport_unavailable", null);
            throw new StockT3HttpError(errorClass, status);
          },
        }),
        id: (() => {
          const ids = ["command-1", "message-1", "lease-1"];
          return () => ids.shift()!;
        })(),
        now: () => iso,
      });

      const receipt = await runtime.send(
        { environmentId: "env-1", threadId: "thread-1" },
        "follow-up",
        { maxReconciliationReads: 1 },
      );

      expect(receipt).toMatchObject({ commandId: "command-1", messageId: "message-1", acceptedSequence: null });
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
    },
  );

  test("does not retry an ambiguous send after cancellation wins", async () => {
    const controller = new AbortController();
    let detailReads = 0;
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 2) controller.abort();
          return detail(2);
        },
        dispatch: async () => {
          dispatches += 1;
          throw new StockT3HttpError("transport_unavailable", null, {
            reason: "request_failed",
          });
        },
      }),
      id: (() => {
        const ids = ["command-1", "message-1", "lease-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });

    await expect(
      runtime.send(
        { environmentId: "env-1", threadId: "thread-1" },
        "follow-up",
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(dispatches).toBe(1);
  });

  test("uses one absolute timeout and never starts the initial turn at its inclusive deadline", async () => {
    let current = 0;
    let shellReads = 0;
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getDescriptor: async () => {
          current = 10;
          return {
            environmentId: "env-1",
            label: "local",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "stock",
            capabilities: { repositoryIdentity: false },
          };
        },
        getShell: async () => {
          shellReads += 1;
          current = shellReads === 1 ? 90 : 100;
          return shell(2, shellReads === 1 ? [] : [threadIdentity()]);
        },
        getThread: async () => detail(2),
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 2 };
        },
      }),
      id: (() => {
        const ids = ["create-1", "thread-1", "turn-1", "message-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
      clock: () => current,
    });

    const result = await runtime.spawn(spawnInput, { timeoutMs: 100 });

    expect(result).toMatchObject({
      kind: "create_reconciliation_pending",
      reconciliation: {
        reason: "deadline_exhausted",
        projectionState: "shell_only",
      },
      safeAction: "resume_create_reconciliation",
    });
    expect(commands.map((entry) => entry.type)).toEqual(["thread.create"]);
  });

  test("never creates a missing project when resolution reaches the inclusive deadline", async () => {
    let current = 0;
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          current = 100;
          return { ...shell(1), projects: [] };
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: 1 };
        },
      }),
      clock: () => current,
    });

    await expect(runtime.spawn(spawnInput, { timeoutMs: 100 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(commands).toHaveLength(0);
  });

  test("accepts valid detail-only resume evidence without manufacturing an identity conflict", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(9),
        getThread: async () => detail(9),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 10 };
        },
      }),
      id: () => "unused",
      now: () => iso,
    });
    const pending = {
      kind: "create_reconciliation_pending" as const,
      provisionalRef: { environmentId: "env-1", threadId: "thread-1" },
      createAttempt: {
        commandId: "create-1",
        threadId: "thread-1",
        projectId: "project-1",
        acceptedSequence: 9,
        dispatchState: "accepted" as const,
        retryState: "not_applicable" as const,
        retryError: null,
      },
      reconciliation: {
        reason: "projection_pending" as const,
        projectionState: "unobserved" as const,
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
      safeAction: "resume_create_reconciliation" as const,
    };

    const result = await runtime.resumeCreateReconciliation(pending, spawnInput, {
      maxReconciliationReads: 1,
    });

    expect(result).toMatchObject({
      kind: "create_reconciliation_pending",
      provisionalRef: pending.provisionalRef,
      reconciliation: { projectionState: "detail_only" },
    });
    expect(dispatches).toBe(0);
  });

  test("fails closed when terminal shell and detail bind different turns", async () => {
    const targetTurn = {
      turnId: "turn-target",
      state: "completed" as const,
      requestedAt: iso,
      startedAt: iso,
      completedAt: iso,
      assistantMessageId: "assistant-target",
    };
    const foreignTurn = { ...targetTurn, turnId: "turn-foreign" };
    let detailReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () =>
          shell(3, [{ ...threadIdentity(), latestTurn: foreignTurn }]),
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 1) return detail(1);
          return detail(
            3,
            [
              message("message-target", "follow-up"),
              {
                id: "assistant-target",
                role: "assistant",
                text: "foreign content must not complete",
                attachments: [],
                turnId: "turn-target",
                streaming: false,
                createdAt: iso,
                updatedAt: iso,
              },
            ],
            targetTurn,
          );
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: (() => {
        const ids = ["command-target", "message-target", "lease-target"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-1" },
      "follow-up",
    );

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "concurrent_writer",
    });
  });

  test.each([
    ["same-ID payload mutation", [message("message-target", "mutated")], "causality_unverifiable"],
    ["writer after target", [message("message-target", "follow-up"), message("foreign", "foreign")], "concurrent_writer"],
  ] as const)("fails closed on detectable %s", async (_label, messages, expectedCode) => {
    const terminal = {
      turnId: "turn-target",
      state: "completed" as const,
      requestedAt: iso,
      startedAt: iso,
      completedAt: iso,
      assistantMessageId: "assistant-target",
    };
    let reads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(3, [{ ...threadIdentity(), latestTurn: terminal }]),
        getThread: async () => {
          reads += 1;
          return reads === 1 ? detail(1) : detail(3, [...messages], terminal);
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: (() => {
        const ids = ["command-target", "message-target", "lease-target"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-1" },
      "follow-up",
    );

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  test("documents the indistinguishable exact-ID/payload reuse boundary", async () => {
    const terminal = {
      turnId: "turn-target",
      state: "completed" as const,
      requestedAt: iso,
      startedAt: iso,
      completedAt: iso,
      assistantMessageId: "assistant-target",
    };
    let reads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(3, [{ ...threadIdentity(), latestTurn: terminal }]),
        getThread: async () => {
          reads += 1;
          return reads === 1
            ? detail(1)
            : detail(3, [
                message("message-target", "follow-up"),
                {
                  id: "assistant-target",
                  role: "assistant",
                  text: "completed",
                  attachments: [],
                  turnId: "turn-target",
                  streaming: false,
                  createdAt: iso,
                  updatedAt: iso,
                },
              ], terminal);
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: (() => {
        const ids = ["command-target", "message-target", "lease-target"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-1" },
      "follow-up",
    );

    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "completed",
      assistantContent: "completed",
    });
  });

  test("caps terminal assistant evidence on a valid UTF-8 boundary and reports truncation", async () => {
    const targetTurn = {
      turnId: "turn-target",
      state: "completed" as const,
      requestedAt: iso,
      startedAt: iso,
      completedAt: iso,
      assistantMessageId: "assistant-target",
    };
    const oversized = `${"a".repeat(256 * 1024 - 1)}🙂tail`;
    let detailReads = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () =>
          shell(3, [{ ...threadIdentity(), latestTurn: targetTurn }]),
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 1) return detail(1);
          return detail(
            3,
            [
              message("message-target", "follow-up"),
              {
                id: "assistant-target",
                role: "assistant",
                text: oversized,
                attachments: [],
                turnId: "turn-target",
                streaming: false,
                createdAt: iso,
                updatedAt: iso,
              },
            ],
            targetTurn,
          );
        },
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: (() => {
        const ids = ["command-target", "message-target", "lease-target"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-1" },
      "follow-up",
    );

    const result = await runtime.wait(receipt, { timeoutMs: 1_000 });
    const encoded = new TextEncoder().encode(result.assistantContent);
    expect(encoded.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(encoded)).toBe(
      result.assistantContent,
    );
    expect(result).toMatchObject({
      evidence: {
        truncated: true,
        originalBytes: new TextEncoder().encode(oversized).byteLength,
        retainedBytes: encoded.byteLength,
      },
    });
  });

  test("expires a receipt and its send lease at the inclusive boundary", async () => {
    let current = 0;
    let idIndex = 0;
    const ids = [
      "command-first",
      "message-first",
      "lease-first",
      "command-second",
      "message-second",
      "lease-second",
    ];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async () => detail(1),
        dispatch: async () => ({ sequence: 2 }),
      }),
      id: () => ids[idIndex++]!,
      now: () => iso,
      clock: () => current,
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };
    const receipt = await runtime.send(ref, "first", { deadlineMs: 100 });
    current = 100;

    await expect(runtime.wait(receipt)).rejects.toMatchObject({ code: "receipt_expired" });
    await expect(runtime.send(ref, "second", { deadlineMs: 200 })).resolves.toMatchObject({
      messageId: "message-second",
    });
  });
});

describe("facade worker hierarchy overlay", () => {
  test("installs role and parent metadata only after a reconciled stock spawn", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const childDetails = [
      detailFor("thread-1", 2),
      detailFor("thread-1", 2),
      {
        ...detailFor("thread-1", 4),
        thread: {
          ...detailFor("thread-1", 4).thread,
          messages: [message("message-1", "initial")],
        },
      },
    ];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(4, [threadIdentity()]),
        getThread: async (threadId) =>
          threadId === "parent" ? detailFor("parent", 1) : childDetails.shift(),
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length === 1 ? 2 : 4 };
        },
      }),
      id: (() => {
        const ids = ["thread-create-1", "thread-1", "turn-command-1", "message-1", "lease-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });
    const facade = createStockT3Facade(runtime, {
      overlay: { now: () => "2026-08-01T20:00:00.000Z" },
    });
    const parentRef = { environmentId: "env-1", threadId: "parent" };

    const result = await facade.spawn({
      ...spawnInput,
      role: "worker",
      parentRef,
    });

    expect(result.kind).toBe("spawned");
    expect(facade.getWorker({ environmentId: "env-1", threadId: "thread-1" })).toMatchObject({
      role: "worker",
      parentRef,
      depth: null,
      creation: { source: "spawn", createdAt: "2026-08-01T20:00:00.000Z" },
    });
    expect(facade.listChildren(parentRef).map((entry) => entry.ref.threadId)).toEqual([
      "thread-1",
    ]);
    expect(commands).toHaveLength(2);
    expect(commands.every((command) => !("role" in command) && !("parentRef" in command))).toBe(
      true,
    );
  });

  test("keeps provisional metadata unknown until read-only resume reconciles the create", async () => {
    let phase: "pending" | "resume" = "pending";
    let resumeDetailReads = 0;
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () =>
          phase === "pending" ? shell(1) : shell(10, [threadIdentity()]),
        getThread: async () => {
          if (phase === "pending") return undefined;
          resumeDetailReads += 1;
          return resumeDetailReads < 3
            ? detailFor("thread-1", 9)
            : {
                ...detailFor("thread-1", 10),
                thread: {
                  ...detailFor("thread-1", 10).thread,
                  messages: [message("message-1", "initial")],
                },
              };
        },
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length === 1 ? 9 : 10 };
        },
      }),
      id: (() => {
        const ids = ["create-1", "thread-1", "turn-1", "message-1", "lease-1"];
        return () => ids.shift()!;
      })(),
      now: () => iso,
    });
    const facade = createStockT3Facade(runtime);
    const input = { ...spawnInput, role: "worker", parentRef: null };

    const pending = await facade.spawn(input, { maxReconciliationReads: 1 });
    expect(pending.kind).toBe("create_reconciliation_pending");
    expect(() =>
      facade.getWorker({ environmentId: "env-1", threadId: "thread-1" }),
    ).toThrow(WorkerOverlayError);
    if (pending.kind !== "create_reconciliation_pending") {
      throw new Error("expected reconciliation pending");
    }

    phase = "resume";
    const result = await facade.resumeCreateReconciliation(pending, input);

    expect(result.kind).toBe("spawned");
    expect(facade.getWorker(result.kind === "spawned" ? result.agentRef : pending.provisionalRef))
      .toMatchObject({ role: "worker", parentRef: null, creation: { source: "spawn" } });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  });

  test("reattaches canonical stock threads explicitly and surfaces overlay loss after restart", async () => {
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async (threadId) => detailFor(threadId, 3),
      }),
    });
    const ref = { environmentId: "env-1", threadId: "thread-1" };
    const firstProcess = createStockT3Facade(runtime);

    await expect(
      firstProcess.attach(ref, { role: "worker", parentRef: null }),
    ).resolves.toMatchObject({ role: "worker", depth: 0 });
    expect(firstProcess.getWorker(ref).parentRef).toBeNull();

    const restartedProcess = createStockT3Facade(runtime);
    await expect(restartedProcess.observe(ref)).resolves.toMatchObject({ snapshotSequence: 3 });
    expect(() => restartedProcess.getWorker(ref)).toThrow(WorkerOverlayError);
    try {
      restartedProcess.getWorker(ref);
    } catch (error) {
      expect(error).toMatchObject({ code: "overlay_unknown" });
    }
    expect(restartedProcess.listWorkers()).toEqual([]);
  });

  test("fails missing canonical parents and hierarchy capacity before spawn dispatch", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async (threadId) =>
          threadId === "root" ? detailFor("root", 1) : undefined,
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 1 };
        },
      }),
    });
    const root = { environmentId: "env-1", threadId: "root" };
    const missing = { environmentId: "env-1", threadId: "missing" };
    const facade = createStockT3Facade(runtime, { overlay: { maxWorkers: 1 } });

    await expect(
      facade.spawn({ ...spawnInput, role: "worker", parentRef: missing }),
    ).rejects.toMatchObject({ code: "overlay_canonical_not_found" });
    expect(dispatches).toBe(0);

    await facade.attach(root, { role: "lead", parentRef: null });
    await expect(
      facade.spawn({ ...spawnInput, role: "worker", parentRef: root }),
    ).rejects.toMatchObject({ code: "overlay_capacity_exceeded" });
    expect(dispatches).toBe(0);
  });

  test("rejects cross-environment, cyclic, and over-depth attachments before dispatch", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getThread: async (threadId) => detailFor(threadId, 1),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 1 };
        },
      }),
    });
    const root = { environmentId: "env-1", threadId: "root" };
    const child = { environmentId: "env-1", threadId: "child" };
    const facade = createStockT3Facade(runtime, { overlay: { maxDepth: 1 } });

    await expect(
      facade.attach(
        { environmentId: "env-2", threadId: "foreign" },
        { role: "worker", parentRef: root },
      ),
    ).rejects.toMatchObject({ code: "overlay_environment_mismatch" });

    await facade.attach(root, { role: "lead", parentRef: null });
    await facade.attach(child, { role: "worker", parentRef: root });
    await expect(
      facade.spawn({ ...spawnInput, role: "worker", parentRef: child }),
    ).rejects.toMatchObject({ code: "overlay_depth_exceeded" });

    const cyclic = createStockT3Facade(runtime);
    await cyclic.attach(root, { role: "lead", parentRef: child });
    await expect(
      cyclic.attach(child, { role: "worker", parentRef: root }),
    ).rejects.toMatchObject({ code: "overlay_cycle" });
    expect(dispatches).toBe(0);
  });
});
