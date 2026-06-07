# Contract: clock

## Purpose
The per-Agent timer boundary: how a beat gets activated on a schedule and how its rhythm is controlled.
Holds a **default** interval and a **current** interval — each beat counts down `current`; after every
activation `current` resets to `default`.

## Connects
clock (impl) ↔ orchestrator, agent_instance (consumers)

## Interface definition
- `start()` → begin firing. `stop()` → stop; idempotent.
- `setInterval(ms)` → set the **current** beat's interval, **effective immediately this beat** (see below).
- `setDefaultInterval(ms)` → set the **default** baseline that `current` resets to after each activation.
- `fireNow()` → fire immediately + reset countdown (to current).
- `onFire(handler)` → set the single activation handler (later call replaces).

## Behavioral constraints
- Only activates; never schedules/decides. Exactly one handler. Firing with no handler must not throw.
- **`setInterval` is immediate, not deferred**: let `elapsed` = time since the current countdown began.
  If `ms <= elapsed` → fire **now**; if `ms > elapsed` → reschedule to fire at `ms` (i.e. after
  `ms - elapsed` more). After any activation, `current` resets to `default`.
- `setDefaultInterval` changes the baseline only (takes effect from the next reset); it does not by
  itself re-arm the current countdown.
- `fireNow` works regardless of started state. The default is supplied by the wirer (agent_instance,
  from the Agent config) — the clock does not read files.

## Status
locked
