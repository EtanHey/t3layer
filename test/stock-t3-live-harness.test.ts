import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProofReceiptError,
  canonicalProofBody,
  canonicalProofEnvelopeJson,
  canonicalProofJson,
  proofChecksum,
  validateProofEnvelope,
  validateProofReceipt,
} from "../src/stockProof";

const isolatedGitEnv = {
  ...Bun.env,
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function gitCommand(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: isolatedGitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
function gitOutput(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: isolatedGitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
async function candidateFixture(unmerged = false) {
  const root = await mkdtemp(join(tmpdir(), "t3layer-harness-candidate-repo."));
  gitCommand(root, "init", "--quiet", "--initial-branch=main");
  await Bun.write(join(root, "candidate.txt"), "merged\n");
  gitCommand(root, "add", "candidate.txt");
  gitCommand(root, "-c", "user.name=T3Layer Test", "-c", "user.email=test@example.com", "commit", "--quiet", "--no-gpg-sign", "-m", "merged candidate");
  const mainSha = gitOutput(root, "rev-parse", "HEAD");
  gitCommand(root, "update-ref", "refs/remotes/origin/main", mainSha);
  if (unmerged) {
    gitCommand(root, "switch", "--quiet", "--create", "feature");
    await Bun.write(join(root, "candidate.txt"), "unmerged\n");
    gitCommand(root, "add", "candidate.txt");
    gitCommand(root, "-c", "user.name=T3Layer Test", "-c", "user.email=test@example.com", "commit", "--quiet", "--no-gpg-sign", "-m", "unmerged candidate");
  }
  return { root, headSha: gitOutput(root, "rev-parse", "HEAD") };
}

let defaultCandidateRepo = "";
let defaultCandidateSha = "";
let defaultCandidateRoot = "";
beforeAll(async () => {
  const fixture = await candidateFixture();
  defaultCandidateRepo = fixture.root;
  defaultCandidateSha = fixture.headSha;
  defaultCandidateRoot = fixture.root;
});
afterAll(async () => {
  await rm(defaultCandidateRoot, { recursive: true, force: true });
});

const candidateEnv = (expectedSha = defaultCandidateSha, repo = defaultCandidateRepo) => ({
  T3_STOCK_CANDIDATE_REPO: repo,
  T3_STOCK_CANDIDATE_SHA: expectedSha,
});

async function run(
  command: string[],
  env: Record<string, string> = {},
  unsetEnv: readonly string[] = [],
) {
  const harnessDefaults = command[1] === "scripts/stock-t3-live-harness.sh"
    ? candidateEnv()
    : {};
  const processEnv = { ...Bun.env, ...harnessDefaults, ...env } as Record<
    string,
    string | undefined
  >;
  for (const name of unsetEnv) delete processEnv[name];
  const process = Bun.spawn(command, {
    cwd: join(import.meta.dir, ".."),
    env: processEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function canaryFixture(prefix = "t3layer-canary.") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const log = join(root, "commands.log");
  const paths: Record<string, string> = {};
  for (const name of ["off", "canary", "promote", "prior", "readiness", "descriptor", "thread", "cancel"]) {
    const path = join(root, name);
    const output = name === "descriptor"
      ? `echo '{"environmentId":"env-canary","serverVersion":"stock"}'`
      : name === "thread"
        ? `echo '{"threadId":"existing-thread","readable":true}'`
        : name === "cancel"
          ? `printf '%s\\n' 'cancel' >> '${log}'\necho '{"cancelled":2,"replayed":0}'`
          : `printf '%s\\n' '${name}' >> '${log}'`;
    await Bun.write(path, `#!/usr/bin/env bash\nset -euo pipefail\n${output}\n`);
    await chmod(path, 0o700);
    paths[name] = path;
  }
  const artifact = join(root, "artifact");
  const config = join(root, "config.json");
  await Bun.write(artifact, "immutable artifact\n");
  await Bun.write(config, '{"schema":"stock-http-v1","acceleration":"off"}\n');
  const artifactDigest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(artifact).arrayBuffer())
    .digest("hex");
  const configDigest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(config).arrayBuffer())
    .digest("hex");
  return {
    root,
    log,
    receipt: join(root, "receipt.json"),
    paths,
    artifact,
    env: {
      T3_STOCK_ROUTE_OFF_COMMAND: paths.off!,
      T3_STOCK_ROUTE_CANARY_COMMAND: paths.canary!,
      T3_STOCK_ROUTE_PROMOTE_COMMAND: paths.promote!,
      T3_STOCK_ROUTE_PRIOR_CONFIG_COMMAND: paths.prior!,
      T3_STOCK_READINESS_COMMAND: paths.readiness!,
      T3_STOCK_DESCRIPTOR_COMMAND: paths.descriptor!,
      T3_STOCK_THREAD_READ_COMMAND: paths.thread!,
      T3_STOCK_CANCEL_WAITS_COMMAND: paths.cancel!,
      T3_STOCK_ARTIFACT_PATH: artifact,
      T3_STOCK_CONFIG_PATH: config,
      T3_STOCK_APPROVED_ARTIFACT_SHA256: artifactDigest,
      T3_STOCK_APPROVED_CONFIG_SHA256: configDigest,
      T3_STOCK_DRILL_RECEIPT_PATH: join(root, "receipt.json"),
    },
  };
}

describe("stock live harness lifecycle", () => {
  const completeBody = () => ({
    runId: "current-run",
    candidateSha: "a".repeat(40),
    stockSha: "d3037064e61a9f059eafbd4f9869679779bd2a7c",
    success: true as const,
    cleanBeforeBuild: true as const,
    artifactDigest: "b".repeat(64),
    privateResolution: false as const,
    provenance: {
      stockInstall: { command: "corepack pnpm install --frozen-lockfile", status: 0 },
      stockBuild: { command: "corepack pnpm --filter t3 build:bundle", status: 0 },
      candidateInstall: { command: "bun install --frozen-lockfile", status: 0 },
      exactCharacterization: {
        command: "corepack pnpm --filter t3 exec vp test run src/orchestration/Layers/T3LayerStockProjectionCharacterization.generated.test.ts",
        status: 0,
      },
      providerAuth: {
        mode: "subscription" as const,
        claudeExecutable: "/usr/local/bin/claude",
        claudeVersion: "2.1.220 (Claude Code)",
      },
      isolatedBasenames: ["stock-tree", "t3layer-clean", "server-home", "workspace"],
    },
    exactHttpNegative: {
      status: 500,
      shellStatus: 200,
      detailStatus: 404,
      code: "internal_error",
      reason: "orchestration_dispatch_failed",
      threadAbsent: true as const,
    },
    live: {
      environmentId: "environment-fixture",
      serverVersion: "0.1.0",
      endpointStatusTrace: [
        { method: "GET", path: "/.well-known/t3/environment", status: 200 },
        { method: "GET", path: "/api/orchestration/shell", status: 200 },
        { method: "GET", path: "/api/orchestration/shell", status: 200 },
        { method: "GET", path: "/api/orchestration/shell", status: 200 },
        { method: "GET", path: "/api/orchestration/threads/thread-id", status: 200 },
        { method: "GET", path: "/api/orchestration/threads/thread-id", status: 200 },
        { method: "POST", path: "/api/orchestration/dispatch", status: 200 },
        { method: "POST", path: "/api/orchestration/dispatch", status: 200 },
        { method: "POST", path: "/api/orchestration/dispatch", status: 200 },
      ],
      ids: {
        projectId: "project-id",
        threadId: "thread-id",
        createCommandId: "create-command-id",
        initialCommandId: "initial-command-id",
        initialMessageId: "initial-message-id",
        followupCommandId: "followup-command-id",
        followupMessageId: "followup-message-id",
      },
      sequences: { create: 1, initial: 2, followup: 3 },
      counters: { requests: 9, shellPolls: 3, detailPolls: 2, peakInFlight: 1 },
      terminalKinds: ["completed", "completed"],
      timestamps: { startedAt: "2026-07-31T00:00:00.000Z", completedAt: "2026-07-31T00:01:00.000Z" },
    },
    teardown: { pidStopped: true as const, worktreeRemoved: true as const, rootRemoved: true as const },
  });
  const expectedProof = (body: ReturnType<typeof completeBody>) => ({
    runId: body.runId,
    candidateSha: body.candidateSha,
    providerAuth: body.provenance.providerAuth,
  });

  test("arms cleanup immediately after the proof root is allocated", async () => {
    const source = await Bun.file(join(import.meta.dir, "../scripts/stock-t3-live-harness.sh")).text();
    const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
    const allocation = lines.findIndex((line) => line.startsWith("proof_root=$(mktemp -d"));
    expect(allocation).toBeGreaterThan(0);
    expect(lines[allocation + 1]).toBe("trap cleanup EXIT INT TERM");
    expect(source).toContain("set -euo pipefail");
    expect(source).not.toContain("pkill");
    expect(source).not.toContain("killall");
    expect(source).toContain('worktree list --porcelain');
    expect(source).toContain('current_cwd=$(/usr/sbin/lsof');
    expect(source).toContain('validate-provisional');
    expect(source).toContain('validate-envelope');
    expect(source).toContain("stat -f '%Lp'");
    expect(source).toContain('staging_bytes=$(sha256_file "$final_staging")');
    expect(source).toContain('if [[ ! -e "$proof_root" ]]');
    expect(source).not.toContain('--header "Authorization: Bearer $http_token"');
    expect(source).toContain('--header @-');
  });

  test("declares fault seams across setup, live execution, and atomic finalization", async () => {
    const source = await Bun.file(join(import.meta.dir, "../scripts/stock-t3-live-harness.sh")).text();
    for (const seam of [
      "after-proof-root", "after-worktree-add", "after-stock-install", "after-stock-build",
      "after-archive-extract", "after-candidate-install", "after-exact-characterization",
      "after-generated-fixture",
      "after-bearer-issue", "after-secret-read", "after-server-launch", "after-readiness",
      "after-http-negative", "after-live-test", "after-provisional-validation", "before-normal-exit",
      "before-final-body-validation", "after-final-body-validation", "after-final-rename",
    ]) expect(source).toContain(seam);
  });

  test("defaults to a verified Claude subscription without requiring or injecting a provider secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-token-subscription."));
    temporaryRoots.push(root);
    const bin = root;
    const claude = join(bin, "claude");
    const authLog = join(root, "claude-auth.log");
    const serverEnvLog = join(root, "server-env.log");
    const serverRunner = join(root, "server-runner");
    const target = join(root, "proof.json");
    await Bun.write(
      claude,
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> '${authLog}'\ncase "\${1:-}" in\n  auth) printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"private@example.com","orgId":"private-org-id","orgName":"Private Org","subscriptionType":"max"}' ;;\n  --version) printf '%s\\n' '2.1.220 (Claude Code)' ;;\n  *) exit 64 ;;\nesac\n`,
    );
    await chmod(claude, 0o700);
    await Bun.write(
      serverRunner,
      `#!/usr/bin/env bash\nset -euo pipefail\nfor name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CODE_EXECPATH CMUX_CLAUDE_WRAPPER_SHIM SHELLBOOK_REAL_CLAUDE; do\n  if [[ \${!name+x} == x ]]; then printf '%s\\n' "unexpected environment: $name" >&2; exit 41; fi\ndone\n[[ $(command -v claude) == "$2" ]]\nprintf '%s\\n' "$1|$2|$3" > '${serverEnvLog}'\n`,
    );
    await chmod(serverRunner, 0o700);

    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      ...candidateEnv(),
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
      ANTHROPIC_API_KEY: "ambient-api-key-do-not-log",
      ANTHROPIC_AUTH_TOKEN: "ambient-auth-token-do-not-log",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "nested-agent",
      CLAUDE_CODE_SESSION_ID: "nested-session",
      CLAUDE_PID: "123",
      CLAUDE_CODE_EXECPATH: "/tmp/nested-claude",
      CMUX_CLAUDE_WRAPPER_SHIM: "/tmp/cmux-shim",
      SHELLBOOK_REAL_CLAUDE: "/tmp/shellbook-claude",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_HARNESS_SERVER_RUNNER: serverRunner,
      T3_STOCK_PROOF_TARGET: target,
    }, ["T3_STOCK_PROVIDER_SECRET_REF"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(await Bun.file(authLog).text()).toBe("auth status\n--version\n");
    expect(await Bun.file(serverEnvLog).text()).toBe(`subscription|${claude}|2.1.220 (Claude Code)\n`);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    for (const redacted of [
      "ambient-api-key-do-not-log", "ambient-auth-token-do-not-log",
      "private@example.com", "private-org-id", "Private Org",
    ]) expect(combinedOutput).not.toContain(redacted);
    const receipt = await Bun.file(target).json();
    expect(receipt).toMatchObject({
      success: true,
      provenance: {
        providerAuth: {
          mode: "subscription",
          claudeExecutable: claude,
          claudeVersion: "2.1.220 (Claude Code)",
        },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("private@example.com");

  }, 20_000);

  for (const authCase of [
    {
      name: "API-key auth",
      body: "printf '%s\\n' '{\"loggedIn\":true,\"authMethod\":\"apiKey\",\"apiProvider\":\"firstParty\"}'",
      reason: "subscription_auth_method_api_key",
    },
    {
      name: "logged-out status",
      body: "printf '%s\\n' '{\"loggedIn\":false,\"authMethod\":\"none\"}'",
      reason: "subscription_not_authenticated",
    },
    {
      name: "unrecognized auth",
      body: "case \"${1:-}\" in auth) printf '%s\\n' '{\"loggedIn\":true,\"authMethod\":\"mystery\",\"apiProvider\":\"firstParty\"}' ;; --version) printf '%s\\n' '2.1.220 (Claude Code)' ;; esac",
      reason: "subscription_auth_method_unrecognized",
    },
    { name: "probe failure", body: "exit 73", reason: "auth_probe_failed" },
    { name: "malformed status", body: "printf '%s\\n' 'not-json'", reason: "auth_probe_invalid" },
    { name: "probe timeout", body: "sleep 30", reason: "auth_probe_timeout" },
    { name: "missing executable", body: null, reason: "claude_executable_not_found" },
  ] as const) {
    test(`fails closed before server launch for ${authCase.name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "t3layer-harness-no-subscription."));
      temporaryRoots.push(root);
      const claude = join(root, "claude");
      const target = join(root, "proof.json");
      const launchLog = join(root, "server-launched");
      const serverRunner = join(root, "server-runner");
      if (authCase.body !== null) {
        await Bun.write(claude, `#!/usr/bin/env bash\nset -euo pipefail\n${authCase.body}\n`);
        await chmod(claude, 0o700);
      }
      await Bun.write(
        serverRunner,
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' launched > '${launchLog}'\n`,
      );
      await chmod(serverRunner, 0o700);

      const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
        ...candidateEnv(),
        PATH: authCase.body === null ? "/usr/bin:/bin" : `${root}:${Bun.env.PATH ?? ""}`,
        T3_STOCK_HARNESS_TEST_MODE: "1",
        T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
        T3_STOCK_HARNESS_SERVER_RUNNER: serverRunner,
        T3_STOCK_PROOF_TARGET: target,
      }, [
        "T3_STOCK_PROVIDER_SECRET_REF", "T3_STOCK_CLAUDE_EXECUTABLE",
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      ]);

      expect(result.exitCode, authCase.name).not.toBe(0);
      expect(result.stderr, authCase.name).toContain("provider_auth_unavailable");
      expect(result.stderr, authCase.name).toContain(`reason=${authCase.reason}`);
      expect(result.stderr, authCase.name).not.toContain("cleanup root_removed=");
      expect(await Bun.file(launchLog).exists(), authCase.name).toBe(false);
      expect(await Bun.file(target).exists(), authCase.name).toBe(false);
    }, 10_000);
  }

  test("rejects a probed Claude override that differs from server PATH resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-claude-mismatch."));
    temporaryRoots.push(root);
    const binA = join(root, "bin-a");
    const binB = join(root, "bin-b");
    await mkdir(binA);
    await mkdir(binB);
    const claudeA = join(binA, "claude");
    const claudeB = join(binB, "claude");
    const probeLog = join(root, "probe.log");
    const launchLog = join(root, "server-launched");
    const serverRunner = join(root, "server-runner");
    const target = join(root, "proof.json");
    for (const path of [claudeA, claudeB]) {
      await Bun.write(
        path,
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$0 $*" >> '${probeLog}'\nprintf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'\n`,
      );
      await chmod(path, 0o700);
    }
    await Bun.write(serverRunner, `#!/usr/bin/env bash\nprintf '%s\\n' launched > '${launchLog}'\n`);
    await chmod(serverRunner, 0o700);

    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      ...candidateEnv(),
      PATH: `${binB}:${Bun.env.PATH ?? ""}`,
      T3_STOCK_CLAUDE_EXECUTABLE: claudeA,
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_HARNESS_SERVER_RUNNER: serverRunner,
      T3_STOCK_PROOF_TARGET: target,
    }, ["T3_STOCK_PROVIDER_SECRET_REF", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("provider_auth_unavailable");
    expect(result.stderr).toContain("reason=claude_executable_mismatch");
    expect(await Bun.file(probeLog).exists()).toBe(false);
    expect(await Bun.file(launchLog).exists()).toBe(false);
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("preserves the provider-secret override without probing subscription auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-secret-override."));
    temporaryRoots.push(root);
    const bin = root;
    const claude = join(bin, "claude");
    const authLog = join(root, "claude-auth.log");
    const serverEnvLog = join(root, "server-env.log");
    const serverRunner = join(root, "server-runner");
    const target = join(root, "proof.json");
    await Bun.write(
      claude,
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> '${authLog}'\nexit 99\n`,
    );
    await chmod(claude, 0o700);
    await Bun.write(
      serverRunner,
      `#!/usr/bin/env bash\nset -euo pipefail\n[[ \${ANTHROPIC_API_KEY+x} == x ]]\n[[ "$ANTHROPIC_API_KEY" == test-mode-redacted ]]\nfor name in ANTHROPIC_AUTH_TOKEN CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CODE_EXECPATH CMUX_CLAUDE_WRAPPER_SHIM SHELLBOOK_REAL_CLAUDE; do\n  [[ \${!name+x} != x ]]\ndone\nprintf '%s\\n' "$1" > '${serverEnvLog}'\n`,
    );
    await chmod(serverRunner, 0o700);

    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      ...candidateEnv(),
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
      ANTHROPIC_API_KEY: "ambient-api-key-do-not-log",
      ANTHROPIC_AUTH_TOKEN: "ambient-auth-token-do-not-log",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "nested-agent",
      CLAUDE_CODE_SESSION_ID: "nested-session",
      CLAUDE_PID: "123",
      CLAUDE_CODE_EXECPATH: "/tmp/nested-claude",
      CMUX_CLAUDE_WRAPPER_SHIM: "/tmp/cmux-shim",
      SHELLBOOK_REAL_CLAUDE: "/tmp/shellbook-claude",
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_HARNESS_SERVER_RUNNER: serverRunner,
      T3_STOCK_PROOF_TARGET: target,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(await Bun.file(authLog).exists()).toBe(false);
    const serverLaunched = await Bun.file(serverEnvLog).exists();
    expect(serverLaunched).toBe(true);
    if (serverLaunched) expect(await Bun.file(serverEnvLog).text()).toBe("secret_ref\n");
    expect(result.stderr).not.toContain("op://fixture/provider/key");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("test-mode-redacted");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("ambient-api-key-do-not-log");
    await expect(Bun.file(target).json()).resolves.toMatchObject({
      provenance: { providerAuth: { mode: "secret_ref" } },
    });
  }, 20_000);

  test("binds the archive to a caller SHA matching merged main and origin/main", async () => {
    const candidate = await candidateFixture();
    temporaryRoots.push(candidate.root);
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-candidate."));
    temporaryRoots.push(root);
    const target = join(root, "proof.json");
    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      ...candidateEnv(candidate.headSha, candidate.root),
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_PROOF_TARGET: target,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    await expect(Bun.file(target).json()).resolves.toMatchObject({ candidateSha: candidate.headSha });

    const source = await Bun.file(join(import.meta.dir, "../scripts/stock-t3-live-harness.sh")).text();
    expect(source).not.toContain("/Users/etanheyman/Gits/t3layer-stock-http-runtime");
  });

  test("rejects a caller SHA that does not match candidate HEAD", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-candidate-mismatch."));
    temporaryRoots.push(root);
    const target = join(root, "proof.json");
    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      ...candidateEnv("c".repeat(40)),
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_PROOF_TARGET: target,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("candidate_identity_mismatch");
    expect(result.stderr).toContain("reason=expected_sha_does_not_match_head");
    expect(result.stderr).not.toContain("cleanup root_removed=");
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("rejects a candidate HEAD that is not merged main and origin/main", async () => {
    const candidate = await candidateFixture(true);
    temporaryRoots.push(candidate.root);
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-candidate-unmerged."));
    temporaryRoots.push(root);
    const target = join(root, "proof.json");
    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      ...candidateEnv(candidate.headSha, candidate.root),
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_PROOF_TARGET: target,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("candidate_identity_unmerged");
    expect(result.stderr).toContain("reason=head_not_main_and_origin_main");
    expect(result.stderr).not.toContain("cleanup root_removed=");
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("fails closed before allocation when caller candidate identity is missing", async () => {
    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
    }, ["T3_STOCK_CANDIDATE_REPO", "T3_STOCK_CANDIDATE_SHA"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("candidate_identity_invalid");
    expect(result.stderr).not.toContain("op://fixture/provider/key");
    expect(result.stderr).not.toContain("cleanup root_removed=");
  });

  test("asserts both requested live sentinels in-process", async () => {
    const source = await Bun.file(join(import.meta.dir, "stock-t3-live.test.ts")).text();
    expect(source).toContain('expect(first.assistantContent.trim()).toBe("T3LAYER_STOCK_PROOF_OK")');
    expect(source).toContain('expect(second.assistantContent.trim()).toBe("T3LAYER_STOCK_PROOF_FOLLOWUP_OK")');
  });

  test("test-mode failure after allocation cleans the exact proof root", async () => {
    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_FAIL_AT: "after-proof-root",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("injected failure: after-proof-root");
    expect(result.stderr).toContain("cleanup root_removed=true");
    expect(result.stderr).not.toContain("op://fixture/provider/key");
  });

  test("canonicalizes a symlinked temp root before cleanup identity is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-canonical-root."));
    temporaryRoots.push(root);
    const realTemp = join(root, "real-temp");
    const linkedTemp = join(root, "linked-temp");
    const observedRootPath = join(root, "observed-root.txt");
    const childPidPath = join(root, "child.pid");
    const childStatePath = join(root, "child-state.txt");
    const commandRunner = join(root, "command-runner");
    await mkdir(realTemp);
    await symlink(realTemp, linkedTemp);
    await Bun.write(
      commandRunner,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == after-proof-root ]]; then
  proof_root=$2
  printf '%s\\n' "$proof_root" > '${observedRootPath}'
  (cd "$proof_root/workspace" && exec /bin/sleep 30) </dev/null >/dev/null 2>&1 &
  child_pid=$!
  printf '%s\\n' "$child_pid" > '${childPidPath}'
  child_cwd=''
  for _attempt in {1..20}; do
    child_cwd=$(/usr/sbin/lsof -a -p "$child_pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p')
    [[ -n "$child_cwd" ]] && break
    sleep 0.05
  done
  if [[ "$child_cwd" == "$proof_root/workspace" ]]; then
    /bin/kill -TERM "$child_pid"
    wait "$child_pid" 2>/dev/null || true
    printf '%s\\n' stopped > '${childStatePath}'
  else
    printf '%s\\n' orphaned > '${childStatePath}'
  fi
fi
`,
    );
    await chmod(commandRunner, 0o700);

    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      TMPDIR: linkedTemp,
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: commandRunner,
      T3_STOCK_FAIL_AT: "after-proof-root",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("injected failure: after-proof-root");
    expect(result.stderr).toContain("cleanup root_removed=true");
    const observedRoot = (await Bun.file(observedRootPath).text()).trim();
    const childPid = Number.parseInt((await Bun.file(childPidPath).text()).trim(), 10);
    const childState = (await Bun.file(childStatePath).text()).trim();
    const childWasLeftAlive = Bun.spawnSync(["/bin/kill", "-0", String(childPid)]).exitCode === 0;
    try {
      expect(childState).toBe("stopped");
      expect(childWasLeftAlive).toBe(false);
      expect(observedRoot).toStartWith(`${await realpath(realTemp)}/t3layer-stock-proof.`);
      expect(observedRoot).not.toStartWith(`${linkedTemp}/t3layer-stock-proof.`);
      expect(await Bun.file(observedRoot).exists()).toBe(false);
    } finally {
      if (childWasLeftAlive) Bun.spawnSync(["/bin/kill", "-TERM", String(childPid)]);
    }
  });

  test("all setup/live fault seams preserve secret redaction and clean the proof root", async () => {
    const seams = [
      "after-worktree-add", "after-stock-install", "after-stock-build", "after-archive-extract",
      "after-candidate-install", "after-exact-characterization", "after-bearer-issue",
      "after-secret-read", "after-server-launch", "after-readiness", "after-http-negative",
      "after-live-test", "after-provisional-validation", "before-normal-exit",
    ];
    for (const seam of seams) {
      const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
        T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
        T3_STOCK_HARNESS_TEST_MODE: "1",
        T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
        T3_STOCK_FAIL_AT: seam,
      });
      expect(result.exitCode, seam).not.toBe(0);
      expect(result.stderr, seam).toContain(`injected failure: ${seam}`);
      expect(result.stderr, seam).toContain("cleanup root_removed=true");
      expect(result.stderr, seam).not.toContain("op://fixture/provider/key");
    }
  }, 30_000);

  test("real-path command seam reaches finalization failures without a passing receipt", async () => {
    for (const seam of [
      "before-final-body-validation",
      "after-final-body-validation",
      "after-final-rename",
    ]) {
      const root = await mkdtemp(join(tmpdir(), "t3layer-harness-finalize."));
      temporaryRoots.push(root);
      const target = join(root, "proof.json");
      const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
        T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
        T3_STOCK_HARNESS_TEST_MODE: "1",
        T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
        T3_STOCK_PROOF_TARGET: target,
        T3_STOCK_FAIL_AT: seam,
      });
      expect(result.exitCode, seam).not.toBe(0);
      expect(await Bun.file(target).exists(), seam).toBe(false);
      expect(result.stderr, seam).not.toContain("op://fixture/provider/key");
    }
  });

  test("test-mode teardown publishes only after deleting its isolated proof root", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-success."));
    temporaryRoots.push(root);
    const target = join(root, "proof.json");
    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: "/usr/bin/true",
      T3_STOCK_PROOF_TARGET: target,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("cleanup root_removed=true");
    expect(result.stderr).not.toContain("op://fixture/provider/key");
    expect(await Bun.file(target).exists()).toBe(true);
    await expect(Bun.file(target).json()).resolves.toMatchObject({
      success: true,
      teardown: { pidStopped: true, worktreeRemoved: true, rootRemoved: true },
    });
  });

  test("test-mode teardown failure cannot exit zero or publish a receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-harness-teardown-failure."));
    temporaryRoots.push(root);
    const target = join(root, "proof.json");
    const rootRecord = join(root, "proof-root.txt");
    const runner = join(root, "runner");
    await Bun.write(
      runner,
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' "$2" > '${rootRecord}'\n`,
    );
    await chmod(runner, 0o700);
    const result = await run(["bash", "scripts/stock-t3-live-harness.sh"], {
      T3_STOCK_PROVIDER_SECRET_REF: "op://fixture/provider/key",
      T3_STOCK_HARNESS_TEST_MODE: "1",
      T3_STOCK_HARNESS_COMMAND_RUNNER: runner,
      T3_STOCK_FAIL_TEARDOWN_AT: "root",
      T3_STOCK_PROOF_TARGET: target,
    });
    const strandedRoot = await Bun.file(rootRecord).text();
    temporaryRoots.push(strandedRoot);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cleanup root_removed=false");
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("requires caller-held runId, candidateSha, and provider auth instead of trusting a stale path", async () => {
    const prior = canonicalProofBody({ ...completeBody(), runId: "prior-run" });
    expect(() =>
      validateProofReceipt(prior, {
        ...expectedProof(completeBody()),
        runId: "current-run",
        candidateSha: "b".repeat(40),
      }),
    ).toThrow(ProofReceiptError);
    expect(
      validateProofReceipt(prior, {
        ...expectedProof(completeBody()),
        runId: "prior-run",
      }),
    ).toEqual(prior);
  });

  test("requires every behavioral/provenance field and verifies canonical envelope bytes", async () => {
    const body = completeBody();
    expect(() => canonicalProofBody({ ...body, live: { ...body.live, endpointStatusTrace: [] } })).toThrow(ProofReceiptError);
    expect(() => canonicalProofBody({ ...body, provenance: undefined })).toThrow(ProofReceiptError);
    expect(() => canonicalProofBody({
      ...body,
      provenance: { ...body.provenance, providerAuth: undefined },
    })).toThrow(ProofReceiptError);
    expect(() => canonicalProofBody({ ...body, forgedTopLevel: true })).toThrow(ProofReceiptError);
    expect(() => canonicalProofJson({
      ...body,
      live: { ...body.live, unexpectedUndefined: undefined },
    })).toThrow(ProofReceiptError);
    const checksum = await proofChecksum(body);
    const envelope = { ...body, checksum };
    expect(await validateProofEnvelope(envelope, expectedProof(body))).toEqual(canonicalProofBody(body));
    const modeFlippedBody = {
      ...body,
      provenance: { ...body.provenance, providerAuth: { mode: "secret_ref" as const } },
    };
    await expect(validateProofEnvelope(
      { ...modeFlippedBody, checksum: await proofChecksum(modeFlippedBody) },
      expectedProof(body),
    )).rejects.toThrow(ProofReceiptError);
    expect(canonicalProofJson(body)).toEndWith("\n");
    await expect(validateProofEnvelope(
      { ...envelope, checksum: "0".repeat(64) },
      expectedProof(body),
    )).rejects.toThrow(ProofReceiptError);
  });

  test("rejects all 21 proof-forgery classes while accepting the valid control", () => {
    const body = completeBody();
    const expected = expectedProof(body);
    const withoutOneDispatch = body.live.endpointStatusTrace.filter(
      (_, index) => index !== body.live.endpointStatusTrace.length - 1,
    );
    const forgeries = [
      () => canonicalProofBody({ ...body, stockSha: "f".repeat(40) }),
      () => canonicalProofBody({
        ...body,
        provenance: {
          ...body.provenance,
          stockInstall: { command: "echo forged", status: 0 },
        },
      }),
      () => canonicalProofBody({
        ...body,
        provenance: {
          ...body.provenance,
          isolatedBasenames: ["t3layer-clean", "stock-tree", "server-home", "workspace"],
        },
      }),
      () => canonicalProofBody({
        ...body,
        live: {
          ...body.live,
          endpointStatusTrace: [body.live.endpointStatusTrace[0]],
          counters: { ...body.live.counters, requests: 1 },
        },
      }),
      () => canonicalProofBody({
        ...body,
        live: {
          ...body.live,
          endpointStatusTrace: withoutOneDispatch,
          counters: { ...body.live.counters, requests: withoutOneDispatch.length },
        },
      }),
      () => canonicalProofBody({
        ...body,
        live: { ...body.live, counters: { ...body.live.counters, shellPolls: 0 } },
      }),
      () => canonicalProofBody({
        ...body,
        live: { ...body.live, counters: { ...body.live.counters, shellPolls: 4 } },
      }),
      () => canonicalProofBody({
        ...body,
        live: { ...body.live, counters: { ...body.live.counters, requests: 8 } },
      }),
      () => canonicalProofBody({
        ...body,
        live: { ...body.live, counters: { ...body.live.counters, peakInFlight: 9 } },
      }),
      () => canonicalProofBody({
        ...body,
        live: {
          ...body.live,
          ids: { ...body.live.ids, followupMessageId: body.live.ids.initialMessageId },
        },
      }),
      () => canonicalProofBody({
        ...body,
        live: {
          ...body.live,
          endpointStatusTrace: body.live.endpointStatusTrace.map((entry, index) =>
            index === 0 ? { ...entry, path: "/private/orchestration" } : entry,
          ),
        },
      }),
      () => canonicalProofBody({ ...body, success: false }),
      () => canonicalProofBody({ ...body, cleanBeforeBuild: false }),
      () => canonicalProofBody({
        ...body,
        teardown: { ...body.teardown, rootRemoved: false },
      }),
      () => canonicalProofBody({
        ...body,
        live: { ...body.live, sequences: { create: 1, initial: 1, followup: 3 } },
      }),
      () => canonicalProofBody({
        ...body,
        live: { ...body.live, serverVersion: "op://fixture/provider/key" },
      }),
      () => canonicalProofBody({
        ...body,
        exactHttpNegative: { ...body.exactHttpNegative, status: 400 },
      }),
      () => validateProofReceipt(body, {
        ...expected,
        candidateSha: "f".repeat(40),
      }),
      () => validateProofReceipt({
        ...body,
        provenance: { ...body.provenance, providerAuth: { mode: "secret_ref" } },
      }, expected),
      () => validateProofReceipt({
        ...body,
        provenance: {
          ...body.provenance,
          providerAuth: {
            ...body.provenance.providerAuth,
            claudeExecutable: "/opt/homebrew/bin/claude",
          },
        },
      }, expected),
      () => validateProofReceipt({
        ...body,
        provenance: {
          ...body.provenance,
          providerAuth: {
            ...body.provenance.providerAuth,
            claudeVersion: "9.9.9 (Claude Code)",
          },
        },
      }, expected),
    ];
    expect(validateProofReceipt(body, expected)).toEqual(canonicalProofBody(body));
    expect(forgeries).toHaveLength(21);
    for (const forge of forgeries) expect(forge).toThrow(ProofReceiptError);
  });

  test("proof CLI publishes and rereads a canonical current-run envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-proof-cli."));
    temporaryRoots.push(root);
    const body = completeBody();
    const draft = join(root, "draft.json");
    const receipt = join(root, "receipt.json");
    await Bun.write(draft, JSON.stringify(body));
    await Bun.write(receipt, "");
    await chmod(receipt, 0o600);
    const published = await run([
      "bun", "scripts/stock-proof-cli.ts", "publish", draft, receipt,
      body.runId, body.candidateSha, JSON.stringify(body.provenance.providerAuth),
    ]);
    expect(published.exitCode).toBe(0);
    const validated = await run([
      "bun", "scripts/stock-proof-cli.ts", "validate-envelope", receipt,
      body.runId, body.candidateSha, JSON.stringify(body.provenance.providerAuth),
    ]);
    expect(validated.exitCode).toBe(0);
    expect((await Bun.file(receipt).text()).endsWith("\n")).toBe(true);
  });

  test("proof CLI validates expected identity before replacing an existing receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3layer-proof-cli-preserve."));
    temporaryRoots.push(root);
    const priorBody = { ...completeBody(), runId: "prior-run" };
    const currentBody = completeBody();
    const draft = join(root, "draft.json");
    const receipt = join(root, "receipt.json");
    const priorChecksum = await proofChecksum(priorBody);
    const priorEnvelope = canonicalProofEnvelopeJson(priorBody, priorChecksum);
    await Bun.write(draft, JSON.stringify(currentBody));
    await Bun.write(receipt, priorEnvelope);
    await chmod(receipt, 0o600);

    const published = await run([
      "bun", "scripts/stock-proof-cli.ts", "publish", draft, receipt,
      "wrong-current-run", currentBody.candidateSha,
      JSON.stringify(currentBody.provenance.providerAuth),
    ]);

    expect(published.exitCode).not.toBe(0);
    expect(await Bun.file(receipt).text()).toBe(priorEnvelope);
  });

  test("deploy drill dry-run records the required immutable-artifact transitions", async () => {
    const result = await run(["bash", "scripts/stock-t3-canary-drill.sh", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("off -> canary -> promoted -> canary (prior config) -> off");
    expect(result.stdout).toContain("acceleration=off");
  });

  test("execute mode records digests, statuses, descriptor health, and thread readability", async () => {
    const fixture = await canaryFixture();
    const result = await run(["bash", "scripts/stock-t3-canary-drill.sh", "--execute"], fixture.env);
    expect(result.exitCode).toBe(0);
    const receipt = await Bun.file(fixture.receipt).json();
    expect(receipt.success).toBe(true);
    expect(receipt.configDigestAfter).toBe(receipt.configDigestBefore);
    expect(receipt.commandStatuses.length).toBe(16);
    expect(receipt.descriptors).toHaveLength(3);
    expect(receipt.threadReadability).toHaveLength(3);
    expect(receipt.threadReadability.every((entry: { readable: boolean }) => entry.readable)).toBe(true);
    expect(receipt.artifactChecks.length).toBeGreaterThan(0);
    expect(
      receipt.artifactChecks.every(
        (entry: { digest: string }) => entry.digest === receipt.artifactDigest,
      ),
    ).toBe(true);
    expect(receipt.cancellation).toEqual({ cancelled: 2, replayed: 0 });
    expect(receipt.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await Bun.file(fixture.receipt).stat()).mode & 0o777).toBe(0o600);
  }, 20_000);

  test("execute mode supports command paths containing spaces", async () => {
    const fixture = await canaryFixture("t3layer canary. ");
    const result = await run(["bash", "scripts/stock-t3-canary-drill.sh", "--execute"], fixture.env);
    expect(result.exitCode, result.stderr).toBe(0);
    await expect(Bun.file(fixture.receipt).json()).resolves.toMatchObject({ success: true });
  }, 20_000);

  test("execute mode uses a portable receipt-mode probe", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../scripts/stock-t3-canary-drill.sh"),
    ).text();

    expect(source).toContain("file_mode() {");
    expect(source).toContain("/usr/bin/stat -c '%a'");
    expect(source).toContain("/usr/bin/stat -f '%Lp'");
    expect(source).not.toContain("if [[ $(/usr/bin/stat -f '%Lp'");
  });

  test("execute mode rejects unapproved artifact or config bytes before routing", async () => {
    const fixture = await canaryFixture();
    const result = await run(["bash", "scripts/stock-t3-canary-drill.sh", "--execute"], {
      ...fixture.env,
      T3_STOCK_APPROVED_ARTIFACT_SHA256: "0".repeat(64),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("approved digest mismatch");
    expect(await Bun.file(fixture.log).exists()).toBe(false);
  }, 20_000);

  test("execute mode invalidates a prior receipt before preflight can fail", async () => {
    const fixture = await canaryFixture();
    await Bun.write(fixture.receipt, '{"success":true}\n');

    const result = await run(["bash", "scripts/stock-t3-canary-drill.sh", "--execute"], {
      ...fixture.env,
      T3_STOCK_ROUTE_CANARY_COMMAND: join(fixture.root, "missing-canary-command"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(fixture.receipt).exists()).toBe(false);
  }, 20_000);

  test("SIGINT during execute mode recovers and exits 130", async () => {
    const fixture = await canaryFixture();
    await Bun.write(
      fixture.paths.canary!,
      `#!/usr/bin/env bash\nset -euo pipefail\nsleep 0.2\nprintf '%s\\n' canary >> '${fixture.log}'\n`,
    );
    await chmod(fixture.paths.canary!, 0o700);
    const child = Bun.spawn(["bash", "scripts/stock-t3-canary-drill.sh", "--execute"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...Bun.env, ...fixture.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await Bun.file(fixture.log).exists()) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await Bun.file(fixture.log).exists()).toBe(true);
    child.kill("SIGINT");
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(130);
    expect(stderr).toContain("CANARY_RECOVERY:");
  }, 20_000);

  test("execute mode rejects artifact drift and environment identity drift", async () => {
    const artifactFixture = await canaryFixture();
    await Bun.write(
      artifactFixture.paths.readiness!,
      `#!/usr/bin/env bash\nprintf '%s\\n' mutation >> '${artifactFixture.artifact}'\n`,
    );
    await chmod(artifactFixture.paths.readiness!, 0o700);
    const artifactResult = await run(
      ["bash", "scripts/stock-t3-canary-drill.sh", "--execute"],
      artifactFixture.env,
    );
    expect(artifactResult.exitCode).not.toBe(0);
    expect(artifactResult.stderr).toContain("artifact drift detected");

    const identityFixture = await canaryFixture();
    const counter = join(identityFixture.root, "descriptor-count");
    await Bun.write(counter, "0\n");
    await Bun.write(
      identityFixture.paths.descriptor!,
      `#!/usr/bin/env bash\ncount=$(($(cat '${counter}') + 1))\nprintf '%s\\n' "$count" > '${counter}'\necho "{\\"environmentId\\":\\"env-$count\\",\\"serverVersion\\":\\"stock\\"}"\n`,
    );
    await chmod(identityFixture.paths.descriptor!, 0o700);
    const identityResult = await run(
      ["bash", "scripts/stock-t3-canary-drill.sh", "--execute"],
      identityFixture.env,
    );
    expect(identityResult.exitCode).not.toBe(0);
    expect(identityResult.stderr).toContain("environment identity changed");
  }, 30_000);

  test("every injected canary transition failure restores prior config and routes off", async () => {
    const seams = [
      "route-off", "route-canary", "canary-readiness", "canary-descriptor", "canary-thread",
      "route-promote", "promoted-readiness", "promoted-descriptor", "promoted-thread",
      "restore-prior-config", "route-prior-canary", "prior-canary-readiness",
      "prior-canary-descriptor", "prior-canary-thread", "final-route-off",
      "cancel-waits",
    ];
    for (const seam of seams) {
      const fixture = await canaryFixture();
      const result = await run(["bash", "scripts/stock-t3-canary-drill.sh", "--execute"], {
        ...fixture.env,
        T3_STOCK_FAIL_AT: seam,
      });
      expect(result.exitCode, seam).not.toBe(0);
      expect(result.stderr, seam).toContain("CANARY_RECOVERY:");
      const commands = (await Bun.file(fixture.log).text()).trim().split("\n");
      expect(commands.at(-3), seam).toBe("prior");
      expect(commands.at(-2), seam).toBe("off");
      expect(commands.at(-1), seam).toBe("cancel");
    }
  }, 120_000);

  test("recovery completes safety commands when status bookkeeping fails", async () => {
    const fixture = await canaryFixture();
    const result = await run(["bash", "scripts/stock-t3-canary-drill.sh", "--execute"], {
      ...fixture.env,
      T3_STOCK_FAIL_AT: "route-canary",
      T3_STOCK_FAIL_STATUS_AT: "recovery-prior-config",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "injected status-record failure: recovery-prior-config",
    );
    const commands = (await Bun.file(fixture.log).text()).trim().split("\n");
    expect(commands.slice(-3)).toEqual(["prior", "off", "cancel"]);
  }, 20_000);
});
