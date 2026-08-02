export interface ExpectedProofIdentity {
  readonly runId: string;
  readonly candidateSha: string;
}

export type ProviderAuthProvenance =
  | {
      readonly mode: "subscription";
      readonly claudeExecutable: string;
      readonly claudeVersion: string;
    }
  | { readonly mode: "secret_ref" };

export interface ExpectedProofContext extends ExpectedProofIdentity {
  readonly providerAuth: ProviderAuthProvenance;
}

export interface LiveProofEvidence {
  readonly environmentId: string;
  readonly serverVersion: string;
  readonly endpointStatusTrace: readonly {
    readonly method: string;
    readonly path: string;
    readonly status: number | null;
  }[];
  readonly ids: {
    readonly projectId: string;
    readonly threadId: string;
    readonly createCommandId: string;
    readonly initialCommandId: string;
    readonly initialMessageId: string;
    readonly followupCommandId: string;
    readonly followupMessageId: string;
  };
  readonly sequences: {
    readonly create: number;
    readonly initial: number;
    readonly followup: number;
  };
  readonly counters: {
    readonly requests: number;
    readonly shellPolls: number;
    readonly detailPolls: number;
    readonly peakInFlight: number;
  };
  readonly terminalKinds: readonly ["completed", "completed"];
  readonly timestamps: { readonly startedAt: string; readonly completedAt: string };
}

export interface StockProofBody extends ExpectedProofIdentity {
  readonly stockSha: string;
  readonly success: true;
  readonly cleanBeforeBuild: true;
  readonly artifactDigest: string;
  readonly privateResolution: false;
  readonly provenance: {
    readonly stockInstall: CommandResult;
    readonly stockBuild: CommandResult;
    readonly candidateInstall: CommandResult;
    readonly exactCharacterization: CommandResult;
    readonly providerAuth: ProviderAuthProvenance;
    readonly isolatedBasenames: readonly string[];
  };
  readonly exactHttpNegative: {
    readonly status: 500;
    readonly shellStatus: 200;
    readonly detailStatus: 404;
    readonly code: "internal_error";
    readonly reason: "orchestration_dispatch_failed";
    readonly threadAbsent: true;
  };
  readonly live: LiveProofEvidence;
  readonly teardown: {
    readonly pidStopped: true;
    readonly worktreeRemoved: true;
    readonly rootRemoved: true;
  };
}

interface CommandResult {
  readonly command: string;
  readonly status: 0;
}

export interface ProvisionalProofRecord extends LiveProofEvidence {
  readonly provisional: true;
  readonly success: false;
  readonly runId: string;
}

export class ProofReceiptError extends TypeError {
  readonly code = "invalid_proof_receipt" as const;

