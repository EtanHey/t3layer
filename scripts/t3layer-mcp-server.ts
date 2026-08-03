import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { createStockT3Facade } from "../src/facade";
import {
  createStockT3McpFacade,
  type StockT3McpCallContext,
  type StockT3McpFacade,
  type StockT3McpToolName,
  type StockT3McpToolResult,
} from "../src/mcp";
import {
  createStockT3NativeRuntime,
  type T3NativeRuntime,
} from "../src/nativeRuntime";
import type { ConnectionProfile } from "../src/stockT3Contracts";

const DEFAULT_APP_BIN =
  "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)";
const DEFAULT_BASE_URL = "http://127.0.0.1:3773";
const TOKEN_MINT_TIMEOUT_MS = 10_000;
const DESCRIPTOR_PROBE_TIMEOUT_MS = 5_000;
const HARD_KILL_GRACE_MS = 250;

export const T3LAYER_LOCAL_TOOL_NAMES = [
  "listChildren",
  "listWorkers",
] as const satisfies readonly StockT3McpToolName[];

export const T3LAYER_APP_REQUIRED_TOOL_NAMES = [
  "spawn",
  "send",
  "wait",
  "observe",
  "getState",
  "interrupt",
  "stop",
  "respondToApproval",
  "respondToUserInput",
] as const satisfies readonly StockT3McpToolName[];

const LOCAL_TOOL_NAMES = new Set<string>(T3LAYER_LOCAL_TOOL_NAMES);

export interface T3LayerMcpConfig {
  readonly appBin: string;
  readonly serverBin: string;
  readonly baseDir: string;
  readonly baseUrl: string;
  readonly connectionProfile: ConnectionProfile;
}

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type CommandRunner = (
  invocation: CommandInvocation,
) => Promise<CommandResult>;
export type T3LayerMcpRuntime = T3NativeRuntime;
export type T3LayerMcpAdapter = StockT3McpFacade;

export type T3LayerMcpServerErrorResult = {
  readonly isError: true;
  readonly structuredContent: {
    readonly ok: false;
    readonly error: {
      readonly type: "mcp_server";
      readonly code: "t3_app_unavailable";
      readonly evidence: {
        readonly reason: "token_mint_failed" | "descriptor_probe_failed";
      };
    };
  };
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
};

export type T3LayerMcpServerResult =
  | StockT3McpToolResult
  | T3LayerMcpServerErrorResult;

export interface RuntimeFactoryInput {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly connectionProfile: ConnectionProfile;
}

export interface T3LayerMcpServiceOptions {
  readonly config?: T3LayerMcpConfig;
  readonly createRuntime?: (input: RuntimeFactoryInput) => T3LayerMcpRuntime;
  readonly createMcpFacade?: (runtime: T3LayerMcpRuntime) => T3LayerMcpAdapter;
  readonly runCommand?: CommandRunner;
}

function connectionProfile(value: string | undefined): ConnectionProfile {
  const selected = value ?? "local";
  if (selected === "local" || selected === "relay" || selected === "tunnel") {
    return selected;
  }
  throw new TypeError(
    "T3LAYER_CONNECTION_PROFILE must be local, relay, or tunnel",
  );
}

export function readT3LayerMcpConfig(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  homeDirectory = homedir(),
): T3LayerMcpConfig {
  const appBin = env.T3LAYER_APP_BIN ?? DEFAULT_APP_BIN;
  return Object.freeze({
    appBin,
    serverBin: resolve(
      dirname(appBin),
      "../Resources/app.asar/apps/server/dist/bin.mjs",
    ),
    baseDir: resolve(homeDirectory, ".t3"),
    baseUrl: env.T3LAYER_BASE_URL ?? DEFAULT_BASE_URL,
    connectionProfile: connectionProfile(env.T3LAYER_CONNECTION_PROFILE),
  });
}

