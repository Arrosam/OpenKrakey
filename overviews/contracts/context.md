# Contract: context

## Purpose
The data shapes for context blocks + the composed snapshot. There is no context-buffer node — the
buffer lives inside the orchestrator; this contract just fixes the shapes.

## Connects
orchestrator (owns the buffer), loader (PluginContext block ops reference these types)

## Interface definition
- `ContextBlock` = `{ id, priority: number, render(): string | Promise<string> }`.
- `ComposedContext` = `{ text, meta? }`.

## Behavioral constraints
- Compose order is by `priority` **DESCENDING** (higher = first / top). Ties stable (insertion order).
- Convention: fixed/stable blocks use HIGH priority (10000+, top, cache-friendly); volatile blocks use
  LOW (0–10000, below). Empty buffer composes to `{ text: "" }`. `render` may be sync or async.

## Status
locked
