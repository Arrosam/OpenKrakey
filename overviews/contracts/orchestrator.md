# Contract: orchestrator

## Purpose
The per-Agent conductor surface (+ the context-block store it owns). Used by agent_instance to run it
and by the loader to wire PluginContext's block ops.

## Connects
orchestrator (impl) ↔ agent_instance, loader

## Interface definition
- `start()` → begin conducting (subscribe clock tick, run beats). `stop()`.
- `setBlock(block)` (add/replace by id); `getBlock(id)`; `removeBlock(id)→boolean`; `listBlocks()→[{id,priority}]`.

## Behavioral constraints
- Beat (EVENT-driven, fire-and-forget): `clock.tick` → emit `prompt.gather` → compose context (blocks
  by priority DESC, each block rendered in ISOLATION — a failing render degrades to empty text, never
  drops the beat) → emit `llm.request` without awaiting. The LLM round-trip returns later as
  `llm.return`; its tool calls are dispatched async (a rejected call must not abort the beat).
- One beat in flight per Agent; a tick while busy queues at most one. Non-blocking — new input/results
  fold into the next beat. After stop() nothing further is emitted (a queued beat is cancelled).
- Clock rhythm: while started, the well-known `clock.set_interval` / `clock.set_default_interval` /
  `clock.fire_now` actions (shared/actions `Actions.CLOCK_*`) are registered on the actionbus
  (unregistered on stop). `setBlock` with an existing id replaces it.

## Status
locked

## Change log
- 2026-06-11: doc-drift fix — described beat was a phantom actionbus flow (`llm.chat`/`response.parse`);
  rewritten to the real event-driven flow (`llm.request`/`llm.return`). Added per-block render isolation,
  queued-beat cancellation on stop, and the CLOCK_* rhythm actions (interface unchanged).
