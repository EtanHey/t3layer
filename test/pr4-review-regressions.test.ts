import { describe, expect, test } from "bun:test";

import {
  StockRuntimeError,
  canonicalizeWorkspaceRoot,
  parseProjectCreateIdentity,
  type SpawnResult,
  type StockSpawnInput,
  type ThreadCreateReceipt,
  type TurnReceipt,
} from "../src/facade";
import {
  createStockT3NativeRuntime,
  digestStockSpawnInput,
} from "../src/nativeRuntime";
import { createStockT3Facade } from "../src/facade";

const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const spawnInput: StockSpawnInput = {
  workspaceRoot: "/tmp/project",
  title: "worker",
  message: "start",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
};

describe("PR #4 review regressions", () => {
  test("project identity rejects cycles as a typed identity conflict", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    let error: unknown;
    try {
      parseProjectCreateIdentity({
        projectId: "project-1",
        commandId: "command-1",
        createdAt: "2026-07-31T18:00:00.000Z",
        workspaceRoot: "/tmp/project",
        title: "project",
        defaultModelSelection: { ...modelSelection, options: [cyclic] },
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(StockRuntimeError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: "identity_conflict" });
  });

  test("spawn digests omit undefined object fields but distinguish undefined array entries", async () => {
    const omitted = await digestStockSpawnInput(spawnInput);
    const explicitObjectUndefined = await digestStockSpawnInput({ ...spawnInput, projectId: undefined });
    const emptyOptions = await digestStockSpawnInput({
      ...spawnInput,
      modelSelection: { ...modelSelection, options: [] },
    });
    const undefinedOption = await digestStockSpawnInput({
      ...spawnInput,
      modelSelection: { ...modelSelection, options: [undefined] },
    });

    expect(explicitObjectUndefined).toBe(omitted);
    expect(undefinedOption).not.toBe(emptyOptions);
  });

  test("cross-platform workspace expansion requires an unambiguous absolute path", () => {
    expect(() => canonicalizeWorkspaceRoot("~/project", { platform: "windows" })).toThrow(
      StockRuntimeError,
    );
    expect(() => canonicalizeWorkspaceRoot("relative/project", { platform: "windows" })).toThrow(
      StockRuntimeError,
    );
    expect(canonicalizeWorkspaceRoot("C:\\work\\project", { platform: "windows" })).toBe(
      "C:\\work\\project",
    );
  });

  test("an unrelated invalid server workspace root is non-matching", async () => {
    const runtime = createStockT3NativeRuntime({
      client: {
        getDescriptor: async () => ({
          environmentId: "env-1",
          label: "fixture",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "stock",
          capabilities: { repositoryIdentity: false },
        }),
        getShell: async () => ({
          snapshotSequence: 1,
          projects: [
            {
              id: "blank-root",
              title: "unrelated",
              workspaceRoot: " ",
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: "2026-07-31T18:00:00.000Z",
              updatedAt: "2026-07-31T18:00:00.000Z",
            },
            {
              id: "relative-root",
              title: "unrelated",
              workspaceRoot: "relative/project",
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: "2026-07-31T18:00:00.000Z",
              updatedAt: "2026-07-31T18:00:00.000Z",
            },
          ],
          threads: [],
          updatedAt: "2026-07-31T18:00:00.000Z",
        }),
        getThread: async () => undefined,
        dispatch: async () => {
          throw new Error("dispatch must not run");
        },
      },
    });

    await expect(runtime.spawn({ ...spawnInput, workspaceRoot: "relative/project" })).rejects.toMatchObject({
      code: "identity_conflict",
      evidence: { reason: "project_create_identity_required" },
    });
    runtime.close();
  });

  test("unknown client defects are not mislabeled as transport failures", async () => {
    const runtime = createStockT3NativeRuntime({
      client: {
        getDescriptor: async () => {
          throw new TypeError("fixture decoder defect");
        },
        getShell: async () => {
          throw new Error("unused");
        },
        getThread: async () => undefined,
        dispatch: async () => ({ sequence: 1 }),
      },
    });

    await expect(runtime.spawn(spawnInput)).rejects.toMatchObject({
      code: "internal_error",
      evidence: { errorName: "TypeError" },
    });
    runtime.close();
  });

  test("facade exports result types and forwards metrics plus teardown", () => {
    const _compileOnly: [SpawnResult?, ThreadCreateReceipt?, TurnReceipt?] = [];
    expect(_compileOnly).toEqual([]);
    const runtime = createStockT3NativeRuntime({
      client: {
        getDescriptor: async () => {
          throw new Error("unused");
        },
        getShell: async () => {
          throw new Error("unused");
        },
        getThread: async () => undefined,
        dispatch: async () => ({ sequence: 1 }),
        observations: () => ({
          requestCount: 4,
          inFlight: 0,
          peakInFlight: 2,
          endpointStatusTrace: [],
        }),
      },
    });
    const facade = createStockT3Facade(runtime);

    expect(facade.pollMetrics()).toMatchObject({ activeWaits: 0 });
    expect(facade.httpObservations()).toMatchObject({ requestCount: 4, peakInFlight: 2 });
    expect(() => facade.close()).not.toThrow();
  });
});
