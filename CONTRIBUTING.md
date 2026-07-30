# Contributing to T3Layer

T3Layer is early-stage software. Issues and pull requests are welcome, but
interfaces may change while the native T3 Code integration is established.

## Before opening a pull request

1. Open or reference an issue for changes that alter architecture or public API.
2. Keep T3 Code as the sole owner of thread identity, lifecycle, transcripts,
   approvals, and provider sessions.
3. Do not add terminal scraping, title-based identity, direct database access,
   copied private schemas, or a second durable agent registry.
4. Do not include credentials, access tokens, WebSocket tickets, private
   transcripts, local evidence, or machine-specific paths.
5. Add focused tests for behavioral changes.

## Local checks

Use the repository's pinned toolchain:

```bash
bun install
bun test
bun run typecheck
```

If your change requires a live T3 Code environment, describe the sanitized setup
and observed version in the pull request. Never attach authorization headers,
bearer tokens, tickets, or secret-bearing URLs.

## Pull requests

- Keep each pull request narrowly scoped.
- Explain the user-facing or architectural reason for the change.
- Include exact verification commands and results.
- Call out compatibility assumptions and any verification that could not be
  performed.
- Update public documentation when behavior or interfaces change.

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
