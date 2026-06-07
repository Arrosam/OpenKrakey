# Node: agent_instance

## Purpose
Wraps ONE Agent (the conceptual independent instance). A thin container/facade: holds and wires this
Agent's clock + event-system + orchestrator + loader, and exposes the external lifecycle. No business
logic of its own — conducting is the orchestrator's job, plugin startup is the loader's.

## Zone
core

## Implements contracts
- `agent` — `Agent` / `AgentHandle` (id, start, stop).

## Depends on contracts
- `clock`, `event-system`, `orchestrator`, `loader` — instantiates/wires this Agent's set.

## Exposed interface
- `createAgentInstance(def: AgentDefinition, deps?): Agent` (builds the per-Agent set, or accepts injected factories).
- `id` / `start()` / `stop()`.

## Internal structure
Constructs clock + event-system + orchestrator(+context-buffer) + loader for this Agent and wires
them: bridge `clock.onFire` → `event-system` `clock.tick`; give orchestrator the event-system + clock.
`start()`: `await loader.load()` (plugins register) → `orchestrator.start()` → `clock.start()`.
`stop()`: `clock.stop()` → `orchestrator.stop()` → `await loader.teardown()`. Idempotent.

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
