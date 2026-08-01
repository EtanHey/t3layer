import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const exactTree = Bun.env.T3_STOCK_EXACT_TREE;
const exactToolchain = Bun.env.T3_STOCK_EXACT_TOOLCHAIN;

describe("exact-stock characterization driver", () => {
  test("pins the adopted SHA, generates only inside the worktree, and invokes the literal stock runner", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../scripts/stock-t3-exact-characterization.sh"),
    ).text();
    expect(source).toContain("d3037064e61a9f059eafbd4f9869679779bd2a7c");
    expect(source).toContain(
      "corepack pnpm --filter t3 exec vp test run src/orchestration/Layers/T3LayerStockProjectionCharacterization.generated.test.ts",
    );
    expect(source).toContain("trap cleanup EXIT INT TERM");
    expect(source).toContain('rm -f -- "$generated_path"');
    expect(source).toContain('if [[ -e "$generated_path" ]]');
    expect(source).toContain("generated characterization path already exists");
  });

  test.skipIf(exactTree === undefined || exactToolchain === undefined)(
    "executes the generated fixture at the pinned stock SHA (set T3_STOCK_EXACT_TREE and T3_STOCK_EXACT_TOOLCHAIN)",
    async () => {
      const child = Bun.spawn(
        ["bash", "scripts/stock-t3-exact-characterization.sh", exactTree!],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...Bun.env,
            PATH: `${exactToolchain}:${Bun.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    },
    120_000,
  );
});
