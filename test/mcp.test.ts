import { describe, expect, test } from "bun:test";

import {
  MCP_TOOL_NAMES,
  createStockT3McpFacade,
  type StockT3McpToolResult,
} from "../src/mcp";
import { createStockT3Facade } from "../src/facade";
import {
  StockRuntimeError,
  createStockT3NativeRuntime,
  type AgentRef,
  type RuntimeOperationOptions,
  type T3NativeRuntime,
} from "../src/nativeRuntime";

const ref: AgentRef = Object.freeze({ environmentId: "environment-1", threadId: "thread-1" });
const operation = Object.freeze({ deadlineMs: 1_000 });
const receipt = Object.freeze({
  agentRef: ref,
  leaseId: "lease-1",
  commandId: "command-1",
  messageId: "message-1",
  acceptedSequence: 3,
  observedSequence: 2,
  leaseExpiresAt: 1_000,
  leaseState: "active" as const,
});

function value(result: StockT3McpToolResult): unknown {
  expect(result.isError).toBeFalse();
  expect(result.structuredContent.ok).toBeTrue();
  if (!result.structuredContent.ok) throw new Error("expected MCP success");
  return result.structuredContent.value;
}

function error(result: StockT3McpToolResult) {
  expect(result.isError).toBeTrue();
  expect(result.structuredContent.ok).toBeFalse();
  if (result.structuredContent.ok) throw new Error("expected MCP error");
  return result.structuredContent.error;
}

function fakeFacade() {
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  const snapshot = Object.freeze({ snapshotSequence: 9, thread: { id: ref.threadId } });
  const facade = {
    async spawn(...args: readonly unknown[]) {
      calls.push({ method: "spawn", args });
      return { kind: "spawned", agentRef: ref, marker: "spawn" };
    },
    async send(...args: readonly unknown[]) {
      calls.push({ method: "send", args });
      return receipt;
    },
    async wait(...args: readonly unknown[]) {
      calls.push({ method: "wait", args });
      return { kind: "completed", receipt, assistantContent: "done" };
    },
    async observe(...args: readonly unknown[]) {
      calls.push({ method: "observe", args });
      return snapshot;
    },
    listChildren(...args: readonly unknown[]) {
      calls.push({ method: "listChildren", args });
      return [{ agentRef: ref, role: "worker", parentRef: null }];
    },
    listWorkers(...args: readonly unknown[]) {
      calls.push({ method: "listWorkers", args });
      return [{ agentRef: ref, role: "worker", parentRef: null }];
    },
    async interrupt(...args: readonly unknown[]) {
      calls.push({ method: "interrupt", args });
      return { kind: "applied", operation: "interrupt", agentRef: ref, snapshot };
    },
    async stop(...args: readonly unknown[]) {
      calls.push({ method: "stop", args });
      return { kind: "applied", operation: "stop", agentRef: ref, snapshot };
    },
    async respondToApproval(...args: readonly unknown[]) {
      calls.push({ method: "respondToApproval", args });
      return { kind: "applied", operation: "respond_to_approval", agentRef: ref, snapshot };
    },
    async respondToUserInput(...args: readonly unknown[]) {
      calls.push({ method: "respondToUserInput", args });
      return { kind: "applied", operation: "respond_to_user_input", agentRef: ref, snapshot };
    },
  };
  return {
    calls,
    facade: facade as unknown as ReturnType<typeof createStockT3Facade>,
    snapshot,
  };
}

