# Node: orchestrator

## Purpose
The per-Agent **conductor**, and the home of the **context-buffer** (no separate node). The beat is
**event-driven and non-blocking**: it emits generic events to activate plugins and dispatches tool
calls by name — it holds NO LLM behavior (no prompt building, no provider calls). Five jobs: compose
the context by `priority`; expose the block store so plugins add/modify/remove blocks by id; emit the
LLM request each beat; dispatch parsed tool calls from the LLM return; coordinate the clock.

## Zone
core

## Implements contracts
- `orchestrator` — start/stop + the context-block store (`setBlock`/`getBlock`/`removeBlock`/`listBlocks`).

## Depends on contracts
- `event-system` — subscribes `clock.tick` + `llm.return`; emits `prompt.gather` + `llm.request`; invokes tool actions.
- `clock` — injected (for rhythm coordination); the tick arrives via the event bus.
- `context` — `ContextBlock` / `ComposedContext` shapes.
- `llm` — `LLMResponse` / `ToolCall` TYPES only (to read `toolCalls` off the return payload).

## Exposed interface
- `createOrchestrator(deps: { events: EventSystem; clock: Clock; log?: Logger }): Orchestrator`.
- `start()` / `stop()` (idempotent); block-store ops (used by the loader to wire PluginContext).

## Internal structure
Holds an id→ContextBlock `Map` (the context-buffer). `start()` subscribes to `clock.tick` (run beat)
and `llm.return` (dispatch tools). Beat (single-flight + at most one queued via `setImmediate`):
emit `prompt.gather` (plugins synchronously refresh blocks) → compose (blocks by priority DESC, await
each `render`, empty → `{ text: "" }`) → emit `llm.request` (`Request<{context}>`) WITHOUT awaiting the
LLM. On `llm.return` (`Reply<LLMResponse>`): if ok and there are `toolCalls`, `actions.invoke(name,
arguments)` per call, fire-and-forget with an independent `.catch` (a rejected tool never aborts the
beat or the others). In Phase 0 nobody listens to `llm.request` and `llm.return` never fires — the beat
just emits and completes.

## Status
done

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
- 2026-06-07: implemented — event-driven beat (gather→compose→llm.request; dispatch toolCalls from llm.return); depends on `llm` types.
