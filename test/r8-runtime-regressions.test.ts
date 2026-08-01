import { describe, expect, test } from "bun:test";

import {
  createStockT3NativeRuntime,
  type StockSpawnInput,
} from "../src/nativeRuntime";

const iso = "2026-07-31T18:00:00.000Z";
const selection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const spawnInput: StockSpawnInput = {
  workspaceRoot: "/tmp/project",
  projectCreateIdentity: {
    projectId: "project-1",
    commandId: "project-command-1",
    createdAt: iso,
    workspaceRoot: "/tmp/project",
    title: "project",
    defaultModelSelection: selection,
  },
  title: "worker",
  message: "initial",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
};

type MutationType = "project.create" | "thread.create" | "thread.turn.start";

interface DispatchDecision {
  readonly commit?: boolean;
  readonly response?: Response;
  readonly error?: Error;
}

interface FixtureOptions {
  readonly projects?: readonly string[];
  readonly environmentForRead?: (read: number) => string;
  readonly onShell?: (read: number, fixture: StockFixture) => Response | undefined;
  readonly onThread?: (
    read: number,
    threadId: string,
    fixture: StockFixture,
  ) => Response | undefined;
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

function readFailure(status = 500): Response {
  return Response.json(
    { code: "internal_error", reason: "orchestration_dispatch_failed", secret: "not-retained" },
    { status },
  );
}

function dispatchFailure(status: 400 | 401 | 403 | 500): Response {
  const bodies = {
    400: { code: "invalid_request", reason: "invalid_command" },
    401: { code: "auth_invalid", reason: "invalid_credential" },
    403: { code: "insufficient_scope", reason: null },
    500: { code: "internal_error", reason: "orchestration_dispatch_failed" },
  } as const;
  return Response.json(bodies[status], { status });
}

class StockFixture {
  readonly projects = new Map<string, Record<string, unknown>>();
  readonly threads = new Map<string, Record<string, unknown>>();
  readonly messages = new Map<string, Record<string, unknown>[]>();
  readonly commands: Readonly<Record<string, unknown>>[] = [];
  readonly dispatchAttempts = new Map<MutationType, number>();
  descriptorReads = 0;
  shellReads = 0;
  threadReads = 0;
  sequence = 0;

  constructor(readonly options: FixtureOptions = {}) {
    for (const id of options.projects ?? []) {
      this.projects.set(id, this.project(id));
    }
  }

  private project(id: string): Record<string, unknown> {
    return {
      id,
      title: "project",
      workspaceRoot: spawnInput.workspaceRoot,
      defaultModelSelection: selection,
      createdAt: iso,
      updatedAt: iso,
    };
  }

  private shellThread(thread: Record<string, unknown>): Record<string, unknown> {
    return {
      ...thread,
      latestTurn: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    };
  }

  shellResponse(
    projects = [...this.projects.values()],
    threads = [...this.threads.values()],
  ): Response {
    return Response.json({
      snapshotSequence: this.sequence,
      projects,
      threads: threads.map((entry) => this.shellThread(entry)),
      updatedAt: iso,
    });
  }

  detailResponse(threadId: string, includeMessages = true): Response {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return Response.json({ code: "not_found" }, { status: 404 });
    return Response.json({
      snapshotSequence: this.sequence,
      thread: {
        ...thread,
        latestTurn: null,
        session: null,
        messages: includeMessages ? (this.messages.get(threadId) ?? []) : [],
        activities: [],
        checkpoints: [],
      },
    });
  }

