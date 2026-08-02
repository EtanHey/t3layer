import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createStockT3Facade } from "../src/facade";
import { createStockT3McpFacade, type StockT3McpToolResult } from "../src/mcp";
import { StockRuntimeError, createStockT3NativeRuntime } from "../src/nativeRuntime";

const bearerToken = "phase7-fixture-token";
const createdAt = "2026-08-02T09:00:00.000Z";
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5" };

type ThreadRecord = Record<string, any> & {
  pendingApproval: boolean;
  pendingUserInput: boolean;
};

function createAuthenticatedFixture() {
  let sequence = 1;
  let turnNumber = 0;
  const commands: Array<Record<string, any>> = [];
  const threads = new Map<string, ThreadRecord>();
  const project = {
    id: "project-1",
    title: "fixture",
    workspaceRoot: "/tmp/t3layer-phase7-fixture",
    defaultModelSelection: modelSelection,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
  };

  function shellThreads() {
    return [...threads.values()].map((thread) => ({
      ...thread,
      messages: undefined,
      activities: undefined,
      checkpoints: undefined,
      proposedPlans: undefined,
      deletedAt: undefined,
      latestUserMessageAt:
        thread.messages.filter((entry: any) => entry.role === "user").at(-1)?.createdAt ?? null,
      hasPendingApprovals: thread.pendingApproval,
      hasPendingUserInput: thread.pendingUserInput,
      hasActionableProposedPlan: false,
      pendingApproval: undefined,
      pendingUserInput: undefined,
    }));
  }

  function complete(thread: ThreadRecord, content: string) {
    const latest = thread.latestTurn;
    if (latest === null) throw new Error("missing latest turn");
    const assistantId = `assistant-${turnNumber}`;
    thread.messages.push({
      id: assistantId,
      role: "assistant",
      text: content,
      attachments: [],
      turnId: latest.turnId,
      streaming: false,
      createdAt: latest.requestedAt,
      updatedAt: latest.requestedAt,
    });
    thread.latestTurn = {
      ...latest,
      state: "completed",
      completedAt: latest.requestedAt,
      assistantMessageId: assistantId,
    };
    thread.session = {
      threadId: thread.id,
      status: "ready",
      providerName: "fixture",
      activeTurnId: null,
      lastError: null,
      updatedAt: latest.requestedAt,
    };
  }

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/t3/environment") {
        return Response.json({
          environmentId: "environment-phase7",
          label: "phase7 fixture",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "d3037064-phase7-fixture",
          capabilities: { repositoryIdentity: false },
        });
      }
      if (request.headers.get("authorization") !== `Bearer ${bearerToken}`) {
        return Response.json(
          { code: "auth_invalid", reason: "missing_credential", traceId: "redacted" },
          { status: 401 },
        );
      }
      if (url.pathname === "/api/orchestration/shell") {
        return Response.json({
          snapshotSequence: sequence,
          projects: [project],
          threads: shellThreads(),
          updatedAt: createdAt,
        });
      }
      if (url.pathname.startsWith("/api/orchestration/threads/")) {
        const threadId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const thread = threads.get(threadId);
        if (thread === undefined) {
          return Response.json(
            { code: "not_found", reason: "thread_not_found", traceId: "redacted" },
            { status: 404 },
          );
        }
        const { pendingApproval: _approval, pendingUserInput: _input, ...publicThread } = thread;
        return Response.json({ snapshotSequence: sequence, thread: publicThread });
      }
      if (url.pathname === "/api/orchestration/dispatch") {
        const command = (await request.json()) as Record<string, any>;
        commands.push(command);
        if (command.type === "thread.create") {
          sequence += 1;
          threads.set(command.threadId, {
            id: command.threadId,
            projectId: command.projectId,
            title: command.title,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            branch: command.branch,
            worktreePath: command.worktreePath,
            latestTurn: null,
            createdAt,
            updatedAt: createdAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
            pendingApproval: false,
            pendingUserInput: false,
          });
          return Response.json({ sequence });
        }
        const thread = threads.get(command.threadId);
        if (thread === undefined) {
          return Response.json(
            { code: "invalid_request", reason: "invalid_command", traceId: "redacted" },
            { status: 400 },
          );
        }
        if (command.type === "thread.turn.start") {
          turnNumber += 1;
          sequence += 2;
          const requestedAt = `2026-08-02T09:00:${String(turnNumber).padStart(2, "0")}.000Z`;
          const turnId = `turn-${turnNumber}`;
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
          thread.latestTurn = {
            turnId,
            state: "running",
            requestedAt,
            startedAt: requestedAt,
            completedAt: null,
            assistantMessageId: null,
          };
          thread.session = {
            threadId: thread.id,
            status: "running",
            providerName: "fixture",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: requestedAt,
          };
          thread.pendingApproval = command.message.text === "needs approval";
          thread.pendingUserInput = command.message.text === "needs input";
          if (!thread.pendingApproval && !thread.pendingUserInput && command.message.text !== "keep running") {
            complete(thread, `completed-${turnNumber}`);
          }
          return Response.json({ sequence });
        }
        if (command.type === "thread.approval.respond") {
          sequence += 1;
          thread.pendingApproval = false;
          complete(thread, "approval-complete");
          return Response.json({ sequence });
        }
        if (command.type === "thread.user-input.respond") {
          sequence += 1;
          thread.pendingUserInput = false;
          complete(thread, "input-complete");
          return Response.json({ sequence });
        }
        if (command.type === "thread.turn.interrupt") {
          sequence += 1;
          thread.latestTurn = {
            ...thread.latestTurn,
            state: "interrupted",
            completedAt: thread.latestTurn?.requestedAt ?? createdAt,
          };
          thread.session = {
            ...thread.session,
            status: "interrupted",
            activeTurnId: null,
          };
          return Response.json({ sequence });
        }
        if (command.type === "thread.session.stop") {
          sequence += 1;
          thread.session = {
            ...thread.session,
            status: "stopped",
            activeTurnId: null,
          };
          return Response.json({ sequence });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });

  return { commands, project, server, threads };
}

