import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exactTree = Bun.env.T3_STOCK_EXACT_TREE;
const exactToolchain = Bun.env.T3_STOCK_EXACT_TOOLCHAIN;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runAt(cwd: string, command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function exactDriverFixture(corepackBody: string) {
  const root = await mkdtemp(join(tmpdir(), "t3layer-exact-driver."));
  temporaryRoots.push(root);
  const stockTree = join(root, "stock");
  const layers = join(stockTree, "apps/server/src/orchestration/Layers");
  const fakeBin = join(root, "bin");
  await mkdir(layers, { recursive: true });
  await mkdir(fakeBin);
  await Bun.write(join(layers, ".gitkeep"), "");
  for (const command of [
    ["/usr/bin/git", "init", "-q", stockTree],
    ["/usr/bin/git", "-C", stockTree, "config", "user.email", "fixture@example.invalid"],
    ["/usr/bin/git", "-C", stockTree, "config", "user.name", "fixture"],
    ["/usr/bin/git", "-C", stockTree, "add", "."],
    ["/usr/bin/git", "-C", stockTree, "commit", "-q", "-m", "fixture"],
  ]) {
    const result = await runAt(root, command);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  const head = (await runAt(root, ["/usr/bin/git", "-C", stockTree, "rev-parse", "HEAD"]))
    .stdout.trim();
  const source = await Bun.file(
    join(import.meta.dir, "../scripts/stock-t3-exact-characterization.sh"),
  ).text();
  const driver = join(root, "exact-characterization.sh");
  await Bun.write(driver, source.replace(/expected_sha=[0-9a-f]{40}/, `expected_sha=${head}`));
  await chmod(driver, 0o700);
  const corepack = join(fakeBin, "corepack");
  await Bun.write(corepack, corepackBody);
  await chmod(corepack, 0o700);
  return {
    root,
    stockTree,
    driver,
    fakeBin,
    generated: join(
      layers,
      "T3LayerStockProjectionCharacterization.generated.test.ts",
    ),
  };
}

describe("exact-stock characterization driver", () => {
  test("pins the adopted SHA, generates only inside the worktree, and invokes the literal stock runner", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../scripts/stock-t3-exact-characterization.sh"),
    ).text();
    expect(source).toContain("d3037064e61a9f059eafbd4f9869679779bd2a7c");
    expect(source).toContain(
      "corepack pnpm --filter t3 exec vp test run src/orchestration/Layers/T3LayerStockProjectionCharacterization.generated.test.ts",
    );
    expect(source).toContain("trap cleanup EXIT");
    expect(source).toContain("trap 'handle_signal INT 130' INT");
    expect(source).toContain("trap 'handle_signal TERM 143' TERM");
    expect(source).toContain('rm -f -- "$generated_path"');
    expect(source).toContain('if [[ -e "$generated_path" ]]');
    expect(source).toContain("generated characterization path already exists");
    const shaCheck = source.indexOf('if [[ "$actual_sha" != "$expected_sha" ]]');
    const cleanCheck = source.indexOf("status --porcelain");
    const generatedCollisionCheck = source.indexOf('if [[ -e "$generated_path" ]]');
    expect(cleanCheck).toBeGreaterThan(shaCheck);
    expect(cleanCheck).toBeLessThan(generatedCollisionCheck);
    expect(source).toContain("exact stock worktree is not clean");
  });

  test("fails closed when git cannot verify worktree cleanliness", async () => {
    const fixture = await exactDriverFixture("#!/usr/bin/env bash\nexit 0\n");
    await rm(join(fixture.stockTree, ".git/index"));
    await mkdir(join(fixture.stockTree, ".git/index"));

    const result = await runAt(
      fixture.root,
      ["bash", fixture.driver, fixture.stockTree],
      { PATH: `${fixture.fakeBin}:${Bun.env.PATH ?? ""}` },
    );

    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(fixture.generated).exists()).toBe(false);
  });

  test("forwards TERM to the exact-stock runner and cleans the generated fixture", async () => {
    const fixture = await exactDriverFixture(
        "#!/usr/bin/env bash\n" +
        "set -euo pipefail\n" +
        "trap 'echo TERM > \"$T3_STOCK_TEST_RUNNER_SIGNAL\"; exit 143' TERM\n" +
        'printf \'%s\\n\' "$$" > "$T3_STOCK_TEST_RUNNER_PID"\n' +
        "while :; do sleep 0.05; done\n",
    );
    const runnerPidPath = join(fixture.root, "runner.pid");
    const runnerSignalPath = join(fixture.root, "runner.signal");
    const child = Bun.spawn(["bash", fixture.driver, fixture.stockTree], {
      cwd: fixture.root,
      env: {
        ...Bun.env,
        PATH: `${fixture.fakeBin}:${Bun.env.PATH ?? ""}`,
        T3_STOCK_TEST_RUNNER_PID: runnerPidPath,
        T3_STOCK_TEST_RUNNER_SIGNAL: runnerSignalPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await Bun.file(runnerPidPath).exists()) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await Bun.file(runnerPidPath).exists()).toBe(true);
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 750)),
    ]);
    if (outcome === null) {
      const runnerPid = Number((await Bun.file(runnerPidPath).text()).trim());
      try {
        process.kill(runnerPid, "SIGKILL");
      } catch {
        // The runner may have exited between the timeout and cleanup.
      }
      const parentStopped = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (!parentStopped) {
        child.kill("SIGKILL");
        await child.exited;
      }
      throw new Error("exact-stock driver did not forward TERM promptly");
    }

    expect(outcome.exitCode).toBe(143);
    expect(await Bun.file(runnerSignalPath).text()).toBe("TERM\n");
    expect(await Bun.file(fixture.generated).exists()).toBe(false);
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
