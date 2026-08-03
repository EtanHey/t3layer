import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  StockRuntimeError,
  createStockT3NativeRuntime,
  type CreateReconciliationPending,
  type RuntimeModelSelection,
  type StockSpawnInput,
  type StockT3NativeRuntimeOptions,
  type StockT3RuntimeClient,
} from "../src/nativeRuntime";
import { StockT3HttpError } from "../src/stockT3HttpClient";
import { createStockT3Facade } from "../src/facade";
import { createStockT3McpFacade } from "../src/mcp";

const iso = "2026-08-03T12:00:00.000Z";
const validCodexSlugs = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
] as const;
const invalidSelection = { instanceId: "codex", model: "gpt-5-codex" } as const;

function spawnInput(modelSelection: RuntimeModelSelection = invalidSelection): StockSpawnInput {
  return {
    workspaceRoot: "/tmp/model-pin-project",
    title: "model-pin-worker",
    message: "prove the selected model is installed",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };
}

function countingClient() {
  let httpCalls = 0;
  let dispatchCalls = 0;
  const client: StockT3RuntimeClient = {
    getDescriptor: async () => {
      httpCalls += 1;
      return {
        environmentId: "env-model-pin",
        label: "local",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "stock",
        capabilities: { repositoryIdentity: false },
      };
    },
    getShell: async () => {
      httpCalls += 1;
      return {
        snapshotSequence: 1,
        projects: [{
          id: "project-model-pin",
          title: "model-pin-project",
          workspaceRoot: "/tmp/model-pin-project",
          defaultModelSelection: invalidSelection,
          createdAt: iso,
          updatedAt: iso,
        }],
        threads: [],
        updatedAt: iso,
      };
    },
    getThread: async () => {
      httpCalls += 1;
      return undefined;
    },
    dispatch: async () => {
      httpCalls += 1;
      dispatchCalls += 1;
      throw new StockT3HttpError("command_rejected", 400);
    },
  };
  return {
    client,
    counts: () => ({ httpCalls, dispatchCalls }),
  };
}

function runtimeWithCache(
  client: StockT3RuntimeClient,
  modelCacheDirectory: string,
) {
  return createStockT3NativeRuntime({
    client,
    modelCacheDirectory,
  } as StockT3NativeRuntimeOptions);
}

function temporaryCacheDirectory(): string {
  return mkdtempSync(join(tmpdir(), "t3layer-model-pin-"));
}

function writeCache(directory: string, instanceId: string, slugs: readonly string[]): void {
  writeFileSync(join(directory, `${instanceId}.json`), JSON.stringify({
    instanceId,
    models: slugs.map((slug) => ({ slug })),
  }));
}

