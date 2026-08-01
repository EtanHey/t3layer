# Stock T3 First-Release Runbook

This runbook describes operator-side routing around an already-built Phase 3
artifact. It does not add routing state to T3Layer and does not control or mutate
the stock T3 server.

## Preconditions

- Record the reviewed candidate SHA, artifact SHA-256, and configuration digest.
- Require configuration schema `stock-http-v1` and acceleration `off`.
- Attach passing deterministic, typecheck, stock-only, exact-SHA, and current
  `{runId,candidateSha}` live-proof receipts.
- Supply explicit executable paths for routing off, canary, promotion, prior
  config restoration, readiness, descriptor inspection, and an existing-thread
  read, plus a cancellation command that returns redacted
  `{cancelled, replayed: 0}` evidence. Also supply the immutable artifact and
  redacted configuration files.
  The drill refuses shell snippets.

Without a real routing controller and these commands, only `--dry-run` is valid
and release remains blocked.

## Drill

Run the same immutable artifact through:

```text
off -> canary -> promoted -> canary (prior config) -> off
```

The execute receipt re-hashes the artifact after every stage and records every
command exit status, before/after configuration digests, one unchanged
descriptor environment identity, one unchanged canonical thread identity,
actual cancellation/no-replay evidence, and acceleration=`off`. Its mode-0600
checksum envelope is reread before success. Promotion changes only the routing
percentage or allowlist. Configuration rollback restores the byte-identical
canary-validated redacted configuration.

## Failure behavior

- Any transition, readiness, descriptor, or thread-read failure: invoke the
  already-armed recovery trap, attempt prior-configuration restoration, and
  finish with the supplied routing-off command.
- Code failure or first-release incident: keep routing off, cancel outstanding
  receipt waits with typed outcomes, and do not replay them.
- Never roll back T3 data, start an incompatible predecessor, or infer causal
  completion after a lost receipt.
- Treat a capacity, HTTP, or projection observation error as retryable
  observation failure: retry `wait` with the same active receipt. Do not issue a
  replacement send while that receipt owns the thread slot. Terminal evidence
  must carry `leaseState: "released"` before a new send is admitted.
- Build and validate a forward fix while users continue against stock T3.

After a second stock-only artifact independently passes the same gate, ordinary
binary rollback may select only a previously accepted stock-only artifact.
