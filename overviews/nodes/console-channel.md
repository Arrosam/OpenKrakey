# Node: console-channel (plugin)

## Purpose
The MVP user interface: a terminal channel. Turns stdin lines into `input.message` events and wakes
the agent immediately (via the orchestrator's `clock.fire_now` action) so a reply doesn't wait for the
next scheduled beat; prints `output.message` text to stdout; greets when the agent starts. Future
channels (Discord etc.) are siblings behind the same input/output event seam.

## Manifest
`{ id: "console-channel", version: "0.1.0" }`

## Behavior (spec)
- `process.stdin`/`process.stdout` are PROCESS singletons but boot runs many Agents in one process, so
  the terminal is owned by a single MODULE-LEVEL hub shared (and refcounted) by every per-Agent
  instance — the only legitimate process-singleton owner; per-Agent factory state still lives in each
  closure (R6). The hub holds nothing per-Agent beyond an opaque `{ agentId, deliver }` registry, so no
  Agent observes another's input or output.
- setup:
  - Attach this Agent to the hub. The FIRST attach binds the single `node:readline` over `process.stdin`;
    the LAST detach closes it (refcount). One typed line routes to EXACTLY ONE Agent (never fan-out):
    with a single Agent the line is delivered verbatim (byte-identical to a one-Agent process); with
    several, `@<id> <msg>` addresses + makes-active that Agent, a bare `@<id>` just switches, an unknown
    id is named back with the roster, and any other line goes to the active Agent (default: first
    registered). The chosen Agent's delivery emits `input.message`
    `Notify{ at, data: { text, channel: "console" } }`, then (if `ctx.actions.has("clock.fire_now")`)
    invokes it (swallow rejection) to fold the input into an immediate beat.
  - Subscribe `output.message` → write the text to `process.stdout` as `\n[<agentId>] <text>\n` (the
    real speaking-agent id, so multi-agent replies are distinguishable; a single agent named `krakey`
    still renders `[krakey]`).
  - Subscribe `agent.start` → `ctx.print` a one-line greeting that includes the agentId.
- teardown: detach from the hub (decrement refcount; reassign the active agent if it was this one; close
  stdin only when the last Agent leaves), unsubscribe both listeners.
- Testability note: driven end-to-end through child processes with piped stdio (the tests/agent.test.ts
  pattern). The multi-agent harness builds N instances in one process sharing the hub — no in-process
  stream injection.

## Status
done

## Change log
- 2026-06-11: node specced (Phase-1 MVP wave).
- 2026-06-11: implemented (Phase-1 MVP wave) — edge tests + e2e loop green.
- 2026-06-13: greeting emitted via ctx.print so it lands in the startup report (was a raw stdout write).
- 2026-06-13: multi-agent stdin fix — a single module-level terminal hub (refcounted) replaces per-Agent readline interfaces; one typed line now routes to EXACTLY ONE Agent (was broadcast/fan-out to all in a multi-agent process), via @id addressing + an active default; output carries the real agentId (was a hardcoded [krakey]).
