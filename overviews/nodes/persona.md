# Node: persona (plugin)

## Purpose
The agent's stable identity: one high-priority context block (stable-prefix convention, 10000+) whose
text comes from the agent's config. Always rendered at the top of the composed context, so the prompt
prefix stays stable for cache hits.

## Manifest
`{ id: "persona", version: "0.1.0" }`

## Config slice (`config["persona"]`)
`{ text?: string; priority?: number }` — defaults: `text` = "You are Krakey, an autonomous agent. Be
concise and helpful."; `priority` = 10000.

## Behavior (spec)
- setup: `ctx.setBlock({ id: "persona", priority: <config.priority ?? 10000>, render: () => <config.
  text ?? default> })`. The render result is the configured text verbatim.
- teardown: `ctx.removeBlock("persona")`.

## Status
done

## Change log
- 2026-06-11: node specced (Phase-1 MVP wave).
- 2026-06-11: implemented (Phase-1 MVP wave) — edge tests + e2e loop green.
