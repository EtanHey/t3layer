import { describe, expect, test } from "bun:test";

import {
  StockRuntimeError,
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
import { StockT3HttpError } from "../src/stockT3HttpClient";
import { createStockT3Facade } from "../src/facade";

const iso = "2026-08-01T21:00:00.000Z";
const ref = { environmentId: "env-1", threadId: "thread-1" };
const selection = { instanceId: "claudeAgent", model: "claude-opus-5" };

const runningTurn: StockLatestTurn = {
  turnId: "turn-1",
  state: "running",
  requestedAt: iso,
  startedAt: iso,
  completedAt: null,
  assistantMessageId: null,
};

function terminalTurn(state: "interrupted" | "completed" | "error"): StockLatestTurn {
  return {
    ...runningTurn,
    state,
    completedAt: iso,
    assistantMessageId: state === "completed" ? "assistant-1" : null,
  };
}

function session(status: StockSession["status"]): StockSession {
  return {
    threadId: ref.threadId,
    status,
    providerName: "claude",
    activeTurnId: status === "running" ? runningTurn.turnId : null,
    lastError: status === "error" ? "failed" : null,
    updatedAt: iso,
  };
}

function shellThread(input: {
  latestTurn?: StockLatestTurn | null;
  session?: StockSession | null;
  pendingApproval?: boolean;
  pendingInput?: boolean;
} = {}): StockThreadShell {
  return {
    id: ref.threadId,
    projectId: "project-1",
    title: "worker",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: input.latestTurn === undefined ? runningTurn : input.latestTurn,
    createdAt: iso,
    updatedAt: iso,
    session: input.session === undefined ? session("running") : input.session,
    latestUserMessageAt: iso,
    hasPendingApprovals: input.pendingApproval ?? false,
    hasPendingUserInput: input.pendingInput ?? false,
  };
}

function shell(sequence: number, thread: StockThreadShell): ShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [],
    threads: [thread],
    updatedAt: iso,
  };
}

function detail(
  sequence: number,
  thread: StockThreadShell,
  messages: readonly StockMessage[] = [],
): ThreadDetailSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      latestTurn: thread.latestTurn,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      session: thread.session,
      messages,
      activities: [],
      checkpoints: [],
    },
  };
}

function descriptor() {
  return {
    environmentId: ref.environmentId,
    label: "local",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "stock",
    capabilities: { repositoryIdentity: false },
  };
}

function client(overrides: Partial<StockT3RuntimeClient> = {}): StockT3RuntimeClient {
  const current = shellThread();
  return {
    getDescriptor: async () => descriptor(),
    getShell: async () => shell(1, current),
    getThread: async () => detail(1, current),
    dispatch: async () => ({ sequence: 2 }),
    ...overrides,
  };
}

function ids(...values: string[]): () => string {
  return () => values.shift()!;
}

