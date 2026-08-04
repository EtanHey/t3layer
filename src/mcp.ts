import type { createStockT3Facade } from "./facade";
import { StockRuntimeError } from "./nativeRuntime";
import type {
  AgentRef,
  ApprovalResponse,
  RuntimeOperationOptions,
  StockSpawnInput,
  ThreadMetaFields,
  TurnReceipt,
  UserInputResponse,
} from "./nativeRuntime";
import { WorkerOverlayError } from "./overlay";

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
  "archive",
  "unarchive",
  "settle",
  "unsettle",
  "snooze",
  "unsnooze",
  "updateMeta",
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
const projectCreateIdentitySchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    projectId: stringSchema,
    commandId: stringSchema,
    createdAt: stringSchema,
    workspaceRoot: stringSchema,
    title: stringSchema,
    defaultModelSelection: modelSelectionSchema,
    environmentId: stringSchema,
  }),
  required: Object.freeze([
    "projectId",
    "commandId",
    "createdAt",
    "workspaceRoot",
    "title",
    "defaultModelSelection",
  ]),
  additionalProperties: false,
});
const spawnInputSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    workspaceRoot: stringSchema,
    projectId: stringSchema,
    projectCreateIdentity: projectCreateIdentitySchema,
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
  dependentRequired: Object.freeze({
    role: Object.freeze(["parentRef"]),
    parentRef: Object.freeze(["role"]),
  }),
  additionalProperties: false,
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
const threadMetaFieldsSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    title: stringSchema,
    modelSelection: modelSelectionSchema,
    branch: nullableStringSchema,
    worktreePath: nullableStringSchema,
  }),
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
  tool("archive", "Archive a stock thread and confirm the disposition through snapshots.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("unarchive", "Restore an archived stock thread and confirm through snapshots.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("settle", "Settle a stock thread and confirm the disposition through snapshots.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("unsettle", "Reopen a settled stock thread as an explicit user action.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("snooze", "Snooze a stock thread until an ISO timestamp and confirm through snapshots.", {
    ref: agentRefSchema,
    until: stringSchema,
    operation: operationSchema,
  }, ["ref", "until"]),
  tool("unsnooze", "Wake a snoozed stock thread as an explicit user action.", {
    ref: agentRefSchema,
    operation: operationSchema,
  }, ["ref"]),
  tool("updateMeta", "Update canonical stock thread metadata and confirm through snapshots.", {
    ref: agentRefSchema,
    fields: threadMetaFieldsSchema,
    operation: operationSchema,
  }, ["ref", "fields"]),
]);

function resultContent(payload: unknown) {
  return Object.freeze([
    Object.freeze({ type: "text" as const, text: JSON.stringify(payload) }),
  ]) as readonly [{ readonly type: "text"; readonly text: string }];
}

function success(value: unknown): StockT3McpToolResult {
  const payload = Object.freeze({ ok: true as const, value: value === undefined ? null : value });
  return Object.freeze({
    isError: false as const,
    structuredContent: payload,
    content: resultContent(payload),
  });
}

function jsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? {} : JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { reason: "non_json_error_evidence" };
  }
}

function failure(error: StockT3McpError): StockT3McpToolResult {
  const payload = Object.freeze({ ok: false as const, error: Object.freeze(error) });
  return Object.freeze({
    isError: true as const,
    structuredContent: payload,
    content: resultContent(payload),
  });
}

function stockFailure(code: string, evidence: Readonly<Record<string, unknown>> = {}) {
  return failure({ type: "stock_runtime", code, evidence: jsonRecord(evidence) });
}

function protocolMismatch(field: string): never {
  throw new StockRuntimeError("protocol_mismatch", { field });
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    protocolMismatch(field);
  }
  return value as Record<string, unknown>;
}

interface SchemaShape {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
  readonly additionalProperties?: boolean;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly unknown[];
  readonly minimum?: number;
}

function fieldPath(parent: string, child: string): string {
  return parent.length === 0 ? child : `${parent}.${child}`;
}

function schemaErrorField(field: string): string {
  return field === "operation.deadlineMs" ||
    field === "operation.timeoutMs" ||
    field === "operation.maxReconciliationReads" ||
    field === "response.requestId" ||
    field === "response.decision" ||
    field === "response.answers"
    ? field.slice(field.indexOf(".") + 1)
    : field;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

function schemaMatches(value: unknown, schemaValue: unknown): boolean {
  try {
    validateSchema(value, schemaValue, "value");
    return true;
  } catch (error) {
    if (error instanceof StockRuntimeError && error.code === "protocol_mismatch") return false;
    throw error;
  }
}

function validateSchema(value: unknown, schemaValue: unknown, field: string): void {
  const schema = objectValue(schemaValue, field) as SchemaShape;
  if (schema.anyOf !== undefined) {
    if (!schema.anyOf.some((candidate) => schemaMatches(value, candidate))) protocolMismatch(field);
    return;
  }
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!types.some((type) => matchesType(value, type))) protocolMismatch(schemaErrorField(field));
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    protocolMismatch(schemaErrorField(field));
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    protocolMismatch(schemaErrorField(field));
  }
  if (schema.type === "object") {
    const input = objectValue(value, field);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(input, required)) {
        protocolMismatch(schemaErrorField(fieldPath(field, required)));
      }
    }
    for (const [property, dependencies] of Object.entries(schema.dependentRequired ?? {})) {
      if (!Object.hasOwn(input, property)) continue;
      for (const dependency of dependencies) {
        if (!Object.hasOwn(input, dependency)) {
          protocolMismatch(schemaErrorField(fieldPath(field, dependency)));
        }
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(input)) {
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) {
          protocolMismatch(schemaErrorField(fieldPath(field, key)));
        }
        continue;
      }
      validateSchema(child, childSchema, fieldPath(field, key));
    }
  }
}

