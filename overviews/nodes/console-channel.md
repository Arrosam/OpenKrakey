# Node: console-channel (plugin)

## Purpose
The MVP user interface: a terminal channel. Turns stdin lines into `input.message` events and wakes
the agent immediately (via the orchestrator's `clock.fire_now` action) so a reply doesn't wait for the
next scheduled beat; prints `output.message` text to stdout; greets when the agent starts. Future
channels (Discord etc.) are siblings behind the same input/output event seam.

## Manifest
`{ id: "console-channel", version: "0.1.0" }`

## Behavior (spec)
- setup:
  - Create a `node:readline` interface on `process.stdin`. Each non-empty line → emit `input.message`
    `Notify{ at, data: { text: <line>, channel: "console" } }`, then, if
    `ctx.actions.has("clock.fire_now")`, invoke it (swallow any rejection) to fold the input into an
    immediate beat.
  - Subscribe `output.message` → write the text to `process.stdout` as `\n[krakey] <text>\n`.
  - Subscribe `agent.start` → print a one-line greeting that includes the agentId.
- teardown: close the readline interface, unsubscribe both listeners.
- Testability note: the plugin is driven end-to-end through a child process with piped stdio (the
  pattern used by tests/agent.test.ts) — it deliberately has no in-process stream injection.

## Status
done

## Change log
- 2026-06-11: node specced (Phase-1 MVP wave).
- 2026-06-11: implemented (Phase-1 MVP wave) — edge tests + e2e loop green.
