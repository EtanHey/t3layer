import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const process = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

async function fixtureRepo(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "t3layer-stock-gate."));
  roots.push(root);
  await run(["git", "init", "-q"], root);
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(root, path), content);
  }
  await run(["git", "add", "."], root);
  return root;
}

describe("stock-only gate", () => {
  test("passes a clean tracked candidate when optional scripts is absent", async () => {
    const root = await fixtureRepo({
      "package.json": "{}\n",
      "src/index.ts": "export const transport = 'stock-http-v1';\n",
      "README.md": "stock HTTP\n",
      "historical.test.ts": "historical evidence\n",
    });
    const historical = join(root, "historical.test.ts");
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(historical).arrayBuffer()).digest("hex");
    const result = await run(
      ["bash", join(import.meta.dir, "../scripts/check-stock-only.sh")],
      root,
      { STOCK_ONLY_HISTORICAL_PATH: historical, STOCK_ONLY_HISTORICAL_SHA256: digest },
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("STOCK_ONLY_CHECK: PASS");
  });

  test("fails on an injected tracked private reference", async () => {
    const forbidden = ["@t3tools", "runtime-client"].join("/");
    const root = await fixtureRepo({
      "package.json": "{}\n",
      "src/index.ts": `export const forbidden = ${JSON.stringify(forbidden)};\n`,
      "historical.test.ts": "historical evidence\n",
    });
    const historical = join(root, "historical.test.ts");
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(historical).arrayBuffer()).digest("hex");
    const result = await run(
      ["bash", join(import.meta.dir, "../scripts/check-stock-only.sh")],
      root,
      { STOCK_ONLY_HISTORICAL_PATH: historical, STOCK_ONLY_HISTORICAL_SHA256: digest },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("forbidden candidate reference");
  });

  test("fails on an injected untracked private reference in the intended artifact set", async () => {
    const forbidden = ["@t3tools", "runtime-client"].join("/");
    const root = await fixtureRepo({
      "package.json": "{}\n",
      "historical.test.ts": "historical evidence\n",
    });
    await Bun.write(join(root, "src/untracked.ts"), `export const forbidden = ${JSON.stringify(forbidden)};\n`);
    const historical = join(root, "historical.test.ts");
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(historical).arrayBuffer()).digest("hex");
    const result = await run(
      ["bash", join(import.meta.dir, "../scripts/check-stock-only.sh")],
      root,
      { STOCK_ONLY_HISTORICAL_PATH: historical, STOCK_ONLY_HISTORICAL_SHA256: digest },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("forbidden candidate reference");
  });

  test("fails when the protected historical SHA-256 does not match", async () => {
    const root = await fixtureRepo({
      "package.json": "{}\n",
      "historical.test.ts": "historical evidence\n",
    });
    const historical = join(root, "historical.test.ts");
    const result = await run(
      ["bash", join(import.meta.dir, "../scripts/check-stock-only.sh")],
      root,
      { STOCK_ONLY_HISTORICAL_PATH: historical, STOCK_ONLY_HISTORICAL_SHA256: "0".repeat(64) },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("historical evidence SHA-256 mismatch");
  });
});
