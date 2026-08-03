import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  allocateProjectCreateIdentity,
  canonicalizeWorkspaceRoot,
  createStockT3Facade,
  parseProjectCreateIdentity,
} from "../src/facade";
import {
  type StockSpawnInput,
  type TurnReceipt,
} from "../src/nativeRuntime";
import { createStockT3NativeRuntime } from "./support/modelCache";

const iso = "2026-08-01T08:00:00.000Z";
const selection = { instanceId: "claudeAgent", model: "claude-opus-5" };

function ids(...values: string[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("unexpected ID allocation");
    return value;
  };
}

class BoundaryStock {
  readonly projects = new Map<string, Record<string, unknown>>();
  readonly threads = new Map<string, Record<string, unknown>>();
  readonly messages = new Map<string, Record<string, unknown>[]>();
  readonly mutations: Record<string, unknown>[] = [];
  readonly receipts = new Map<string, number>();
  sequence = 1;
  failNextShell = false;
  failNextDispatch: string | null = null;
  ambiguousNextDispatch = false;
  ambiguousNextDispatchType: string | null = null;
  afterNextCommit: (() => void) | null = null;
  afterEveryCommit: ((command: Record<string, unknown>) => void) | null = null;
  afterShellRead: (() => void) | null = null;
  projectedMessages: Record<string, unknown>[] | null = null;
  terminal = false;
  requests = 0;
  shellReads = 0;

  constructor(readonly projectRoot: string) {
    this.projects.set("project-visible", {
      id: "project-visible",
      title: "project",
      workspaceRoot: projectRoot,
      defaultModelSelection: selection,
      createdAt: iso,
      updatedAt: iso,
    });
    this.seedThread("thread-existing");
  }

  seedThread(id: string, projectId = "project-visible") {
    this.threads.set(id, {
      id,
      projectId,
      title: "worker",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: iso,
      updatedAt: iso,
    });
    this.messages.set(id, []);
  }

  private latestTurn() {
    return this.terminal
      ? {
          turnId: "turn-stock",
          state: "completed",
          requestedAt: iso,
          startedAt: iso,
          completedAt: iso,
          assistantMessageId: "assistant-stock",
          error: null,
        }
      : null;
  }

  private shell() {
    return {
      snapshotSequence: this.sequence,
      projects: [...this.projects.values()],
      threads: [...this.threads.values()].map((thread) => ({
        ...thread,
        latestTurn: this.latestTurn(),
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      })),
      updatedAt: iso,
    };
  }

  private detail(threadId: string): Response {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return Response.json({ code: "not_found" }, { status: 404 });
    const messages = [...(this.projectedMessages ?? this.messages.get(threadId) ?? [])];
    if (this.terminal) {
      for (const message of messages) {
        if (message.role === "user") message.turnId = "turn-stock";
      }
      messages.push({
        id: "assistant-stock",
        role: "assistant",
        text: "done",
        attachments: [],
        turnId: "turn-stock",
        streaming: false,
        createdAt: iso,
        updatedAt: iso,
      });
    }
    return Response.json({
      snapshotSequence: this.sequence,
      thread: {
        ...thread,
        latestTurn: this.latestTurn(),
        session: null,
        messages,
        activities: [],
        checkpoints: [],
      },
    });
  }