describe("model pin guard", () => {
  test("refuses the field-case gpt-5-codex slug before dispatch and names valid Codex slugs", async () => {
    const cacheDirectory = temporaryCacheDirectory();
    writeCache(cacheDirectory, "codex", validCodexSlugs);
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, cacheDirectory);

    const caught = await runtime.spawn(spawnInput()).catch((error) => error);

    expect(counting.counts().dispatchCalls).toBe(0);
    expect(counting.counts().httpCalls).toBe(0);
    expect(caught).toBeInstanceOf(StockRuntimeError);
    expect(caught).toMatchObject({
      code: "model_unavailable",
      evidence: {
        reason: "model_slug_unavailable",
        instanceId: "codex",
        model: "gpt-5-codex",
        validSlugs: validCodexSlugs,
      },
    });
    runtime.close();
    rmSync(cacheDirectory, { recursive: true });
  });

  test("refuses an unavailable model before resume reconciliation performs HTTP", async () => {
    const cacheDirectory = temporaryCacheDirectory();
    writeCache(cacheDirectory, "codex", ["gpt-5.6-sol"]);
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, cacheDirectory);
    const pending: CreateReconciliationPending = {
      kind: "create_reconciliation_pending",
      provisionalRef: { environmentId: "env-model-pin", threadId: "thread-model-pin" },
      createAttempt: {
        commandId: "create-model-pin",
        threadId: "thread-model-pin",
        projectId: "project-model-pin",
        acceptedSequence: 1,
        dispatchState: "accepted",
        retryState: "not_applicable",
        retryError: null,
      },
      reconciliation: {
        reason: "projection_pending",
        projectionState: "unobserved",
        highestShellSequence: null,
        highestDetailSequence: null,
        deadlineMs: 10_000,
        evidence: [],
      },
      initialTurnContinuation: {
        commandId: "turn-model-pin",
        messageId: "message-model-pin",
        inputDigest: "not-reached-before-model-validation",
      },
      safeAction: "resume_create_reconciliation",
    };

    const caught = await runtime.resumeCreateReconciliation(
      pending,
      spawnInput(),
    ).catch((error) => error);

    expect(caught).toMatchObject({
      code: "model_unavailable",
      evidence: {
        reason: "model_slug_unavailable",
        instanceId: "codex",
        model: "gpt-5-codex",
        validSlugs: ["gpt-5.6-sol"],
      },
    });
    expect(counting.counts()).toEqual({ httpCalls: 0, dispatchCalls: 0 });
    runtime.close();
    rmSync(cacheDirectory, { recursive: true });
  });

  test("allows the installed gpt-5.6-sol slug to reach dispatch unchanged", async () => {
    const cacheDirectory = temporaryCacheDirectory();
    writeCache(cacheDirectory, "codex", ["gpt-5.6-sol"]);
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, cacheDirectory);

    const caught = await runtime.spawn(
      spawnInput({ instanceId: "codex", model: "gpt-5.6-sol" }),
    ).catch((error) => error);

    expect(counting.counts().dispatchCalls).toBe(1);
    expect(caught).toMatchObject({ code: "command_rejected" });
    runtime.close();
    rmSync(cacheDirectory, { recursive: true });
  });

  test("fails closed for an unknown instanceId before HTTP", async () => {
    const cacheDirectory = temporaryCacheDirectory();
    writeCache(cacheDirectory, "codex", ["gpt-5.6-sol"]);
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, cacheDirectory);

    const caught = await runtime.spawn(spawnInput({
      instanceId: "not-installed",
      model: "gpt-5.6-sol",
    })).catch((error) => error);

    expect(caught).toMatchObject({
      code: "model_unavailable",
      evidence: {
        reason: "model_instance_unknown",
        instanceId: "not-installed",
        model: "gpt-5.6-sol",
        validSlugs: [],
      },
    });
    expect(counting.counts()).toEqual({ httpCalls: 0, dispatchCalls: 0 });
    runtime.close();
    rmSync(cacheDirectory, { recursive: true });
  });

  test("fails closed when the cache directory is missing before HTTP", async () => {
    const parent = temporaryCacheDirectory();
    const missingCacheDirectory = join(parent, "missing-caches");
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, missingCacheDirectory);

    const caught = await runtime.spawn(spawnInput()).catch((error) => error);

    expect(caught).toMatchObject({
      code: "model_unavailable",
      evidence: {
        reason: "model_cache_missing",
        instanceId: "codex",
        model: "gpt-5-codex",
        validSlugs: [],
      },
    });
    expect(counting.counts()).toEqual({ httpCalls: 0, dispatchCalls: 0 });
    runtime.close();
    rmSync(parent, { recursive: true });
  });

  test("fails closed when an enumerated instance cache file is missing before HTTP", async () => {
    const cacheDirectory = temporaryCacheDirectory();
    symlinkSync(join(cacheDirectory, "missing-codex.json"), join(cacheDirectory, "codex.json"));
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, cacheDirectory);

    const caught = await runtime.spawn(spawnInput()).catch((error) => error);

    expect(caught).toMatchObject({
      code: "model_unavailable",
      evidence: {
        reason: "model_cache_missing",
        instanceId: "codex",
        model: "gpt-5-codex",
        validSlugs: [],
      },
    });
    expect(counting.counts()).toEqual({ httpCalls: 0, dispatchCalls: 0 });
    runtime.close();
    rmSync(cacheDirectory, { recursive: true });
  });

  test("fails closed when the instance cache is unreadable before HTTP", async () => {
    const cacheDirectory = temporaryCacheDirectory();
    mkdirSync(join(cacheDirectory, "codex.json"));
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, cacheDirectory);

    const caught = await runtime.spawn(spawnInput()).catch((error) => error);

    expect(caught).toMatchObject({
      code: "model_unavailable",
      evidence: {
        reason: "model_cache_unreadable",
        instanceId: "codex",
        model: "gpt-5-codex",
        validSlugs: [],
      },
    });
    expect(counting.counts()).toEqual({ httpCalls: 0, dispatchCalls: 0 });
    runtime.close();
    rmSync(cacheDirectory, { recursive: true });
  });

  test("passes the direct typed model error through MCP verbatim with zero HTTP", async () => {
    const cacheDirectory = temporaryCacheDirectory();
    writeCache(cacheDirectory, "codex", ["gpt-5.6-sol", "gpt-5.6-terra"]);
    const counting = countingClient();
    const runtime = runtimeWithCache(counting.client, cacheDirectory);
    const mcp = createStockT3McpFacade(createStockT3Facade(runtime));

    const result = await mcp.callTool("spawn", { input: spawnInput() });

    expect(result.structuredContent).toEqual({
      ok: false,
      error: {
        type: "stock_runtime",
        code: "model_unavailable",
        evidence: {
          reason: "model_slug_unavailable",
          instanceId: "codex",
          model: "gpt-5-codex",
          validSlugs: ["gpt-5.6-sol", "gpt-5.6-terra"],
        },
      },
    });
    expect(counting.counts()).toEqual({ httpCalls: 0, dispatchCalls: 0 });
    runtime.close();
    rmSync(cacheDirectory, { recursive: true });
  });
});
