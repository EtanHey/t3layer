import { describe, expect, test } from "bun:test";

import {
  type StockSpawnInput,
  type TurnReceipt,
} from "../src/nativeRuntime";
import { createStockT3NativeRuntime } from "./support/modelCache";

const iso = "2026-08-01T04:00:00.000Z";
const selection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const projectIdentity = {
  projectId: "project-shared",
  commandId: "project-command-shared",
  createdAt: iso,
  workspaceRoot: "/tmp/project",
  title: "project",
  defaultModelSelection: selection,
};
const spawnInput = {
  workspaceRoot: "/tmp/project",
  projectCreateIdentity: projectIdentity,
  title: "worker",
  message: "initial",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
} as StockSpawnInput & {
  readonly projectCreateIdentity: typeof projectIdentity & {
    readonly environmentId?: string;
  };
};
const existingProjectInput = {
  ...spawnInput,
  projectId: "project-existing",
  projectCreateIdentity: undefined,
};

type MutationType = "project.create" | "thread.create" | "thread.turn.start";

interface DispatchDecision {
  readonly commit?: boolean;
  readonly response?: Response;
  readonly error?: Error;
}

interface FixtureOptions {
  readonly environmentForRead?: (read: number) => string;
  readonly onShell?: (
    read: number,
    fixture: StockFixture,
  ) => Response | Promise<Response> | undefined;
  readonly onThread?: (
    read: number,
    threadId: string,
    fixture: StockFixture,
  ) => Response | Promise<Response> | undefined;
  readonly onDispatch?: (
    command: Readonly<Record<string, unknown>>,
    attempt: number,
    fixture: StockFixture,
  ) => DispatchDecision | undefined;
}

function descriptor(environmentId: string) {
  return {
    environmentId,
    label: "local",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "stock",
    capabilities: { repositoryIdentity: false },
  };
}

