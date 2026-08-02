import type { createStockT3Facade } from "./facade";

export const MCP_TOOL_NAMES = [
  "spawn",
  "send",
  "wait",
  "observe",
  "getState",
  "listChildren",
  "listWorkers",
  "interrupt",
  "stop",
  "respondToApproval",
  "respondToUserInput",
] as const;

export type StockT3McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type StockT3Facade = ReturnType<typeof createStockT3Facade>;

export interface StockT3McpCallContext {
  readonly signal?: AbortSignal;
}

export interface StockT3McpToolDefinition {
  readonly name: StockT3McpToolName;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
  };
}

export type StockT3McpError =
  | {
      readonly type: "stock_runtime";
      readonly code: string;
      readonly evidence: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "worker_overlay";
      readonly code: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

export type StockT3McpToolResult =
  | {
      readonly isError: false;
      readonly structuredContent: { readonly ok: true; readonly value: unknown };
      readonly content: readonly [{ readonly type: "text"; readonly text: string }];
    }
  | {
      readonly isError: true;
      readonly structuredContent: { readonly ok: false; readonly error: StockT3McpError };
      readonly content: readonly [{ readonly type: "text"; readonly text: string }];
    };

const stringSchema = Object.freeze({ type: "string" });
const nullableStringSchema = Object.freeze({ type: ["string", "null"] });
const agentRefSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({ environmentId: stringSchema, threadId: stringSchema }),
  required: Object.freeze(["environmentId", "threadId"]),
  additionalProperties: false,
});
const operationSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    deadlineMs: Object.freeze({ type: "integer", minimum: 0 }),
    timeoutMs: Object.freeze({ type: "integer", minimum: 1 }),
    maxReconciliationReads: Object.freeze({ type: "integer", minimum: 1 }),
  }),
  additionalProperties: false,
});
const modelSelectionSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    instanceId: stringSchema,
    model: stringSchema,
    options: Object.freeze({ type: "array" }),
  }),
  required: Object.freeze(["instanceId", "model"]),
  additionalProperties: false,
});
const spawnInputSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    workspaceRoot: stringSchema,
    projectId: stringSchema,
    projectCreateIdentity: Object.freeze({ type: "object" }),
    title: stringSchema,
    message: stringSchema,
    modelSelection: modelSelectionSchema,
    runtimeMode: Object.freeze({
      type: "string",
      enum: Object.freeze(["approval-required", "auto-accept-edits", "auto", "full-access"]),
    }),
    interactionMode: Object.freeze({ type: "string", enum: Object.freeze(["default", "plan"]) }),
    branch: nullableStringSchema,
    worktreePath: nullableStringSchema,
    role: stringSchema,
    parentRef: Object.freeze({ anyOf: Object.freeze([agentRefSchema, Object.freeze({ type: "null" })]) }),
  }),
  required: Object.freeze([
    "workspaceRoot",
    "title",
    "message",
    "modelSelection",
    "runtimeMode",
    "interactionMode",
    "branch",
    "worktreePath",
  ]),
  additionalProperties: true,
});
const receiptSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    agentRef: agentRefSchema,
    leaseId: stringSchema,
    commandId: stringSchema,
    messageId: stringSchema,
    acceptedSequence: Object.freeze({ type: ["integer", "null"], minimum: 0 }),
    observedSequence: Object.freeze({ type: "integer", minimum: 0 }),
    leaseExpiresAt: Object.freeze({ type: "integer", minimum: 0 }),
    leaseState: Object.freeze({ type: "string", enum: Object.freeze(["active", "released"]) }),
    reconciliationEvidence: Object.freeze({ type: "array" }),
  }),
  required: Object.freeze([
    "agentRef",
    "leaseId",
    "commandId",
    "messageId",
    "acceptedSequence",
    "observedSequence",
    "leaseExpiresAt",
    "leaseState",
  ]),
  additionalProperties: false,
});

function tool(
  name: StockT3McpToolName,
  description: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): StockT3McpToolDefinition {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({
      type: "object" as const,
      properties: Object.freeze(properties),
      ...(required.length === 0 ? {} : { required: Object.freeze([...required]) }),
      additionalProperties: false as const,
    }),
  });
}

const TOOLS = Object.freeze([
  tool("spawn", "Create and start a scoped stock T3 worker through the shared facade.", {
    input: spawnInputSchema,
    operation: operationSchema,
  }, ["input"]),
  tool("send", "Start a new causal turn and return its executable receipt.", {
    ref: agentRefSchema,
    message: stringSchema,
    operation: operationSchema,
  }, ["ref", "message"]),
  tool("wait", "Wait for the exact causal turn identified by a receipt.", {
    receipt: receiptSchema,
    operation: operationSchema,
  }, ["receipt"]),
  tool("observe", "Read the canonical stock thread snapshot without claiming causality.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("getState", "Read canonical stock state through the same observe path.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("listChildren", "List process-local child metadata for one scoped parent.", {
    parentRef: agentRefSchema,
  }, ["parentRef"]),
  tool("listWorkers", "List all process-local worker metadata in the shared overlay.", {}),
  tool("interrupt", "Interrupt the running stock turn and confirm through snapshots.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("stop", "Stop the stock session and confirm through snapshots.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("respondToApproval", "Respond to a pending stock provider approval request.", {
    ref: agentRefSchema,
    response: Object.freeze({
      type: "object",
      properties: Object.freeze({
        requestId: stringSchema,
        decision: Object.freeze({
          type: "string",
          enum: Object.freeze(["accept", "acceptForSession", "decline", "cancel"]),
        }),
      }),
      required: Object.freeze(["requestId", "decision"]),
      additionalProperties: false,
    }),
    operation: operationSchema,
  }, ["ref", "response"]),
  tool("respondToUserInput", "Respond to a pending stock user-input request.", {
    ref: agentRefSchema,
    response: Object.freeze({
      type: "object",
      properties: Object.freeze({
        requestId: stringSchema,
        answers: Object.freeze({ type: "object", additionalProperties: true }),
      }),
      required: Object.freeze(["requestId", "answers"]),
      additionalProperties: false,
    }),
    operation: operationSchema,
  }, ["ref", "response"]),
]);

function notImplemented(): StockT3McpToolResult {
  const payload = {
    ok: false as const,
    error: {
      type: "stock_runtime" as const,
      code: "internal_error",
      evidence: { reason: "mcp_not_implemented" },
    },
  };
  return Object.freeze({
    isError: true as const,
    structuredContent: Object.freeze(payload),
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: JSON.stringify(payload) }),
    ]) as readonly [{ readonly type: "text"; readonly text: string }],
  });
}

/** Transport-neutral MCP tool adapter. The runtime/facade is injected exactly once. */
export function createStockT3McpFacade(_facade: StockT3Facade) {
  return Object.freeze({
    listTools: (): readonly StockT3McpToolDefinition[] => TOOLS,
    async callTool(
      _name: string,
      _arguments: unknown,
      _context: StockT3McpCallContext = {},
    ): Promise<StockT3McpToolResult> {
      return notImplemented();
    },
  });
}

export type StockT3McpFacade = ReturnType<typeof createStockT3McpFacade>;
