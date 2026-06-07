# Contract: loader

## Purpose
The per-Agent plugin-lifecycle boundary used by agent_instance.

## Connects
loader (impl) ↔ agent_instance

## Interface definition
- `load()` → `Promise<void>` — resolve + register all of this Agent's plugins.
- `teardown()` → `Promise<void>` — tear every loaded plugin down.

## Behavioral constraints
- `load` copies declared `privatePlugins` into the Agent (skip if present), auto-loads the Agent's
  private folder (overriding same-id public), loads declared public plugins, sets each `dataDir`, builds
  PluginContext, and calls `setup` (registering into the event-system + orchestrator block store).
- Unmet `requires` → `DependencyError`; unloadable/invalid module → `PluginLoadError`.
- `teardown` calls each loaded plugin's `teardown?` (one failure must not block the rest).

## Status
locked
