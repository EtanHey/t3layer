# T3Layer

T3Layer is an experimental TypeScript orchestration facade for an unmodified
stock [T3 Code](https://t3.codes/) server. Stock T3 remains the only durable
owner of projects, threads, messages, turns, sessions, approvals, checkpoints,
and provider state. T3Layer keeps only bounded process-local receipts, causal
wait leases, polling cursors, evidence, and orchestration policy.

> [!WARNING]
> T3Layer is pre-release software. Use disposable workspaces and a scoped,
> short-lived T3 bearer while testing it.

T3Layer is independent and is not an official T3 Code product.

## Stock HTTP boundary

The baseline transport uses only the public stock endpoints below:

- `GET /.well-known/t3/environment`
- `POST /oauth/token` when a bootstrap credential must be exchanged
- `GET /api/orchestration/shell`
- `GET /api/orchestration/threads/:threadId`
- `POST /api/orchestration/dispatch`

Dispatch always uses authenticated HTTP. Observation uses one coalesced shell
poller per environment plus conditional thread-detail reads. Socket framing,
server source imports, direct database access, copied runtime internals, and a
second transcript/lifecycle store are outside the baseline.

Configure a runtime directly:

```ts
import { createStockT3Facade } from "./src/facade";
import { createStockT3NativeRuntime } from "./src/nativeRuntime";

const runtime = createStockT3NativeRuntime({
  baseUrl: "http://127.0.0.1:3774",
  bearerToken: process.env.T3_STOCK_HTTP_TOKEN,
  connectionProfile: "local",
});
const t3 = createStockT3Facade(runtime);
```

Create the MCP tool surface from that same facade instance:

```ts
import { createStockT3McpFacade } from "./src/mcp";

const mcp = createStockT3McpFacade(t3);
const toolDefinitions = mcp.listTools();
const result = await mcp.callTool("observe", {
  ref: { environmentId, threadId },
  operation: { timeoutMs: 15_000 },
});
```

`createStockT3McpFacade` is transport-neutral: register `listTools()` and
`callTool()` with the MCP server library used by the host application. Do not
construct another native runtime, facade, or worker overlay for MCP. Direct and
MCP calls must share the same instance so receipts, lifecycle fences, and
process-local hierarchy metadata have one owner. MCP context cancellation is
merged into the operation signal; callers cannot provide an `AbortSignal` in a
JSON tool argument.

The exposed tools are `spawn`, `send`, `wait`, `observe`, `getState`,
`listChildren`, `listWorkers`, `interrupt`, `stop`, `respondToApproval`, and
`respondToUserInput`. `getState` is an alias for the canonical `observe` path;
it does not create or cache a second state representation.

Never log the bearer, authorization headers, bootstrap credentials, provider
keys, prompts, or raw responses. The live harness accepts a 1Password reference
through `T3_STOCK_PROVIDER_SECRET_REF`; the resolved value is scoped only to the
owned isolated server child.

## Causal API

Project lookup remains stock-authoritative. If a unique project for
`workspaceRoot` is already visible, `spawn` may resolve it without a creation
identity. If no project exists, the caller must preallocate and retain the full
immutable `projectCreateIdentity`: cryptographically random project and command
IDs plus `createdAt`, workspace root, project title, and default model selection.
The same object must be reused after a timeout, runtime recreation, or by
simultaneous runtime objects participating in the same logical attempt.
Identity-free creation fails before dispatch as
`identity_conflict/project_create_identity_required`; T3Layer never derives a
deterministic ID from a workspace root or relies on a process-local map for
duplicate prevention.

```ts
import {
  allocateProjectCreateIdentity,
  parseProjectCreateIdentity,
} from "./src/facade";

const projectCreateIdentity = allocateProjectCreateIdentity({
  workspaceRoot,
  title: "My stock project",
  defaultModelSelection: modelSelection,
});
const restoredIdentity = parseProjectCreateIdentity(
  JSON.parse(JSON.stringify(projectCreateIdentity)),
  { workspaceRoot },
);

await t3.spawn({
  workspaceRoot,
  projectCreateIdentity: restoredIdentity,
  title: "worker",
  message: "Start",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
});
```

HTTP spawn is a two-stage operation:

```text
thread.create -> shell/detail identity reconciliation
              -> fresh empty-thread preflight
              -> bootstrap-free thread.turn.start
```

`spawn` returns either a fully reconciled `spawned` result, a truthful partial
result for a durable thread whose initial turn is not proven, a
`create_reconciliation_pending` result with its provisional scoped reference,
or a ref-preserving protocol failure. Pending create reconciliation is read-only
until identity is established; it never hides or deletes the stock thread.

`send` returns a `TurnReceipt`. Only `wait(receipt, ...)` may claim causal turn
completion. One expiring send lease is allowed per scoped thread. A bare thread
reference can be observed but cannot be upgraded into a causal completion claim
after process restart or lease loss. Receipts use `leaseState: "active"` while
executable. External-writer terminal partials retain the complete accepted or
ambiguous receipt as `leaseState: "released"`; that evidence is not executable
and `wait` rejects it as `receipt_expired`.

Workspace roots cross one stock-compatible ingress seam before lookup, identity
validation, payload construction, or comparison: whitespace is trimmed, `~` is
expanded, relative paths become absolute, trailing separators are normalized,
and Windows drive/UNC comparison is case-insensitive. The canonical root is
stored in project-create identities and evidence. `createdAt` remains
allocator-owned because an ambiguous stock command retry must replay the entire
original command byte-for-byte.

The distinct-ID correlation contract fails closed on observable overlap:
`superseded`, `concurrent_writer`, or `causality_unverifiable`. Deliberate reuse
of the exact target message ID with indistinguishable time and payload is outside
the deterministic guarantee because stock exposes no public command-to-turn
causation field.

## Polling and request budgets

- Healthy shell cadence after dispatch: 250 ms, 500 ms, 1 s, then 2 s.
- Shell starts: at most 32 in minute one, then 30 per rolling minute.
- Detail amplification: at most four reads per active wait/minute and no
  overlapping detail read for one thread.
- Capacity: eight active waits and eight total HTTP requests per client.
- Aggregate ceiling for eight fast waits: 64 starts in minute one and 62 in a
  later full minute; slow requests reduce starts because attempts do not overlap.
- Attempt deadline: 5 s for `local`; 15 s independently for `relay` and
  `tunnel`, always capped by the operation deadline.
- Default operation/lease deadline: 15 minutes; no unbounded wait.
- Snapshot failure backoff: 500 ms, 1 s, 2 s, 4 s, then 8 s; `Retry-After` is
  capped at 8 s.
- Evidence cap: 256 KiB per wait, with terminal identity retained.

Capacity, transport, protocol-decode, and shell/detail observation failures do
not prove a causal turn outcome. They leave the receipt active so the caller can
retry `wait` with the same receipt; a duplicate `send` remains blocked. Only
explicit cancellation/release, environment invalidation, inclusive lease
expiry, a proven causal terminal outcome, or successful completion releases the
lease. Every terminal result/error embeds a structurally released receipt.

Exact received dispatch errors are surfaced as `command_rejected` (400),
`authentication_failed` (401), `permission_denied` (403), or `server_internal`
(500). A received first-attempt error is not retried. Only a request with no
trustworthy response can be retried once with identical IDs and payload; a retry
error cannot erase ambiguity about the original attempt.

An environment-ID change invalidates only the old environment's receipts and
slot claims, then re-pins the runtime to the newly discovered stable
environment. The operation that observes the roll returns `environment_changed`;
new-environment work cannot be blocked or cleared by a colliding old ref. Scoped
old project-create evidence fails closed, while stable work may reuse the same
unscoped caller-held project command identity without minting a second ID.

Operation budgets are bounded integers at every direct and MCP ingress:
`deadlineMs` is a non-negative safe integer, while `timeoutMs` and
`maxReconciliationReads` are positive safe integers. `NaN`, infinities,
fractions, unsafe integers, and values below those minima fail before HTTP as
`protocol_mismatch` with the offending field in evidence.

## MCP outcomes and supported errors

Successful MCP calls return `{ ok: true, value }` in `structuredContent` and as
JSON text. An absent `observe` result is encoded as JSON `null` in both forms.
Failures set `isError: true` and retain the direct error family:

- `stock_runtime` carries a `StockRuntimeError` code and `evidence`.
- `worker_overlay` carries a `WorkerOverlayError` code and `details`.

Runtime codes currently include `command_rejected`, `authentication_failed`,
`permission_denied`, `server_internal`, `internal_error`,
`transport_unavailable`, `protocol_mismatch`, `environment_changed`,
`identity_conflict`, `send_in_progress`, `receipt_expired`,
`correlation_capacity`, `cancelled`, `timeout`, `superseded`,
`concurrent_writer`, `causality_unverifiable`, `pending_approval`,
`pending_input`, `approval_not_pending`, `user_input_not_pending`,
`turn_interrupted`, and `turn_error`. Overlay failures retain their
`overlay_*` codes. JSON-compatible evidence is preserved across the MCP
boundary; unhandled exceptions are reduced to a non-secret `internal_error`
instead of exposing exception text.

At adopted stock T3 commit `d3037064`, optional acceleration is **N/A**. The
public environment descriptor exposes no supported orchestration contract ID or
fingerprint that could safely negotiate a faster path. T3Layer therefore uses
the public authenticated HTTP endpoints and polling budgets above. A stream,
socket, private package, or server-source import is never a prerequisite.

## Migrating to the stock facade

To replace an older private runtime-client integration:

1. Remove the private client dependency and imports; configure the public stock
   base URL and a scoped bearer for `createStockT3NativeRuntime`.
2. Create one `createStockT3Facade(runtime)` and inject that exact facade into
   `createStockT3McpFacade`. Do not copy refs into another registry.
3. Persist caller-owned project-create identities when creation may need to be
   resumed. Treat returned `TurnReceipt` objects as the only causal wait handle.
4. Replace state-cache reads with `observe` or MCP `getState`, and handle
   pending approval/input by responding through the facade before retrying
   `wait` with the same receipt.
5. Run the authenticated in-process fixture, the stock-only scan, and the opt-in
   live proof before enabling MCP traffic.

For rollback, stop routing new direct/MCP operations to the candidate and cancel
in-flight waits without replaying a turn. Stock remains authoritative and is not
modified by disabling T3Layer. Keep the same reviewed artifact when rolling
back configuration during the first stock-only release; after another artifact
passes the same gates, roll back only to a previously accepted stock-only
artifact.

## Troubleshooting

- `authentication_failed`: issue a fresh scoped bearer and confirm the base URL;
  never print the token while diagnosing.
- `protocol_mismatch`: inspect `evidence.field`; numeric budgets must follow the
  bounded-integer rules above, and scoped refs require both IDs.
- `pending_approval` or `pending_input`: respond to the pending request, then
  call `wait` again with the same active receipt.
- `receipt_expired`: do not reconstruct or replay the causal claim. Observe the
  stock thread and decide explicitly whether to start a new turn.
- `environment_changed`: discard refs and receipts scoped to the old
  environment ID, rediscover the descriptor, and reattach canonical workers.
- `transport_unavailable` or `timeout`: retain an active receipt and retry the
  same `wait`; do not issue a duplicate `send`.
- Missing hierarchy after restart: stock state is still available through
  `observe`, but overlay role/parent metadata is process-local and must be
  restored with explicit canonical attachment.

## Development and proof

Declared toolchain target: Bun 1.3.11 and TypeScript 6.0.x.

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bash scripts/check-stock-only.sh
bash scripts/stock-t3-canary-drill.sh --dry-run
```

The opt-in exact-stock live proof is isolated from normal user state:

```bash
set -a
. ./.env.stock-proof
set +a
bash scripts/stock-t3-live-harness.sh
```

`.env.stock-proof` is ignored and must contain only a secret reference, never a
secret value. The harness pins the adopted stock SHA, builds in detached clean
worktrees, uses a dedicated base directory/workspace/bearer, validates exact PID
birth and working-directory identity during teardown, and accepts proof freshness
only for the caller-held current `{runId, candidateSha}` pair. Its TypeScript
validator requires clean-install/build provenance, executable exact-stock
characterization, the HTTP negative, redacted endpoint/status observations,
actual request/poll counters, scoped IDs and sequences, terminal outcomes,
isolation, and complete teardown before atomic mode-0600 publication. Literal
stock SHA/provenance commands and isolation basenames are pinned, and final
validation runs from the archived candidate rather than the mutable worktree.

Because the harness exports `git archive HEAD`, it proves only a reviewed
checkpoint commit. An uncommitted working tree cannot produce a current proof
for those edits.

## First stock-only release

The first stock-only release has no compatible earlier binary rollback target.
Canary and promotion therefore use the same immutable artifact and
`stock-http-v1` configuration. A configuration rollback restores the
canary-validated config on that same artifact. A code failure turns T3Layer
routing off, cancels in-flight receipt waits without replay, and leaves stock T3
untouched while a forward fix is built. After a second stock-only artifact passes
the same gate, rollback may target a previously accepted stock-only artifact.

See [docs/operations/stock-t3-first-release.md](docs/operations/stock-t3-first-release.md).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed
under the [Apache License 2.0](LICENSE).
