# Node: inspector (plugin)

## Purpose
The browser **debug/analysis** surface — a read-only sibling of `web`. Where `web` is a chat
*channel* (it injects `input.message` and wakes beats), `inspector` is a passive *observability*
window: it subscribes to a running Agent's bus and renders, live, every prompt sent, every reply
received, the whole event timeline (the "event queue"), and the detailed log stream — so a developer
can see exactly how the Agent is working. It is **strictly read-only**: it emits NOTHING onto the bus
(no `input.message`, no `clock.fire_now`, no actions), so it can never perturb the Agent it observes.
That non-interference is its defining invariant.

## Manifest
`{ id: "inspector", version: "0.1.0" }`

## Behavior (spec)
- **Process resource — own refcounted hub.** Like `web`, `inspector` owns ONE `node:http` server per
  process, owned by a MODULE-LEVEL hub refcounted by every per-Agent instance (boot runs many agents
  in one process). It is inspector's OWN hub (NOT shared with `web` — R2: plugins never reach into
  each other), on its own port. The hub holds only an opaque per-agent registry
  `{ agentId, ring, sse-clients }`; no Agent can observe another's records — routing is explicit by
  URL (R6 per-agent isolation, identical to web).
- **Per-Agent ring buffer.** Each per-Agent instance keeps a bounded in-memory **ring buffer**
  (default `config.inspector.bufferSize` = 1000 records; FIFO drop-oldest when full, tracking a
  `dropped` counter). This is the live + scrollback buffer; no disk persistence. A single record is
  capped at `config.inspector.maxRecordBytes` (default ~64 KB) — larger payloads (big prompts) are
  truncated with an explicit `…[truncated N bytes]` marker so it is never mistaken for data loss.
- **Record shape:** `{ seq, at, kind, agentId, corrId?, payload }`.
  - `seq` monotonic per-agent (closure counter); `at` = capture time.
  - `kind` ∈ `agent.start | tick | gather | prompt.sent | prompt.received | input | output | tool.result | log`.
  - `corrId` = the Request/Reply `id` for `prompt.sent` / `prompt.received` (and the ToolCall id for
    `tool.result`) — the per-beat correlation key.
- **Subscribes to ALL well-known bus events** (the only way to observe "everything" — there is no
  wildcard; `shared/actions` `Events` is the canonical, enumerable vocabulary). Each handler is
  wrapped so a malformed payload is recorded best-effort and NEVER throws (does not break fan-out):
  | `Events.*` | record `kind` | captured |
  |---|---|---|
  | `AGENT_START` | `agent.start` | agentId |
  | `CLOCK_TICK` | `tick` | seq (beat boundary) |
  | `PROMPT_GATHER` | `gather` | seq |
  | `LLM_REQUEST` | `prompt.sent` | `corrId=id`, full `context.text` (+ `meta`) — the composed prompt |
  | `LLM_RETURN` | `prompt.received` | `corrId=id`, `ok`, `content`, `toolCalls`, `usage`, `error` |
  | `INPUT_MESSAGE` | `input` | text/from/channel/meta |
  | `OUTPUT_MESSAGE` | `output` | text/to/channel/meta |
  | `TOOL_RESULT` | `tool.result` | `corrId=id`, `name`, `ok`, data/error |
  | `LOG` | `log` | `level`, `pluginId` (incl. `core:*`), `text` |
  Note: there is **NO `tool.call` event** — the orchestrator invokes tool actions directly and emits
  only `tool.result` as each settles. The Logs feed includes core-internal lines (tagged
  `core:orchestrator` / `core:loader`) once `agent_instance` bridges the core logger to the bus.
- **setup(ctx):**
  - Register this agent with the hub. The FIRST registration starts the server on the configured port
    (`config.inspector.port`, default 7718) bound to loopback (`config.inspector.host`, default
    `127.0.0.1`) and AWAITS the bind, then `ctx.print`s `✦ Inspector: http://127.0.0.1:<port>/?token=…`
    inside the agent startup block (as web's bind-await fix established).
  - Subscribe every `Events.*` above; each handler pushes a `Record` into this agent's ring and streams
    it to this agent's SSE clients.
- **HTTP routes** (all `/api` + `/` gated by a per-process session token — random base64url or
  `config.inspector.token` — via HttpOnly cookie / `?token=` / Bearer, constant-time compared; 401 ⇒
  page shows a locked notice). This is a READ-ONLY server — no POST:
  - `GET /` → the static debug dashboard page (dependency-free HTML/JS; sets the cookie on a valid token).
  - `GET /api/agents` → `{ agents: string[] }` (online agent ids).
  - `GET /api/agents/:id/snapshot` → `{ records: Record[], dropped: number }` (drain the ring to
    backfill scrollback on connect/reconnect). Unknown id → 404.
  - `GET /api/agents/:id/stream` → SSE; streams each new `Record` as `{ type:"record", record }`.
    Unknown id → 404. (Page calls `/snapshot` first, then opens `/stream`, deduping by `seq`.)
- **Dashboard page** (dependency-free, like web's): an agent selector driving four coordinated panels
  off one SSE feed — **Prompts** (sent composed `context.text` ↔ received `content`/`toolCalls`/`usage`
  or `error`, keyed by `corrId`), **Event stream** (the live timeline / "queue", every record by
  `seq`, color-coded, auto-scroll w/ pause-on-scroll-up), **Logs** (level + `pluginId` filter), and a
  **per-beat timeline** that groups records between `tick`/`gather` boundaries and joins
  `prompt.sent → prompt.received → output/tool.result` by `corrId`.
- **teardown:** unsubscribe ALL stored `Unsub`s; end this agent's SSE clients; deregister from the hub;
  close the server only when the LAST agent has detached (refcount). Mirrors web's discipline.
- **Correlation:** join by the Request `id` the orchestrator echoes on `llm.return` (llm-core
  guarantees reply `id` === request `id`) — NEVER by arrival order (emit is synchronous fan-out and
  overlapping non-blocking beats can reorder returns; this is the race the web read-receipt fix fixed).
- **Notes / limits:** read-only — no keys, no config editing (R1 untouched). An Agent without
  `llm-core` produces no `llm.request`/`llm.return`, so the Prompts panel stays empty for it (the event
  stream + logs still populate). One server per process — if two agents request different ports, the
  first wins (later listen errors degrade, not crash), as in web.

## Config slice
`config["inspector"]` = `{ port?: number (7718), host?: string ("127.0.0.1"), token?: string,
bufferSize?: number (1000), maxRecordBytes?: number (~65536) }`. Opt-in install (a debug tool); list
it in an agent's `plugins`. Placement doesn't matter — read-only, no `provides`/`requires`.

## Testability
Driven end-to-end through a CHILD process, exactly like web: N instances share the hub on an ephemeral
port (first agent `config.port=0`); the parent observes via the REAL server over HTTP (fetch + SSE),
emitting `llm.request`/`llm.return`/`log.entry`/etc. on a chosen agent's bus through a stdin command
loop and asserting they surface in `/snapshot` and `/stream`, correlated by `corrId`, with per-agent
isolation (R6).

## Status
done

## Change log
- 2026-06-14: node created — read-only browser debug/analysis dashboard; own refcounted loopback+token
  http hub, per-agent SSE, bounded in-memory record ring (live + scrollback), subscribes to all
  well-known bus events, correlates prompts by request id; consumes the core-log-to-bus bridge added in
  `agent_instance`.
