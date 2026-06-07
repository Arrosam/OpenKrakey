# Node: loader

## Purpose
Per-Agent plugin lifecycle (loader only handles startup/shutdown + registration). Resolves this
Agent's plugins, sets each one's `dataDir`, builds its PluginContext, and registers it (calls
`setup`, wiring actions/listeners/context blocks into the event-system + orchestrator block store).

## Zone
core

## Implements contracts
- `loader` — `load()` / `teardown()`.

## Depends on contracts
- `plugin` — loads modules satisfying `Plugin`; builds `PluginContext`.
- `event-system` — wires plugin actions/listeners into the Agent's buses.
- `context` — `ContextBlock` for PluginContext block ops.
- `orchestrator` — delegates PluginContext block ops to the orchestrator's block store.

## Exposed interface
- `createLoader(deps: { agentId, def, events, orchestrator, publicPluginDir, agentDir, log }): Loader`.
- `load()` / `teardown()`.

## Internal structure
At construction copy `def.privatePlugins` from `public_plugin/<id>/` → `agents/<id>/plugins/<id>/`
(skip if present). Discovery: agent's private folder (auto-load, overrides same-id public) + declared
public ids. Dynamic-import each module's default `Plugin`. dataDir = `<plugin code dir>/data/`. Build
PluginContext (events, actions, config slice, dataDir, block ops → orchestrator, log) → `await setup`.
Throws `PluginLoadError` / `DependencyError`. Tracks loaded plugins for teardown.

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
