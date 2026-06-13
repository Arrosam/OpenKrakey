# Contract: plugin

## Purpose
What a plugin IS and what it's handed at setup. The sole extensibility surface — kept small enough for
an LLM to author plugins (self-growth).

## Connects
loader (loads + builds PluginContext), orchestrator (owns the block store) ↔ plugins (implementors)

## Interface definition
- `PluginManifest` = `{ id, version, requires?, provides?, configSchema? }`.
- `PluginContext` = `{ agentId, events, actions, config, dataDir, llm, setBlock, getBlock, removeBlock, listBlocks, log }`.
  `llm` is a key-less `CommunicatorLibrary` (from `contracts/llm`) — a plugin picks a communicator by
  name to make LLM requests; it never sees API keys or the request wire-format.
- `Plugin` = `{ manifest, setup(ctx)→void|Promise, teardown?()→void|Promise }`.

## Behavioral constraints
- `setup` called once per Agent (by the loader); `teardown` once on stop.
- A plugin registers everything in `setup`; never imports another plugin or core internals.
- `dataDir` = this plugin's persistent storage; PUBLIC plugins share it (shared knowledge), PRIVATE
  ones are isolated.
- Context blocks are addressed BY ID and are NOT owner-locked: any plugin may set/get/remove/list ANY
  block (e.g. A edits B's `BBB`). These ops delegate to the orchestrator's block store.

## Status
locked

## Change log
- 2026-06-11: provides is now real — a requires entry may name a plugin id OR a provided capability of the same load set.
- 2026-06-13: default export is a PluginFactory (() => Plugin), called once per Agent by the loader; keep all mutable state in the factory closure, construction side-effect free.
- 2026-06-13: v1.1 — ctx.log is a leveled logger {info,warn,error}; new ctx.print(text) = the plugin's clean user-facing line (during setup: its starting message); both also pushed on the agent's bus as log.entry (Events.LOG).