export const runCommand: CommandRunner = async (invocation) => {
  const processHandle = Bun.spawn([invocation.command, ...invocation.args], {
    env: { ...Bun.env, ...invocation.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdoutReader = processHandle.stdout.getReader();
  const stdout = (async () => {
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) return output + decoder.decode();
        output += decoder.decode(value, { stream: true });
      }
    } finally {
      stdoutReader.releaseLock();
    }
  })();
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    processHandle.kill();
    hardKill = setTimeout(() => {
      processHandle.kill("SIGKILL");
      void stdoutReader.cancel().catch(() => {});
    }, HARD_KILL_GRACE_MS);
  }, invocation.timeoutMs);
  try {
    const [exitCode, output] = await Promise.all([
      processHandle.exited,
      stdout,
    ]);
    return { exitCode, stdout: output };
  } finally {
    clearTimeout(timeout);
    if (hardKill !== undefined) clearTimeout(hardKill);
  }
};

export async function mintSubscriptionToken(input: {
  readonly appBin: string;
  readonly serverBin: string;
  readonly baseDir: string;
  readonly runCommand: CommandRunner;
}): Promise<string> {
  const result = await input.runCommand({
    command: input.appBin,
    args: [
      input.serverBin,
      "auth",
      "session",
      "issue",
      "--base-dir",
      input.baseDir,
      "--ttl",
      "12h",
      "--label",
      "t3layer-mcp",
      "--subject",
      "t3layer-mcp",
      "--token-only",
    ],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: TOKEN_MINT_TIMEOUT_MS,
  });
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || token.length === 0 || /\s/.test(token)) {
    throw new Error("token_mint_failed");
  }
  return token;
}

interface RuntimeSlot {
  readonly proxy: T3LayerMcpRuntime;
  readonly current: () => T3LayerMcpRuntime;
  readonly replace: (create: () => T3LayerMcpRuntime) => void;
  readonly close: () => void;
}

function createRuntimeSlot(initial: T3LayerMcpRuntime): RuntimeSlot {
  let current = initial;
  const proxy = new Proxy(initial, {
    get(_target, property) {
      const value = Reflect.get(current, property);
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
  return {
    proxy,
    current: () => current,
    replace(create) {
      const previous = current;
      current = create();
      previous.close();
    },
    close() {
      current.close();
    },
  };
}

function appUnavailable(
  reason: "token_mint_failed" | "descriptor_probe_failed",
): T3LayerMcpServerErrorResult {
  const payload = Object.freeze({
    ok: false as const,
    error: Object.freeze({
      type: "mcp_server" as const,
      code: "t3_app_unavailable" as const,
      evidence: Object.freeze({ reason }),
    }),
  });
  return Object.freeze({
    isError: true as const,
    structuredContent: payload,
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: JSON.stringify(payload) }),
    ]) as readonly [{ readonly type: "text"; readonly text: string }],
  });
}

function resultErrorCode(result: T3LayerMcpServerResult): string | undefined {
  if (!result.isError || result.structuredContent.ok) return undefined;
  return result.structuredContent.error.code;
}

function isAuthenticationFailure(result: T3LayerMcpServerResult): boolean {
  const code = resultErrorCode(result);
  return (
    code === "authentication_failed" ||
    code === "auth_invalid" ||
    code === "auth_expired"
  );
}