  private commit(command: Readonly<Record<string, unknown>>): void {
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
      const input = command.message as Record<string, unknown>;
      const rows = this.messages.get(threadId) ?? [];
      if (!rows.some((entry) => entry.id === input.messageId)) {
        rows.push({
          id: input.messageId,
          role: "user",
          text: input.text,
          attachments: input.attachments ?? [],
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        });
      }
      this.messages.set(threadId, rows);
    }
    this.sequence += 1;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
      return this.options.onShell?.(this.shellReads, this) ?? this.shellResponse();
    }
    if (path.startsWith("/api/orchestration/threads/")) {
      this.threadReads += 1;
      const threadId = decodeURIComponent(path.slice("/api/orchestration/threads/".length));
      return (
        this.options.onThread?.(this.threadReads, threadId, this) ??
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
      if (decision?.commit ?? true) this.commit(command);
      if (decision?.error !== undefined) throw decision.error;
      return decision?.response ?? Response.json({ sequence: this.sequence });
    }
    throw new Error(`unexpected route ${request.method} ${path}`);
  };
}

function ids(...values: string[]) {
  return () => values.shift()!;
}

function projectAttemptEvidence(retryState: string, acceptedSequence: number | null) {
  return {
    provisionalProjectId: "project-1",
    projectAttempt: {
      commandId: "project-command-1",
      projectId: "project-1",
      acceptedSequence,
      retryState,
    },
    readEvidence: [
      { stage: "project_create_reconciliation", class: "server_internal", status: 500 },
    ],
  };
}

