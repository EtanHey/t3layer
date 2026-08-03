import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MCP_TOOL_NAMES, type StockT3McpToolResult } from "../src/mcp";
import {
  T3LAYER_APP_REQUIRED_TOOL_NAMES,
  T3LAYER_LOCAL_TOOL_NAMES,
  createT3LayerSdkServer,
  createT3LayerMcpService,
  mintSubscriptionToken,
  readT3LayerMcpConfig,
  runCommand,
  type CommandRunner,
  type T3LayerMcpAdapter,
  type T3LayerMcpRuntime,
  type T3LayerMcpServerResult,
} from "../scripts/t3layer-mcp-server";

const toolDefinitions = MCP_TOOL_NAMES.map((name) => ({
  name,
  description: `test definition for ${name}`,
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false as const,
  },
}));

function success(value: unknown): StockT3McpToolResult {
  const payload = { ok: true as const, value };
  return {
    isError: false,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function stockFailure(code: string): StockT3McpToolResult {
  const payload = {
    ok: false as const,
    error: { type: "stock_runtime" as const, code, evidence: {} },
  };
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function runnerReturning(...tokens: string[]): CommandRunner {
  let index = 0;
  return async () => ({
    exitCode: 0,
    stdout: `${tokens[index++] ?? tokens.at(-1)}\n`,
  });
}

function runtime(
  options: {
    readonly descriptorProbe?: () => Promise<unknown>;
    readonly close?: () => void;
  } = {},
): T3LayerMcpRuntime {
  return {
    client: {
      getDescriptor:
        options.descriptorProbe ??
        (async () => ({ environmentId: "environment-1" })),
    },
    close: options.close ?? (() => {}),
  } as unknown as T3LayerMcpRuntime;
}

function adapter(callTool: T3LayerMcpAdapter["callTool"]): T3LayerMcpAdapter {
  return {
    listTools: () => toolDefinitions,
    callTool,
  };
}

function expectUnavailable(
  result: T3LayerMcpServerResult,
  reason: "token_mint_failed" | "descriptor_probe_failed",
): void {
  expect(result).toEqual({
    isError: true,
    structuredContent: {
      ok: false,
      error: {
        type: "mcp_server",
        code: "t3_app_unavailable",
        evidence: { reason },
      },
    },
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            type: "mcp_server",
            code: "t3_app_unavailable",
            evidence: { reason },
          },
        }),
      },
    ],
  });
}