export function createT3LayerMcpService(
  options: T3LayerMcpServiceOptions = {},
) {
  const config = options.config ?? readT3LayerMcpConfig();
  const createRuntime =
    options.createRuntime ??
    ((input: RuntimeFactoryInput) => createStockT3NativeRuntime(input));
  const createMcpFacade =
    options.createMcpFacade ??
    ((runtime: T3LayerMcpRuntime) => {
      const facade = createStockT3Facade(runtime);
      return createStockT3McpFacade(facade);
    });
  const commandRunner = options.runCommand ?? runCommand;
  let bearerToken: string | undefined;
  let unavailableReason:
    | "token_mint_failed"
    | "descriptor_probe_failed"
    | undefined;
  let runtimeSlot: RuntimeSlot | undefined;
  let mcpFacade: T3LayerMcpAdapter | undefined;
  let initializePromise: Promise<void> | undefined;
  let recreatePromise: Promise<boolean> | undefined;
  let recreateRemints = false;

  const newRuntime = (token: string | undefined) =>
    createRuntime({
      baseUrl: config.baseUrl,
      ...(token === undefined ? {} : { bearerToken: token }),
      connectionProfile: config.connectionProfile,
    });

  const mint = () =>
    mintSubscriptionToken({
      appBin: config.appBin,
      serverBin: config.serverBin,
      baseDir: config.baseDir,
      runCommand: commandRunner,
    });

  async function probeCurrentRuntime(): Promise<void> {
    await runtimeSlot!.current().client.getDescriptor({
      deadlineMs: Date.now() + DESCRIPTOR_PROBE_TIMEOUT_MS,
    });
  }

  async function initializeOnce(): Promise<void> {
    try {
      bearerToken = await mint();
    } catch {
      bearerToken = undefined;
      unavailableReason = "token_mint_failed";
    }
    runtimeSlot = createRuntimeSlot(newRuntime(bearerToken));
    mcpFacade = createMcpFacade(runtimeSlot.proxy);
    if (bearerToken === undefined) return;
    try {
      await probeCurrentRuntime();
      unavailableReason = undefined;
    } catch {
      unavailableReason = "descriptor_probe_failed";
    }
  }

  async function recreate(remint: boolean): Promise<boolean> {
    const pending = recreatePromise;
    if (pending !== undefined) {
      if (!remint || recreateRemints) return pending;
      try {
        await pending;
      } catch {
        // Authentication recovery still needs a remint after a failed
        // environment-only recreation.
      }
      return recreate(true);
    }
    recreateRemints = remint;
    const operation = (async () => {
      let replacementToken = bearerToken;
      if (remint || replacementToken === undefined) {
        try {
          replacementToken = await mint();
        } catch {
          unavailableReason = "token_mint_failed";
          return false;
        }
      }
      runtimeSlot!.replace(() => newRuntime(replacementToken));
      bearerToken = replacementToken;
      try {
        await probeCurrentRuntime();
        unavailableReason = undefined;
        return true;
      } catch {
        unavailableReason = "descriptor_probe_failed";
        return false;
      }
    })();
    recreatePromise = operation;
    try {
      return await operation;
    } finally {
      if (recreatePromise === operation) {
        recreatePromise = undefined;
        recreateRemints = false;
      }
    }
  }

  function initializedFacade(): T3LayerMcpAdapter {
    if (mcpFacade === undefined)
      throw new Error("T3Layer MCP service is not initialized");
    return mcpFacade;
  }

  return Object.freeze({
    initialize(): Promise<void> {
      initializePromise ??= initializeOnce();
      return initializePromise;
    },
    listTools() {
      return initializedFacade().listTools();
    },
    async callTool(
      name: string,
      argumentsValue: unknown,
      context: StockT3McpCallContext = {},
    ): Promise<T3LayerMcpServerResult> {
      initializePromise ??= initializeOnce();
      await initializePromise;
      const facade = initializedFacade();
      if (unavailableReason !== undefined && !LOCAL_TOOL_NAMES.has(name)) {
        if (!(await recreate(true))) return appUnavailable(unavailableReason);
      }
      let result = await facade.callTool(name, argumentsValue, context);
      if (isAuthenticationFailure(result)) {
        if (!(await recreate(true))) return appUnavailable(unavailableReason!);
        result = await facade.callTool(name, argumentsValue, context);
      } else if (resultErrorCode(result) === "environment_changed") {
        if (!(await recreate(false))) return appUnavailable(unavailableReason!);
        result = await facade.callTool(name, argumentsValue, context);
      }
      return result;
    },
    close(): void {
      bearerToken = undefined;
      runtimeSlot?.close();
    },
  });
}

export function createT3LayerSdkServer(
  service: ReturnType<typeof createT3LayerMcpService>,
): Server {
  const server = new Server(
    { name: "t3layer", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...service.listTools()],
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) =>
      (await service.callTool(
        request.params.name,
        request.params.arguments ?? {},
        { signal: extra.signal },
      )) as unknown as CallToolResult,
  );
  return server;
}

export async function startT3LayerMcpServer(
  options: T3LayerMcpServiceOptions = {},
): Promise<{
  readonly server: Server;
  readonly service: ReturnType<typeof createT3LayerMcpService>;
}> {
  const service = createT3LayerMcpService(options);
  await service.initialize();
  const server = createT3LayerSdkServer(service);
  await server.connect(new StdioServerTransport());
  return { server, service };
}

if (import.meta.main) {
  void startT3LayerMcpServer().catch(() => {
    process.stderr.write("T3Layer MCP stdio transport failed to start\n");
    process.exitCode = 1;
  });
}
