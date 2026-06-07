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
- Beat: compose context (blocks by priority DESC) → invoke `llm.chat` (skip if unregistered) → parse
  (`response.parse` action or none) → dispatch tool calls async (a rejected call must not abort the beat).
- One beat in flight per Agent; a tick while busy queues at most one. Non-blocking — new input/results
  fold into the next beat. `setBlock` with an existing id replaces it.

## Status
locked
