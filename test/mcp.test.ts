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
import { WorkerOverlayError } from "../src/overlay";

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
const spawnInput = Object.freeze({
  workspaceRoot: "/tmp/project",
  projectId: "project-1",
  title: "worker",
  message: "start",
  modelSelection: Object.freeze({ instanceId: "claudeAgent", model: "claude-opus-5" }),
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
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
    const spawn = tools.find((entry) => entry.name === "spawn");
    const nestedInput = spawn?.inputSchema.properties.input as
      | { readonly additionalProperties?: boolean }
      | undefined;
    expect(nestedInput?.additionalProperties).toBeFalse();
  });

  test("routes every tool through the same injected facade instance", async () => {
    const { facade, calls, snapshot } = fakeFacade();
    const mcp = createStockT3McpFacade(facade);
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
        observedSequence: 9,
      });
    };
    const result = await createStockT3McpFacade(facade).callTool("interrupt", {
      ref,
      operation,
    });

    expect(error(result)).toEqual({
      type: "stock_runtime",
      code: "identity_conflict",
      evidence: { reason: "invalid_agent_ref", observedSequence: 9 },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            type: "stock_runtime",
            code: "identity_conflict",
            evidence: { reason: "invalid_agent_ref", observedSequence: 9 },
          },
        }),
      },
    ]);

    (facade as unknown as { listChildren: () => never }).listChildren = () => {
      throw new WorkerOverlayError("overlay_unknown", { ref });
    };
    expect(error(await createStockT3McpFacade(facade).callTool("listChildren", {
      parentRef: ref,
    }))).toEqual({
      type: "worker_overlay",
      code: "overlay_unknown",
      details: { ref },
    });
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

    const malformedArguments = await mcp.callTool("send", null);
    expect(error(malformedArguments)).toEqual({
      type: "stock_runtime",
      code: "protocol_mismatch",
      evidence: { field: "arguments" },
    });
    expect(calls).toHaveLength(0);

    const extraSpawnField = await mcp.callTool("spawn", {
      input: { ...spawnInput, privateRuntimeClient: "forbidden" },
    });
    expect(error(extraSpawnField)).toEqual({
      type: "stock_runtime",
      code: "protocol_mismatch",
      evidence: { field: "input.privateRuntimeClient" },
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

    const rawSignal = await createStockT3McpFacade(facade).callTool("observe", {
      ref,
      operation: { signal: {} },
    });
    expect(error(rawSignal)).toEqual({
      type: "stock_runtime",
      code: "protocol_mismatch",
      evidence: { field: "operation.signal" },
    });
    expect(calls).toHaveLength(1);
  });

  test("serializes receipts and snapshots without losing MCP transport fields", async () => {
    const { facade } = fakeFacade();
    const mcp = createStockT3McpFacade(facade);

    for (const result of [
      await mcp.callTool("send", { ref, message: "hello" }),
      await mcp.callTool("observe", { ref }),
    ]) {
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  test("turns an aborted MCP context into the runtime's typed cancellation before HTTP", async () => {
    const counted = countingRuntime();
    const result = await createStockT3McpFacade(createStockT3Facade(counted.runtime)).callTool(
      "observe",
      { ref },
      { signal: AbortSignal.abort() },
    );

    expect(error(result)).toEqual({
      type: "stock_runtime",
      code: "cancelled",
      evidence: {},
    });
    expect(counted.calls).toEqual([]);
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
  const malformedOperations = [
    ...[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
      .map((value) => ({ field: "deadlineMs" as const, value })),
    ...[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]
      .map((value) => ({ field: "timeoutMs" as const, value })),
    ...[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]
      .map((value) => ({ field: "maxReconciliationReads" as const, value })),
  ];

  for (const { field, value } of malformedOperations) {
    test(`send, spawn, and control reject malformed ${field}=${String(value)} before HTTP`, async () => {
      const invalidOperation = { [field]: value } as RuntimeOperationOptions;
      const direct = countingRuntime();
      const sendError = await directError(
        (runtime, options) => runtime.send(ref, "hello", options),
        direct.runtime,
        invalidOperation,
      );
      expect(sendError.code).toBe("protocol_mismatch");
      expect(sendError.evidence).toEqual({ field });
      expect(direct.calls).toEqual([]);

      const spawn = countingRuntime();
      const spawnError = await directError(
        (runtime, options) =>
          runtime.spawn(
            spawnInput,
            options,
          ),
        spawn.runtime,
        invalidOperation,
      );
      expect(spawnError.code).toBe("protocol_mismatch");
      expect(spawnError.evidence).toEqual({ field });
      expect(spawn.calls).toEqual([]);

      const control = countingRuntime();
      const controlError = await directError(
        (runtime, options) => runtime.interrupt(ref, options),
        control.runtime,
        invalidOperation,
      );
      expect(controlError.code).toBe("protocol_mismatch");
      expect(controlError.evidence).toEqual({ field });
      expect(control.calls).toEqual([]);

      const mcpRuntime = countingRuntime();
      const mcp = createStockT3McpFacade(createStockT3Facade(mcpRuntime.runtime));
      const mcpResult = await mcp.callTool("send", {
        ref,
        message: "hello",
        operation: invalidOperation,
      });
      expect(error(mcpResult)).toEqual({
        type: "stock_runtime",
        code: "protocol_mismatch",
        evidence: { field },
      });
      expect(mcpRuntime.calls).toEqual([]);

      const mcpSpawnRuntime = countingRuntime();
      const mcpSpawn = createStockT3McpFacade(createStockT3Facade(mcpSpawnRuntime.runtime));
      expect(error(await mcpSpawn.callTool("spawn", {
        input: spawnInput,
        operation: invalidOperation,
      }))).toEqual({
        type: "stock_runtime",
        code: "protocol_mismatch",
        evidence: { field },
      });
      expect(mcpSpawnRuntime.calls).toEqual([]);

      const mcpControlRuntime = countingRuntime();
      const mcpControl = createStockT3McpFacade(createStockT3Facade(mcpControlRuntime.runtime));
      expect(error(await mcpControl.callTool("interrupt", {
        ref,
        operation: invalidOperation,
      }))).toEqual({
        type: "stock_runtime",
        code: "protocol_mismatch",
        evidence: { field },
      });
      expect(mcpControlRuntime.calls).toEqual([]);
    });
  }
});
