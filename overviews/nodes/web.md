# Node: web (plugin)

## Purpose
The browser chat channel — a sibling of any other channel behind the same input/output event seam.
A typed browser message becomes `input.message` (and wakes the beat via `clock.fire_now`);
`output.message` text is streamed back to the browser over SSE. Per message it reports a delivery
status: `sent` when the message is appended to the event queue, `read` once the agent's beat has
processed it. This is the second channel (after the retired terminal channel) and the project's
primary chat surface.

## Manifest
`{ id: "web", version: "0.1.0" }`

## Behavior (spec)
- `process` owns ONE http server, so — like any process singleton — it is owned by a MODULE-LEVEL hub
  shared and refcounted by every per-Agent instance (boot runs many agents in one process). The hub is
  the only process-singleton owner; per-Agent factory state still lives in each closure (R6). The hub
  holds only an opaque per-agent registry `{ agentId, deliver, sse-clients, pending }` — no Agent can
  observe another's input or output; routing is explicit by URL.
- setup:
  - Register this agent with the hub. The FIRST registration starts the server on the configured port
    (`config.web.port`, default 7717) and `ctx.print`s `✦ Web chat: http://localhost:<port>`.
  - Subscribe `output.message` → stream `{ type:"output", text }` to this agent's SSE clients.
  - Subscribe `llm.return` → a completed beat means every queued message has been processed; flip the
    pending message ids to `read` and stream `{ type:"status", id, status:"read" }`.
- HTTP routes:
  - `GET /` → the static chat page (dependency-free; agent sidebar, per-agent transcript, monogram
    avatars, sent/read ticks; SSE via `EventSource`).
  - `GET /api/agents` → `{ agents: string[] }` (the online agent ids).
  - `POST /api/agents/:id/message` `{text}` → assign a message id, emit `input.message`
    `Notify{ at, data:{ text, channel:"web", meta:{ msgId } } }` + `clock.fire_now` on that agent's bus,
    stream a `sent` status, return `202 { id, status:"sent" }`. Empty text → 400; unknown id → 404.
  - `GET /api/agents/:id/stream` → SSE; sends a greeting output event on connect, then that agent's
    output + status events. Unknown id → 404.
- teardown: unsubscribe; end this agent's SSE clients; deregister; close the server only when the LAST
  agent has detached (refcount).
- Notes / limits: `read` rides `llm.return`, so an agent without `llm-core` never advances past `sent`.
  One server per process — if two agents request different ports, the first wins (later listen errors
  degrade, not crash). No keys, no config editing (R1 untouched).
- Testability: driven end-to-end through a child process — N instances share the hub on an ephemeral
  port; the parent drives the real server over HTTP (fetch + SSE).

## Status
done

## Change log
- 2026-06-13: node created — browser chat channel replacing the terminal channel; refcounted http hub,
  per-agent SSE isolation (R6), sent/read delivery status (read on llm.return), dependency-free page.
- 2026-06-13: setup() awaits the server bind so the URL is announced inside the agent startup block (was an async listen callback landing after the run summary); real bound port; bind clash prints a ✖ note and degrades.
- 2026-06-13: chat page switched to Bootstrap Icons (CDN: bi-send-fill send button, bi-check/bi-check-all ticks, bi-bell* notify toggle) and added browser push notifications — a header bell opts in; replies raise a Notification while the tab is backgrounded.
- 2026-06-13: security — server binds loopback (config.web.host, default 127.0.0.1; was all interfaces) and every /api route requires a per-process session token (random base64url or config.web.token), presented via HttpOnly cookie / ?token= / Bearer and checked constant-time; tokenized startup URL; GET / sets the cookie on a valid token; page shows a locked notice on 401.