describe("stock T3 MCP facade", () => {
  test("publishes the accepted facade as exact MCP tool definitions", () => {
    const { facade } = fakeFacade();
    const mcp = createStockT3McpFacade(facade);
    const tools = mcp.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(MCP_TOOL_NAMES.length);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBeFalse();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  test("routes every tool through the same injected facade instance", async () => {
    const { facade, calls, snapshot } = fakeFacade();
    const mcp = createStockT3McpFacade(facade);
    const spawnInput = {
      workspaceRoot: "/tmp/project",
      title: "worker",
      message: "start",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    };

    expect(value(await mcp.callTool("spawn", { input: spawnInput, operation }))).toMatchObject({
      marker: "spawn",
    });
    expect(value(await mcp.callTool("send", { ref, message: "hello", operation }))).toEqual(receipt);
    expect(value(await mcp.callTool("wait", { receipt, operation }))).toMatchObject({ kind: "completed" });
    expect(value(await mcp.callTool("observe", { ref, operation }))).toBe(snapshot);
    expect(value(await mcp.callTool("getState", { ref, operation }))).toBe(snapshot);
    expect(value(await mcp.callTool("listChildren", { parentRef: ref }))).toHaveLength(1);
    expect(value(await mcp.callTool("listWorkers", {}))).toHaveLength(1);
    expect(value(await mcp.callTool("interrupt", { ref, operation }))).toMatchObject({ operation: "interrupt" });
    expect(value(await mcp.callTool("stop", { ref, operation }))).toMatchObject({ operation: "stop" });
    expect(
      value(
        await mcp.callTool("respondToApproval", {
          ref,
          response: { requestId: "approval-1", decision: "accept" },
          operation,
        }),
      ),
    ).toMatchObject({ operation: "respond_to_approval" });
    expect(
      value(
        await mcp.callTool("respondToUserInput", {
          ref,
          response: { requestId: "input-1", answers: { choice: "a" } },
          operation,
        }),
      ),
    ).toMatchObject({ operation: "respond_to_user_input" });

    expect(calls.map((entry) => entry.method)).toEqual([
      "spawn",
      "send",
      "wait",
      "observe",
      "observe",
      "listChildren",
      "listWorkers",
      "interrupt",
      "stop",
      "respondToApproval",
      "respondToUserInput",
    ]);
    expect(calls[0]?.args).toEqual([spawnInput, operation]);
    expect(calls[1]?.args).toEqual([ref, "hello", operation]);
  });

  test("preserves typed facade errors and their bounded evidence", async () => {
    const { facade } = fakeFacade();
    (facade as unknown as { interrupt: () => Promise<never> }).interrupt = async () => {
      throw new StockRuntimeError("identity_conflict", {
        reason: "invalid_agent_ref",
        secret: undefined,
      });
    };
    const result = await createStockT3McpFacade(facade).callTool("interrupt", {
      ref,
      operation,
    });

    expect(error(result)).toEqual({
      type: "stock_runtime",
      code: "identity_conflict",
      evidence: { reason: "invalid_agent_ref" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            type: "stock_runtime",
            code: "identity_conflict",
            evidence: { reason: "invalid_agent_ref" },
          },
        }),
      },
    ]);
  });

  test("rejects malformed scoped refs and unknown tools at the MCP boundary", async () => {
    const { facade, calls } = fakeFacade();
    const mcp = createStockT3McpFacade(facade);

    const malformed = await mcp.callTool("send", {
      ref: { threadId: "thread-1" },
      message: "hello",
    });
    expect(error(malformed)).toEqual({
      type: "stock_runtime",
      code: "protocol_mismatch",
      evidence: { field: "ref.environmentId" },
    });
    expect(calls).toHaveLength(0);

    const unknown = await mcp.callTool("deleteAgent", {});
    expect(error(unknown)).toEqual({
      type: "stock_runtime",
      code: "protocol_mismatch",
      evidence: { field: "tool.name" },
    });
    expect(calls).toHaveLength(0);
  });

  test("propagates MCP cancellation through operation context without accepting a signal argument", async () => {
    const { facade, calls } = fakeFacade();
    const signal = AbortSignal.abort();
    const result = await createStockT3McpFacade(facade).callTool(
      "observe",
      { ref, operation: { timeoutMs: 500 } },
      { signal },
    );

    expect(value(result)).toBeDefined();
    expect(calls[0]?.args).toEqual([ref, { timeoutMs: 500, signal }]);
  });
});

function countingRuntime() {
  const calls: string[] = [];
  const client = {
    async getDescriptor() {
      calls.push("getDescriptor");
      return {
        environmentId: "environment-1",
        label: "fixture",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "fixture",
        capabilities: { repositoryIdentity: false },
      };
    },
    async getShell() {
      calls.push("getShell");
      throw new Error("unexpected getShell");
    },
    async getThread() {
      calls.push("getThread");
      throw new Error("unexpected getThread");
    },
    async dispatch() {
      calls.push("dispatch");
      throw new Error("unexpected dispatch");
    },
  };
  const runtime = createStockT3NativeRuntime({
    client,
    clock: () => 100,
  });
  return { calls, runtime };
}

async function directError(
  action: (runtime: T3NativeRuntime, operation: RuntimeOperationOptions) => Promise<unknown>,
  runtime: T3NativeRuntime,
  operation: RuntimeOperationOptions,
) {
  try {
    await action(runtime, operation);
    throw new Error("expected direct call to reject");
  } catch (caught) {
    expect(caught).toBeInstanceOf(StockRuntimeError);
    return caught as StockRuntimeError;
  }
}

describe("runtime numeric-bound ingress", () => {
  const malformedDeadlines = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];

  for (const deadlineMs of malformedDeadlines) {
    test(`send and spawn reject malformed deadlineMs=${String(deadlineMs)} before HTTP`, async () => {
      const direct = countingRuntime();
      const sendError = await directError(
        (runtime, options) => runtime.send(ref, "hello", options),
        direct.runtime,
        { deadlineMs },
      );
      expect(sendError.code).toBe("protocol_mismatch");
      expect(sendError.evidence).toEqual({ field: "deadlineMs" });
      expect(direct.calls).toEqual([]);

      const spawn = countingRuntime();
      const spawnError = await directError(
        (runtime, options) =>
          runtime.spawn(
            {
              workspaceRoot: "/tmp/project",
              projectId: "project-1",
              title: "worker",
              message: "start",
              modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            },
            options,
          ),
        spawn.runtime,
        { deadlineMs },
      );
      expect(spawnError.code).toBe("protocol_mismatch");
      expect(spawnError.evidence).toEqual({ field: "deadlineMs" });
      expect(spawn.calls).toEqual([]);

      const mcpRuntime = countingRuntime();
      const mcp = createStockT3McpFacade(createStockT3Facade(mcpRuntime.runtime));
      const mcpResult = await mcp.callTool("send", {
        ref,
        message: "hello",
        operation: { deadlineMs },
      });
      expect(error(mcpResult)).toEqual({
        type: "stock_runtime",
        code: "protocol_mismatch",
        evidence: { field: "deadlineMs" },
      });
      expect(mcpRuntime.calls).toEqual([]);
    });
  }
});