  constructor(readonly reason: string) {
    super("invalid stock proof receipt");
    this.name = "ProofReceiptError";
  }
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ATTESTED_EXECUTABLE_PATH = "receipt.provenance.providerAuth.claudeExecutable";
const HTTP_METHOD = /^(GET|POST)$/;
const ALLOWED_PATH = /^(?:\/\.well-known\/t3\/environment|\/api\/orchestration\/(?:shell|dispatch|threads\/[^/?#]+))$/;
const EXPECTED_STOCK_SHA = "d3037064e61a9f059eafbd4f9869679779bd2a7c";
const EXPECTED_COMMANDS = Object.freeze({
  stock_install: "corepack pnpm install --frozen-lockfile",
  stock_build: "corepack pnpm --filter t3 build:bundle",
  candidate_install: "bun install --frozen-lockfile",
  exact_characterization:
    "corepack pnpm --filter t3 exec vp test run src/orchestration/Layers/T3LayerStockProjectionCharacterization.generated.test.ts",
});
const EXPECTED_ISOLATED_BASENAMES = Object.freeze([
  "stock-tree",
  "t3layer-clean",
  "server-home",
  "workspace",
]);
const PROOF_BODY_KEYS = new Set([
  "runId",
  "candidateSha",
  "stockSha",
  "success",
  "cleanBeforeBuild",
  "artifactDigest",
  "privateResolution",
  "provenance",
  "exactHttpNegative",
  "live",
  "teardown",
]);

function record(value: unknown, reason = "not_object"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProofReceiptError(reason);
  }
  return value as Record<string, unknown>;
}

function textField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new ProofReceiptError(key);
  return value;
}

function integerField(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProofReceiptError(key);
  return value as number;
}

function assertNoSecretMaterial(value: unknown, path = "receipt"): void {
  if (typeof value === "string") {
    if (path === ATTESTED_EXECUTABLE_PATH) return;
    if (/op:\/\/|bearer\s|api[_-]?key|token/i.test(value)) {
      throw new ProofReceiptError(`secret_material:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (/secret|token|prompt|response|authorization|body|header|log/i.test(key)) {
        throw new ProofReceiptError(`forbidden_key:${path}.${key}`);
      }
      assertNoSecretMaterial(entry, `${path}.${key}`);
    }
  }
}

function validateLive(value: unknown): LiveProofEvidence {
  const live = record(value, "live");
  textField(live, "environmentId");
  textField(live, "serverVersion");
  if (!Array.isArray(live.endpointStatusTrace) || live.endpointStatusTrace.length === 0) {
    throw new ProofReceiptError("endpoint_status_trace");
  }
  for (const rawEntry of live.endpointStatusTrace) {
    const entry = record(rawEntry, "endpoint_trace_entry");
    const method = textField(entry, "method");
    const path = textField(entry, "path");
    if (!HTTP_METHOD.test(method) || !ALLOWED_PATH.test(path)) {
      throw new ProofReceiptError("endpoint_trace_value");
    }
    if (entry.status !== null && (!Number.isSafeInteger(entry.status) || (entry.status as number) < 100 || (entry.status as number) > 599)) {
      throw new ProofReceiptError("endpoint_trace_status");
    }
  }
  const trace = live.endpointStatusTrace as readonly {
    readonly method: string;
    readonly path: string;
    readonly status: number | null;
  }[];
  const shellRequests = trace.filter(
    (entry) => entry.method === "GET" && entry.path === "/api/orchestration/shell" && entry.status === 200,
  ).length;
  const detailRequests = trace.filter(
    (entry) => entry.method === "GET" && entry.path.startsWith("/api/orchestration/threads/") && entry.status === 200,
  ).length;
  const dispatchRequests = trace.filter(
    (entry) => entry.method === "POST" && entry.path === "/api/orchestration/dispatch" && entry.status === 200,
  ).length;
  if (shellRequests === 0 || detailRequests === 0 || dispatchRequests < 3) {
    throw new ProofReceiptError("endpoint_trace_coverage");
  }
  const ids = record(live.ids, "ids");
  const idKeys = ["projectId", "threadId", "createCommandId", "initialCommandId", "initialMessageId", "followupCommandId", "followupMessageId"];
  const idValues = idKeys.map((key) => textField(ids, key));
  if (new Set(idValues).size !== idValues.length) throw new ProofReceiptError("ids_not_distinct");
  const sequences = record(live.sequences, "sequences");
  const create = integerField(sequences, "create");
  const initial = integerField(sequences, "initial");
  const followup = integerField(sequences, "followup");
  if (!(create < initial && initial < followup)) throw new ProofReceiptError("sequence_order");
  const counters = record(live.counters, "counters");
  for (const key of ["requests", "shellPolls", "detailPolls", "peakInFlight"]) integerField(counters, key);
  const requests = counters.requests as number;
  const shellPolls = counters.shellPolls as number;
  const detailPolls = counters.detailPolls as number;
  const peakInFlight = counters.peakInFlight as number;
  if (requests === 0 || shellPolls === 0 || detailPolls === 0 || peakInFlight === 0) {
    throw new ProofReceiptError("empty_counters");
  }
  if (
    requests !== trace.length ||
    shellPolls > shellRequests ||
    detailPolls > detailRequests ||
    peakInFlight > 8 ||
    peakInFlight > requests
  ) {
    throw new ProofReceiptError("inconsistent_counters");
  }
  if (!Array.isArray(live.terminalKinds) || live.terminalKinds.length !== 2 || live.terminalKinds.some((entry) => entry !== "completed")) {
    throw new ProofReceiptError("terminal_kinds");
  }
  const timestamps = record(live.timestamps, "timestamps");
  const startedAt = textField(timestamps, "startedAt");
  const completedAt = textField(timestamps, "completedAt");
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt)) || Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new ProofReceiptError("timestamps");
  }
  return structuredClone(live) as unknown as LiveProofEvidence;
}

export function canonicalProvisionalProof(value: unknown, expectedRunId: string): ProvisionalProofRecord {
  const input = record(value);
  if (input.provisional !== true || input.success !== false || input.runId !== expectedRunId) {
    throw new ProofReceiptError("provisional_identity");
  }
  validateLive(input);
  assertNoSecretMaterial(input);
  return structuredClone(input) as unknown as ProvisionalProofRecord;
}

function commandResult(
  value: unknown,
  key: keyof typeof EXPECTED_COMMANDS,
): void {
  const result = record(value, key);
  if (result.command !== EXPECTED_COMMANDS[key]) {
    throw new ProofReceiptError(`${key}_command`);
  }
  if (result.status !== 0) throw new ProofReceiptError(`${key}_status`);
}

function providerAuth(value: unknown): ProviderAuthProvenance {
  const auth = record(value, "provider_auth");
  if (auth.mode === "secret_ref") {
    if (Object.keys(auth).length !== 1) throw new ProofReceiptError("provider_auth_secret_ref_shape");
    return { mode: "secret_ref" };
  }
  if (auth.mode !== "subscription") throw new ProofReceiptError("provider_auth_mode");
  if (
    Object.keys(auth).length !== 3 ||
    typeof auth.claudeExecutable !== "string" ||
    !auth.claudeExecutable.startsWith("/") ||
    auth.claudeExecutable.includes("\n") ||
    typeof auth.claudeVersion !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+/.test(auth.claudeVersion) ||
    auth.claudeVersion.includes("\n")
  ) {
    throw new ProofReceiptError("provider_auth_subscription_shape");
  }
  return {
    mode: "subscription",
    claudeExecutable: auth.claudeExecutable,
    claudeVersion: auth.claudeVersion,
  };
}

export function canonicalProofBody(value: unknown): StockProofBody {
  const input = record(value);
  if (Object.keys(input).some((key) => !PROOF_BODY_KEYS.has(key))) {
    throw new ProofReceiptError("unknown_top_level_key");
  }
  if (typeof input.runId !== "string" || input.runId.length < 8) throw new ProofReceiptError("run_id");
  if (typeof input.candidateSha !== "string" || !SHA40.test(input.candidateSha)) throw new ProofReceiptError("candidate_sha");
  if (input.stockSha !== EXPECTED_STOCK_SHA) throw new ProofReceiptError("stock_sha");
  if (input.success !== true) throw new ProofReceiptError("not_success");
  if (input.cleanBeforeBuild !== true) throw new ProofReceiptError("not_clean_before_build");
  if (typeof input.artifactDigest !== "string" || !SHA256.test(input.artifactDigest)) throw new ProofReceiptError("artifact_digest");
  if (input.privateResolution !== false) throw new ProofReceiptError("private_resolution");
  const provenance = record(input.provenance, "provenance");
  commandResult(provenance.stockInstall, "stock_install");
  commandResult(provenance.stockBuild, "stock_build");
  commandResult(provenance.candidateInstall, "candidate_install");
  commandResult(provenance.exactCharacterization, "exact_characterization");
  providerAuth(provenance.providerAuth);
  if (
    !Array.isArray(provenance.isolatedBasenames) ||
    provenance.isolatedBasenames.length !== EXPECTED_ISOLATED_BASENAMES.length ||
    provenance.isolatedBasenames.some(
      (entry, index) => entry !== EXPECTED_ISOLATED_BASENAMES[index],
    )
  ) {
    throw new ProofReceiptError("isolated_basenames");
  }
  const negative = record(input.exactHttpNegative, "exact_http_negative");
  if (negative.status !== 500 || negative.shellStatus !== 200 || negative.detailStatus !== 404 || negative.code !== "internal_error" || negative.reason !== "orchestration_dispatch_failed" || negative.threadAbsent !== true) {
    throw new ProofReceiptError("exact_http_negative");
  }
  validateLive(input.live);
  const teardown = record(input.teardown, "teardown");
  if (teardown.pidStopped !== true || teardown.worktreeRemoved !== true || teardown.rootRemoved !== true) {
    throw new ProofReceiptError("teardown_incomplete");
  }
  assertNoSecretMaterial(input);
  return structuredClone(input) as unknown as StockProofBody;
}

export function validateProofReceipt(value: unknown, expected: ExpectedProofContext): StockProofBody {
  const receipt = canonicalProofBody(value);
  if (receipt.runId !== expected.runId || receipt.candidateSha !== expected.candidateSha) {
    throw new ProofReceiptError("expected_identity_mismatch");
  }
  const expectedAuth = providerAuth(expected.providerAuth);
  const actualAuth = receipt.provenance.providerAuth;
  if (
    actualAuth.mode !== expectedAuth.mode ||
    (actualAuth.mode === "subscription" && expectedAuth.mode === "subscription" && (
      actualAuth.claudeExecutable !== expectedAuth.claudeExecutable ||
      actualAuth.claudeVersion !== expectedAuth.claudeVersion
    ))
  ) {
    throw new ProofReceiptError("expected_provider_auth_mismatch");
  }
  return receipt;
}

function canonical(value: unknown): string {
  if (value === undefined) throw new ProofReceiptError("canonical_undefined");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ProofReceiptError("canonical_undefined");
  return encoded;
}

export function canonicalProofEnvelopeJson(bodyValue: unknown, checksum: string): string {
  const body = canonicalProofBody(bodyValue);
  if (!SHA256.test(checksum)) throw new ProofReceiptError("checksum");
  return `${canonical({ ...body, checksum })}\n`;
}

export function canonicalProofJson(value: unknown): string {
  return `${canonical(canonicalProofBody(value))}\n`;
}

export async function proofChecksum(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalProofJson(value));
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hashed)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

export async function validateProofEnvelope(value: unknown, expected: ExpectedProofContext): Promise<StockProofBody> {
  const envelope = record(value);
  if (typeof envelope.checksum !== "string" || !SHA256.test(envelope.checksum)) throw new ProofReceiptError("checksum");
  const { checksum, ...bodyValue } = envelope;
  const body = validateProofReceipt(bodyValue, expected);
  if ((await proofChecksum(body)) !== checksum) throw new ProofReceiptError("checksum_mismatch");
  return body;
}
