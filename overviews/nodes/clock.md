# Node: clock

## Purpose
A per-Agent dumb timer. Counts down and, on each tick, activates by calling its single registered
handler. It only activates — never schedules or decides content. Rhythm is controllable from outside.

## Zone
core

## Implements contracts
- `clock` — the full `Clock` interface.

## Depends on contracts
None.

## Exposed interface
- `createClock(opts?: { intervalMs?: number }): Clock` (factory; default interval e.g. 1000).
- `start()` / `stop()` (idempotent) / `setInterval(ms)` (next tick onward) / `fireNow()` (fire now + reset) / `onFire(handler)` (single handler, replaces).

## Internal structure
Recursive `setTimeout` (global) tracking one pending timer + the single handler. No domain knowledge.
The tick→`event-system` bridge (`clock.tick`) is done by the wirer (agent_instance/orchestrator), not here.

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
