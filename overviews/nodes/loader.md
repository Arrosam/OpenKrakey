# Node: loader

## Purpose
Per-Agent plugin lifecycle (loader only handles startup/shutdown + registration). Resolves this
Agent's plugins, sets each one's `dataDir`, builds its PluginContext (including the key-less `llm`
communicator library), and registers it (calls `setup`, wiring actions/listeners/context blocks into
the event-system + orchestrator block store).

## Zone
core

## Implements contracts
- `loader` — `load()` / `teardown()`.

## Depends on contracts
- `plugin` — loads modules satisfying `Plugin`; builds `PluginContext`.
- `event-system` — wires plugin actions/listeners into the Agent's buses.
- `context` — `ContextBlock` for PluginContext block ops.
- `orchestrator` — delegates PluginContext block ops to the orchestrator's block store.
- `llm` — receives the global `CommunicatorLibrary` and injects it as `PluginContext.llm` (key-less).

## Exposed interface
- `createLoader(deps: { agentId, def, events, orchestrator, library, publicPluginDir, agentDir, log? }): Loader`.
- `load()` / `teardown()`.

## Internal structure
`load()`: copy `def.privatePlugins` from `public_plugin/<id>/` → `agents/<id>/plugins/<id>/` (skip if
present; missing source → `PluginLoadError`). Resolve plugin dirs into a Map — private folder first
(auto-load, overrides same-id public), then declared public ids not already mapped. For each:
dynamic-`import` the module's default `Plugin` (invalid/unloadable → `PluginLoadError`), check
`manifest.requires` (`.`-names → actionbus `has`; else an already-loaded plugin id; unmet →
`DependencyError`), build `PluginContext` (`events.events`/`events.actions` separately, config slice,
`dataDir = <pluginDir>/data`, `llm = library`, block ops → orchestrator, log) → `await setup`; track in
load order. `teardown()`: reverse order, each `teardown?()` error-isolated (one failure never blocks
the rest), then clear. A bare agent (empty plugins) resolves to nothing and returns cleanly. The loader
does NOT run the beat.

## Status
done

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
- 2026-06-07: implemented — injects key-less `ctx.llm` (CommunicatorLibrary); depends on `llm`.
- 2026-06-11: bug-fix wave — plugin ids validated (no separators/./..) before any fs/import; deterministic sorted private order; two-pass load (import+validate ALL, then setup in order) with requires resolved against the full load set + manifest.provides; all-or-nothing rollback on any pass-2 failure; independent copies exclude the source data/; index.js entry fallback.