  private commit(command: Record<string, unknown>): number {
    const commandId = command.commandId as string;
    const existing = this.receipts.get(commandId);
    if (existing !== undefined) return existing;
    if (command.type === "project.create") {
      this.projects.set(command.projectId as string, {
        id: command.projectId,
        title: command.title,
        workspaceRoot: command.workspaceRoot,
        defaultModelSelection: command.defaultModelSelection,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      });
    } else if (command.type === "thread.create") {
      this.seedThread(command.threadId as string, command.projectId as string);
    } else {
      const message = command.message as Record<string, unknown>;
      this.messages.get(command.threadId as string)!.push({
        id: message.messageId,
        role: "user",
        text: message.text,
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: iso,
        updatedAt: iso,
      });
    }
    this.sequence += 1;
    this.receipts.set(commandId, this.sequence);
    return this.sequence;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.requests += 1;
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/t3/environment") {
      return Response.json({
        environmentId: "env-1",
        label: "local",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "stock",
        capabilities: { repositoryIdentity: false },
      });
    }
    if (path === "/api/orchestration/shell") {
      this.shellReads += 1;
      this.afterShellRead?.();
      if (this.failNextShell) {
        this.failNextShell = false;
        return Response.json(
          { code: "internal_error", reason: "orchestration_dispatch_failed" },
          { status: 500 },
        );
      }
      return Response.json(this.shell());
    }
    if (path.startsWith("/api/orchestration/threads/")) {
      return this.detail(decodeURIComponent(path.slice("/api/orchestration/threads/".length)));
    }
    if (path === "/api/orchestration/dispatch") {
      const command = JSON.parse(await request.text()) as Record<string, unknown>;
      this.mutations.push(command);
      if (this.failNextDispatch === command.type) {
        this.failNextDispatch = null;
        return Response.json(
          { code: "internal_error", reason: "orchestration_dispatch_failed" },
          { status: 500 },
        );
      }
      const sequence = this.commit(command);
      this.afterEveryCommit?.(command);
      this.afterNextCommit?.();
      this.afterNextCommit = null;
      if (this.ambiguousNextDispatch || this.ambiguousNextDispatchType === command.type) {
        this.ambiguousNextDispatch = false;
        this.ambiguousNextDispatchType = null;
        throw new TypeError("response lost after stock acceptance");
      }
      return Response.json({ sequence });
    }
    throw new Error(`unexpected route ${request.method} ${path}`);
  };
}

function runtimeFor(
  stock: BoundaryStock,
  allocated: string[] = [],
  extra: Readonly<Record<string, unknown>> = {},
) {
  return createStockT3NativeRuntime({
    baseUrl: "http://stock.invalid",
    fetch: stock.fetch,
    id: ids(...allocated),
    now: () => iso,
    ...extra,
  });
}

function input(workspaceRoot: string): StockSpawnInput {
  return {
    workspaceRoot,
    projectId: "project-visible",
    title: "worker",
    message: "initial",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };
}