describe("round 8 all-mutation result invariant over stock HTTP", () => {
  test("E2 accepted project.create plus reconciliation 500 preserves project identity and evidence", async () => {
    const fixture = new StockFixture({
      onShell: (read) => (read === 2 ? readFailure() : undefined),
    });
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id: ids("project-1", "project-command-1"),
      now: () => iso,
    });

    const error = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 }).catch((cause) => cause);
    expect(error).toMatchObject({
      code: "transport_unavailable",
      evidence: {
        reason: "project_projection_pending",
        ...projectAttemptEvidence("not_applicable", 1),
      },
    });
    expect(fixture.dispatchAttempts.get("project.create")).toBe(1);
    expect(JSON.stringify(error)).not.toContain("not-retained");
    runtime.close();
  });

  test("E2b ambiguous project.create plus accepted identical retry and reconciliation 500 preserves one attempt", async () => {
    const fixture = new StockFixture({
      onShell: (read, stock) => {
        if (read === 2) return stock.shellResponse([], []);
        if (read === 3) return readFailure();
        return undefined;
      },
      onDispatch: (command, attempt) =>
        command.type === "project.create" && attempt === 1
          ? { commit: true, error: new Error("response lost") }
          : undefined,
    });
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id: ids("project-1", "project-command-1"),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).rejects.toMatchObject({
      code: "transport_unavailable",
      evidence: {
        reason: "project_create_outcome_unknown",
        ...projectAttemptEvidence("identical_retry_accepted", 2),
      },
    });
    const projectCommands = fixture.commands.filter((entry) => entry.type === "project.create");
    expect(projectCommands).toHaveLength(2);
    expect(projectCommands[1]).toEqual(projectCommands[0]);
    runtime.close();
  });

  test("C1 caller retries reuse the caller-held project identity and never create a second project row", async () => {
    const fixture = new StockFixture({
      onShell: (read, stock) => {
        if (read === 2) return readFailure();
        if (read === 3) return stock.shellResponse([], []);
        return undefined;
      },
    });
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id: ids(
        "create-1", "thread-1", "turn-1", "message-1", "lease-1",
        "create-2", "thread-2", "turn-2", "message-2", "lease-2",
      ),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).rejects.toMatchObject({
      evidence: { provisionalProjectId: "project-1" },
    });
    const second = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
    expect(second).toMatchObject({ kind: "spawned", agentRef: { threadId: "thread-1" } });
    if (second.kind === "spawned") runtime.releaseReceipt(second.turnReceipt);
    const third = await runtime.spawn(spawnInput, { maxReconciliationReads: 1 });
    expect(third).toMatchObject({ kind: "spawned", agentRef: { threadId: "thread-2" } });
    if (third.kind === "spawned") runtime.releaseReceipt(third.turnReceipt);
    const projectCommands = fixture.commands.filter((entry) => entry.type === "project.create");
    expect(projectCommands).toHaveLength(2);
    expect(projectCommands[1]).toEqual(projectCommands[0]);
    expect([...fixture.projects]).toHaveLength(1);
    runtime.close();
  });

  test("an ambiguous project attempt cancelled before retry reuses the exact caller identity", async () => {
    const controller = new AbortController();
    const fixture = new StockFixture({
      onShell: (read, stock) => {
        if (read === 2) {
          controller.abort();
          return stock.shellResponse([], []);
        }
        if (read === 3) return stock.shellResponse([], []);
        return undefined;
      },
      onDispatch: (command, attempt) =>
        command.type === "project.create" && attempt === 1
          ? { commit: true, error: new Error("response lost") }
          : undefined,
    });
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id: ids(
        "create-1", "thread-1", "turn-1", "message-1", "lease-1",
      ),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, {
      maxReconciliationReads: 1,
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: "cancelled",
      evidence: {
        provisionalProjectId: "project-1",
        projectAttempt: { retryState: "eligible_not_sent" },
      },
    });
    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
      kind: "spawned",
      agentRef: { threadId: "thread-1" },
    });
    const projectCommands = fixture.commands.filter((entry) => entry.type === "project.create");
    expect(projectCommands).toHaveLength(2);
    expect(projectCommands[1]).toEqual(projectCommands[0]);
    runtime.close();
  });

  test("E4 one received target-read 500 does not consume the remaining four-read budget", async () => {
    let targetReads = 0;
    const fixture = new StockFixture({
      projects: ["project-1"],
      onThread: (read, threadId, stock) => {
        if (read <= 2) return undefined;
        targetReads += 1;
        if (targetReads === 1) return readFailure();
        if (targetReads < 4) return stock.detailResponse(threadId, false);
        return undefined;
      },
    });
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 4 })).resolves.toMatchObject({
      kind: "spawned",
      turnReceipt: {
        messageId: "message-1",
        acceptedSequence: 2,
        reconciliationEvidence: [
          { stage: "target_reconciliation", class: "server_internal", status: 500 },
        ],
      },
    });
    expect(targetReads).toBe(4);
    expect(runtime.httpObservations().endpointStatusTrace).toContainEqual({
      method: "GET",
      path: "/api/orchestration/threads/thread-1",
      status: 500,
    });
    runtime.close();
  });

  test("E3 a stable environment roll invalidates old refs once and admits new work after re-pin", async () => {
    const fixture = new StockFixture({
      projects: ["project-1"],
      environmentForRead: (read) => (read === 1 ? "env-1" : "env-2"),
    });
    fixture.threads.set("old-thread", {
      id: "old-thread",
      projectId: "project-1",
      title: "worker",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: iso,
      updatedAt: iso,
    });
    fixture.messages.set("old-thread", []);
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });
    const oldRef = { environmentId: "env-1", threadId: "old-thread" };

    await expect(runtime.observe(oldRef)).resolves.toMatchObject({ snapshotSequence: 0 });
    await expect(runtime.observe(oldRef)).rejects.toMatchObject({ code: "environment_changed" });
    await expect(runtime.observe(oldRef)).rejects.toMatchObject({ code: "environment_changed" });
    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
      kind: "spawned",
      agentRef: { environmentId: "env-2", threadId: "thread-1" },
    });
    runtime.close();
  });

  test.each([
    "project.create",
    "thread.create",
    "thread.turn.start",
  ] as const)("malformed accepted %s response reconciles exact identity without a duplicate", async (stage) => {
    const fixture = new StockFixture({
      projects: stage === "project.create" ? [] : ["project-1"],
      onDispatch: (command) =>
        command.type === stage
          ? { commit: true, response: Response.json({ sequence: "malformed" }) }
          : undefined,
    });
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id:
        stage === "project.create"
          ? ids("create-1", "thread-1", "turn-1", "message-1", "lease-1")
          : ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
      kind: "spawned",
      agentRef: { threadId: "thread-1" },
    });
    expect(fixture.dispatchAttempts.get(stage)).toBe(1);
    runtime.close();
  });

  test.each([
    ["thread shell", "shell"],
    ["thread detail", "detail"],
  ] as const)("received %s reconciliation 500 is bounded and the next read recovers", async (_label, boundary) => {
    const fixture = new StockFixture({
      projects: ["project-1"],
      onShell: (read) => (boundary === "shell" && read === 2 ? readFailure() : undefined),
      onThread: (read) => (boundary === "detail" && read === 1 ? readFailure() : undefined),
    });
    const runtime = createStockT3NativeRuntime({
      baseUrl: "http://stock.invalid",
      fetch: fixture.fetch,
      id: ids("create-1", "thread-1", "turn-1", "message-1", "lease-1"),
      now: () => iso,
    });

    await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 2 })).resolves.toMatchObject({
      kind: "spawned",
      agentRef: { threadId: "thread-1" },
    });
    runtime.close();
  });

  test.each([400, 401, 403, 500] as const)(
    "a trustworthy original project.create %i permits a new caller-held logical identity",
    async (status) => {
      let first = true;
      const fixture = new StockFixture({
        onDispatch: (command) => {
          if (command.type === "project.create" && first) {
            first = false;
            return { commit: false, response: dispatchFailure(status) };
          }
          return undefined;
        },
      });
      const runtime = createStockT3NativeRuntime({
        baseUrl: "http://stock.invalid",
        fetch: fixture.fetch,
        id: ids(
          "create-1", "thread-1", "turn-1", "message-1", "lease-1",
        ),
        now: () => iso,
      });

      await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).rejects.toMatchObject({
        code: status === 400 ? "command_rejected" : status === 401 ? "authentication_failed" : status === 403 ? "permission_denied" : "server_internal",
      });
      await expect(runtime.spawn({
        ...spawnInput,
        projectCreateIdentity: {
          projectId: "project-2",
          commandId: "project-command-2",
          createdAt: iso,
          workspaceRoot: "/tmp/project",
          title: "project",
          defaultModelSelection: selection,
        },
      }, { maxReconciliationReads: 1 })).resolves.toMatchObject({ kind: "spawned" });
      expect(fixture.dispatchAttempts.get("project.create")).toBe(2);
      expect([...fixture.projects.keys()]).toEqual(["project-2"]);
      runtime.close();
    },
  );

  test.each([400, 401, 403, 500] as const)(
    "an ambiguous accepted original survives a trustworthy identical project retry %i",
    async (status) => {
      const fixture = new StockFixture({
        onShell: (read, stock) =>
          read === 2 || read === 3 ? stock.shellResponse([], []) : undefined,
        onDispatch: (command, attempt) => {
          if (command.type !== "project.create") return undefined;
          if (attempt === 1) return { commit: true, error: new Error("response lost") };
          return { commit: false, response: dispatchFailure(status) };
        },
      });
      const runtime = createStockT3NativeRuntime({
        baseUrl: "http://stock.invalid",
        fetch: fixture.fetch,
        id: ids(
          "create-1", "thread-1", "turn-1", "message-1", "lease-1",
        ),
        now: () => iso,
      });

      await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).rejects.toMatchObject({
        code: "transport_unavailable",
        evidence: {
          provisionalProjectId: "project-1",
          projectAttempt: {
            commandId: "project-command-1",
            projectId: "project-1",
            acceptedSequence: null,
            dispatchState: "outcome_unknown",
            retryState: "identical_retry_received_error",
            retryClass:
              status === 400
                ? "command_rejected"
                : status === 401
                  ? "authentication_failed"
                  : status === 403
                    ? "permission_denied"
                    : "server_internal",
          },
        },
      });
      await expect(runtime.spawn(spawnInput, { maxReconciliationReads: 1 })).resolves.toMatchObject({
        kind: "spawned",
      });
      expect(fixture.dispatchAttempts.get("project.create")).toBe(2);
      runtime.close();
    },
  );
});
