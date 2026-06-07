# Contract: clock

## Purpose
The per-Agent timer boundary: how a beat gets activated on a schedule and how its rhythm is controlled.

## Connects
clock (impl) ↔ orchestrator, agent_instance (consumers)

## Interface definition
- `start()` → begin firing on each interval. `stop()` → stop; idempotent.
- `setInterval(ms)` → countdown length for subsequent ticks.
- `fireNow()` → fire immediately + reset countdown.
- `onFire(handler)` → set the single activation handler (later call replaces).

## Behavioral constraints
- Only activates; never schedules/decides. Exactly one handler. `fireNow` works regardless of started
  state. Firing with no handler must not throw. `setInterval` takes effect from the next tick.

## Status
locked