describe("phase 3 boundary convergence", () => {
  test.each([
    ["trailing separator", "/tmp/boundary-project/", "/tmp/boundary-project"],
    ["surrounding whitespace", "  /tmp/boundary-project/  ", "/tmp/boundary-project"],
    ["relative path", "./boundary-project/", resolve("boundary-project")],
    ["home path", "~/boundary-project/", resolve(homedir(), "boundary-project")],
  ])("canonicalizes %s before visible-project lookup and dispatch", async (_name, supplied, canonical) => {
    const stock = new BoundaryStock(canonical);
    const runtime = runtimeFor(stock, [
      "thread-command-1", "thread-1", "turn-1", "message-1", "lease-1",
    ]);
    const result = await runtime.spawn(input(supplied), { maxReconciliationReads: 1 });
    expect(result.kind).toBe("spawned");
    expect(stock.mutations.find((entry) => entry.type === "thread.create")?.projectId)
      .toBe("project-visible");
    expect(canonicalizeWorkspaceRoot(supplied)).toBe(canonical);
    if (result.kind === "spawned") runtime.releaseReceipt(result.turnReceipt);
    runtime.close();
  });

  test("public allocator/parser round-trips through plain JSON with canonical replay fields", () => {
    const identity = allocateProjectCreateIdentity(
      {
        workspaceRoot: " /tmp/boundary-project/ ",
        title: "project",
        defaultModelSelection: selection,
      },
      { id: ids("project-public", "command-public"), now: () => iso },
    );
    expect(parseProjectCreateIdentity(JSON.parse(JSON.stringify(identity)), {
      workspaceRoot: "/tmp/boundary-project",
      projectId: "project-public",
    })).toEqual({
      projectId: "project-public",
      commandId: "command-public",
      createdAt: iso,
      workspaceRoot: "/tmp/boundary-project",
      title: "project",
      defaultModelSelection: selection,
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.defaultModelSelection)).toBe(true);
  });

  test("project identity parsing preserves an own __proto__ JSON key", () => {
    const replay = JSON.parse(JSON.stringify(allocateProjectCreateIdentity(
      {
        workspaceRoot: "/tmp/boundary-project",
        title: "project",
        defaultModelSelection: selection,
      },
      { id: ids("project-public", "command-public"), now: () => iso },
    )));
    replay.defaultModelSelection.options = [
      JSON.parse('{"__proto__":{"polluted":true},"safe":1}'),
    ];

    const parsed = parseProjectCreateIdentity(replay);
    const option = parsed.defaultModelSelection.options?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(option, "__proto__")).toBe(true);
    expect(option.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(option)).toBe(Object.prototype);
  });

  test("project.create receives only the canonical root stored in caller identity", async () => {
    const stock = new BoundaryStock("/tmp/new-boundary");
    stock.projects.clear();
    const identity = allocateProjectCreateIdentity({
      workspaceRoot: "  /tmp/new-boundary/  ",
      title: "project",
      defaultModelSelection: selection,
    }, { id: ids("project-new", "project-command"), now: () => iso });
    const runtime = runtimeFor(stock, [
      "thread-command", "thread-new", "turn-command", "message-new", "lease-new",
    ]);
    const result = await runtime.spawn({
      ...input("  /tmp/new-boundary/  "),
      projectId: "project-new",
      projectCreateIdentity: identity,
    }, { maxReconciliationReads: 1 });
    expect(result.kind).toBe("spawned");
    expect(stock.mutations.find((entry) => entry.type === "project.create")).toMatchObject({
      projectId: "project-new",
      commandId: "project-command",
      workspaceRoot: "/tmp/new-boundary",
    });
    if (result.kind === "spawned") runtime.releaseReceipt(result.turnReceipt);
    runtime.close();
  });

  test.each([
    ["missing model", { defaultModelSelection: { instanceId: "provider" } }],
    ["whitespace ID", { projectId: "   " }],
    ["malformed nested object", { defaultModelSelection: [] }],
  ])("rejects %s as typed invalid identity before mutation", async (_name, override) => {
    const stock = new BoundaryStock("/tmp/new-boundary");
    stock.projects.clear();
    const runtime = runtimeFor(stock);
    const valid = allocateProjectCreateIdentity({
      workspaceRoot: "/tmp/new-boundary",
      title: "project",
      defaultModelSelection: selection,
    }, { id: ids("project-new", "command-new"), now: () => iso });
    await expect(runtime.spawn({
      ...input("/tmp/new-boundary"),
      projectId: "project-new",
      projectCreateIdentity: { ...valid, ...override } as never,
    })).rejects.toMatchObject({
      code: "identity_conflict",
      evidence: { reason: "invalid_project_create_identity" },
    });
    expect(stock.mutations).toHaveLength(0);
    runtime.close();
  });

  test("a received project.create failure retains full caller identity evidence", async () => {
    const stock = new BoundaryStock("/tmp/new-boundary");
    stock.projects.clear();
    stock.failNextDispatch = "project.create";
    const runtime = runtimeFor(stock);
    const identity = allocateProjectCreateIdentity({
      workspaceRoot: "/tmp/new-boundary/",
      title: "project",
      defaultModelSelection: selection,
    }, { id: ids("project-new", "command-new"), now: () => iso });
    await expect(runtime.spawn({
      ...input("/tmp/new-boundary/"),
      projectId: "project-new",
      projectCreateIdentity: identity,
    })).rejects.toMatchObject({
      code: "server_internal",
      evidence: {
        reason: "project_create_received_error",
        projectAttempt: {
          projectId: "project-new",
          commandId: "command-new",
          workspaceRoot: "/tmp/new-boundary",
          defaultModelSelection: selection,
        },
      },
    });
    runtime.close();
  });

  test("shell 500 is observational: same receipt retries and duplicate send remains blocked", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const runtime = runtimeFor(stock, [
      "command-1", "message-1", "lease-1",
      "command-2", "message-2", "lease-2",
    ]);
    const ref = { environmentId: "env-1", threadId: "thread-existing" };
    const receipt = await runtime.send(ref, "hello");
    stock.failNextShell = true;
    await expect(runtime.wait(receipt, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "server_internal",
    });
    await expect(runtime.send(ref, "duplicate")).rejects.toMatchObject({ code: "send_in_progress" });
    stock.terminal = true;
    const completed = await runtime.wait(receipt, { timeoutMs: 2_000 });
    expect(completed).toMatchObject({ kind: "completed", receipt: { leaseState: "released" } });
    const next = await runtime.send(ref, "next");
    expect(next.leaseState).toBe("active");
    runtime.releaseReceipt(next);
    runtime.close();
  });

  test("ninth wait capacity failure preserves its lease for retry and blocks duplicate send", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const allocated = Array.from({ length: 10 }, (_, index) => [
      `command-${index + 1}`,
      `message-${index + 1}`,
      `lease-${index + 1}`,
    ]).flat();
    const runtime = runtimeFor(stock, allocated);
    const receipts: TurnReceipt[] = [];
    for (let index = 0; index < 9; index += 1) {
      const threadId = `thread-capacity-${index + 1}`;
      stock.seedThread(threadId);
      receipts.push(await runtime.send({ environmentId: "env-1", threadId }, `message ${index + 1}`));
    }
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const active = receipts.slice(0, 8).map((receipt, index) =>
      runtime.wait(receipt, { signal: controllers[index]!.signal, timeoutMs: 5_000 })
        .catch((error) => error),
    );
    for (let spin = 0; spin < 50 && runtime.pollMetrics().activeWaits < 8; spin += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.pollMetrics().activeWaits).toBe(8);
    await expect(runtime.wait(receipts[8]!, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "transport_unavailable",
      evidence: { reason: "capacity" },
    });
    await expect(runtime.send(receipts[8]!.agentRef, "duplicate")).rejects.toMatchObject({
      code: "send_in_progress",
    });
    for (const controller of controllers) controller.abort();
    await Promise.all(active);
    stock.terminal = true;
    const completed = await runtime.wait(receipts[8]!, { timeoutMs: 2_000 });
    expect(completed.receipt).toMatchObject({
      leaseId: "lease-9",
      leaseState: "released",
    });
    runtime.close();
  });

  test("received send rejection exposes a complete released receipt and unblocks later send", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    stock.failNextDispatch = "thread.turn.start";
    const runtime = runtimeFor(stock, [
      "command-1", "message-1", "lease-1",
      "command-2", "message-2", "lease-2",
    ]);
    const ref = { environmentId: "env-1", threadId: "thread-existing" };
    const failure = await runtime.send(ref, "rejected").catch((error) => error);
    expect(failure).toMatchObject({
      code: "server_internal",
      evidence: {
        receipt: {
          agentRef: ref,
          commandId: "command-1",
          messageId: "message-1",
          acceptedSequence: null,
          leaseState: "released",
        },
      },
    });
    await expect(runtime.wait(failure.evidence.receipt as TurnReceipt)).rejects.toMatchObject({
      code: "receipt_expired",
    });
    const next = await runtime.send(ref, "next");
    runtime.releaseReceipt(next);
    runtime.close();
  });

  test("received initial-turn rejection returns a complete released receipt", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    stock.failNextDispatch = "thread.turn.start";
    const runtime = runtimeFor(stock, [
      "thread-command", "thread-new", "turn-command", "message-new", "lease-new",
    ]);
    const result = await runtime.spawn(input("/tmp/boundary-project"), {
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "partial",
      initialTurn: {
        state: "initial_turn_rejected",
        turnReceipt: {
          commandId: "turn-command",
          messageId: "message-new",
          acceptedSequence: null,
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });

  test.each([
    ["superseded", [{ id: "foreign", text: "foreign" }]],
    ["concurrent_writer", [
      { id: "message-1", text: "target" },
      { id: "foreign", text: "foreign" },
    ]],
    ["causality_unverifiable", [{ id: "message-1", text: "rewritten" }]],
  ])("send %s terminal evidence contains a released receipt", async (classification, rows) => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    stock.ambiguousNextDispatch = true;
    stock.afterNextCommit = () => {
      stock.projectedMessages = rows.map((row) => ({
        id: row.id,
        role: "user",
        text: row.text,
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: iso,
        updatedAt: iso,
      }));
    };
    const runtime = runtimeFor(stock, ["command-1", "message-1", "lease-1"]);
    const failure = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "target",
    ).catch((error) => error);
    expect(failure).toMatchObject({
      code: classification,
      evidence: {
        receipt: {
          commandId: "command-1",
          messageId: "message-1",
          acceptedSequence: null,
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });

  test("cancellation after possible acceptance releases a complete send receipt", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const controller = new AbortController();
    stock.afterNextCommit = () => controller.abort();
    stock.ambiguousNextDispatch = true;
    const runtime = runtimeFor(stock, ["command-1", "message-1", "lease-1"]);
    const failure = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "possibly accepted",
      { signal: controller.signal },
    ).catch((error) => error);
    expect(failure).toMatchObject({
      code: "cancelled",
      evidence: {
        receipt: {
          commandId: "command-1",
          messageId: "message-1",
          acceptedSequence: null,
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });

  test("deadline after possible acceptance releases a complete send receipt", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    let clock = 100;
    stock.afterNextCommit = () => { clock = 200; };
    stock.ambiguousNextDispatch = true;
    const runtime = runtimeFor(
      stock,
      ["command-1", "message-1", "lease-1"],
      { clock: () => clock },
    );
    const failure = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "possibly accepted",
      { deadlineMs: 200 },
    ).catch((error) => error);
    expect(failure).toMatchObject({
      code: "timeout",
      evidence: {
        receipt: {
          commandId: "command-1",
          messageId: "message-1",
          acceptedSequence: null,
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });

  test("facade publishes identity allocation and parsing without a private helper", () => {
    const facade = createStockT3Facade({} as never);
    expect(facade).toBeDefined();
    expect(typeof allocateProjectCreateIdentity).toBe("function");
    expect(typeof parseProjectCreateIdentity).toBe("function");
  });
});

describe("post-ship medium closure", () => {
  test("MEDIUM-1 wait with a caller-mutated receipt still releases the admitted lease", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const runtime = runtimeFor(stock, [
      "command-1", "message-1", "lease-1",
      "command-2", "message-2", "lease-2",
    ]);
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "mutated receipt",
      { timeoutMs: 30_000 },
    );
    const mutatedReceipt = { ...receipt, commandId: "caller-mutated-command" };
    stock.terminal = true;

    const completed = await runtime.wait(mutatedReceipt, { timeoutMs: 30_000 });
    expect(completed.kind).toBe("completed");
    expect(completed.receipt).toMatchObject({
      commandId: "caller-mutated-command",
      leaseId: "lease-1",
      leaseState: "released",
    });

    await expect(
      runtime.send(
        { environmentId: "env-1", threadId: "thread-existing" },
        "lease is reusable",
        { timeoutMs: 30_000 },
      ),
    ).resolves.toMatchObject({
      commandId: "command-2",
      messageId: "message-2",
      leaseId: "lease-2",
      leaseState: "active",
    });
    runtime.close();
  });

  test("MEDIUM-1 honest receipt control continues to release the lease", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const runtime = runtimeFor(stock, [
      "command-1", "message-1", "lease-1",
      "command-2", "message-2", "lease-2",
    ]);
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "honest receipt",
      { timeoutMs: 30_000 },
    );
    stock.terminal = true;

    const completed = await runtime.wait(receipt, { timeoutMs: 30_000 });
    expect(completed.kind).toBe("completed");
    expect(completed.receipt.leaseState).toBe("released");

    await expect(
      runtime.send(
        { environmentId: "env-1", threadId: "thread-existing" },
        "lease is reusable",
        { timeoutMs: 30_000 },
      ),
    ).resolves.toMatchObject({
      commandId: "command-2",
      messageId: "message-2",
      leaseId: "lease-2",
      leaseState: "active",
    });
    runtime.close();
  });

  test("MEDIUM-A wait without a lease rejects a receipt missing commandId as receipt_expired", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const runtime = runtimeFor(stock);
    const malformedReceipt = {
      agentRef: { environmentId: "env-1", threadId: "thread-existing" },
      leaseId: "ghost-lease",
      messageId: "ghost-message",
      acceptedSequence: null,
      observedSequence: 0,
      leaseExpiresAt: Date.now() + 60_000,
      leaseState: "active",
    } as unknown as TurnReceipt;

    const failure = await runtime.wait(malformedReceipt, { timeoutMs: 30_000 })
      .catch((error) => error);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      name: "StockRuntimeError",
      code: "receipt_expired",
      evidence: {
        receipt: {
          leaseId: "ghost-lease",
          messageId: "ghost-message",
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });

  test("MEDIUM-A stale receipt missing commandId rejects as receipt_expired without releasing the live lease", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const runtime = runtimeFor(stock, ["command-1", "message-1", "lease-1"]);
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "live lease",
      { timeoutMs: 30_000 },
    );
    const staleReceipt = { ...receipt, leaseId: "stale-lease" } as unknown as Record<string, unknown>;
    delete staleReceipt.commandId;

    const failure = await runtime.wait(staleReceipt as unknown as TurnReceipt, { timeoutMs: 30_000 })
      .catch((error) => error);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      name: "StockRuntimeError",
      code: "receipt_expired",
      evidence: {
        receipt: {
          leaseId: "stale-lease",
          messageId: "message-1",
          leaseState: "released",
        },
      },
    });
    await expect(
      runtime.send(
        { environmentId: "env-1", threadId: "thread-existing" },
        "live lease remains held",
        { timeoutMs: 30_000 },
      ),
    ).rejects.toMatchObject({ name: "StockRuntimeError", code: "send_in_progress" });
    runtime.close();
  });

  test("already-expired active wait entry returns receipt_expired without network access", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    let clock = 100;
    const runtime = runtimeFor(
      stock,
      ["command-1", "message-1", "lease-1"],
      { clock: () => clock },
    );
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "already expired",
      { deadlineMs: 200 },
    );
    const requestsBeforeWait = stock.requests;
    clock = 200;

    const failure = await runtime.wait(receipt).catch((error) => error);
    expect(failure).toMatchObject({
      code: "receipt_expired",
      evidence: {
        receipt: {
          leaseId: "lease-1",
          commandId: "command-1",
          messageId: "message-1",
          acceptedSequence: receipt.acceptedSequence,
          leaseState: "released",
        },
      },
    });
    expect(stock.requests).toBe(requestsBeforeWait);
    runtime.close();
  });

  test("already-expired released wait entry returns receipt_expired without network access", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    let clock = 100;
    const runtime = runtimeFor(
      stock,
      ["command-1", "message-1", "lease-1"],
      { clock: () => clock },
    );
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "released then held",
      { deadlineMs: 200 },
    );
    runtime.releaseReceipt(receipt);
    const requestsBeforeWait = stock.requests;
    clock = 200;

    const failure = await runtime.wait(receipt).catch((error) => error);
    expect(failure).toMatchObject({
      code: "receipt_expired",
      evidence: {
        receipt: {
          leaseId: "lease-1",
          commandId: "command-1",
          messageId: "message-1",
          acceptedSequence: receipt.acceptedSequence,
          leaseState: "released",
        },
      },
    });
    expect(stock.requests).toBe(requestsBeforeWait);
    runtime.close();
  });

  test("mid-wait expiry remains receipt_expired when the shared clock advances", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    let clock = 100;
    const runtime = runtimeFor(
      stock,
      ["command-1", "message-1", "lease-1"],
      { clock: () => clock },
    );
    const receipt = await runtime.send(
      { environmentId: "env-1", threadId: "thread-existing" },
      "expires while polling",
      { deadlineMs: 1_000 },
    );
    stock.afterShellRead = () => { clock = 1_000; };

    const failure = await runtime.wait(receipt).catch((error) => error);
    expect(failure).toMatchObject({
      code: "receipt_expired",
      evidence: {
        receipt: {
          leaseId: "lease-1",
          acceptedSequence: receipt.acceptedSequence,
          leaseState: "released",
        },
      },
    });
    expect(stock.shellReads).toBe(1);
    runtime.close();
  });

  test("P3.1 accepted initial turn cancelled after response preserves exact sequence", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    const controller = new AbortController();
    stock.afterEveryCommit = (command) => {
      if (command.type === "thread.turn.start") controller.abort();
    };
    const runtime = runtimeFor(stock, [
      "thread-command", "thread-new", "turn-command", "message-new", "lease-new",
    ]);

    const result = await runtime.spawn(input("/tmp/boundary-project"), {
      signal: controller.signal,
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "partial",
      initialTurn: {
        state: "initial_turn_accepted_projection_pending",
        turnReceipt: {
          commandId: "turn-command",
          messageId: "message-new",
          acceptedSequence: 3,
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });

  test("P3.2 accepted initial turn past deadline preserves exact sequence", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    let clock = 100;
    stock.afterEveryCommit = (command) => {
      if (command.type === "thread.turn.start") clock = 200;
    };
    const runtime = runtimeFor(
      stock,
      ["thread-command", "thread-new", "turn-command", "message-new", "lease-new"],
      { clock: () => clock },
    );

    const result = await runtime.spawn(input("/tmp/boundary-project"), {
      deadlineMs: 200,
      maxReconciliationReads: 1,
    });
    expect(result).toMatchObject({
      kind: "partial",
      initialTurn: {
        state: "initial_turn_accepted_projection_pending",
        turnReceipt: {
          commandId: "turn-command",
          messageId: "message-new",
          acceptedSequence: 3,
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });

  test("P6.7 accepted identical retry preserves the original exact sequence", async () => {
    const stock = new BoundaryStock("/tmp/boundary-project");
    let clock = 100;
    let turnAttempts = 0;
    stock.ambiguousNextDispatchType = "thread.turn.start";
    stock.afterEveryCommit = (command) => {
      if (command.type !== "thread.turn.start") return;
      turnAttempts += 1;
      if (turnAttempts === 1) stock.projectedMessages = [];
      if (turnAttempts === 2) clock = 200;
    };
    const runtime = runtimeFor(
      stock,
      ["thread-command", "thread-new", "turn-command", "message-new", "lease-new"],
      { clock: () => clock },
    );

    const result = await runtime.spawn(input("/tmp/boundary-project"), {
      deadlineMs: 200,
      maxReconciliationReads: 1,
    });
    expect(turnAttempts).toBe(2);
    expect(result).toMatchObject({
      kind: "partial",
      initialTurn: {
        state: "initial_turn_accepted_projection_pending",
        turnReceipt: {
          commandId: "turn-command",
          messageId: "message-new",
          acceptedSequence: 3,
          leaseState: "released",
        },
      },
    });
    runtime.close();
  });
});
