# Node: toolbox (plugin)

## Purpose
The basic tool kit: gives the LLM a clock to read and — via the orchestrator's already-registered
rhythm actions — a clock to SET. `time.now` is its own action; the two pacing tools are pure ToolDefs
whose action names point at `clock.set_interval` / `clock.set_default_interval`, which the
orchestrator registered — the LLM calling them IS the self-pacing loop, with zero glue code.

## Manifest
`{ id: "toolbox", version: "0.1.0", requires: ["llm.register_tool"] }`

## Behavior (spec)
- setup: register action `time.now` (params ignored) → returns `{ iso: string, epochMs: number }`
  (current time). Then invoke `llm.register_tool` three times with ToolDefs:
  - `time.now` — "Get the current date and time." (no params)
  - `clock.set_interval` — params schema `{ ms: number }`; description explains it adjusts ONLY the
    current beat (fire sooner/later once).
  - `clock.set_default_interval` — params schema `{ ms: number }`; description explains it sets the
    steady thinking pace in milliseconds.
  (No handlers for the clock.* names — the orchestrator owns those actions; the tool names must equal
  shared/actions `Actions.CLOCK_SET_INTERVAL` / `Actions.CLOCK_SET_DEFAULT_INTERVAL` exactly.)
- teardown: unregister `time.now`.

## Status
planned

## Change log
- 2026-06-11: node specced (Phase-1 MVP wave).