function ids(...values: string[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("unexpected ID allocation");
    return value;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class StockFixture {
  readonly projects = new Map<string, Record<string, unknown>>();
  readonly threads = new Map<string, Record<string, unknown>>();
  readonly messages = new Map<string, Record<string, unknown>[]>();
  readonly commands: Readonly<Record<string, unknown>>[] = [];
  readonly dispatchAttempts = new Map<MutationType, number>();
  readonly acceptedCommands = new Map<string, number>();
  descriptorReads = 0;
  shellReads = 0;
  threadReads = 0;
  sequence = 0;

  constructor(readonly options: FixtureOptions = {}) {}

  project(id: string): Record<string, unknown> {
    return {
      id,
      title: "project",
      workspaceRoot: spawnInput.workspaceRoot,
      defaultModelSelection: selection,
      createdAt: iso,
      updatedAt: iso,
    };
  }

  seedProject(id = "project-existing"): void {
    this.projects.set(id, this.project(id));
  }

  seedThread(threadId: string, projectId = "project-existing"): void {
    this.threads.set(threadId, {
      id: threadId,
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
    this.messages.set(threadId, []);
  }

  shellResponse(
    projects = [...this.projects.values()],
    threads = [...this.threads.values()],
  ): Response {
    return Response.json({
      snapshotSequence: this.sequence,
      projects,
      threads: threads.map((thread) => ({
        ...thread,
        latestTurn: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      })),
      updatedAt: iso,
    });
  }

  detailResponse(
    threadId: string,
    input: {
      readonly messages?: readonly Record<string, unknown>[];
      readonly latestTurn?: Record<string, unknown> | null;
    } = {},
  ): Response {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return Response.json({ code: "not_found" }, { status: 404 });
    return Response.json({
      snapshotSequence: this.sequence,
      thread: {
        ...thread,
        latestTurn: input.latestTurn ?? null,
        session: null,
        messages: input.messages ?? this.messages.get(threadId) ?? [],
        activities: [],
        checkpoints: [],
      },
    });
  }

  userMessage(id: string, text: string): Record<string, unknown> {
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

  private commit(command: Readonly<Record<string, unknown>>): number {
    const commandId = command.commandId as string;
    const prior = this.acceptedCommands.get(commandId);
    if (prior !== undefined) return prior;
    const type = command.type as MutationType;
    if (type === "project.create") {
      const projectId = command.projectId as string;
      this.projects.set(projectId, {
        ...this.project(projectId),
        title: command.title,
        workspaceRoot: command.workspaceRoot,
        defaultModelSelection: command.defaultModelSelection,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      });
    } else if (type === "thread.create") {
      const threadId = command.threadId as string;
      this.threads.set(threadId, {
        id: threadId,
        projectId: command.projectId,
        title: command.title,
        modelSelection: command.modelSelection,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        branch: command.branch,
        worktreePath: command.worktreePath,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      });
      this.messages.set(threadId, []);
    } else {
      const threadId = command.threadId as string;
      const message = command.message as Record<string, unknown>;
      const rows = this.messages.get(threadId) ?? [];
      if (!rows.some((entry) => entry.id === message.messageId)) {
        rows.push(this.userMessage(message.messageId as string, message.text as string));
      }
      this.messages.set(threadId, rows);
    }
    this.sequence += 1;
    this.acceptedCommands.set(commandId, this.sequence);
    return this.sequence;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/t3/environment") {
      this.descriptorReads += 1;
      return Response.json(
        descriptor(this.options.environmentForRead?.(this.descriptorReads) ?? "env-1"),
      );
    }
    if (path === "/api/orchestration/shell") {
      this.shellReads += 1;
      return (await this.options.onShell?.(this.shellReads, this)) ?? this.shellResponse();
    }
    if (path.startsWith("/api/orchestration/threads/")) {
      this.threadReads += 1;
      const threadId = decodeURIComponent(path.slice("/api/orchestration/threads/".length));
      return (
        (await this.options.onThread?.(this.threadReads, threadId, this)) ??
        this.detailResponse(threadId)
      );
    }
    if (path === "/api/orchestration/dispatch") {
      const command = JSON.parse(await request.text()) as Readonly<Record<string, unknown>>;
      const type = command.type as MutationType;
      const attempt = (this.dispatchAttempts.get(type) ?? 0) + 1;
      this.dispatchAttempts.set(type, attempt);
      (this.commands as Readonly<Record<string, unknown>>[]).push(command);
      const decision = this.options.onDispatch?.(command, attempt, this);
      const sequence = decision?.commit === false
        ? this.sequence
        : this.commit(command);
      if (decision?.error !== undefined) throw decision.error;
      return decision?.response ?? Response.json({ sequence });
    }
    throw new Error(`unexpected route ${request.method} ${path}`);
  };
}

function runtimeFor(
  fixture: StockFixture,
  allocatedIds: readonly string[] = [],
  extra: Readonly<Record<string, unknown>> = {},
) {
  return createStockT3NativeRuntime({
    baseUrl: "http://stock.invalid",
    fetch: fixture.fetch,
    id: ids(...allocatedIds),
    now: () => iso,
    ...extra,
  });
}

describe("round 9 caller-held project creation identity", () => {
  test("a mismatched caller-held project payload fails before mutation", async () => {
    const fixture = new StockFixture();
    const runtime = runtimeFor(fixture);
    await expect(runtime.spawn({
      ...spawnInput,
      projectCreateIdentity: {
        ...projectIdentity,
        workspaceRoot: "/tmp/different-project",
      },
    }, { maxReconciliationReads: 1 })).rejects.toMatchObject({
      code: "identity_conflict",
      evidence: {
        reason: "invalid_project_create_identity",
        detail: "workspace_root_mismatch",
      },
    });
    expect(fixture.dispatchAttempts.get("project.create") ?? 0).toBe(0);
    runtime.close();
  });

  test("a recreated runtime reuses one projection-lagged project identity", async () => {
    const fixture = new StockFixture({
      onShell: (read, stock) =>
        read <= 3 ? stock.shellResponse([], []) : undefined,
    });
    const runtimeA = runtimeFor(fixture);
    const first = await runtimeA
      .spawn(spawnInput, { maxReconciliationReads: 1 })
      .catch((error) => error);
    expect(first).toMatchObject({
      evidence: {
        provisionalProjectId: projectIdentity.projectId,
        projectAttempt: {
          environmentId: "env-1",
          ...projectIdentity,
          acceptedSequence: 1,
        },
      },
    });
    runtimeA.close();

    const runtimeB = runtimeFor(fixture, [
      "create-1",
      "thread-1",
      "turn-1",
      "message-1",
      "lease-1",
    ]);
    const recovered = await runtimeB.spawn(spawnInput, { maxReconciliationReads: 1 });
    expect(recovered).toMatchObject({ kind: "spawned", agentRef: { threadId: "thread-1" } });
    if (recovered.kind === "spawned") runtimeB.releaseReceipt(recovered.turnReceipt);
    const commands = fixture.commands.filter((entry) => entry.type === "project.create");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect([...fixture.projects.keys()]).toEqual([projectIdentity.projectId]);
    runtimeB.close();
  });

  test("two identity-free runtimes fail before racing distinct project mutations", async () => {
    const bothShellReads = deferred<void>();
    let initialReads = 0;
    const fixture = new StockFixture({
      onShell: async (_read, stock) => {
        const empty = stock.shellResponse([], []);
        initialReads += 1;
        if (initialReads === 2) bothShellReads.resolve();
        await bothShellReads.promise;
        return empty;
      },
    });
    const withoutIdentity = { ...spawnInput, projectCreateIdentity: undefined };
    const left = runtimeFor(fixture, ["project-left", "command-left"]);
    const right = runtimeFor(fixture, ["project-right", "command-right"]);
    const outcomes = await Promise.all([
      left.spawn(withoutIdentity, { maxReconciliationReads: 1 }).catch((error) => error),
      right.spawn(withoutIdentity, { maxReconciliationReads: 1 }).catch((error) => error),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        code: "identity_conflict",
        evidence: { reason: "project_create_identity_required" },
      });
    }
    expect(fixture.dispatchAttempts.get("project.create") ?? 0).toBe(0);
    expect(fixture.projects.size).toBe(0);
    left.close();
    right.close();
  });

  test("two runtimes sharing one caller-held identity converge on one durable project", async () => {
    const bothShellReads = deferred<void>();
    let initialReads = 0;
    const fixture = new StockFixture({
      onShell: async (read, stock) => {
        if (read > 2) return stock.shellResponse();
        const empty = stock.shellResponse([], []);
        initialReads += 1;
        if (initialReads === 2) bothShellReads.resolve();
        await bothShellReads.promise;
        return empty;
      },
    });
    const left = runtimeFor(fixture, [
      "create-left",
      "thread-left",
      "turn-left",
      "message-left",
      "lease-left",
    ]);
    const right = runtimeFor(fixture, [
      "create-right",
      "thread-right",
      "turn-right",
      "message-right",
      "lease-right",
    ]);
    const results = await Promise.all([
      left.spawn(spawnInput, { maxReconciliationReads: 2 }),
      right.spawn(spawnInput, { maxReconciliationReads: 2 }),
    ]);
    expect(results.every((entry) => entry.kind === "spawned")).toBe(true);
    const commands = fixture.commands.filter((entry) => entry.type === "project.create");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect([...fixture.projects.keys()]).toEqual([projectIdentity.projectId]);
    for (const result of results) {
      if (result.kind === "spawned") {
        (result.agentRef.threadId === "thread-left" ? left : right).releaseReceipt(
          result.turnReceipt,
        );
      }
    }
    left.close();
    right.close();
  });

  test("environment roll rejects scoped old evidence and reuses the unscoped caller identity", async () => {
    const fixture = new StockFixture({
      environmentForRead: (read) => (read === 1 ? "env-1" : "env-2"),
      onShell: (read, stock) =>
        read <= 3 ? stock.shellResponse([], []) : undefined,
    });
    const runtimeA = runtimeFor(fixture);
    const first = await runtimeA
      .spawn(spawnInput, { maxReconciliationReads: 1 })
      .catch((error) => error);
    expect(first).toMatchObject({
      evidence: { projectAttempt: { environmentId: "env-1", ...projectIdentity } },
    });
    runtimeA.close();

    const runtimeB = runtimeFor(fixture, [
      "create-1",
      "thread-1",
      "turn-1",
      "message-1",
      "lease-1",
    ]);
    const oldScopedInput = {
      ...spawnInput,
      projectCreateIdentity: { ...projectIdentity, environmentId: "env-1" },
    };
    await expect(runtimeB.spawn(oldScopedInput, { maxReconciliationReads: 1 })).rejects.toMatchObject({
      code: "environment_changed",
      evidence: { expectedEnvironmentId: "env-1", actualEnvironmentId: "env-2" },
    });
    expect(fixture.dispatchAttempts.get("project.create")).toBe(1);

    const recovered = await runtimeB.spawn(spawnInput, { maxReconciliationReads: 1 });
    expect(recovered).toMatchObject({
      kind: "spawned",
      agentRef: { environmentId: "env-2", threadId: "thread-1" },
    });
    if (recovered.kind === "spawned") runtimeB.releaseReceipt(recovered.turnReceipt);
    const commands = fixture.commands.filter((entry) => entry.type === "project.create");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect([...fixture.projects.keys()]).toEqual([projectIdentity.projectId]);
    runtimeB.close();
  });
});

describe("round 9 terminal initial-turn evidence", () => {
  test.each([
    ["superseded", (stock: StockFixture) => [stock.userMessage("foreign", "foreign")]],
    [
      "concurrent_writer",
      (stock: StockFixture) => [
        stock.userMessage("message-1", "initial"),
        stock.userMessage("foreign", "foreign"),
      ],
    ],
    ["causality_unverifiable", (stock: StockFixture) => [stock.userMessage("message-1", "rewritten")]],
  ] as const)(
    "accepted initial turn retains a released receipt for %s",
    async (classification, projectedMessages) => {
      const fixture = new StockFixture({
        onThread: (read, threadId, stock) =>
          read >= 3
            ? stock.detailResponse(threadId, { messages: projectedMessages(stock) })
            : undefined,
      });
      fixture.seedProject();
      const runtime = runtimeFor(fixture, [
        "create-1",
        "thread-1",
        "turn-1",
        "message-1",
        "lease-1",
      ]);
      const result = await runtime.spawn(
        existingProjectInput,
        { maxReconciliationReads: 1 },
      );
      expect(result).toMatchObject({
        kind: "partial",
        initialTurn: {
          state: classification,
          leaseExpiresAt: null,
          safeAction: "observe",
          turnReceipt: {
            commandId: "turn-1",
            messageId: "message-1",
            acceptedSequence: 2,
            leaseState: "released",
          },
        },
      });
      if (result.kind !== "partial" || result.initialTurn.turnReceipt === null) {
        throw new Error("expected evidence-bearing partial");
      }
      await expect(runtime.wait(result.initialTurn.turnReceipt)).rejects.toMatchObject({
        code: "receipt_expired",
      });
      runtime.close();
    },
  );

  test.each([
    ["superseded", (stock: StockFixture) => [stock.userMessage("foreign", "foreign")]],
    [
      "concurrent_writer",
      (stock: StockFixture) => [
        stock.userMessage("message-1", "initial"),
        stock.userMessage("foreign", "foreign"),
      ],
    ],
    ["causality_unverifiable", (stock: StockFixture) => [stock.userMessage("message-1", "rewritten")]],
  ] as const)(
    "ambiguous initial turn retains a released unknown-sequence receipt for %s",
    async (classification, projectedMessages) => {
      const fixture = new StockFixture({
        onThread: (read, threadId, stock) =>
          read >= 3
            ? stock.detailResponse(threadId, { messages: projectedMessages(stock) })
            : undefined,
        onDispatch: (command) =>
          command.type === "thread.turn.start"
            ? { commit: true, error: new Error("response lost") }
            : undefined,
      });
      fixture.seedProject();
      const runtime = runtimeFor(fixture, [
        "create-1",
        "thread-1",
        "turn-1",
        "message-1",
        "lease-1",
      ]);
      const result = await runtime.spawn(
        existingProjectInput,
        { maxReconciliationReads: 1 },
      );
      expect(result).toMatchObject({
        kind: "partial",
        initialTurn: {
          state: classification,
          turnReceipt: {
            commandId: "turn-1",
            messageId: "message-1",
            acceptedSequence: null,
            leaseState: "released",
          },
        },
      });
      expect(fixture.dispatchAttempts.get("thread.turn.start")).toBe(1);
      runtime.close();
    },
  );
});

describe("round 9 environment-scoped turn admission", () => {
  test("a stale colliding ref cannot reserve or clear the stable environment slot", async () => {
    const oldDescriptorStarted = deferred<void>();
    const releaseOldDescriptor = deferred<void>();
    const fixture = new StockFixture({
      environmentForRead: () => "env-2",
    });
    fixture.seedProject();
    fixture.seedThread("shared-thread");
    const originalFetch = fixture.fetch;
    let oldDescriptorGated = false;
    const gatedFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (
        path === "/.well-known/t3/environment" &&
        fixture.descriptorReads === 1 &&
        !oldDescriptorGated
      ) {
        oldDescriptorGated = true;
        oldDescriptorStarted.resolve();
        await releaseOldDescriptor.promise;
      }
      return originalFetch(request);
    };
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: gatedFetch,
      id: ids("command-fresh", "message-fresh", "lease-fresh"),
      now: () => iso,
    });
    const freshRef = { environmentId: "env-2", threadId: "shared-thread" };
    const staleRef = { environmentId: "env-1", threadId: "shared-thread" };
    await runtime.observe(freshRef);

    const stale = runtime.send(staleRef, "stale").then(
      (receipt) => ({ kind: "fulfilled" as const, receipt }),
      (error) => ({ kind: "rejected" as const, error }),
    );
    await oldDescriptorStarted.promise;
    const fresh = await runtime.send(freshRef, "fresh").then(
      (receipt) => ({ kind: "fulfilled" as const, receipt }),
      (error) => ({ kind: "rejected" as const, error }),
    );
    releaseOldDescriptor.resolve();
    const staleOutcome = await stale;

    expect(fresh).toMatchObject({
      kind: "fulfilled",
      receipt: {
        agentRef: freshRef,
        messageId: "message-fresh",
        acceptedSequence: 1,
        leaseState: "active",
      },
    });
    expect(staleOutcome).toMatchObject({
      kind: "rejected",
      error: { code: "environment_changed" },
    });
    expect(fixture.commands.filter((entry) => entry.type === "thread.turn.start")).toHaveLength(1);
    if (fresh.kind === "fulfilled") runtime.releaseReceipt(fresh.receipt as TurnReceipt);
    runtime.close();
  });

  test("the injected runtime clock governs the internally constructed HTTP client", async () => {
    const fixture = new StockFixture();
    fixture.seedProject();
    const runtime = runtimeFor(
      fixture,
      ["create-1", "thread-1", "turn-1", "message-1", "lease-1"],
      { clock: () => 100 },
    );
    const result = await runtime.spawn(
      existingProjectInput,
      { deadlineMs: 200, maxReconciliationReads: 1 },
    );
    expect(result.kind).toBe("spawned");
    expect(fixture.descriptorReads).toBe(1);
    if (result.kind === "spawned") runtime.releaseReceipt(result.turnReceipt);
    runtime.close();
  });
});
