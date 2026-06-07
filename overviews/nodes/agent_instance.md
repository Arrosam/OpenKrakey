# Node: agent_instance

## Purpose
Wraps ONE Agent (the conceptual independent instance). A thin container/facade: holds and wires this
Agent's clock + event-system + orchestrator + loader, receives the global LLM communicator library to
pass down, and exposes the external lifecycle. No business logic of its own — conducting is the
orchestrator's job, plugin startup is the loader's.

## Zone
core

## Implements contracts
- `agent` — `Agent` / `AgentHandle` (id, start, stop).

## Depends on contracts
- `clock`, `event-system`, `orchestrator`, `loader` — instantiates/wires this Agent's set (composition
  root exception: imports the concrete sibling factories).
- `agent` — the `AgentDefinition` it runs.
- `llm` — receives a `CommunicatorLibrary` (from boot) and forwards it to the loader.

## Exposed interface
- `createAgentInstance(def: AgentDefinition, deps?: { library?, log?, publicPluginDir?, agentsDir? }): Agent`.
- `id` / `start()` / `stop()`.

## Internal structure
Constructs clock (`defaultIntervalMs = def.intervalMs`) + event-system + orchestrator + loader at
construction time. Falls back to an empty `CommunicatorLibrary` if `deps.library` is absent so a bare
agent runs with no LLM config. The ONLY wiring/bridge: `clock.onFire` → emit `clock.tick`
(`Notify<{seq}>`, the sole emitter of that event). `start()` (idempotent): emit `agent.start` →
`await loader.load()` → `orchestrator.start()` → `clock.start()`. `stop()` (idempotent; no-op if never
started): `clock.stop()` → `orchestrator.stop()` → `await loader.teardown()`.

## Status
done

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
- 2026-06-07: implemented — clock default from config, receives global llm library, emits `agent.start`.
