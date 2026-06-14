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
agent runs with no LLM config. Wiring/bridges owned here: (1) `clock.onFire` → emit `clock.tick`
(`Notify<{seq}>`, the sole emitter of that event); (2) a `busLogger` wrapper around the injected base
`Logger` (still tagged `[agent:<id>]`) given ONLY to the **orchestrator**, so every orchestrator
diagnostic line is ALSO published on this Agent's eventbus as a `log.entry` (`Events.LOG`) tagged
`core:orchestrator` — console output unchanged, reuses the existing event, no contract change. The
**loader is NOT bridged** (it gets the plain `[agent:<id>]` console logger): it reuses its logger to
echo every plugin's `ctx.log.*` line, so bridging it would duplicate plugin logs on the bus — instead
the loader self-reports its own diagnostics as `core:loader` via its own bus-push. `start()` (idempotent): `await loader.load()` →
re-check `stopped` (a stop() that arrived mid-load tears the loaded plugins down and returns without
arming anything) → emit `agent.start` (AFTER load, so plugins subscribed in setup observe it, and
BEFORE the first tick) → `orchestrator.start()` → `clock.start()`. `stop()` (idempotent; no-op if never
started): `clock.stop()` → `orchestrator.stop()` → `await loader.teardown()`.

## Status
done

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
- 2026-06-07: implemented — clock default from config, receives global llm library, emits `agent.start`.
- 2026-06-11: bug-fix wave — `agent.start` now emitted after loader.load() (was emitted before any plugin could subscribe, dead on arrival); stop()-during-in-flight-start() re-checked after load (no more "stopped" agent with a live timer).
- 2026-06-13: deps.print (plugin starting-message sink) threaded through to the loader.
- 2026-06-14: bridges the **orchestrator's** diagnostic logger onto the Agent eventbus as `log.entry` tagged `core:orchestrator`, in addition to console output, so an observer plugin (inspector) can see core diagnostics. Inline `busLogger` wrapper; reuses `Events.LOG`; `createAgentInstance` signature unchanged. (The loader is given the plain console logger and self-reports its own `core:loader` diagnostics — bridging it would have duplicated every plugin `ctx.log` line on the bus.)
- 2026-06-14: code-review fix — `busLogger`'s bus mirror is now re-entrancy-guarded (a module-level `mirroring` flag), so a `log.entry` subscriber that logs from its own handler can no longer drive unbounded synchronous recursion; sequential logging is unaffected.