function validateRef(value: unknown, field: string): AgentRef {
  const ref = objectValue(value, field);
  for (const key of ["environmentId", "threadId"] as const) {
    const part = ref[key];
    if (typeof part !== "string") {
      protocolMismatch(fieldPath(field, key));
    }
  }
  return ref as unknown as AgentRef;
}

function validateToolArguments(name: StockT3McpToolName, argumentsValue: unknown): Record<string, unknown> {
  const definition = TOOLS.find((candidate) => candidate.name === name);
  if (definition === undefined) protocolMismatch("tool.name");
  objectValue(argumentsValue, "arguments");
  validateSchema(argumentsValue, definition.inputSchema, "");
  const args = objectValue(argumentsValue, "arguments");
  if (Object.hasOwn(args, "ref")) validateRef(args.ref, "ref");
  if (Object.hasOwn(args, "parentRef")) validateRef(args.parentRef, "parentRef");
  const receipt = args.receipt;
  if (receipt !== undefined) validateRef(objectValue(receipt, "receipt").agentRef, "receipt.agentRef");
  const input = args.input;
  if (input !== undefined) {
    const parentRef = objectValue(input, "input").parentRef;
    if (parentRef !== undefined && parentRef !== null) validateRef(parentRef, "input.parentRef");
  }
  return args;
}

function operationWithContext(
  value: unknown,
  context: StockT3McpCallContext,
): RuntimeOperationOptions | undefined {
  const operation = value as RuntimeOperationOptions | undefined;
  if (context.signal === undefined) return operation;
  return { ...(operation ?? {}), signal: context.signal };
}

function isToolName(name: string): name is StockT3McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Transport-neutral MCP tool adapter. The runtime/facade is injected exactly once. */
export function createStockT3McpFacade(facade: StockT3Facade) {
  return Object.freeze({
    listTools: (): readonly StockT3McpToolDefinition[] => TOOLS,
    async callTool(
      name: string,
      argumentsValue: unknown,
      context: StockT3McpCallContext = {},
    ): Promise<StockT3McpToolResult> {
      try {
        if (!isToolName(name)) protocolMismatch("tool.name");
        const args = validateToolArguments(name, argumentsValue);
        const operation = operationWithContext(args.operation, context);
        switch (name) {
          case "spawn":
            return success(await facade.spawn(args.input as StockSpawnInput, operation));
          case "send":
            return success(await facade.send(args.ref as AgentRef, args.message as string, operation));
          case "wait":
            return success(await facade.wait(args.receipt as TurnReceipt, operation));
          case "observe":
          case "getState":
            return success(await facade.observe(args.ref as AgentRef, operation));
          case "listChildren":
            return success(facade.listChildren(args.parentRef as AgentRef));
          case "listWorkers":
            return success(facade.listWorkers());
          case "interrupt":
            return success(await facade.interrupt(args.ref as AgentRef, operation));
          case "stop":
            return success(await facade.stop(args.ref as AgentRef, operation));
          case "respondToApproval":
            return success(await facade.respondToApproval(
              args.ref as AgentRef,
              args.response as unknown as ApprovalResponse,
              operation,
            ));
          case "respondToUserInput":
            return success(await facade.respondToUserInput(
              args.ref as AgentRef,
              args.response as unknown as UserInputResponse,
              operation,
            ));
          case "archive":
            return success(await facade.archive(args.ref as AgentRef, operation));
          case "unarchive":
            return success(await facade.unarchive(args.ref as AgentRef, operation));
          case "settle":
            return success(await facade.settle(args.ref as AgentRef, operation));
          case "unsettle":
            return success(await facade.unsettle(args.ref as AgentRef, operation));
          case "snooze":
            return success(await facade.snooze(
              args.ref as AgentRef,
              args.until as string,
              operation,
            ));
          case "unsnooze":
            return success(await facade.unsnooze(args.ref as AgentRef, operation));
          case "updateMeta":
            return success(await facade.updateMeta(
              args.ref as AgentRef,
              args.fields as ThreadMetaFields,
              operation,
            ));
          default:
            return protocolMismatch("tool.name");
        }
      } catch (error) {
        if (error instanceof StockRuntimeError) {
          return stockFailure(error.code, error.evidence);
        }
        if (error instanceof WorkerOverlayError) {
          return failure({
            type: "worker_overlay",
            code: error.code,
            details: jsonRecord(error.details),
          });
        }
        return stockFailure("internal_error", { reason: "unhandled_facade_error" });
      }
    },
  });
}

export type StockT3McpFacade = ReturnType<typeof createStockT3McpFacade>;