describe("stock control operations", () => {
  test("dispatches and confirms interrupt through stock snapshots", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    let interrupted = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const current = shellThread({
            latestTurn: interrupted ? terminalTurn("interrupted") : runningTurn,
          });
          return shell(interrupted ? 2 : 1, current);
        },
        getThread: async () => {
          const current = shellThread({
            latestTurn: interrupted ? terminalTurn("interrupted") : runningTurn,
          });
          return detail(interrupted ? 2 : 1, current);
        },
        dispatch: async (command) => {
          commands.push(command);
          interrupted = true;
          return { sequence: 2 };
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    const result = await runtime.interrupt(ref, { timeoutMs: 1_000 });

    expect(result).toMatchObject({
      kind: "applied",
      operation: "interrupt",
      agentRef: ref,
      receipt: {
        commandId: "interrupt-command",
        acceptedSequence: 2,
        retryState: "not_needed",
      },
      snapshot: { snapshotSequence: 2, thread: { latestTurn: { state: "interrupted" } } },
    });
    expect(commands).toEqual([
      {
        type: "thread.turn.interrupt",
        commandId: "interrupt-command",
        threadId: ref.threadId,
        turnId: runningTurn.turnId,
        createdAt: iso,
      },
    ]);
    runtime.close();
  });

  test("dispatches and confirms stop through stock snapshots", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    let stopped = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const current = shellThread({ session: session(stopped ? "stopped" : "running") });
          return shell(stopped ? 3 : 1, current);
        },
        getThread: async (threadId) => {
          const current = shellThread({ session: session(stopped ? "stopped" : "running") });
          const snapshot = detail(stopped ? 3 : 1, current);
          return {
            ...snapshot,
            thread: { ...snapshot.thread, id: threadId },
          };
        },
        dispatch: async (command) => {
          commands.push(command);
          stopped = true;
          return { sequence: 2 };
        },
      }),
      id: ids("stop-command"),
      now: () => iso,
    });
    const facade = createStockT3Facade(runtime, { overlay: { maxWorkers: 1 } });
    await facade.attach(ref, { role: "worker", parentRef: null });

    const result = await facade.stop(ref, { timeoutMs: 1_000 });

    expect(result).toMatchObject({
      kind: "applied",
      operation: "stop",
      receipt: { commandId: "stop-command", acceptedSequence: 2 },
      snapshot: { thread: { session: { status: "stopped" } } },
    });
    expect(commands).toEqual([
      {
        type: "thread.session.stop",
        commandId: "stop-command",
        threadId: ref.threadId,
        createdAt: iso,
      },
    ]);
    await expect(
      facade.attach(
        { environmentId: ref.environmentId, threadId: "replacement" },
        { role: "worker", parentRef: null },
      ),
    ).resolves.toMatchObject({ ref: { threadId: "replacement" } });
    expect(facade.listWorkers()).toHaveLength(2);
    facade.close();
  });

  test("dispatches approval and user-input responses without releasing the send lease", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    let turnStarted = false;
    let approvalPending = true;
    let inputPending = true;
    const targetMessage: StockMessage = {
      id: "message-1",
      role: "user",
      text: "start",
      attachments: [],
      turnId: runningTurn.turnId,
      streaming: false,
      createdAt: iso,
      updatedAt: iso,
    };
    const currentThread = () =>
      shellThread({
        latestTurn: turnStarted ? runningTurn : null,
        session: turnStarted ? session("running") : null,
        pendingApproval: turnStarted && approvalPending,
        pendingInput: turnStarted && inputPending,
      });
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(commands.length + 1, currentThread()),
        getThread: async () =>
          detail(commands.length + 1, currentThread(), turnStarted ? [targetMessage] : []),
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "thread.turn.start") turnStarted = true;
          if (command.type === "thread.approval.respond") approvalPending = false;
          if (command.type === "thread.user-input.respond") inputPending = false;
          return { sequence: commands.length + 1 };
        },
      }),
      id: ids(
        "turn-command",
        "message-1",
        "lease-1",
        "approval-command",
        "input-command",
      ),
      now: () => iso,
    });
    const facade = createStockT3Facade(runtime);
    const receipt = await facade.send(ref, "start", { timeoutMs: 5_000 });

    await expect(
      facade.respondToApproval(
        ref,
        { requestId: "approval-1", decision: "acceptForSession" },
        { timeoutMs: 1_000 },
      ),
    ).resolves.toMatchObject({
      kind: "applied",
      operation: "respond_to_approval",
      snapshot: { thread: { id: ref.threadId } },
    });
    await expect(
      facade.respondToUserInput(
        ref,
        { requestId: "input-1", answers: { answer: "yes" } },
        { timeoutMs: 1_000 },
      ),
    ).resolves.toMatchObject({ kind: "applied", operation: "respond_to_user_input" });
    await expect(facade.send(ref, "second")).rejects.toMatchObject({
      code: "send_in_progress",
    });
    expect(receipt.leaseState).toBe("active");
    expect(commands.slice(1)).toEqual([
      {
        type: "thread.approval.respond",
        commandId: "approval-command",
        threadId: ref.threadId,
        requestId: "approval-1",
        decision: "acceptForSession",
        createdAt: iso,
      },
      {
        type: "thread.user-input.respond",
        commandId: "input-command",
        threadId: ref.threadId,
        requestId: "input-1",
        answers: { answer: "yes" },
        createdAt: iso,
      },
    ]);
    facade.releaseReceipt(receipt);
    facade.close();
  });

  test("snapshots user-input answers across an identical ambiguity retry", async () => {
    const payloads: string[] = [];
    const answers: Record<string, unknown> = { answer: "yes" };
    let inputPending = true;
    const currentThread = () => shellThread({ pendingInput: inputPending });
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(inputPending ? 1 : 2, currentThread()),
        getThread: async () => detail(inputPending ? 1 : 2, currentThread()),
        dispatch: async (command) => {
          payloads.push(JSON.stringify(command));
          if (payloads.length === 1) {
            answers.answer = "mutated";
            throw new StockT3HttpError("transport_unavailable", null);
          }
          inputPending = false;
          return { sequence: 2 };
        },
      }),
      id: ids("input-command"),
      now: () => iso,
    });

    await expect(
      runtime.respondToUserInput(ref, { requestId: "input-1", answers }, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      kind: "applied",
      receipt: { retryState: "identical_retry_accepted" },
    });
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(JSON.parse(payloads[0]!).answers).toEqual({ answer: "yes" });
    runtime.close();
  });

  test("returns typed no-ops for already-terminal interrupt and stop targets", async () => {
    let dispatches = 0;
    const current = shellThread({
      latestTurn: terminalTurn("completed"),
      session: session("stopped"),
    });
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(8, current),
        getThread: async () => detail(8, current),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 9 };
        },
      }),
    });

    await expect(runtime.interrupt(ref)).resolves.toMatchObject({
      kind: "no_op",
      operation: "interrupt",
      reason: "turn_terminal",
      snapshot: { snapshotSequence: 8 },
    });
    await expect(runtime.stop(ref)).resolves.toMatchObject({
      kind: "no_op",
      operation: "stop",
      reason: "session_terminal",
      snapshot: { snapshotSequence: 8 },
    });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("returns a typed stop no-op when no stock session exists", async () => {
    let dispatches = 0;
    const current = shellThread({ latestTurn: null, session: null });
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(8, current),
        getThread: async () => detail(8, current),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 9 };
        },
      }),
    });

    await expect(runtime.stop(ref, { timeoutMs: 300 })).resolves.toMatchObject({
      kind: "no_op",
      operation: "stop",
      reason: "session_terminal",
      snapshot: { snapshotSequence: 8, thread: { session: null } },
    });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("returns an interrupt no-op when one aligned projection omits the terminal turn", async () => {
    let dispatches = 0;
    const shellView = shellThread({ latestTurn: null });
    const detailView = shellThread({ latestTurn: terminalTurn("completed") });
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(8, shellView),
        getThread: async () => detail(8, detailView),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 9 };
        },
      }),
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 300 })).resolves.toMatchObject({
      kind: "no_op",
      operation: "interrupt",
      reason: "turn_terminal",
      snapshot: { snapshotSequence: 8 },
    });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("does not return a terminal no-op from a detail snapshot behind the shell", async () => {
    let detailReads = 0;
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const current = shellThread({
            latestTurn: dispatches === 0 ? runningTurn : terminalTurn("interrupted"),
          });
          return shell(dispatches === 0 ? 2 : 3, current);
        },
        getThread: async () => {
          detailReads += 1;
          const latestTurn =
            detailReads === 1
              ? terminalTurn("completed")
              : dispatches === 0
                ? runningTurn
                : terminalTurn("interrupted");
          const current = shellThread({ latestTurn });
          return detail(detailReads === 1 ? 1 : dispatches === 0 ? 2 : 3, current);
        },
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 3 };
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      receipt: { commandId: "interrupt-command", acceptedSequence: 3 },
    });
    expect(dispatches).toBe(1);
    runtime.close();
  });

  test("accepts a detail snapshot ahead of the shell during control preflight", async () => {
    let dispatched = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const latestTurn = dispatched ? terminalTurn("interrupted") : runningTurn;
          return shell(dispatched ? 3 : 1, shellThread({ latestTurn }));
        },
        getThread: async () => {
          const latestTurn = dispatched ? terminalTurn("interrupted") : runningTurn;
          return detail(dispatched ? 3 : 2, shellThread({ latestTurn }));
        },
        dispatch: async () => {
          dispatched = true;
          return { sequence: 3 };
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      receipt: { commandId: "interrupt-command", acceptedSequence: 3 },
    });
    expect(dispatched).toBe(true);
    runtime.close();
  });

  test("does not return an interrupt no-op while the aligned shell turn is running", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const latestTurn = dispatches === 0 ? runningTurn : terminalTurn("interrupted");
          return shell(2, shellThread({ latestTurn }));
        },
        getThread: async () => {
          const latestTurn =
            dispatches === 0 ? terminalTurn("completed") : terminalTurn("interrupted");
          return detail(2, shellThread({ latestTurn }));
        },
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 2 };
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      receipt: { commandId: "interrupt-command" },
    });
    expect(dispatches).toBe(1);
    runtime.close();
  });

  test("reconciles an ambiguous interrupt before one byte-identical retry", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    let interrupted = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const current = shellThread({
            latestTurn: interrupted ? terminalTurn("interrupted") : runningTurn,
          });
          return shell(interrupted ? 4 : 1, current);
        },
        getThread: async () => {
          const current = shellThread({
            latestTurn: interrupted ? terminalTurn("interrupted") : runningTurn,
          });
          return detail(interrupted ? 4 : 1, current);
        },
        dispatch: async (command) => {
          commands.push(command);
          if (commands.length === 1) {
            throw new StockT3HttpError("transport_unavailable", null);
          }
          interrupted = true;
          return { sequence: 4 };
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      receipt: {
        commandId: "interrupt-command",
        acceptedSequence: 4,
        retryState: "identical_retry_accepted",
      },
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    runtime.close();
  });

  test("still performs one identical retry when the ambiguity reconciliation read fails", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    let detailReads = 0;
    let interrupted = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const current = shellThread({
            latestTurn: interrupted ? terminalTurn("interrupted") : runningTurn,
          });
          return shell(interrupted ? 4 : 1, current);
        },
        getThread: async () => {
          detailReads += 1;
          if (detailReads === 2) {
            throw new StockT3HttpError("server_internal", 500);
          }
          const current = shellThread({
            latestTurn: interrupted ? terminalTurn("interrupted") : runningTurn,
          });
          return detail(interrupted ? 4 : 1, current);
        },
        dispatch: async (command) => {
          commands.push(command);
          if (commands.length === 1) {
            throw new StockT3HttpError("transport_unavailable", null);
          }
          interrupted = true;
          return { sequence: 4 };
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 1_000 })).resolves.toMatchObject({
      kind: "applied",
      receipt: { retryState: "identical_retry_accepted" },
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    runtime.close();
  });

  test("fails closed on a malformed received identical-control retry", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    const runtime = createStockT3NativeRuntime({
      client: client({
        dispatch: async (command) => {
          commands.push(command);
          if (commands.length === 1) {
            throw new StockT3HttpError("transport_unavailable", null);
          }
          throw new StockT3HttpError("protocol_mismatch", 400);
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 300 })).rejects.toMatchObject({
      code: "protocol_mismatch",
      evidence: { status: 400 },
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    runtime.close();
  });

  test("does not confirm interrupt until shell and detail agree on the terminal turn", async () => {
    let dispatched = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () =>
          shell(dispatched ? 2 : 1, shellThread({ latestTurn: runningTurn })),
        getThread: async () => {
          const current = shellThread({
            latestTurn: dispatched ? terminalTurn("interrupted") : runningTurn,
          });
          return detail(dispatched ? 2 : 1, current);
        },
        dispatch: async () => {
          dispatched = true;
          return { sequence: 2 };
        },
      }),
      id: ids("interrupt-command"),
      now: () => iso,
    });

    await expect(runtime.interrupt(ref, { timeoutMs: 300 })).rejects.toMatchObject({
      code: "timeout",
      evidence: {
        receipt: {
          commandId: "interrupt-command",
          acceptedSequence: 2,
          observedSequence: 1,
        },
      },
    });
    runtime.close();
  });

  test("does not confirm stop until shell and detail agree on terminal session state", async () => {
    let dispatched = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () =>
          shell(dispatched ? 2 : 1, shellThread({ session: session("running") })),
        getThread: async () => {
          const current = shellThread({
            session: session(dispatched ? "stopped" : "running"),
          });
          return detail(dispatched ? 2 : 1, current);
        },
        dispatch: async () => {
          dispatched = true;
          return { sequence: 2 };
        },
      }),
      id: ids("stop-command"),
      now: () => iso,
    });

    await expect(runtime.stop(ref, { timeoutMs: 300 })).rejects.toMatchObject({
      code: "timeout",
      evidence: { receipt: { commandId: "stop-command", acceptedSequence: 2 } },
    });
    runtime.close();
  });

  test("validates scope, environment, cancellation, deadline, and response input before dispatch", async () => {
    let dispatches = 0;
    const runtime = createStockT3NativeRuntime({
      client: client({
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 2 };
        },
      }),
    });
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(
      runtime.interrupt({ environmentId: "env-2", threadId: ref.threadId }),
    ).rejects.toMatchObject({ code: "environment_changed" });
    await expect(
      runtime.stop({ environmentId: ref.environmentId, threadId: " " }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(runtime.interrupt(ref, { signal: cancelled.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(runtime.stop(ref, { deadlineMs: Number.NaN })).rejects.toMatchObject({
      code: "protocol_mismatch",
    });
    await expect(
      runtime.respondToApproval(ref, { requestId: " ", decision: "accept" }),
    ).rejects.toMatchObject({ code: "protocol_mismatch" });
    await expect(
      runtime.respondToUserInput(ref, {
        requestId: "input-1",
        answers: [] as unknown as Record<string, unknown>,
      }),
    ).rejects.toMatchObject({ code: "protocol_mismatch" });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("rejects responses when the stock projection reports no pending request", async () => {
    let dispatches = 0;
    const current = shellThread({ pendingApproval: false, pendingInput: false });
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => shell(5, current),
        getThread: async () => detail(5, current),
        dispatch: async () => {
          dispatches += 1;
          return { sequence: 6 };
        },
      }),
    });

    await expect(
      runtime.respondToApproval(ref, { requestId: "approval-1", decision: "accept" }),
    ).rejects.toMatchObject({ code: "approval_not_pending" });
    await expect(
      runtime.respondToUserInput(ref, {
        requestId: "input-1",
        answers: { answer: "yes" },
      }),
    ).rejects.toMatchObject({ code: "user_input_not_pending" });
    expect(dispatches).toBe(0);
    runtime.close();
  });

  test("never emits thread.delete from the control surface", async () => {
    const commands: Array<Readonly<Record<string, unknown>>> = [];
    let stopped = false;
    const runtime = createStockT3NativeRuntime({
      client: client({
        getShell: async () => {
          const current = shellThread({ session: session(stopped ? "stopped" : "running") });
          return shell(stopped ? 2 : 1, current);
        },
        getThread: async () => {
          const current = shellThread({ session: session(stopped ? "stopped" : "running") });
          return detail(stopped ? 2 : 1, current);
        },
        dispatch: async (command) => {
          commands.push(command);
          stopped = true;
          return { sequence: 2 };
        },
      }),
      id: ids("stop-command"),
      now: () => iso,
    });

    await runtime.stop(ref);
    expect(commands.every((command) => command.type !== "thread.delete")).toBe(true);
    runtime.close();
  });
});
