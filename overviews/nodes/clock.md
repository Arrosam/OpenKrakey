# Node: clock

## Purpose
A per-Agent dumb timer. Holds a **default** and a **current** interval; counts down `current` and, on
each tick, activates by calling its single registered handler, then resets `current` to `default`. It
only activates — never schedules or decides content. Rhythm is controllable from outside, immediately.

## Zone
core

## Implements contracts
- `clock` — the full `Clock` interface.

## Depends on contracts
None.

## Exposed interface
- `createClock(opts: { defaultIntervalMs: number }): Clock` (factory; current starts = default).
- `start()` / `stop()` (idempotent) / `setInterval(ms)` (current; **immediate this beat**) /
  `setDefaultInterval(ms)` (baseline) / `fireNow()` (fire now + reset) / `onFire(handler)` (single, replaces).

## Internal structure
Recursive `setTimeout` tracking one pending timer + the single handler. Tracks `defaultIntervalMs`,
`currentIntervalMs`, and the **start timestamp** of the current countdown (to compute `elapsed`).
`setInterval(ms)`: set current; if `ms <= elapsed` fire now (which resets current→default and re-arms),
else clear the pending timer and re-arm for `ms - elapsed`. After each activation, `current = default`.
No domain knowledge. The tick→`event-system` bridge (`clock.tick`) is done by the wirer (agent_instance).

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
- 2026-06-07: revised — default/current dual interval; `setInterval` immediate (this beat); `setDefaultInterval` added.
- 2026-06-11: bug-fix wave — setInterval while NOT running (pre-start / stopped) records without firing (was: fired immediately off a stale/zero countdownStart); arm/rearm clear the pending timer first, so re-entrant fireNow/setInterval from inside the handler can no longer double-arm.
