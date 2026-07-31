import { describe, expect, test } from "bun:test";
import { AmbiguousDispatchError, createT3Facade } from "../src/facade";

describe("spawn", () => {
  test("discovers the project by exact workspace root and starts one explicit atomic turn", async () => {
    const calls: Array<{
      readonly operation: string;
      readonly input: unknown;
    }> = [];
    const evidence: unknown[] = [];
    const runtime = {
      async listProjects() {
        return [
          { projectId: "project-other", workspaceRoot: "/work/app-copy" },
          { projectId: "project-exact", workspaceRoot: "/work/app" },
        ];
      },
      async createProject(input: unknown) {
        calls.push({ operation: "createProject", input });
        return { sequence: 1 };
      },
      async startThread(input: unknown) {
        calls.push({ operation: "startThread", input });
        return { sequence: 12 };
      },
      async startTurn(input: unknown) {
        calls.push({ operation: "startTurn", input });
        return { sequence: 13 };
      },
      async getThread(threadId: string) {
        return {
          threadId,
          projectId: "project-exact",
          snapshotSequence: 12,
          session: { status: "running", activeTurnId: "turn-1" },
          latestTurn: {
            turnId: "turn-1",
            status: "running",
            userMessageId: "message-1",
            assistantMessage: null,
          },
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["thread-1", "command-1", "message-1"];
    const facade = createT3Facade(runtime, {
      id: () => ids.shift()!,
      now: () => "2026-07-30T18:00:00.000Z",
      evidence: (record) => evidence.push(record),
    });

    const result = await facade.spawn({
      workspaceRoot: "/work/app",
      title: "reviewer",
      message: "secret task body",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5",
        options: [
          { id: "effort", value: "high" },
          { id: "contextWindow", value: "1m" },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(calls).toEqual([
      {
        operation: "startThread",
        input: {
          commandId: "command-1",
          projectId: "project-exact",
          threadId: "thread-1",
          messageId: "message-1",
          title: "reviewer",
          message: "secret task body",
          modelSelection: {
            instanceId: "claudeAgent",
            model: "claude-opus-5",
            options: [
              { id: "effort", value: "high" },
              { id: "contextWindow", value: "1m" },
            ],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-07-30T18:00:00.000Z",
          attachments: [],
        },
      },
    ]);
    expect(result.agentId).toBe("thread-1");
    expect(evidence).toEqual([
      {
        operation: "spawn",
        commandId: "command-1",
        projectId: "project-exact",
        threadId: "thread-1",
        messageId: "message-1",
        workspaceRoot: "/work/app",
        modelSelection: {
          instanceId: "claudeAgent",
          model: "claude-opus-5",
          optionCount: 2,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-07-30T18:00:00.000Z",
        attachments: 0,
        messageBytes: 16,
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("secret task body");
  });

  test("allowlists model-selection evidence without option values", async () => {
    const credential = "hostile-model-option-credential";
    const evidence: unknown[] = [];
    const runtime = {
      async listProjects() {
        return [{ projectId: "project-1", workspaceRoot: "/work/app" }];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 2 };
      },
      async startTurn() {
        return { sequence: 3 };
      },
      async getThread(threadId: string) {
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 2,
          session: { status: "running", activeTurnId: "turn-1" },
          latestTurn: {
            turnId: "turn-1",
            status: "running",
            userMessageId: "message-1",
            assistantMessage: null,
          },
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["thread-1", "command-1", "message-1"];
    const facade = createT3Facade(runtime, {
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
      evidence: (record) => evidence.push(record),
    });

    await facade.spawn({
      workspaceRoot: "/work/app",
      title: "worker",
      message: "run once",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "credential", value: credential }],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        optionCount: 1,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain(credential);
    expect(JSON.stringify(evidence)).not.toContain("credential");
  });

  test("creates a missing project without creating the workspace root", async () => {
    const calls: Array<{
      readonly operation: string;
      readonly input: unknown;
    }> = [];
    const runtime = {
      async listProjects() {
        return [];
      },
      async createProject(input: unknown) {
        calls.push({ operation: "createProject", input });
        return { sequence: 4 };
      },
      async startThread(input: unknown) {
        calls.push({ operation: "startThread", input });
        return { sequence: 5 };
      },
      async startTurn() {
        return { sequence: 6 };
      },
      async getThread(threadId: string) {
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 5,
          session: { status: "running", activeTurnId: "turn-1" },
          latestTurn: {
            turnId: "turn-1",
            status: "running",
            userMessageId: "message-1",
            assistantMessage: null,
          },
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = [
      "project-1",
      "project-command-1",
      "thread-1",
      "thread-command-1",
      "message-1",
    ];
    const facade = createT3Facade(runtime, {
      id: () => ids.shift()!,
      now: () => "2026-07-30T18:00:00.000Z",
    });

    await facade.spawn({
      workspaceRoot: "/work/new-app",
      title: "worker",
      message: "do work",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "effort", value: "high" }],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(calls[0]).toEqual({
      operation: "createProject",
      input: {
        commandId: "project-command-1",
        projectId: "project-1",
        title: "worker",
        workspaceRoot: "/work/new-app",
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "effort", value: "high" }],
        },
        createdAt: "2026-07-30T18:00:00.000Z",
      },
    });
    expect(calls[1]).toMatchObject({
      operation: "startThread",
      input: {
        projectId: "project-1",
        threadId: "thread-1",
        commandId: "thread-command-1",
        messageId: "message-1",
      },
    });
  });

  test("reconciles an ambiguously created project after one identical retry", async () => {
    const projectAttempts: unknown[] = [];
    const threadAttempts: unknown[] = [];
    let listCount = 0;
    const runtime = {
      async listProjects() {
        listCount += 1;
        return listCount === 3
          ? [{ projectId: "project-stable", workspaceRoot: "/work/app" }]
          : [];
      },
      async createProject(input: unknown) {
        projectAttempts.push(input);
        throw new AmbiguousDispatchError();
      },
      async startThread(input: unknown) {
        threadAttempts.push(input);
        return { sequence: 5 };
      },
      async startTurn() {
        return { sequence: 6 };
      },
      async getThread(threadId: string) {
        return {
          threadId,
          projectId: "project-stable",
          snapshotSequence: 5,
          session: { status: "running", activeTurnId: "turn-1" },
          latestTurn: {
            turnId: "turn-1",
            status: "running",
            userMessageId: "message-stable",
            assistantMessage: null,
          },
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = [
      "project-stable",
      "project-command-stable",
      "thread-stable",
      "thread-command-stable",
      "message-stable",
    ];
    const facade = createT3Facade(runtime, {
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    const snapshot = await facade.spawn({
      workspaceRoot: "/work/app",
      title: "worker",
      message: "run once",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(projectAttempts).toHaveLength(2);
    expect(projectAttempts[1]).toBe(projectAttempts[0]);
    expect(listCount).toBe(3);
    expect(threadAttempts).toHaveLength(1);
    expect(threadAttempts[0]).toMatchObject({
      projectId: "project-stable",
      threadId: "thread-stable",
      messageId: "message-stable",
    });
    expect(ids).toHaveLength(0);
    expect(snapshot).toMatchObject({
      agentId: "thread-stable",
      projectId: "project-stable",
    });
  });

  test("retries an ambiguous spawn with the identical preallocated payload", async () => {
    const attempts: unknown[] = [];
    let queryCount = 0;
    const runtime = {
      async listProjects() {
        return [{ projectId: "project-1", workspaceRoot: "/work/app" }];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread(input: unknown) {
        attempts.push(input);
        if (attempts.length === 1) {
          throw new AmbiguousDispatchError();
        }
        return { sequence: 9 };
      },
      async startTurn() {
        return { sequence: 10 };
      },
      async getThread(threadId: string) {
        queryCount += 1;
        if (queryCount === 1) return undefined;
        return {
          threadId,
          projectId: "project-1",
          snapshotSequence: 9,
          session: { status: "running", activeTurnId: "turn-stable" },
          latestTurn: {
            turnId: "turn-stable",
            status: "running",
            userMessageId: "message-stable",
            assistantMessage: null,
          },
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["thread-stable", "command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      id: () => ids.shift()!,
      now: () => "2026-07-30T18:00:00.000Z",
    });

    await facade.spawn({
      workspaceRoot: "/work/app",
      title: "worker",
      message: "run once",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(ids).toHaveLength(0);
  });

  test("reconciles the same thread after an ambiguous identical retry lands", async () => {
    const attempts: unknown[] = [];
    let queryCount = 0;
    const runtime = {
      async listProjects() {
        return [{ projectId: "project-selected", workspaceRoot: "/work/app" }];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread(input: unknown) {
        attempts.push(input);
        throw new AmbiguousDispatchError();
      },
      async startTurn() {
        return { sequence: 10 };
      },
      async getThread(threadId: string) {
        queryCount += 1;
        if (queryCount === 1) return undefined;
        return {
          threadId,
          projectId: "project-selected",
          snapshotSequence: 9,
          session: { status: "running", activeTurnId: "turn-stable" },
          latestTurn: {
            turnId: "turn-stable",
            status: "running",
            userMessageId: "message-stable",
            assistantMessage: null,
          },
          pendingApproval: null,
          pendingInput: null,
        };
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["thread-stable", "command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    const snapshot = await facade.spawn({
      workspaceRoot: "/work/app",
      title: "worker",
      message: "run once",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(queryCount).toBe(2);
    expect(ids).toHaveLength(0);
    expect(snapshot).toMatchObject({
      agentId: "thread-stable",
      projectId: "project-selected",
      sequence: 9,
    });
  });

  test("returns a structural facade error when an accepted spawn snapshot is unavailable", async () => {
    const runtime = {
      async listProjects() {
        return [{ projectId: "project-selected", workspaceRoot: "/work/app" }];
      },
      async createProject() {
        return { sequence: 1 };
      },
      async startThread() {
        return { sequence: 9 };
      },
      async startTurn() {
        return { sequence: 10 };
      },
      async getThread() {
        return undefined;
      },
      async *subscribeThread() {
        return;
      },
    };
    const ids = ["thread-stable", "command-stable", "message-stable"];
    const facade = createT3Facade(runtime, {
      id: () => ids.shift()!,
      now: () => "2026-07-31T00:00:00.000Z",
    });

    const result = facade.spawn({
      workspaceRoot: "/work/app",
      title: "worker",
      message: "run once",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    await expect(result).rejects.toMatchObject({
      code: "transport_unavailable",
      sequence: 0,
      structuralSnapshot: {
        threadId: "thread-stable",
        projectId: "project-selected",
      },
    });
    expect(ids).toHaveLength(0);
  });

  for (const mismatch of [
    {
      label: "thread",
      threadId: "thread-other",
      projectId: "project-selected",
      userMessageId: "message-stable",
    },
    {
      label: "project",
      threadId: "thread-stable",
      projectId: "project-other",
      userMessageId: "message-stable",
    },
    {
      label: "initial message",
      threadId: "thread-stable",
      projectId: "project-selected",
      userMessageId: "message-other",
    },
  ]) {
    test(`fails closed when an accepted spawn lookup returns a mismatched ${mismatch.label}`, async () => {
      const runtime = {
        async listProjects() {
          return [
            { projectId: "project-selected", workspaceRoot: "/work/app" },
          ];
        },
        async createProject() {
          return { sequence: 1 };
        },
        async startThread() {
          return { sequence: 9 };
        },
        async startTurn() {
          return { sequence: 10 };
        },
        async getThread() {
          return {
            threadId: mismatch.threadId,
            projectId: mismatch.projectId,
            snapshotSequence: 9,
            session: { status: "running", activeTurnId: "turn-1" },
            latestTurn: {
              turnId: "turn-1",
              status: "running",
              userMessageId: mismatch.userMessageId,
              assistantMessage: null,
            },
            pendingApproval: null,
            pendingInput: null,
          };
        },
        async *subscribeThread() {
          return;
        },
      };
      const ids = ["thread-stable", "command-stable", "message-stable"];
      const facade = createT3Facade(runtime, {
        id: () => ids.shift()!,
        now: () => "2026-07-31T00:00:00.000Z",
      });

      const result = facade.spawn({
        workspaceRoot: "/work/app",
        title: "worker",
        message: "run once",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      await expect(result).rejects.toMatchObject({
        code: "transport_unavailable",
        sequence: 9,
        structuralSnapshot: {
          threadId: mismatch.threadId,
          projectId: mismatch.projectId,
        },
      });
      expect(ids).toHaveLength(0);
    });
  }

  for (const collision of [
    {
      label: "project",
      threadId: "thread-stable",
      projectId: "project-colliding",
      userMessageId: "message-stable",
    },
    {
      label: "initial message",
      threadId: "thread-stable",
      projectId: "project-selected",
      userMessageId: "message-colliding",
    },
    {
      label: "thread",
      threadId: "thread-colliding",
      projectId: "project-selected",
      userMessageId: "message-stable",
    },
  ]) {
    test(`fails closed when ambiguous recovery finds a colliding ${collision.label} identity`, async () => {
      let attempts = 0;
      let queryCount = 0;
      const runtime = {
        async listProjects() {
          return [
            { projectId: "project-selected", workspaceRoot: "/work/app" },
          ];
        },
        async createProject() {
          return { sequence: 1 };
        },
        async startThread() {
          attempts += 1;
          throw new AmbiguousDispatchError();
        },
        async startTurn() {
          return { sequence: 10 };
        },
        async getThread() {
          queryCount += 1;
          return {
            threadId: collision.threadId,
            projectId: collision.projectId,
            snapshotSequence: 9,
            session: { status: "running", activeTurnId: "turn-colliding" },
            latestTurn: {
              turnId: "turn-colliding",
              status: "running",
              userMessageId: collision.userMessageId,
              assistantMessage: null,
            },
            pendingApproval: null,
            pendingInput: null,
          };
        },
        async *subscribeThread() {
          return;
        },
      };
      const ids = ["thread-stable", "command-stable", "message-stable"];
      const facade = createT3Facade(runtime, {
        id: () => ids.shift()!,
        now: () => "2026-07-31T00:00:00.000Z",
      });

      await expect(
        facade.spawn({
          workspaceRoot: "/work/app",
          title: "worker",
          message: "run once",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.6-sol",
            options: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        }),
      ).rejects.toBeInstanceOf(AmbiguousDispatchError);

      expect(attempts).toBe(1);
      expect(queryCount).toBe(1);
      expect(ids).toHaveLength(0);
    });
  }
});