let fixture: ReturnType<typeof createAuthenticatedFixture>;
beforeAll(() => {
  fixture = createAuthenticatedFixture();
});
afterAll(() => fixture?.server.stop(true));

function value<T = unknown>(result: StockT3McpToolResult): T {
  expect(result.isError).toBeFalse();
  if (!result.structuredContent.ok) throw new Error("expected MCP success");
  return result.structuredContent.value as T;
}

function typedError(result: StockT3McpToolResult) {
  expect(result.isError).toBeTrue();
  if (result.structuredContent.ok) throw new Error("expected MCP error");
  return result.structuredContent.error;
}

describe("direct and MCP end-to-end parity", () => {
  test("shares one authenticated runtime for spawn -> wait -> send -> wait and the full control plane", async () => {
    const runtime = createStockT3NativeRuntime({
      baseUrl: `http://127.0.0.1:${fixture.server.port}`,
      bearerToken,
    });
    try {
      const facade = createStockT3Facade(runtime);
      const mcp = createStockT3McpFacade(facade);

    const spawned = value<any>(
      await mcp.callTool("spawn", {
        input: {
          workspaceRoot: fixture.project.workspaceRoot,
          title: "root worker",
          message: "initial",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          role: "lead",
          parentRef: null,
        },
      }),
    );
    expect(spawned.kind).toBe("spawned");
    const firstWait = await facade.wait(spawned.turnReceipt);
    expect(firstWait).toMatchObject({
      kind: "completed",
      assistantContent: "completed-1",
      receipt: { agentRef: spawned.agentRef, leaseState: "released" },
    });

    const sent = await facade.send(spawned.agentRef, "follow-up");
    const secondWait = value<any>(await mcp.callTool("wait", { receipt: sent }));
    expect(secondWait).toMatchObject({
      kind: "completed",
      assistantContent: "completed-2",
      receipt: { agentRef: spawned.agentRef, commandId: sent.commandId, leaseState: "released" },
    });

    const directObservation = await facade.observe(spawned.agentRef);
    expect(value<any>(await mcp.callTool("observe", { ref: spawned.agentRef }))).toEqual(directObservation);
    expect(value<any>(await mcp.callTool("getState", { ref: spawned.agentRef }))).toEqual(directObservation);

    const child = value<any>(
      await mcp.callTool("spawn", {
        input: {
          workspaceRoot: fixture.project.workspaceRoot,
          title: "child worker",
          message: "child initial",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          role: "worker",
          parentRef: spawned.agentRef,
        },
      }),
    );
    expect(child.agentRef.environmentId).toBe(spawned.agentRef.environmentId);
    await facade.wait(child.turnReceipt);
    expect(value<any>(await mcp.callTool("listWorkers", {}))).toEqual(facade.listWorkers());
    expect(value<any>(await mcp.callTool("listChildren", { parentRef: spawned.agentRef }))).toEqual(
      facade.listChildren(spawned.agentRef),
    );

    const approvalReceipt = await facade.send(spawned.agentRef, "needs approval");
    const directPending = await facade.wait(approvalReceipt).catch((caught) => caught);
    expect(directPending).toBeInstanceOf(StockRuntimeError);
    expect((directPending as StockRuntimeError).code).toBe("pending_approval");
    const approval = value<any>(
      await mcp.callTool("respondToApproval", {
        ref: spawned.agentRef,
        response: { requestId: "approval-1", decision: "accept" },
      }),
    );
    expect(approval).toMatchObject({ kind: "applied", operation: "respond_to_approval" });
    expect(value<any>(await mcp.callTool("wait", { receipt: approvalReceipt }))).toMatchObject({
      assistantContent: "approval-complete",
      receipt: { leaseId: approvalReceipt.leaseId, leaseState: "released" },
    });

    const inputReceipt = value<any>(
      await mcp.callTool("send", { ref: spawned.agentRef, message: "needs input" }),
    );
    expect(typedError(await mcp.callTool("wait", { receipt: inputReceipt }))).toMatchObject({
      type: "stock_runtime",
      code: "pending_input",
    });
    expect(
      value<any>(
        await mcp.callTool("respondToUserInput", {
          ref: spawned.agentRef,
          response: { requestId: "input-1", answers: { choice: "a" } },
        }),
      ),
    ).toMatchObject({ kind: "applied", operation: "respond_to_user_input" });
    expect(await facade.wait(inputReceipt)).toMatchObject({ assistantContent: "input-complete" });

    const runningReceipt = value<any>(
      await mcp.callTool("send", { ref: spawned.agentRef, message: "keep running" }),
    );
    const interrupted = value<any>(
      await mcp.callTool("interrupt", { ref: spawned.agentRef }),
    );
    expect(interrupted).toMatchObject({
      kind: "applied",
      operation: "interrupt",
      agentRef: spawned.agentRef,
      snapshot: { thread: { latestTurn: { state: "interrupted" } } },
    });
    const interruptedWait = await facade.wait(runningReceipt).catch((caught) => caught);
    expect(interruptedWait).toBeInstanceOf(StockRuntimeError);
    expect((interruptedWait as StockRuntimeError).code).toBe("turn_interrupted");

    const stopped = value<any>(await mcp.callTool("stop", { ref: spawned.agentRef }));
    expect(stopped).toMatchObject({
      kind: "applied",
      operation: "stop",
      snapshot: { thread: { session: { status: "stopped" } } },
    });

    const invalidRef = { environmentId: "", threadId: spawned.agentRef.threadId };
    const directInvalid = await facade.interrupt(invalidRef).catch((caught) => caught);
    const mcpInvalid = typedError(await mcp.callTool("interrupt", { ref: invalidRef }));
    expect(directInvalid).toBeInstanceOf(StockRuntimeError);
    expect(mcpInvalid).toEqual({
      type: "stock_runtime",
      code: (directInvalid as StockRuntimeError).code,
      evidence: (directInvalid as StockRuntimeError).evidence,
    });

    expect(fixture.commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.turn.start",
      "thread.create",
      "thread.turn.start",
      "thread.turn.start",
      "thread.approval.respond",
      "thread.turn.start",
      "thread.user-input.respond",
      "thread.turn.start",
      "thread.turn.interrupt",
      "thread.session.stop",
    ]);
    } finally {
      runtime.close();
    }
  });
});