describe("T3Layer stdio MCP service", () => {
  test("classifies every MCP tool explicitly for bootstrap availability", () => {
    expect([...T3LAYER_LOCAL_TOOL_NAMES]).toEqual([
      "listChildren",
      "listWorkers",
    ]);
    expect(
      new Set([
        ...T3LAYER_LOCAL_TOOL_NAMES,
        ...T3LAYER_APP_REQUIRED_TOOL_NAMES,
      ]),
    ).toEqual(new Set(MCP_TOOL_NAMES));
    expect(
      T3LAYER_LOCAL_TOOL_NAMES.filter((name) =>
        (T3LAYER_APP_REQUIRED_TOOL_NAMES as readonly string[]).includes(name),
      ),
    ).toEqual([]);
  });

  test("uses documented defaults and derives the server CLI beside an overridden app binary", () => {
    expect(readT3LayerMcpConfig({}, "/Users/tester")).toEqual({
      appBin:
        "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
      baseDir: "/Users/tester/.t3",
      baseUrl: "http://127.0.0.1:3773",
      connectionProfile: "local",
      serverBin:
        "/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    });

    expect(
      readT3LayerMcpConfig(
        {
          T3LAYER_APP_BIN:
            "/Applications/T3 Code Nightly.app/Contents/MacOS/T3 Code Nightly",
          T3LAYER_BASE_URL: "http://127.0.0.1:4773",
          T3LAYER_CONNECTION_PROFILE: "tunnel",
        },
        "/Users/tester",
      ),
    ).toEqual({
      appBin:
        "/Applications/T3 Code Nightly.app/Contents/MacOS/T3 Code Nightly",
      baseDir: "/Users/tester/.t3",
      baseUrl: "http://127.0.0.1:4773",
      connectionProfile: "tunnel",
      serverBin:
        "/Applications/T3 Code Nightly.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    });
  });

  test("mints a subscription token through the injected command seam without a shell", async () => {
    const invocations: Parameters<CommandRunner>[0][] = [];
    const runCommand: CommandRunner = async (invocation) => {
      invocations.push(invocation);
      return { exitCode: 0, stdout: "memory-only-token\n" };
    };
    const appBin =
      "/Applications/T3 Code Nightly.app/Contents/MacOS/T3 Code Nightly";
    const serverBin =
      "/Applications/T3 Code Nightly.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";

    expect(
      await mintSubscriptionToken({
        appBin,
        baseDir: "/Users/tester/.t3",
        runCommand,
        serverBin,
      }),
    ).toBe("memory-only-token");
    expect(invocations).toEqual([
      {
        command: appBin,
        args: [
          serverBin,
          "auth",
          "session",
          "issue",
          "--base-dir",
          "/Users/tester/.t3",
          "--ttl",
          "12h",
          "--label",
          "t3layer-mcp",
          "--subject",
          "t3layer-mcp",
          "--token-only",
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        timeoutMs: 10_000,
      },
    ]);
  });

  test("force-kills a mint command and closes stdout held by a descendant", async () => {
    const startedAt = Date.now();
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        'const grandchild = \'process.stdout.on("error", () => process.exit(0)); setInterval(() => process.stdout.write("."), 50); setTimeout(() => process.exit(0), 30_000);\'; Bun.spawn([process.execPath, "-e", grandchild], { stdin: "ignore", stdout: "inherit", stderr: "ignore" }); process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
      ],
      env: {},
      timeoutMs: 25,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.startsWith("ready\n")).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  test("lists the exact MCP tool surface and passes calls through verbatim", async () => {
    const calls: unknown[][] = [];
    const typedFailure = stockFailure("identity_conflict");
    let adapterCreations = 0;
    const service = createT3LayerMcpService({
      createMcpFacade: () => {
        adapterCreations += 1;
        return adapter(async (...args) => {
          calls.push(args);
          return typedFailure;
        });
      },
      createRuntime: () => runtime(),
      runCommand: runnerReturning("token-1"),
    });
    await service.initialize();
    const input = {
      ref: { environmentId: "environment-1", threadId: "thread-1" },
    };
    const controller = new AbortController();

    expect(service.listTools().map((tool) => tool.name)).toEqual([
      ...MCP_TOOL_NAMES,
    ]);
    expect(
      await service.callTool("observe", input, { signal: controller.signal }),
    ).toBe(typedFailure);
    expect(calls).toEqual([["observe", input, { signal: controller.signal }]]);
    expect(adapterCreations).toBe(1);
  });

  test("does not rewrite a live facade transport failure", async () => {
    const transportFailure = stockFailure("transport_unavailable");
    const service = createT3LayerMcpService({
      createMcpFacade: () => adapter(async () => transportFailure),
      createRuntime: () => runtime(),
      runCommand: runnerReturning("token-1"),
    });
    await service.initialize();

    expect(await service.callTool("observe", {})).toBe(transportFailure);
  });

  test("registers the exact facade over real SDK list and call handlers", async () => {
    const called = success({ source: "facade" });
    const calls: unknown[][] = [];
    const service = createT3LayerMcpService({
      createMcpFacade: () =>
        adapter(async (...args) => {
          calls.push(args);
          return called;
        }),
      createRuntime: () => runtime(),
      runCommand: runnerReturning("token-1"),
    });
    await service.initialize();
    const server = createT3LayerSdkServer(service);
    const client = new Client({ name: "t3layer-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        [...MCP_TOOL_NAMES],
      );
      const result = await client.callTool({
        name: "observe",
        arguments: { marker: "verbatim" },
      });
      expect(result.structuredContent).toEqual(called.structuredContent);
      expect(calls).toEqual([
        ["observe", { marker: "verbatim" }, expect.any(Object)],
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps local overlay tools available after failed mint while network tools return a server error", async () => {
    let mintAttempts = 0;
    const runtimeTokens: Array<string | undefined> = [];
    const listWorkersResult = success([]);
    const listChildrenResult = stockFailure("overlay_unknown");
    const adapterCalls: string[] = [];
    const service = createT3LayerMcpService({
      createMcpFacade: () =>
        adapter(async (name) => {
          adapterCalls.push(name);
          return name === "listWorkers"
            ? listWorkersResult
            : listChildrenResult;
        }),
      createRuntime: ({ bearerToken }) => {
        runtimeTokens.push(bearerToken);
        return runtime();
      },
      runCommand: async () => {
        mintAttempts += 1;
        throw new Error("sensitive mint failure");
      },
    });

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.listTools().map((tool) => tool.name)).toEqual([
      ...MCP_TOOL_NAMES,
    ]);
    expect(await service.callTool("listWorkers", {})).toBe(listWorkersResult);
    expect(
      await service.callTool("listChildren", {
        parentRef: { environmentId: "environment-1", threadId: "thread-1" },
      }),
    ).toBe(listChildrenResult);
    const unavailable = await service.callTool("observe", {});
    expectUnavailable(unavailable, "token_mint_failed");
    expect(adapterCalls).toEqual(["listWorkers", "listChildren"]);
    expect(mintAttempts).toBe(2);
    expect(runtimeTokens).toEqual([undefined]);
    expect(JSON.stringify(unavailable)).not.toContain("sensitive mint failure");
  });

  test("recovers in-process when mint fails at boot and succeeds on a later call", async () => {
    let mintAttempts = 0;
    let adapterCreations = 0;
    const runtimeTokens: Array<string | undefined> = [];
    const recovered = success("recovered");
    const service = createT3LayerMcpService({
      createMcpFacade: () => {
        adapterCreations += 1;
        return adapter(async () => recovered);
      },
      createRuntime: ({ bearerToken }) => {
        runtimeTokens.push(bearerToken);
        return runtime();
      },
      runCommand: async () => {
        mintAttempts += 1;
        if (mintAttempts === 1) throw new Error("app closed");
        return { exitCode: 0, stdout: "token-after-open\n" };
      },
    });
    await service.initialize();

    expect(await service.callTool("observe", {})).toBe(recovered);
    expect(mintAttempts).toBe(2);
    expect(runtimeTokens).toEqual([undefined, "token-after-open"]);
    expect(adapterCreations).toBe(1);
  });

  test("starts with tools when the boot descriptor probe fails", async () => {
    let runtimeCount = 0;
    let adapterCreations = 0;
    const service = createT3LayerMcpService({
      createMcpFacade: () => {
        adapterCreations += 1;
        return adapter(async () => success("must not run"));
      },
      createRuntime: () => {
        runtimeCount += 1;
        return runtime({
          descriptorProbe: async () => {
            throw new Error(
              "verbose descriptor response with memory-only-token",
            );
          },
        });
      },
      runCommand: runnerReturning("memory-only-token"),
    });

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.listTools().map((tool) => tool.name)).toEqual([
      ...MCP_TOOL_NAMES,
    ]);
    const result = await service.callTool("observe", {});
    expectUnavailable(result, "descriptor_probe_failed");
    expect(runtimeCount).toBe(2);
    expect(adapterCreations).toBe(1);
    expect(JSON.stringify(result)).not.toContain("memory-only-token");
  });

  test("recreates only the runtime once and retries one call after environment_changed", async () => {
    const closeCounts = [0, 0];
    const observedTokens: Array<string | undefined> = [];
    const recovered = success({ workers: [] });
    let callCount = 0;
    let adapterCreations = 0;
    const service = createT3LayerMcpService({
      createMcpFacade: () => {
        adapterCreations += 1;
        return adapter(async () => {
          callCount += 1;
          return callCount === 1
            ? stockFailure("environment_changed")
            : recovered;
        });
      },
      createRuntime: ({ bearerToken }) => {
        const index = observedTokens.length;
        observedTokens.push(bearerToken);
        return runtime({
          close: () => (closeCounts[index] = (closeCounts[index] ?? 0) + 1),
        });
      },
      runCommand: runnerReturning("token-1"),
    });
    await service.initialize();

    expect(await service.callTool("listWorkers", {})).toBe(recovered);
    expect(observedTokens).toEqual(["token-1", "token-1"]);
    expect(callCount).toBe(2);
    expect(closeCounts).toEqual([1, 0]);
    expect(adapterCreations).toBe(1);
  });

  test("surfaces a persistent environment_changed after exactly one runtime recreation", async () => {
    let runtimeCount = 0;
    let adapterCreations = 0;
    const persistent = stockFailure("environment_changed");
    const service = createT3LayerMcpService({
      createMcpFacade: () => {
        adapterCreations += 1;
        return adapter(async () => persistent);
      },
      createRuntime: () => {
        runtimeCount += 1;
        return runtime();
      },
      runCommand: runnerReturning("token-1"),
    });
    await service.initialize();

    expect(await service.callTool("listWorkers", {})).toBe(persistent);
    expect(runtimeCount).toBe(2);
    expect(adapterCreations).toBe(1);
  });

  test("preserves the current runtime when replacement construction throws", async () => {
    let runtimeCreations = 0;
    let closeCount = 0;
    let callCount = 0;
    const recovered = success("still-usable");
    const service = createT3LayerMcpService({
      createMcpFacade: () =>
        adapter(async () => {
          callCount += 1;
          return callCount === 1
            ? stockFailure("environment_changed")
            : recovered;
        }),
      createRuntime: () => {
        runtimeCreations += 1;
        if (runtimeCreations === 2) throw new Error("replacement failed");
        return runtime({ close: () => (closeCount += 1) });
      },
      runCommand: runnerReturning("token-1"),
    });
    await service.initialize();

    await expect(service.callTool("listWorkers", {})).rejects.toThrow(
      "replacement failed",
    );
    expect(closeCount).toBe(0);
    expect(await service.callTool("listWorkers", {})).toBe(recovered);
  });

  test("serializes an auth re-mint behind an in-flight environment recreation", async () => {
    let releaseEnvironmentProbe: (() => void) | undefined;
    const environmentProbe = new Promise<void>((resolve) => {
      releaseEnvironmentProbe = resolve;
    });
    const runtimeTokens: Array<string | undefined> = [];
    const calls = new Map<string, number>();
    const recovered = success("recovered");
    const service = createT3LayerMcpService({
      createMcpFacade: () =>
        adapter(async (name) => {
          const count = (calls.get(name) ?? 0) + 1;
          calls.set(name, count);
          if (count > 1) return recovered;
          return stockFailure(
            name === "listWorkers"
              ? "environment_changed"
              : "authentication_failed",
          );
        }),
      createRuntime: ({ bearerToken }) => {
        runtimeTokens.push(bearerToken);
        const creation = runtimeTokens.length;
        return runtime({
          descriptorProbe:
            creation === 2 ? async () => environmentProbe : undefined,
        });
      },
      runCommand: runnerReturning("token-1", "token-2"),
    });
    await service.initialize();

    const environmentCall = service.callTool("listWorkers", {});
    while (runtimeTokens.length < 2) await Bun.sleep(1);
    const authCall = service.callTool("listChildren", {});
    releaseEnvironmentProbe!();

    expect(await environmentCall).toBe(recovered);
    expect(await authCall).toBe(recovered);
    expect(runtimeTokens).toEqual(["token-1", "token-1", "token-2"]);
  });

  test("re-mints and recreates only the runtime once on an authentication failure", async () => {
    const observedTokens: Array<string | undefined> = [];
    const recovered = success("ok");
    let callCount = 0;
    let adapterCreations = 0;
    const service = createT3LayerMcpService({
      createMcpFacade: () => {
        adapterCreations += 1;
        return adapter(async () => {
          callCount += 1;
          return callCount === 1
            ? stockFailure("authentication_failed")
            : recovered;
        });
      },
      createRuntime: ({ bearerToken }) => {
        observedTokens.push(bearerToken);
        return runtime();
      },
      runCommand: runnerReturning("token-1", "token-2"),
    });
    await service.initialize();

    expect(await service.callTool("listWorkers", {})).toBe(recovered);
    expect(observedTokens).toEqual(["token-1", "token-2"]);
    expect(adapterCreations).toBe(1);
  });
});
