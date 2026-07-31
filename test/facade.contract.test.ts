import { describe, expect, test } from "bun:test";
import { createConfig } from "../src/config";
import { createT3Facade } from "../src/facade";

const FACADE_CONFIG = createConfig({
  baseUrl: "http://127.0.0.1:3773",
  provider: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  contextWindow: "1m",
  runtimeMode: "full-access",
  interactionMode: "default",
});

function makeRuntime(
  startThreadInputs: unknown[],
  startTurnInputs: unknown[] = [],
) {
  return {
    async listProjects() {
      return [{ projectId: "project-1", workspaceRoot: "/work/app" }];
    },
    async createProject() {
      return { sequence: 1 };
    },
    async startThread(input: unknown) {
      startThreadInputs.push(input);
      return { sequence: 2 };
    },
    async startTurn(input: unknown) {
      startTurnInputs.push(input);
      return { sequence: 3 };
    },
    async getThread(threadId: string) {
      return {
        threadId,
        projectId: "project-1",
        snapshotSequence: 2,
        session: { status: "ready", activeTurnId: null },
        latestTurn:
          startThreadInputs.length === 0
            ? null
            : {
                turnId: "turn-1",
                status: "completed",
                userMessageId: "message-1",
                assistantMessage: {
                  content: "complete",
                  streaming: false,
                },
              },
        pendingApproval: null,
        pendingInput: null,
      };
    },
    async *subscribeThread() {
      return;
    },
  };
}

describe("canonical pre-adapter contracts", () => {
  test("accepts omitted model options and records an evidence count of zero", async () => {
    const startThreadInputs: unknown[] = [];
    const evidence: unknown[] = [];
    const ids = ["thread-1", "command-1", "message-1"];
    const facade = createT3Facade(makeRuntime(startThreadInputs), {
      ...FACADE_CONFIG,
      id: () => ids.shift()!,
      now: () => "2026-07-31T10:00:00.000Z",
      evidence: (record) => evidence.push(record),
    });

    await facade.spawn({
      workspaceRoot: "/work/app",
      title: "worker",
      message: "task",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(startThreadInputs[0]).toMatchObject({
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
    expect(
      (
        startThreadInputs[0] as {
          readonly modelSelection: Record<string, unknown>;
        }
      ).modelSelection,
    ).not.toHaveProperty("options");
    expect(evidence[0]).toMatchObject({
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        optionCount: 0,
      },
    });
  });

  test("accepts exact boolean model option values without exposing them", async () => {
    const startThreadInputs: unknown[] = [];
    const evidence: unknown[] = [];
    const ids = ["thread-1", "command-1", "message-1"];
    const facade = createT3Facade(makeRuntime(startThreadInputs), {
      ...FACADE_CONFIG,
      id: () => ids.shift()!,
      now: () => "2026-07-31T10:00:00.000Z",
      evidence: (record) => evidence.push(record),
    });

    await facade.spawn({
      workspaceRoot: "/work/app",
      title: "worker",
      message: "task",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "fastMode", value: true }],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    expect(startThreadInputs[0]).toMatchObject({
      modelSelection: {
        options: [{ id: "fastMode", value: true }],
      },
    });
    expect(evidence[0]).toMatchObject({
      modelSelection: { optionCount: 1 },
    });
    expect(JSON.stringify(evidence)).not.toContain("fastMode");
    expect(
      (
        evidence[0] as {
          readonly modelSelection: Record<string, unknown>;
        }
      ).modelSelection,
    ).not.toHaveProperty("options");
  });

  test("includes the configured modes in follow-up dispatch and evidence", async () => {
    const startTurnInputs: unknown[] = [];
    const evidence: unknown[] = [];
    const ids = ["command-2", "message-2"];
    const facade = createT3Facade(makeRuntime([], startTurnInputs), {
      ...FACADE_CONFIG,
      id: () => ids.shift()!,
      now: () => "2026-07-31T10:05:00.000Z",
      evidence: (record) => evidence.push(record),
    });

    await facade.send("thread-1", "follow-up");

    expect(startTurnInputs).toEqual([
      {
        commandId: "command-2",
        threadId: "thread-1",
        messageId: "message-2",
        message: "follow-up",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-31T10:05:00.000Z",
        attachments: [],
      },
    ]);
    expect(evidence).toEqual([
      {
        operation: "send",
        commandId: "command-2",
        threadId: "thread-1",
        messageId: "message-2",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-31T10:05:00.000Z",
        attachments: 0,
        messageBytes: 9,
      },
    ]);
  });
});
