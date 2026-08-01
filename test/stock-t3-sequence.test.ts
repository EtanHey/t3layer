import { afterAll, describe, expect, test } from "bun:test";

import { createStockT3Facade } from "../src/facade";
import { createStockT3NativeRuntime } from "../src/nativeRuntime";

const auth = "proof-token";
const iso = "2026-07-31T18:00:00.000Z";
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5" };
let sequence = 1;
let turnNumber = 0;
let thread: Record<string, any> | undefined;
const commandTypes: string[] = [];

const project = {
  id: "project-1",
  title: "fixture",
  workspaceRoot: "/tmp/t3layer-stock-fixture",
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: iso,
  updatedAt: iso,
};

function shellThread() {
  if (thread === undefined) return [];
  return [
    {
      ...thread,
      messages: undefined,
      activities: undefined,
      checkpoints: undefined,
      proposedPlans: undefined,
      deletedAt: undefined,
      latestUserMessageAt:
        thread.messages.filter((entry: any) => entry.role === "user").at(-1)?.createdAt ?? null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ];
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/t3/environment") {
      return Response.json({
        environmentId: "environment-fixture",
        label: "fixture",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "d3037064-fixture",
        capabilities: { repositoryIdentity: false },
      });
    }
    if (request.headers.get("authorization") !== `Bearer ${auth}`) {
      return Response.json(
        { code: "auth_invalid", reason: "missing_credential", traceId: "redacted" },
        { status: 401 },
      );
    }
    if (url.pathname === "/api/orchestration/shell") {
      return Response.json({
        snapshotSequence: sequence,
        projects: [project],
        threads: shellThread(),
        updatedAt: iso,
      });
    }
    if (url.pathname.startsWith("/api/orchestration/threads/")) {
      if (thread === undefined) {
        return Response.json(
          { code: "not_found", reason: "thread_not_found", traceId: "redacted" },
          { status: 404 },
        );
      }
      return Response.json({ snapshotSequence: sequence, thread });
    }
    if (url.pathname === "/api/orchestration/dispatch") {
      const command = (await request.json()) as Record<string, any>;
      commandTypes.push(command.type);
      if (command.type === "thread.create") {
        sequence += 1;
        thread = {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          latestTurn: null,
          createdAt: iso,
          updatedAt: iso,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        };
        return Response.json({ sequence });
      }
      if (command.type === "thread.turn.start" && thread !== undefined) {
        turnNumber += 1;
        sequence += 2;
        const requestedAt = iso.replace("00.000Z", `0${turnNumber}.000Z`);
        const turnId = `turn-${turnNumber}`;
        const assistantId = `assistant-${turnNumber}`;
        thread.messages.push({
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        });
        thread.messages.push({
          id: assistantId,
          role: "assistant",
          text: `completed-${turnNumber}`,
          attachments: [],
          turnId,
          streaming: false,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        });
        thread.latestTurn = {
          turnId,
          state: "completed",
          requestedAt,
          startedAt: requestedAt,
          completedAt: requestedAt,
          assistantMessageId: assistantId,
        };
        thread.session = {
          threadId: thread.id,
          status: "ready",
          providerName: "fixture",
          activeTurnId: null,
          lastError: null,
          updatedAt: requestedAt,
        };
        return Response.json({ sequence });
      }
      return Response.json(
        { code: "invalid_request", reason: "invalid_command", traceId: "redacted" },
        { status: 400 },
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

describe("stock HTTP sequence", () => {
  test("performs receipt-targeted spawn -> wait -> send -> wait", async () => {
    const runtime = createStockT3NativeRuntime({
      baseUrl: `http://127.0.0.1:${server.port}`,
      bearerToken: auth,
    });
    const facade = createStockT3Facade(runtime);

    const spawned = await facade.spawn({
      workspaceRoot: project.workspaceRoot,
      title: "fixture worker",
      message: "initial",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    expect(spawned.kind).toBe("spawned");
    if (spawned.kind !== "spawned") throw new Error("spawn did not produce a turn receipt");
    expect(await facade.wait(spawned.turnReceipt)).toMatchObject({
      kind: "completed",
      assistantContent: "completed-1",
    });

    const sent = await facade.send(spawned.agentRef, "follow-up");
    expect(await facade.wait(sent)).toMatchObject({
      kind: "completed",
      assistantContent: "completed-2",
    });
    expect(commandTypes).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.turn.start",
    ]);
    expect(new Set([spawned.createReceipt.commandId, spawned.turnReceipt.commandId, sent.commandId]).size).toBe(3);
  });
});
