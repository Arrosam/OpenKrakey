# OpenKrakey Documentation

The documentation index, organized by what you are trying to do.

## Start here

| You want to… | Read |
|---|---|
| Understand what OpenKrakey is | [Project README](../README.md) |
| Understand the design and the boundaries | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Build a plugin (new tool, context, or channel) | [PLUGIN_DEV.md](PLUGIN_DEV.md) |
| Contribute to the kernel | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Report a security issue | [SECURITY.md](../SECURITY.md) |

## By role

### New users

1. [Install and setup](../README.md#install-and-setup) — install, configure a provider, create your first Agent.
2. [Configuration](../README.md#configuration) — the `llm.json` and Agent config shapes.
3. [Bundled plugins](../README.md#what-your-agent-can-do) — what each plugin gives an Agent.

### Plugin authors

1. [The system model](../README.md#4-system-model-the-beat) — the beat and the result loop.
2. [PLUGIN_DEV.md](PLUGIN_DEV.md) — the complete authoring guide, including the result loop,
   channels-as-tools, persistence, and the testing harness.
3. [The invariants](../ARCHITECTURE.md#9-invariants-anti-rot--test-enforced) — the rules a plugin
   must not break.

### Kernel contributors

1. [ARCHITECTURE.md](../ARCHITECTURE.md) — module responsibilities and contracts (§8).
2. [CONTRIBUTING.md](../CONTRIBUTING.md) — setup, conventions, the repository map.

## Tooling

The `docs/scripts/` directory contains the architecture-graph tooling
([docs/scripts/README.md](scripts/README.md)):

| Command | Purpose |
|---|---|
| `npm run arch:graph` | Build the architecture dependency graph. |
| `npm run arch:serve` | Serve the graph locally. |
