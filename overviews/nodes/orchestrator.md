# Node: orchestrator

## Purpose
The per-Agent **conductor**, and the home of the **context-buffer** (no separate node). Five jobs:
compose the full context from its blocks by `priority` (DESC, high on top); expose the eventbus so
plugins add/modify/remove any context block by id; execute LLM-parsed tool calls async/non-blocking;
maintain the actionbus for plugin invocation; coordinate the clock. Runs the beat.

## Zone
core

## Implements contracts
- `orchestrator` — start/stop + the context-block store (`setBlock`/`getBlock`/`removeBlock`/`listBlocks`).

## Depends on contracts
- `event-system` — emits/subscribes; invokes `llm.chat` / `response.parse` / tool actions on the actionbus.
- `clock` — subscribes to its tick (via event-system) and coordinates its rhythm.
- `context` — `ContextBlock` / `ComposedContext` shapes.

## Exposed interface
- `createOrchestrator(deps: { events, clock, ... }): Orchestrator`.
- `start()` / `stop()`; block store ops (used by loader to wire PluginContext).

## Internal structure
Holds an id→ContextBlock map (the context-buffer). Beat (on clock tick): compose = render blocks by
priority DESC, join → invoke `llm.chat` (if present) → parse (`response.parse` action or none) →
dispatch each tool call async (fire-and-forget, errors isolated). Single-flight beat with one queued.

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
