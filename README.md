# T3Layer

T3Layer is an experimental TypeScript control-plane facade for native
[T3 Code](https://t3.codes/) projects, threads, turns, and lifecycle events.
It is designed to coordinate coding agents through T3 Code's structured APIs
without parsing terminal output or maintaining a second agent registry.

> [!WARNING]
> T3Layer is in early development. It has no stable public API or release yet.
> The narrow protocol code currently in this repository is prototype evidence,
> not a supported T3 Code client.

T3Layer is an independent project and is not an official T3 Code product.

## Design principles

- T3 Code remains the source of truth for agent identity and lifecycle.
- A native T3 thread ID is the durable agent ID.
- Transport adaptation, compatibility checks, timeouts, and bounded resource
  policy belong in T3Layer.
- Agent transcripts, approvals, provider sessions, and UI state do not.
- Lifecycle decisions come from structured state and events, never terminal
  panes, titles, or model prose.

## Intended API

The planned facade is deliberately small:

```ts
spawn(input): Promise<AgentSnapshot>
send(agentId, message): Promise<TurnReceipt>
wait(agentId, condition): AsyncIterable<AgentEvent>
getState(agentId): Promise<AgentSnapshot>
interrupt(agentId): Promise<void>
stop(agentId): Promise<void>
```

These signatures describe project direction, not a released implementation.

## Development

Declared toolchain target:

- [Bun](https://bun.sh/) 1.3.11
- TypeScript 6.0.x

```bash
bun install
bun test
bun run typecheck
```

Do not point experimental code at an important T3 Code environment. Some future
operations may run agents with broad filesystem access; use disposable projects
and worktrees while developing integrations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately
as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
