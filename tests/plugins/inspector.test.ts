/**
 * Black-box EDGE tests for the `inspector` plugin — the READ-ONLY browser
 * debug/analysis dashboard (a passive sibling of `web`).
 *
 * Contract surface under test (derived ONLY from contracts/plugin + shared/actions
 * + overviews/nodes/inspector.md — NO implementation read; the module may not exist
 * yet, in which case every scenario fails on a clean assertion):
 *
 *   A `Plugin` = { manifest:{id:"inspector",version}, setup(ctx): void|Promise, teardown?() }
 *   and the default module export is a `PluginFactory` (a zero-arg function that
 *   yields a fresh Plugin per Agent).
 *
 *   The plugin owns a PROCESS resource — ONE node:http server, owned by a
 *   MODULE-LEVEL hub refcounted by every per-Agent instance in the process (boot
 *   runs many agents in one process). It is inspector's OWN hub (not web's), on its
 *   own port, bound to LOOPBACK (127.0.0.1) with a per-process session TOKEN.
 *
 *   It EMITS NOTHING on the bus (no input.message, no clock.fire_now, no actions).
 *   It is otherwise read-only over HTTP with ONE exception: the token-gated
 *   POST /api/agents/:id/clear (clear-logs), which mutates only inspector's OWN
 *   capture state (the per-agent ring + persisted events.jsonl) — it never emits.
 *   It SUBSCRIBES to all
 *   well-known `Events.*` and pushes a `Record` { seq, at, kind, agentId, corrId?,
 *   payload } into a bounded per-agent in-memory ring (default bufferSize 1000,
 *   FIFO drop-oldest, tracking `dropped`).
 *
 *   Event -> record `kind` map (from the spec):
 *     agent.start    -> "agent.start"
 *     clock.tick     -> "tick"
 *     prompt.gather  -> "gather"
 *     llm.request    -> "prompt.sent"      (corrId=id; payload carries context.text)
 *     llm.return     -> "prompt.received"  (corrId=id; ok/content/toolCalls/usage/error)
 *     input.message  -> "input"
 *     output.message -> "output"
 *     tool.result    -> "tool.result"      (corrId=id; name/ok/data/error)
 *     log.entry      -> "log"              (level/pluginId incl. core:* / text)
 *   prompt.sent and prompt.received correlate by the request `id` (NEVER by arrival
 *   order). Each handler is wrapped so a malformed payload never throws / breaks fan-out.
 *
 *   HTTP routes (all /api + / are token-gated EXCEPT GET / serves the page WITHOUT a
 *   token; read-only apart from the single POST /clear below):
 *     - GET /                          -> 200 text/html dashboard page (token-free)
 *     - GET /api/agents                -> { agents: string[] } (online ids)
 *     - GET /api/agents/:id/snapshot   -> { records: Record[], dropped: number }; unknown id -> 404
 *     - GET /api/agents/:id/stream     -> SSE; each new record as { type:"record", record }; unknown id -> 404
 *     - POST /api/agents/:id/clear     -> 200 { cleared:true, agentId:id }; unknown/malformed id -> 404;
 *                                         GET/DELETE to /clear -> 404 (single method); missing/wrong
 *                                         token -> 401 BEFORE any mutation (existing /api/agents/* gate).
 *                                         Effect: clears that agent's in-memory ring (snapshot/query
 *                                         afterwards return zero records) AND truncates its persisted
 *                                         events.jsonl via the store's serialized write chain; highestSeq
 *                                         is NOT reset (seq stays monotonic); SSE clients stay connected.
 *   R6: a record emitted on agent A's bus appears in A's snapshot/stream but NOT B's.
 *   Lifecycle: first setup binds the server; last teardown closes it (port freed).
 *
 * Driven END-TO-END in a CHILD process, exactly like web: the child builds N
 * per-Agent instances sharing the module hub on an EPHEMERAL port (first agent
 * config.port=0), reports the bound port (via the printed URL), and runs a stdin
 * command loop so the PARENT can EMIT bus events on a chosen agent's bus (inspector
 * never emits — the parent does, to simulate the orchestrator/core) and then read
 * them back over the REAL server via HTTP (fetch + SSE).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const REPO = path.resolve(".");
const EVENT_SYSTEM_URL = pathToFileURL(
  path.resolve(REPO, "packages", "event-system", "src", "index.ts"),
).href;
const PLUGIN_URL = pathToFileURL(
  path.resolve(REPO, "public_plugin", "inspector", "index.ts"),
).href;
// The per-agent persisted store module — imported DIRECTLY (in-process, via tsx)
// by the EventStore.clear() unit test below, which needs to drive the serialized
// write chain (append → clear → append) and re-load the file to observe truncation.
const STORE_URL = pathToFileURL(
  path.resolve(REPO, "public_plugin", "inspector", "store.ts"),
).href;

let TMP: string;
test.before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-inspector-"));
});
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// --------------------------------------------------------------------------
// Child harness: builds N inspector-plugin instances sharing the module hub,
// reports the bound port (in the printed ✦ Inspector URL), and runs a stdin
// command loop the PARENT uses to EMIT well-known bus events on a chosen agent's
// bus (inspector subscribes; the parent stands in for the orchestrator/core):
//
//   req   <id> <reqId> <text>   -> emit llm.request{ id:reqId, data:{ context:{ text } } }
//   ret   <id> <reqId> <content>-> emit llm.return{ id:reqId, ok:true, data:{ content } }
//   reterr<id> <reqId> <error>  -> emit llm.return{ id:reqId, ok:false, error }
//   log   <id> <lvl> <pid> <txt>-> emit log.entry{ data:{ level, pluginId, text } }
//   in    <id> <text>           -> emit input.message{ data:{ text } }
//   out   <id> <text>           -> emit output.message{ data:{ text } }
//   tool  <id> <callId> <name>  -> emit tool.result{ id:callId, ok:true, name, data:{} }
//   tick  <id> <seq>            -> emit clock.tick{ data:{ seq } }
//   gather<id> <seq>            -> emit prompt.gather{ data:{ seq } }
//   start <id>                  -> emit agent.start{ data:{ agentId:id } }
//   bad   <id> <ev>             -> emit a MALFORMED envelope for event <ev> (no data)
//   flood <id> <n>              -> emit n input.message events (ring-bound stress)
//   down  <id>                  -> teardown that agent's instance (TORE_DOWN:<id>)
//   quit                        -> teardown all + exit
//
// Full envelopes per shared/actions are emitted (Notify {at,data} / Request
// {id,at,data} / Reply {id,at,ok,data?,error?}).
// --------------------------------------------------------------------------
const CHILD = `
import { createEventSystem } from ${JSON.stringify(EVENT_SYSTEM_URL)};
import * as readline from "node:readline";
function emit(s){ process.stdout.write(s + "\\n"); }

const E = {
  AGENT_START: "agent.start",
  CLOCK_TICK: "clock.tick",
  PROMPT_GATHER: "prompt.gather",
  LLM_REQUEST: "llm.request",
  LLM_REQUEST_SENT: "llm.request.sent",
  LLM_RETURN: "llm.return",
  INPUT_MESSAGE: "input.message",
  OUTPUT_MESSAGE: "output.message",
  TOOL_RESULT: "tool.result",
  LOG: "log.entry",
};

const AGENTS = (process.env.INS_AGENTS || "alice,bob").split(",").filter(Boolean);
// Optional per-agent bufferSize, comma-aligned with AGENTS (e.g. "3,1000").
const BUFS = (process.env.INS_BUFS || "").split(",");
// Optional per-agent persist flag, comma-aligned with AGENTS (e.g. "false,true").
// Absent/blank ⇒ leave config.inspector.persist unset (defaults ON per the config
// slice). "false"/"0"/"off" ⇒ persist:false (in-memory-only, store null).
const PERSIST = (process.env.INS_PERSIST || "").split(",");
const instances = {};

function makeCtx(agentId, port, bufferSize, persist){
  const sys = createEventSystem();
  const blocks = new Map();
  const inspectorCfg = { port };
  if (bufferSize !== undefined && bufferSize !== "" && bufferSize !== null) {
    inspectorCfg.bufferSize = Number(bufferSize);
  }
  if (persist !== undefined && persist !== "" && persist !== null) {
    const p = String(persist).toLowerCase();
    inspectorCfg.persist = !(p === "false" || p === "0" || p === "off" || p === "no");
  }
  return { sys, ctx: {
    agentId,
    events: sys.events,
    actions: sys.actions,
    // inspector reads its slice from config.inspector (per the config slice spec).
    config: { inspector: inspectorCfg, port },
    dataDir: process.env.INS_DATADIR,
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b) => { blocks.set(b.id, b); },
    getBlock: (id) => blocks.get(id),
    removeBlock: (id) => blocks.delete(id),
    listBlocks: () => [...blocks.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    print: (t) => { emit("PRINT:" + t); },
  } };
}

const mod = await import(${JSON.stringify(PLUGIN_URL)}).then((m) => m, () => null);
if (!mod || typeof mod.default !== "function") { emit("NOT_IMPLEMENTED"); process.exit(0); }

let isFirst = true;
let bi = 0;
for (const a of AGENTS) {
  const { sys, ctx } = makeCtx(a, isFirst ? 0 : 7718, BUFS[bi], PERSIST[bi]);
  isFirst = false; bi++;
  const plugin = mod.default();
  await plugin.setup(ctx);
  instances[a] = { plugin, sys };
}
emit("SETUP_DONE");

function busEmit(id, name, env){ if (instances[id]) instances[id].sys.events.emit(name, env); }
function splitN(s, n){
  // split into at most n parts, last part keeps the remaining (text may have spaces)
  const out = []; let rest = s;
  for (let k = 0; k < n - 1; k++) {
    const i = rest.indexOf(" ");
    if (i === -1) { out.push(rest); rest = ""; break; }
    out.push(rest.slice(0, i)); rest = rest.slice(i + 1);
  }
  if (out.length < n) out.push(rest);
  return out;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const t = line.replace(/\\r$/, "");
  if (!t.trim()) return;
  const sp = t.indexOf(" ");
  const op = sp === -1 ? t.trim() : t.slice(0, sp);
  const rest = sp === -1 ? "" : t.slice(sp + 1);
  try {
    if (op === "req") {
      const [id, rid, text] = splitN(rest, 3);
      busEmit(id, E.LLM_REQUEST, { id: rid, at: Date.now(), data: { context: { text: text || "" } } });
    } else if (op === "reqsent") {
      // emit llm.request.sent{ id:reqId, data:{ request: LLMRequest } } — the
      // DISPATCHED request (new vocabulary). Mirrors the "req" op but carries the
      // full Request<{ request }> envelope so the captured payload exposes
      // data.request.{system,messages,tools,temperature}.
      const [id, rid] = splitN(rest, 2);
      busEmit(id, E.LLM_REQUEST_SENT, {
        id: rid,
        at: Date.now(),
        data: {
          request: {
            system: "SYS",
            messages: [{ role: "user", content: "hi", name: "web-chat" }],
            tools: [{ name: "time.now" }],
            temperature: 0.7,
          },
        },
      });
    } else if (op === "ret") {
      const [id, rid, content] = splitN(rest, 3);
      busEmit(id, E.LLM_RETURN, { id: rid, at: Date.now(), ok: true, data: { content: content || "", toolCalls: [] } });
    } else if (op === "reterr") {
      const [id, rid, err] = splitN(rest, 3);
      busEmit(id, E.LLM_RETURN, { id: rid, at: Date.now(), ok: false, error: err || "boom" });
    } else if (op === "log") {
      const [id, lvl, pid, txt] = splitN(rest, 4);
      busEmit(id, E.LOG, { at: Date.now(), data: { level: lvl, pluginId: pid, text: txt || "" } });
    } else if (op === "in") {
      const [id, text] = splitN(rest, 2);
      busEmit(id, E.INPUT_MESSAGE, { at: Date.now(), data: { text: text || "" } });
    } else if (op === "out") {
      const [id, text] = splitN(rest, 2);
      busEmit(id, E.OUTPUT_MESSAGE, { at: Date.now(), data: { text: text || "" } });
    } else if (op === "tool") {
      const [id, cid, name] = splitN(rest, 3);
      busEmit(id, E.TOOL_RESULT, { id: cid, at: Date.now(), ok: true, name: name || "t", data: {} });
    } else if (op === "tick") {
      const [id, seq] = splitN(rest, 2);
      busEmit(id, E.CLOCK_TICK, { at: Date.now(), data: { seq: Number(seq) || 0 } });
    } else if (op === "gather") {
      const [id, seq] = splitN(rest, 2);
      busEmit(id, E.PROMPT_GATHER, { at: Date.now(), data: { seq: Number(seq) || 0 } });
    } else if (op === "start") {
      const id = rest.trim();
      busEmit(id, E.AGENT_START, { at: Date.now(), data: { agentId: id } });
    } else if (op === "bad") {
      const [id, ev] = splitN(rest, 2);
      const name = E[ev] || ev;
      // Deliberately malformed: no/garbage envelope. Inspector handlers must
      // record best-effort and NEVER throw (must not break fan-out).
      busEmit(id, name, undefined);
      busEmit(id, name, {});
      busEmit(id, name, { at: Date.now() });
    } else if (op === "flood") {
      const [id, n] = splitN(rest, 2);
      const count = Number(n) || 0;
      for (let k = 0; k < count; k++) busEmit(id, E.INPUT_MESSAGE, { at: Date.now(), data: { text: "f" + k } });
    } else if (op === "down") {
      const id = rest.trim();
      if (instances[id] && instances[id].plugin.teardown) await instances[id].plugin.teardown();
      emit("TORE_DOWN:" + id);
      delete instances[id];
    } else if (op === "quit") {
      for (const k of Object.keys(instances)) { try { instances[k].plugin.teardown && await instances[k].plugin.teardown(); } catch {} }
      emit("BYE");
      process.exit(0);
    }
    emit("DONE:" + op);
  } catch (e) {
    emit("ERR:" + op + ":" + (e && e.message ? e.message : String(e)));
  }
});
`;

interface Child {
  proc: ChildProcess;
  port: number;
  token: string;
  /** The shared inspector dataDir; persisted files live at <dataDir>/<id>/events.jsonl. */
  dataDir: string;
  lines: string[];
  send(cmd: string): void;
  waitFor(pred: (lines: string[]) => boolean, ms?: number): Promise<boolean>;
  close(): Promise<void>;
  notImplemented: boolean;
}

/**
 * @param bufs    optional per-agent bufferSize, comma-aligned with `agents`.
 * @param persist optional per-agent persist flag (boolean), comma-aligned with
 *                `agents`; omit an entry (or the whole array) to leave persist at
 *                its config default (ON). Pass `false` for an in-memory-only agent.
 */
async function startChild(
  agents: string[],
  bufs?: number[],
  persist?: boolean[],
): Promise<Child> {
  const dataDir = fs.mkdtempSync(path.join(TMP, "data-"));
  const scriptPath = path.join(fs.mkdtempSync(path.join(TMP, "child-")), "inspector-harness.mts");
  fs.writeFileSync(scriptPath, CHILD, "utf8");

  const proc = spawn(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: REPO,
    env: {
      ...process.env,
      INS_AGENTS: agents.join(","),
      INS_DATADIR: dataDir,
      INS_BUFS: bufs ? bufs.join(",") : "",
      INS_PERSIST: persist ? persist.map((p) => String(p)).join(",") : "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Writing to a child that has already exited (e.g. it printed NOT_IMPLEMENTED
  // and called process.exit) surfaces EPIPE as an async 'error' event on the
  // stream — which would otherwise become an uncaught exception and fail an
  // unrelated test. Swallow it; the child being gone is exactly what we want.
  proc.stdin.on("error", () => {
    /* child already gone */
  });

  const lines: string[] = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.length) lines.push(l);
    }
  });
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => (stderr += d));

  const waitFor = (pred: (lines: string[]) => boolean, ms = 8000): Promise<boolean> =>
    new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const tick = () => {
        if (pred(lines)) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 15);
      };
      tick();
    });

  const child: Child = {
    proc,
    port: 0,
    token: "",
    dataDir,
    lines,
    send: (cmd) => {
      try {
        proc.stdin.write(cmd + "\n");
      } catch {
        /* gone */
      }
    },
    waitFor,
    notImplemented: false,
    close: () =>
      new Promise<void>((resolve) => {
        // If the child already exited (e.g. it printed NOT_IMPLEMENTED and
        // called process.exit before we attached this listener), 'close' will
        // never fire again — resolve immediately so the test's finally never hangs.
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
        const done = () => resolve();
        proc.once("close", done);
        try {
          proc.stdin.write("quit\n");
        } catch {
          /* gone */
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* dead */
          }
        }, 2500);
      }),
  };

  // Wait for either NOT_IMPLEMENTED or SETUP_DONE + the printed Inspector URL.
  const up = await waitFor(
    (ls) =>
      ls.includes("NOT_IMPLEMENTED") ||
      (ls.includes("SETUP_DONE") && ls.some((l) => l.startsWith("PRINT:"))),
    9000,
  );
  if (!up) {
    await child.close();
    throw new Error("inspector child never came up. stderr:\n" + stderr.slice(0, 1200));
  }
  if (lines.includes("NOT_IMPLEMENTED")) {
    child.notImplemented = true;
    return child;
  }
  // The Inspector URL line: ✦ Inspector: http://127.0.0.1:<port>/?token=…
  const urlLine = lines.find(
    (l) => l.startsWith("PRINT:") && /http:\/\/[^\s]+:\d+/.test(l) && /token=/.test(l),
  );
  const m = urlLine ? /:(\d+)\b/.exec(urlLine.replace("PRINT:", "")) : null;
  child.port = m ? parseInt(m[1], 10) : 0;
  const tk = urlLine ? /[?&]token=([^\s&]+)/.exec(urlLine) : null;
  child.token = tk ? decodeURIComponent(tk[1]) : "";
  return child;
}

function assertUp(c: Child): void {
  assert.ok(
    !c.notImplemented,
    "inspector plugin not implemented yet: public_plugin/inspector/index.ts missing or no default factory",
  );
  assert.ok(c.port > 0, "the hub must bind a port and print its URL (got port " + c.port + ")");
}

const base = (c: Child) => "http://127.0.0.1:" + c.port;

/** A full /api URL carrying the session token (so authed requests pass). */
function api(c: Child, p: string): string {
  const sep = p.includes("?") ? "&" : "?";
  return base(c) + p + (c.token ? sep + "token=" + encodeURIComponent(c.token) : "");
}

interface SSEHandle {
  events: any[];
  status: number;
  close: () => void;
}

/** Open an SSE stream and accumulate parsed `data:` JSON payloads. */
async function openSSE(c: Child, id: string): Promise<SSEHandle> {
  const ac = new AbortController();
  const res = await fetch(api(c, "/api/agents/" + id + "/stream"), { signal: ac.signal });
  const events: any[] = [];
  if (res.body) {
    (async () => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let sbuf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          sbuf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = sbuf.indexOf("\n\n")) !== -1) {
            const chunk = sbuf.slice(0, idx);
            sbuf = sbuf.slice(idx + 2);
            const dl = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (dl) {
              try {
                events.push(JSON.parse(dl.slice(5).trim()));
              } catch {
                /* skip non-JSON keepalives */
              }
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }
  return { events, status: res.status, close: () => ac.abort() };
}

const waitEvents = async (
  events: any[],
  pred: (e: any[]) => boolean,
  ms = 6000,
): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!pred(events)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 15));
  }
  return true;
};

/** Wait for a single command to be acked by the child (DONE:<op>) past a mark. */
const sendAndWait = async (c: Child, cmd: string, op: string): Promise<void> => {
  const before = c.lines.filter((l) => l === "DONE:" + op).length;
  c.send(cmd);
  await c.waitFor((ls) => ls.filter((l) => l === "DONE:" + op).length > before, 4000);
};

/** Fetch + parse the snapshot for an agent (authed). */
async function snapshot(
  c: Child,
  id: string,
): Promise<{ status: number; records: any[]; dropped: number }> {
  const res = await fetch(api(c, "/api/agents/" + id + "/snapshot"));
  if (res.status !== 200) return { status: res.status, records: [], dropped: 0 };
  const body = (await res.json()) as { records: any[]; dropped: number };
  return { status: res.status, records: body.records || [], dropped: body.dropped || 0 };
}

/** Poll the snapshot until a predicate holds over its records. */
async function waitSnapshot(
  c: Child,
  id: string,
  pred: (records: any[]) => boolean,
  ms = 6000,
): Promise<any[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const snap = await snapshot(c, id);
    if (snap.status === 200 && pred(snap.records)) return snap.records;
    if (Date.now() > deadline) return snap.records;
    await new Promise((r) => setTimeout(r, 30));
  }
}

const flat = (s: any): string => {
  try {
    return JSON.stringify(s);
  } catch {
    return String(s);
  }
};

/** GET /api/agents/:id/query (authed); returns the documented { records, total, dropped } shape. */
async function query(
  c: Child,
  id: string,
): Promise<{ status: number; records: any[]; total: number; dropped: number }> {
  const res = await fetch(api(c, "/api/agents/" + id + "/query"));
  if (res.status !== 200) return { status: res.status, records: [], total: 0, dropped: 0 };
  const body = (await res.json()) as { records: any[]; total: number; dropped: number };
  return {
    status: res.status,
    records: body.records || [],
    total: typeof body.total === "number" ? body.total : 0,
    dropped: body.dropped || 0,
  };
}

/**
 * POST /api/agents/:id/clear WITH the session token (authed). Returns the parsed
 * status + body so a test can assert the { cleared:true, agentId } contract.
 */
async function clear(
  c: Child,
  id: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(api(c, "/api/agents/" + id + "/clear"), { method: "POST" });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ===========================================================================
// Scenario 1 — PluginFactory / manifest shape (positive + structure)
// ===========================================================================

test("inspector: default export is a factory yielding { manifest:{id:'inspector',version}, setup, teardown }", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // If we got here without NOT_IMPLEMENTED, the default export was a function
    // and setup() ran. The printed startup line proves a Plugin with a working
    // setup was constructed per agent.
    assert.ok(
      c.lines.includes("SETUP_DONE"),
      "the factory built a Plugin and setup() completed for the agent",
    );
    // Manifest id is asserted indirectly through the branded startup line below;
    // here we confirm the agent is registered, which only a wired setup achieves.
    const res = await fetch(api(c, "/api/agents"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: string[] };
    assert.deepEqual(body.agents, ["alice"], "the constructed instance registered its agent");
  } finally {
    await c.close();
  }
});

test("inspector: manifest id is branded 'inspector' in the startup line", async () => {
  const c = await startChild(["solo"]);
  try {
    assertUp(c);
    const urlLine = c.lines.find((l) => l.startsWith("PRINT:") && /Inspector/i.test(l)) || "";
    assert.match(
      urlLine,
      /Inspector/i,
      "the startup line must brand the plugin as Inspector: " + flat(c.lines),
    );
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 2 — setup announces a tokenized LOOPBACK url DURING setup
// (printed BEFORE SETUP_DONE, like web's bind-await timing test)
// ===========================================================================

test("inspector: setup announces a tokenized loopback URL DURING setup (before SETUP_DONE)", async () => {
  const c = await startChild(["solo"]);
  try {
    assertUp(c);
    const printIdx = c.lines.findIndex(
      (l) => l.startsWith("PRINT:") && /Inspector/i.test(l) && /127\.0\.0\.1/.test(l) && /token=/.test(l),
    );
    const doneIdx = c.lines.findIndex((l) => l === "SETUP_DONE");
    assert.ok(printIdx !== -1, "the Inspector URL must be printed: " + flat(c.lines));
    assert.ok(doneIdx !== -1, "setup must complete");
    assert.ok(
      printIdx < doneIdx,
      "the URL must be announced before setup completes (it lands in the agent's startup block); " +
        "print@" + printIdx + " vs SETUP_DONE@" + doneIdx,
    );
  } finally {
    await c.close();
  }
});

test("inspector: the startup URL carries a non-trivial session token and binds loopback (127.0.0.1)", async () => {
  const c = await startChild(["solo"]);
  try {
    assertUp(c);
    assert.ok(
      c.token.length >= 16,
      "a non-trivial session token is generated: " + JSON.stringify(c.token),
    );
    const urlLine = c.lines.find((l) => l.startsWith("PRINT:") && /Inspector/i.test(l)) || "";
    assert.match(urlLine, /127\.0\.0\.1/, "the server binds loopback (URL is 127.0.0.1, not all interfaces)");
    assert.match(urlLine, /[?&]token=/, "the printed URL carries the token");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 3 — GET / serves an HTML dashboard page WITHOUT a token
// ===========================================================================

test("inspector: GET / serves an HTML dashboard page", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(base(c) + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<\/html>|<!doctype|<div|<script/i, "the page must be HTML");
  } finally {
    await c.close();
  }
});

test("inspector: GET / serves the page WITHOUT a token (the page holds no secrets)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(base(c) + "/");
    assert.equal(res.status, 200, "the page itself is not token-gated");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 4 — GET /api/agents lists every registered agent; token-gated
// ===========================================================================

test("inspector: GET /api/agents lists every registered agent", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: string[] };
    assert.deepEqual([...body.agents].sort(), ["alice", "bob"], "both agents are listed online");
  } finally {
    await c.close();
  }
});

test("inspector: GET /api/agents is token-gated (401 without token, 401 with wrong token)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const noTok = await fetch(base(c) + "/api/agents");
    assert.equal(noTok.status, 401, "GET /api/agents requires the token");
    const badTok = await fetch(base(c) + "/api/agents?token=not-the-real-token");
    assert.equal(badTok.status, 401, "a wrong token is rejected");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 5 — Capture llm.request -> "prompt.sent" with corrId + composed text
// (visible in BOTH /snapshot and a live /stream)
// ===========================================================================

test("inspector: llm.request becomes a 'prompt.sent' record carrying corrId + composed context.text (snapshot)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    await sendAndWait(c, "req alice R1 PROMPT-TEXT", "req");
    const recs = await waitSnapshot(c, "alice", (rs) =>
      rs.some((r) => r.kind === "prompt.sent" && r.corrId === "R1"),
    );
    const sent = recs.find((r) => r.kind === "prompt.sent" && r.corrId === "R1");
    assert.ok(sent, "a prompt.sent record with corrId R1 must appear: " + flat(recs));
    assert.equal(sent.agentId, "alice", "the record is tagged with the emitting agent");
    assert.match(
      flat(sent.payload),
      /PROMPT-TEXT/,
      "the record payload carries the composed context text",
    );
  } finally {
    await c.close();
  }
});

test("inspector: a live /stream emits the prompt.sent record as { type:'record', record }", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const s = await openSSE(c, "alice");
    assert.equal(s.status, 200, "the stream opens for a known agent");
    await sendAndWait(c, "req alice R7 LIVE-PROMPT", "req");
    const ok = await waitEvents(s.events, (e) =>
      e.some(
        (x) =>
          x.type === "record" &&
          x.record &&
          x.record.kind === "prompt.sent" &&
          x.record.corrId === "R7" &&
          /LIVE-PROMPT/.test(flat(x.record.payload)),
      ),
    );
    assert.ok(ok, "the live record arrives over SSE as {type:'record',record}: " + flat(s.events));
    s.close();
  } finally {
    await c.close();
  }
});

test("inspector: llm.request.sent is captured as a 'prompt.sent' record carrying data.request (corrId = id)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // Emit the DISPATCHED request (new `llm.request.sent` vocabulary). It maps to
    // the SAME dashboard kind ("prompt.sent") as `llm.request`, with corrId=id and
    // the full LLMRequest carried under payload.data.request, so it pairs by corrId.
    await sendAndWait(c, "reqsent alice RS1", "reqsent");
    const recs = await waitSnapshot(c, "alice", (rs) =>
      rs.some(
        (r) =>
          r.kind === "prompt.sent" &&
          r.corrId === "RS1" &&
          r.payload &&
          r.payload.data &&
          r.payload.data.request,
      ),
    );
    const sent = recs.find((r) => r.kind === "prompt.sent" && r.corrId === "RS1");
    assert.ok(sent, "a prompt.sent record with corrId RS1 must appear: " + flat(recs));
    assert.equal(sent.agentId, "alice", "the record is tagged with the emitting agent");
    assert.ok(
      sent.payload && sent.payload.data && sent.payload.data.request,
      "the record payload carries the dispatched request under data.request: " + flat(sent.payload),
    );
    const req = sent.payload.data.request;
    assert.equal(req.messages.length, 1, "the captured request carries its one message");
    assert.equal(req.tools.length, 1, "the captured request carries its one tool");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 6 — Correlation: llm.return -> "prompt.received" SAME corrId as the sent
// ===========================================================================

test("inspector: llm.return becomes a 'prompt.received' record with the SAME corrId as the prompt.sent (correlation by id)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    await sendAndWait(c, "req alice R1 ASK", "req");
    await sendAndWait(c, "ret alice R1 REPLY", "ret");
    const recs = await waitSnapshot(
      c,
      "alice",
      (rs) =>
        rs.some((r) => r.kind === "prompt.sent" && r.corrId === "R1") &&
        rs.some((r) => r.kind === "prompt.received" && r.corrId === "R1"),
    );
    const sent = recs.find((r) => r.kind === "prompt.sent" && r.corrId === "R1");
    const received = recs.find((r) => r.kind === "prompt.received" && r.corrId === "R1");
    assert.ok(sent, "the prompt.sent record exists");
    assert.ok(received, "the prompt.received record exists");
    assert.equal(
      received.corrId,
      sent.corrId,
      "received correlates to sent by the request id (NEVER by arrival order)",
    );
    assert.match(flat(received.payload), /REPLY/, "the received payload carries the reply content");
  } finally {
    await c.close();
  }
});

test("inspector: a FAILED llm.return (ok:false) still records prompt.received carrying the error", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    await sendAndWait(c, "req alice RX ASKX", "req");
    await sendAndWait(c, "reterr alice RX kaboom", "reterr");
    const recs = await waitSnapshot(c, "alice", (rs) =>
      rs.some((r) => r.kind === "prompt.received" && r.corrId === "RX"),
    );
    const received = recs.find((r) => r.kind === "prompt.received" && r.corrId === "RX");
    assert.ok(received, "a failed return still produces a prompt.received record");
    assert.match(flat(received.payload), /kaboom/, "the error text is exposed in the payload");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 7 — Logs: log.entry -> "log" exposing level + pluginId (incl. core:*)
// ===========================================================================

test("inspector: log.entry becomes a 'log' record exposing level + pluginId, and core:* pluginIds survive", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    await sendAndWait(c, "log alice warn core:orchestrator frame-stalled", "log");
    const recs = await waitSnapshot(c, "alice", (rs) =>
      rs.some((r) => r.kind === "log" && /core:orchestrator/.test(flat(r.payload))),
    );
    const logRec = recs.find((r) => r.kind === "log" && /core:orchestrator/.test(flat(r.payload)));
    assert.ok(logRec, "a 'log' record for the core line must appear: " + flat(recs));
    assert.match(flat(logRec.payload), /warn/, "the log level is exposed");
    assert.match(
      flat(logRec.payload),
      /core:orchestrator/,
      "the core: pluginId survives (the Logs panel must show core lines)",
    );
    assert.match(flat(logRec.payload), /frame-stalled/, "the log text is exposed");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 8 — Other event kinds map to their record kinds
// ===========================================================================

test("inspector: input.message -> 'input' and output.message -> 'output'", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    await sendAndWait(c, "in alice HELLO-IN", "in");
    await sendAndWait(c, "out alice HELLO-OUT", "out");
    const recs = await waitSnapshot(
      c,
      "alice",
      (rs) => rs.some((r) => r.kind === "input") && rs.some((r) => r.kind === "output"),
    );
    const inp = recs.find((r) => r.kind === "input");
    const outp = recs.find((r) => r.kind === "output");
    assert.ok(inp, "an 'input' record appears for input.message");
    assert.ok(outp, "an 'output' record appears for output.message");
    assert.match(flat(inp.payload), /HELLO-IN/, "input text captured");
    assert.match(flat(outp.payload), /HELLO-OUT/, "output text captured");
  } finally {
    await c.close();
  }
});

test("inspector: tool.result -> 'tool.result' (corrId = ToolCall id) and clock.tick -> 'tick'", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    await sendAndWait(c, "tool alice T9 search", "tool");
    await sendAndWait(c, "tick alice 5", "tick");
    const recs = await waitSnapshot(
      c,
      "alice",
      (rs) => rs.some((r) => r.kind === "tool.result") && rs.some((r) => r.kind === "tick"),
    );
    const tool = recs.find((r) => r.kind === "tool.result");
    const tick = recs.find((r) => r.kind === "tick");
    assert.ok(tool, "a 'tool.result' record appears");
    assert.equal(tool.corrId, "T9", "tool.result corrId is the ToolCall id");
    assert.match(flat(tool.payload), /search/, "the tool name is captured");
    assert.ok(tick, "a 'tick' record appears for clock.tick");
  } finally {
    await c.close();
  }
});

test("inspector: agent.start -> 'agent.start' and prompt.gather -> 'gather'", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    await sendAndWait(c, "start alice", "start");
    await sendAndWait(c, "gather alice 2", "gather");
    const recs = await waitSnapshot(
      c,
      "alice",
      (rs) => rs.some((r) => r.kind === "agent.start") && rs.some((r) => r.kind === "gather"),
    );
    assert.ok(recs.some((r) => r.kind === "agent.start"), "an 'agent.start' record appears");
    assert.ok(recs.some((r) => r.kind === "gather"), "a 'gather' record appears for prompt.gather");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 9 — SSE stream: streams new records live; unknown id 404; token-gated
// ===========================================================================

test("inspector: GET /api/agents/:id/stream streams subsequently-emitted records live", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const s = await openSSE(c, "alice");
    assert.equal(s.status, 200);
    await sendAndWait(c, "in alice STREAMED-INPUT", "in");
    const ok = await waitEvents(s.events, (e) =>
      e.some(
        (x) =>
          x.type === "record" &&
          x.record &&
          x.record.kind === "input" &&
          /STREAMED-INPUT/.test(flat(x.record.payload)),
      ),
    );
    assert.ok(ok, "a new record is streamed live as {type:'record',record}: " + flat(s.events));
    s.close();
  } finally {
    await c.close();
  }
});

test("inspector: SSE to an unknown agent id -> 404", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/ghost/stream"));
    assert.equal(res.status, 404, "unknown agent stream is 404");
  } finally {
    await c.close();
  }
});

test("inspector: SSE stream is token-gated (401 without token)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(base(c) + "/api/agents/alice/stream");
    assert.equal(res.status, 401, "the SSE stream requires the token");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 10 — R6 isolation: a record on agent A's bus is NOT in agent B's view
// ===========================================================================

test("inspector: a record emitted on agent A's bus appears in A's snapshot but NOT B's (R6 isolation)", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    await sendAndWait(c, "in alice ALICE-ONLY", "in");
    const aRecs = await waitSnapshot(c, "alice", (rs) =>
      rs.some((r) => /ALICE-ONLY/.test(flat(r.payload))),
    );
    assert.ok(
      aRecs.some((r) => /ALICE-ONLY/.test(flat(r.payload))),
      "alice's snapshot carries her own record",
    );
    // Give any (erroneous) cross-fanout a chance to land, then assert isolation.
    await new Promise((r) => setTimeout(r, 200));
    const bSnap = await snapshot(c, "bob");
    assert.equal(bSnap.status, 200, "bob's snapshot is reachable");
    assert.ok(
      !bSnap.records.some((r) => /ALICE-ONLY/.test(flat(r.payload))),
      "bob's snapshot must NOT carry alice's record (per-agent isolation)",
    );
  } finally {
    await c.close();
  }
});

test("inspector: an A-bus record does NOT leak into B's live SSE stream (R6 isolation)", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const a = await openSSE(c, "alice");
    const b = await openSSE(c, "bob");
    await sendAndWait(c, "out alice CROSS-CHECK", "out");
    assert.ok(
      await waitEvents(a.events, (e) =>
        e.some((x) => x.type === "record" && /CROSS-CHECK/.test(flat(x.record))),
      ),
      "alice's stream gets her own record",
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      !b.events.some((x) => x.type === "record" && /CROSS-CHECK/.test(flat(x.record))),
      "bob's stream must NOT carry alice's record",
    );
    a.close();
    b.close();
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 11 — Ring bound (BVA): tiny bufferSize -> records.length <= bufferSize,
// dropped > 0 once we exceed it.
// ===========================================================================

test("inspector: the per-agent ring is bounded by config.inspector.bufferSize and tracks dropped (BVA)", async () => {
  // First agent uses port 0 (ephemeral) and bufferSize 3.
  const c = await startChild(["alice"], [3]);
  try {
    assertUp(c);
    // Emit more events than the ring holds (7 > 3).
    await sendAndWait(c, "flood alice 7", "flood");
    const recs = await waitSnapshot(c, "alice", (rs) => rs.length >= 3, 4000);
    const snap = await snapshot(c, "alice");
    assert.equal(snap.status, 200);
    assert.ok(
      snap.records.length <= 3,
      "the ring must never exceed bufferSize=3 (got " + snap.records.length + ")",
    );
    assert.ok(snap.dropped > 0, "dropped must be > 0 once the ring overflowed (got " + snap.dropped + ")");
    void recs;
  } finally {
    await c.close();
  }
});

test("inspector: a ring at exactly bufferSize reports dropped=0 (BVA: at the boundary, nothing dropped yet)", async () => {
  const c = await startChild(["alice"], [3]);
  try {
    assertUp(c);
    // Exactly 3 events into a size-3 ring: full but nothing evicted.
    await sendAndWait(c, "flood alice 3", "flood");
    const recs = await waitSnapshot(c, "alice", (rs) => rs.length >= 3, 4000);
    const snap = await snapshot(c, "alice");
    assert.equal(snap.status, 200);
    assert.ok(snap.records.length <= 3, "must not exceed the bound at the boundary");
    assert.equal(snap.dropped, 0, "exactly bufferSize records means nothing was dropped yet");
    void recs;
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 12 — Token auth across /api (covered above for /api/agents and /stream;
// here: /snapshot gating + reaffirm GET / is open)
// ===========================================================================

test("inspector: GET /api/agents/:id/snapshot is token-gated (401 without/with wrong token)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const noTok = await fetch(base(c) + "/api/agents/alice/snapshot");
    assert.equal(noTok.status, 401, "snapshot requires the token");
    const badTok = await fetch(base(c) + "/api/agents/alice/snapshot?token=wrong");
    assert.equal(badTok.status, 401, "a wrong token is rejected on snapshot");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 13 — Refcounted lifecycle: server up while >=1 agent; closes after last
// ===========================================================================

test("inspector: the port stays open while >=1 agent is registered and closes after the last teardown", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const port = c.port;

    // Tear down alice — server must stay up for bob.
    await sendAndWait(c, "down alice", "down");
    await c.waitFor((ls) => ls.includes("TORE_DOWN:alice"));
    const stillUp = await fetch(api(c, "/api/agents"))
      .then((r) => r.status)
      .catch(() => 0);
    assert.equal(stillUp, 200, "server stays up while bob is still registered");
    const agents = (await fetch(api(c, "/api/agents")).then((r) => r.json())) as {
      agents: string[];
    };
    assert.deepEqual(agents.agents, ["bob"], "alice is gone from the roster, bob remains");

    // Tear down bob — now the port must close.
    await sendAndWait(c, "down bob", "down");
    await c.waitFor((ls) => ls.includes("TORE_DOWN:bob"));
    await new Promise((r) => setTimeout(r, 300));
    let closed = false;
    try {
      await fetch("http://127.0.0.1:" + port + "/api/agents");
    } catch {
      closed = true;
    }
    assert.ok(closed, "after the last agent tears down, the port is released (connection refused)");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 14 — Robustness (error guessing): a malformed payload must not crash
// the server or break fan-out — subsequent requests still 200.
// ===========================================================================

test("inspector: a malformed/empty event payload does not crash the server (handlers never throw)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // Fire malformed envelopes at several event kinds.
    await sendAndWait(c, "bad alice LLM_REQUEST", "bad");
    await sendAndWait(c, "bad alice LLM_RETURN", "bad");
    await sendAndWait(c, "bad alice LOG", "bad");
    await sendAndWait(c, "bad alice INPUT_MESSAGE", "bad");
    // The child must not have reported an unhandled handler error.
    assert.ok(
      !c.lines.some((l) => l.startsWith("ERR:bad")),
      "emitting a malformed payload must not throw out of the handler: " + flat(c.lines.filter((l) => l.startsWith("ERR:"))),
    );
    // The server is still alive and healthy.
    const res = await fetch(api(c, "/api/agents"));
    assert.equal(res.status, 200, "the server still serves requests after malformed events");

    // And a WELL-FORMED event AFTER the malformed ones still gets captured (fan-out intact).
    await sendAndWait(c, "in alice STILL-WORKS", "in");
    const recs = await waitSnapshot(c, "alice", (rs) =>
      rs.some((r) => r.kind === "input" && /STILL-WORKS/.test(flat(r.payload))),
    );
    assert.ok(
      recs.some((r) => r.kind === "input" && /STILL-WORKS/.test(flat(r.payload))),
      "subsequent well-formed events are still captured (a thrown handler did not break fan-out)",
    );
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 15 — snapshot unknown id -> 404 (negative)
// ===========================================================================

test("inspector: GET /api/agents/:id/snapshot for an unknown id -> 404", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/ghost/snapshot"));
    assert.equal(res.status, 404, "unknown agent snapshot is 404");
  } finally {
    await c.close();
  }
});

test("inspector: a known-agent snapshot returns the documented shape { records:[], dropped:number }", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/alice/snapshot"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { records: unknown; dropped: unknown };
    assert.ok(Array.isArray(body.records), "snapshot.records is an array");
    assert.equal(typeof body.dropped, "number", "snapshot.dropped is a number");
  } finally {
    await c.close();
  }
});

// ###########################################################################
// SECURITY REGRESSION TESTS (added) — two hardening fixes in `inspector`.
// These are RED on the pre-fix code and GREEN once the fixes land. They reuse
// the same child-process harness (startChild / assertUp / base / api / c.token)
// as every test above; the child runs a real node:http server on an ephemeral
// port with a pinned+printed session token.
//
//   TEST A — a malformed Cookie on the un-gated GET / must NOT crash the
//            server (regression for an UNAUTHENTICATED denial-of-service):
//            extractToken does decodeURIComponent(cookieValue), which THROWS a
//            URIError on a bad percent-sequence like "%". Pre-fix that throw is
//            uncaught and takes down the whole process — every agent in it.
//
//   TEST B — the dashboard page's esc() must escape quotes (regression for an
//            attribute-injection XSS): esc() is used inside an HTML attribute
//            (class="lvl …") yet pre-fix it only escaped & < > and left " and '
//            intact, so attacker-controlled text could break out of the attribute.
// ###########################################################################

// --- shared helpers for the security regressions ---------------------------

/**
 * Perform a fetch and report whether the server actually answered vs dropped
 * the connection. A crashed/killed server yields a rejected fetch (ECONNREFUSED
 * / ECONNRESET / socket hang up) — that's the "dropped" signal we test for.
 * Never throws; resolves to a small descriptor.
 */
async function probe(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(url, init);
    // Drain the body so the socket is released and the child isn't left with a
    // half-read response (which can wedge keep-alive on some node versions).
    try {
      await res.arrayBuffer();
    } catch {
      /* body errored after headers — still counts as "answered" */
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Pull the body of a top-level `function esc(...) { ... }` declaration out of the
 * dashboard HTML by brace-matching (robust to braces inside regex/string/object
 * literals in the body). Returns { params, body } or null if not found.
 */
function extractFn(
  html: string,
  name: string,
): { params: string; body: string } | null {
  const re = new RegExp("function\\s+" + name + "\\s*\\(([^)]*)\\)\\s*\\{", "g");
  const m = re.exec(html);
  if (!m) return null;
  const params = m[1].trim();
  // Scan from the opening brace to its match, tracking depth. This is a
  // pragmatic balancer — good enough for a small dependency-free page helper;
  // it is not a full JS parser, but esc()'s body is a flat .replace() chain.
  const open = re.lastIndex - 1; // index of the "{" we just matched
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { params, body: html.slice(open + 1, i) };
      }
    }
  }
  return null;
}

// ===========================================================================
// SEC-A — malformed Cookie on GET / must not crash the server (DoS regression)
// ===========================================================================

test("inspector(security): a malformed percent-encoded Cookie on GET / does NOT crash the server", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);

    // 1) The un-gated page request carrying a malformed cookie value. "%" is a
    //    truncated percent-escape; decodeURIComponent("%") throws URIError.
    //    Pre-fix the uncaught throw crashes the process. The request itself must
    //    NOT hang or drop — it must yield SOME status (the page on tolerant
    //    parsing, or a 4xx; never a refused/reset socket).
    const first = await probe(base(c) + "/", { headers: { cookie: "inspector_token=%" } });
    assert.ok(
      first.ok,
      "GET / with a malformed cookie must return a response, not drop the connection " +
        "(got network error: " + (first.error || "") + ")",
    );
    assert.ok(
      first.status === 200 || (first.status >= 400 && first.status < 500),
      "GET / with a malformed cookie must answer with 200 or a 4xx, got " + first.status,
    );

    // 2) THE crash detector: a subsequent, well-formed authed request must still
    //    be served. Pre-fix the process is gone and this fetch is refused.
    const after = await probe(api(c, "/api/agents"));
    assert.ok(
      after.ok,
      "the server must still be alive after the malformed cookie (the subsequent " +
        "request was dropped — the process crashed: " + (after.error || "") + ")",
    );
    assert.equal(
      after.status,
      200,
      "a normal authed GET /api/agents after the malformed cookie must return 200 (server survived)",
    );

    // 3) And the agent roster is intact — the per-agent state did not die with it.
    const body = (await fetch(api(c, "/api/agents")).then((r) => r.json())) as { agents: string[] };
    assert.deepEqual(body.agents, ["alice"], "the agent is still registered after the malformed cookie");
  } finally {
    await c.close();
  }
});

test("inspector(security): a malformed percent-encoded :id on a token-gated path returns 4xx, not a crash", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);

    // A token-gated route whose :id segment is a bad percent-escape ("%").
    // Decoding the path segment must not throw out of the handler; the route
    // should resolve as a normal unknown-id 404 (it is certainly not a live agent).
    const malformed = await probe(api(c, "/api/agents/%/snapshot"));
    assert.ok(
      malformed.ok,
      "GET /api/agents/%/snapshot must return a response, not drop the connection " +
        "(got network error: " + (malformed.error || "") + ")",
    );
    assert.equal(
      malformed.status,
      404,
      "a malformed percent-encoded agent id resolves to a normal 404, got " + malformed.status,
    );

    // Crash detector: the server is still healthy afterwards.
    const after = await probe(api(c, "/api/agents"));
    assert.ok(after.ok, "server must survive the malformed :id (subsequent request dropped: " + (after.error || "") + ")");
    assert.equal(after.status, 200, "a normal request after the malformed :id must return 200 (server survived)");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// SEC-B — the dashboard page's esc() must escape quotes (attribute-injection XSS)
// ===========================================================================

test("inspector(security): the dashboard page's esc() escapes BOTH double- and single-quotes", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);

    const html = await fetch(base(c) + "/").then((r) => r.text());
    const fn = extractFn(html, "esc");
    assert.ok(
      fn && fn.body.length > 0,
      "the page must define a `function esc(...)` helper (could not extract it from the HTML)",
    );

    // Preferred, BEHAVIORAL check: reconstruct esc() from the page source and
    // run it. CRITICAL: only the *reconstruction* may be caught (an unusual body
    // shape we cannot rebuild) — the behavioral assertions themselves must
    // PROPAGATE, never be swallowed into the weaker source fallback. So we build
    // `escFn` inside a narrow try, then assert OUTSIDE it.
    //
    // The extracted body is a COMPLETE function body (it has its own `return`),
    // so reconstruct it directly; only if that fails to yield a 1-arg
    // string->string function do we try the expression-wrapped form (for an esc
    // written as a bare expression) and then the source-level fallback.
    let escFn: ((x: string) => string) | null = null;
    try {
      // eslint-disable-next-line no-new-func
      const cand = new Function(fn!.params || "s", fn!.body) as (x: string) => string;
      if (typeof cand("x") !== "string") throw new Error("non-string");
      escFn = cand;
    } catch {
      try {
        // eslint-disable-next-line no-new-func
        const cand = new Function(fn!.params || "s", "return (" + fn!.body + "\n);") as (
          x: string,
        ) => string;
        if (typeof cand("x") !== "string") throw new Error("non-string");
        escFn = cand;
      } catch {
        escFn = null;
      }
    }

    if (escFn) {
      const esc = escFn;
      const dq = esc('a"b');
      const sq = esc("a'b");
      // Sanity: it must still escape the basics it already did, so we know we ran
      // the real helper and not a no-op.
      const lt = esc("a<b>c");
      assert.ok(typeof dq === "string" && typeof sq === "string", "esc() must return a string");
      assert.ok(!lt.includes("<") && !lt.includes(">"), "esc() must still escape < and > (ran the real helper)");

      assert.ok(
        !dq.includes('"'),
        'esc(\'a"b\') must not contain a bare double-quote (attribute injection); got ' + JSON.stringify(dq),
      );
      assert.ok(
        /&quot;|&#0*34;|&#x0*22;/i.test(dq),
        'esc() must entity-encode " as &quot; / &#34; / &#x22;; got ' + JSON.stringify(dq),
      );
      assert.ok(
        !sq.includes("'"),
        "esc(\"a'b\") must not contain a bare single-quote (attribute injection); got " + JSON.stringify(sq),
      );
      assert.ok(
        /&#0*39;|&#x0*27;|&apos;/i.test(sq),
        "esc() must entity-encode ' as &#39; / &#x27; / &apos;; got " + JSON.stringify(sq),
      );
    } else {
      // Could not reconstruct esc() — fall back to a strictly-weaker source guard
      // that still FAILS if quote-escaping is absent from the body text.
      const src = fn!.body;
      assert.ok(
        /&quot;|&#0*34;|&#x0*22;/i.test(src),
        "esc()'s source must map the double-quote to an HTML entity (&quot;/&#34;/&#x22;); body: " + src,
      );
      assert.ok(
        /&#0*39;|&#x0*27;|&apos;/i.test(src),
        "esc()'s source must map the single-quote to an HTML entity (&#39;/&#x27;/&apos;); body: " + src,
      );
    }
  } finally {
    await c.close();
  }
});

// ###########################################################################
// RING-BUFFER EVICTION GUARD (added) — pins the FIFO drop-oldest semantics so an
// upcoming internal rewrite of the eviction mechanism cannot regress them. This
// is GREEN on today's code; it deliberately over-specifies the *observable*
// contract (cap, order, dropped count, monotonic seq) so the rewrite is held to
// the exact same behavior, not merely "bounded + some dropped".
// ###########################################################################

// ===========================================================================
// Ring eviction — drop-oldest at capacity, order preserved, accurate `dropped`,
// strictly-increasing seq, retained == the highest `bufferSize` seqs.
// ===========================================================================

test("inspector: the ring evicts oldest-first at capacity, preserves order, and reports an exact dropped count (FIFO guard)", async () => {
  const SIZE = 5;
  const N = 10; // emit twice the capacity so exactly N-SIZE get evicted FIFO
  // First (and only) agent: ephemeral port 0 + bufferSize 5.
  const c = await startChild(["alice"], [SIZE]);
  try {
    assertUp(c);

    // Drive N distinct, ORDERED events onto alice's bus. log.entry carries
    // observable `text`, so each record's payload pins its identity AND its
    // emission order. Wait for each ack so the emission order is deterministic
    // (the bus delivers synchronously, but we serialize to be unambiguous).
    for (let i = 0; i < N; i++) {
      await sendAndWait(c, "log alice info core:test evt-" + i, "log");
    }

    // Poll until the ring has captured the full final window. We require BOTH the
    // newest sentinel (evt-9) present AND the count settled at the cap, so we are
    // never asserting against a mid-fill snapshot.
    const recs = await waitSnapshot(
      c,
      "alice",
      (rs) =>
        rs.filter((r) => r.kind === "log").length >= SIZE &&
        rs.some((r) => r.kind === "log" && /\bevt-9\b/.test(flat(r.payload))),
      6000,
    );
    const snap = await snapshot(c, "alice");
    assert.equal(snap.status, 200, "alice's snapshot is reachable");

    // Only our log records are on this bus (nothing else was emitted), so the
    // whole ring is the log window. Guard that assumption explicitly.
    const logs = snap.records.filter((r) => r.kind === "log");
    assert.equal(
      logs.length,
      snap.records.length,
      "no non-log records should exist on this freshly-started agent's bus: " + flat(snap.records),
    );

    // (1) CAP: the ring is capped at exactly bufferSize.
    assert.equal(
      snap.records.length,
      SIZE,
      "the ring must hold exactly bufferSize=" + SIZE + " records (got " + snap.records.length + ")",
    );

    // (2) ORDER + DROP-OLDEST: the retained records are the LAST SIZE emitted, in
    //     emission order — evt-5..evt-9. The oldest (evt-0..evt-4) were dropped.
    const texts = snap.records.map((r) => {
      const m = /\bevt-(\d+)\b/.exec(flat(r.payload));
      return m ? Number(m[1]) : NaN;
    });
    const expected = [];
    for (let i = N - SIZE; i < N; i++) expected.push(i); // [5,6,7,8,9]
    assert.deepEqual(
      texts,
      expected,
      "the ring must retain the LAST " + SIZE + " events IN ORDER (evt-" + (N - SIZE) + "..evt-" + (N - 1) +
        "); the oldest were evicted FIFO. got: " + flat(texts),
    );
    // Spell out the FIFO-drop half independently: none of the evicted sentinels survive.
    for (let i = 0; i < N - SIZE; i++) {
      assert.ok(
        !snap.records.some((r) => new RegExp("\\bevt-" + i + "\\b").test(flat(r.payload))),
        "evt-" + i + " was among the oldest and must have been dropped (FIFO), but it is still present",
      );
    }

    // (3) DROPPED: exactly N-SIZE were evicted — an ACCURATE running count, not a
    //     boolean "something overflowed".
    assert.equal(
      snap.dropped,
      N - SIZE,
      "dropped must equal the number evicted (" + (N - SIZE) + "), got " + snap.dropped,
    );

    // (4) SEQ: per-record seq is strictly increasing across the retained window,
    //     and the retained seqs are the HIGHEST SIZE seqs (a contiguous tail —
    //     consistent with a monotonic counter and drop-oldest eviction). We assert
    //     the shape WITHOUT hardcoding the seq base (0- or 1-based both pass).
    const seqs = snap.records.map((r) => r.seq);
    assert.ok(
      seqs.every((s) => typeof s === "number" && Number.isFinite(s)),
      "every retained record carries a numeric seq: " + flat(seqs),
    );
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(
        seqs[i] > seqs[i - 1],
        "seq must be STRICTLY increasing in retained order (seq[" + i + "]=" + seqs[i] +
          " !> seq[" + (i - 1) + "]=" + seqs[i - 1] + "): " + flat(seqs),
      );
    }
    // Highest SIZE seqs == a contiguous run ending at the max (the tail of the
    // monotonic counter). With N total emissions and SIZE retained, the gap from
    // first-retained to last-retained is exactly SIZE-1 (no holes), and the max
    // seq corresponds to the newest record (evt-9, last in the window).
    const minRetained = Math.min(...seqs);
    const maxRetained = Math.max(...seqs);
    assert.equal(
      maxRetained - minRetained,
      SIZE - 1,
      "the retained seqs must be a contiguous block of " + SIZE + " (the highest seqs, no holes): " + flat(seqs),
    );
    assert.equal(
      seqs[seqs.length - 1],
      maxRetained,
      "the newest retained record (evt-" + (N - 1) + ") must carry the highest seq: " + flat(seqs),
    );
    assert.equal(
      seqs[0],
      minRetained,
      "the oldest retained record (evt-" + (N - SIZE) + ") must carry the lowest of the retained seqs: " + flat(seqs),
    );
  } finally {
    await c.close();
  }
});

// ###########################################################################
// CLEAR-LOGS (added) — edge tests for the NEW token-gated
//   POST /api/agents/:id/clear  =>  200 { cleared:true, agentId:id }
// route and the EventStore.clear() it drives. Written from the APPROVED SPEC
// ONLY; RED until the feature lands. They reuse the SAME child-process harness
// (startChild / assertUp / base / api / snapshot / query / clear / sendAndWait)
// as every test above — a real node:http server on an ephemeral port with a
// pinned+printed session token.
//
// Contract under test (spec):
//   - POST /clear (authed)                => 200 { cleared:true, agentId:id }
//   - unknown / malformed id              => 404 (no throw)
//   - GET or DELETE to /clear             => 404 (single method)
//   - missing/wrong token                 => 401 BEFORE any mutation (the existing
//                                            /api/agents/* gate; no new auth code)
//   - effect: the agent's in-memory ring is emptied (snapshot & query return zero)
//     AND its persisted events.jsonl is truncated on the store's SERIALIZED write
//     chain; highestSeq is NOT reset (seq stays monotonic); SSE clients stay
//     connected and records captured AFTER the clear flow normally.
//   - persist:false (store null) and a path-hostile id (filePath null) still 200.
// ###########################################################################

// ===========================================================================
// Clear-A — POST /clear without a token -> 401 BEFORE any mutation
// (the pre-existing records survive; the 401 gate runs before the ring is touched)
// ===========================================================================

test("inspector(clear): POST /clear WITHOUT a token -> 401 and does NOT mutate the ring (records survive)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // Seed some records so we can prove a rejected clear left them untouched.
    await sendAndWait(c, "in alice KEEP-1", "in");
    await sendAndWait(c, "in alice KEEP-2", "in");
    const seeded = await waitSnapshot(
      c,
      "alice",
      (rs) => rs.some((r) => /KEEP-1/.test(flat(r.payload))) && rs.some((r) => /KEEP-2/.test(flat(r.payload))),
    );
    assert.ok(seeded.length >= 2, "the two seed records are present before the clear attempt");

    // POST /clear with NO token — must be rejected by the existing /api/agents/* gate.
    const noTok = await fetch(base(c) + "/api/agents/alice/clear", { method: "POST" });
    assert.equal(noTok.status, 401, "POST /clear requires the token (401 before any mutation)");
    // And a WRONG token is likewise rejected before mutating.
    const badTok = await fetch(base(c) + "/api/agents/alice/clear?token=not-the-real-token", {
      method: "POST",
    });
    assert.equal(badTok.status, 401, "a wrong token is rejected on /clear");

    // Give any (erroneous) mutation a chance to land, then prove nothing was cleared.
    await new Promise((r) => setTimeout(r, 150));
    const after = await snapshot(c, "alice");
    assert.equal(after.status, 200, "the authed snapshot is still reachable");
    assert.ok(
      after.records.some((r) => /KEEP-1/.test(flat(r.payload))) &&
        after.records.some((r) => /KEEP-2/.test(flat(r.payload))),
      "the 401'd clear must NOT have emptied the ring — the pre-existing records survive: " + flat(after.records),
    );
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Clear-B — authed POST /clear -> 200 { cleared:true, agentId }; snapshot & query
// afterwards return zero records
// ===========================================================================

test("inspector(clear): authed POST /clear -> 200 {cleared:true, agentId}, then snapshot=[] and query={records:[],total:0}", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // Seed a mix of records.
    await sendAndWait(c, "in alice PRE-A", "in");
    await sendAndWait(c, "out alice PRE-B", "out");
    await sendAndWait(c, "log alice info core:x PRE-C", "log");
    const seeded = await waitSnapshot(c, "alice", (rs) => rs.length >= 3);
    assert.ok(seeded.length >= 3, "three records are captured before the clear");

    // Authed clear.
    const cleared = await clear(c, "alice");
    assert.equal(cleared.status, 200, "an authed POST /clear returns 200");
    assert.deepEqual(
      cleared.body,
      { cleared: true, agentId: "alice" },
      "the clear body is exactly { cleared:true, agentId:'alice' }: " + flat(cleared.body),
    );

    // The in-memory ring is now empty via BOTH read surfaces.
    const snapAfter = await snapshot(c, "alice");
    assert.equal(snapAfter.status, 200, "snapshot is still reachable after the clear (agent stays online)");
    assert.deepEqual(snapAfter.records, [], "snapshot.records is empty after the clear: " + flat(snapAfter.records));

    const qAfter = await query(c, "alice");
    assert.equal(qAfter.status, 200, "query is still reachable after the clear");
    assert.deepEqual(qAfter.records, [], "query.records is empty after the clear: " + flat(qAfter.records));
    assert.equal(qAfter.total, 0, "query.total is 0 after the clear (got " + qAfter.total + ")");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Clear-C — unknown id -> 404; malformed / URI-hostile id -> 404 (no throw)
// ===========================================================================

test("inspector(clear): POST /clear for an UNKNOWN agent id -> 404", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/ghost/clear"), { method: "POST" });
    assert.equal(res.status, 404, "clearing an unknown agent is 404");
    // Body shape, per spec, is the standard unknown-agent error.
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* tolerate a non-JSON 404 body */
    }
    if (body) {
      assert.equal(body.error, "unknown agent", "the 404 body reports 'unknown agent': " + flat(body));
    }
  } finally {
    await c.close();
  }
});

test("inspector(clear): POST /clear with a MALFORMED percent-encoded id -> 404 (no crash)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // "%" is a truncated percent-escape; decoding the :id segment must not throw
    // out of the handler — it resolves to a normal unknown-id 404.
    const malformed = await probe(api(c, "/api/agents/%/clear"), { method: "POST" });
    assert.ok(
      malformed.ok,
      "POST /api/agents/%/clear must answer, not drop the connection (net error: " + (malformed.error || "") + ")",
    );
    assert.equal(malformed.status, 404, "a malformed percent-encoded id resolves to 404, got " + malformed.status);

    // Crash detector: the server is still healthy afterwards.
    const after = await probe(api(c, "/api/agents"));
    assert.ok(after.ok, "the server survives the malformed /clear id (subsequent request dropped: " + (after.error || "") + ")");
    assert.equal(after.status, 200, "a normal request after the malformed /clear id returns 200 (server survived)");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Clear-D — /clear is a SINGLE method: GET and DELETE to /clear -> 404
// ===========================================================================

test("inspector(clear): GET /api/agents/:id/clear -> 404 (clear is POST-only)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // Authed GET to /clear (token present so we test the METHOD gate, not auth).
    const res = await fetch(api(c, "/api/agents/alice/clear"));
    assert.equal(res.status, 404, "GET /clear is not a route (clear is POST-only)");
  } finally {
    await c.close();
  }
});

test("inspector(clear): DELETE /api/agents/:id/clear -> 404 (clear is POST-only)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/alice/clear"), { method: "DELETE" });
    assert.equal(res.status, 404, "DELETE /clear is not a route (clear is POST-only)");

    // And a wrong method left the ring intact: seed, DELETE, still there.
    await sendAndWait(c, "in alice DEL-KEEP", "in");
    const recs = await waitSnapshot(c, "alice", (rs) => rs.some((r) => /DEL-KEEP/.test(flat(r.payload))));
    assert.ok(
      recs.some((r) => /DEL-KEEP/.test(flat(r.payload))),
      "a DELETE to /clear is a no-op 404 — captured records are unaffected",
    );
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Clear-E — a persist:false agent still clears (200, no throw; store is null)
// ===========================================================================

test("inspector(clear): a persist:false agent -> POST /clear still 200 and empties the ring (store null, no throw)", async () => {
  // persist:false ⇒ EventStore.load returns an in-memory-only store (reg.store null).
  const c = await startChild(["alice"], undefined, [false]);
  try {
    assertUp(c);
    await sendAndWait(c, "in alice NOPERSIST-1", "in");
    await sendAndWait(c, "in alice NOPERSIST-2", "in");
    const seeded = await waitSnapshot(c, "alice", (rs) => rs.length >= 2);
    assert.ok(seeded.length >= 2, "records are captured in-memory even with persistence off");

    const cleared = await clear(c, "alice");
    assert.equal(cleared.status, 200, "clear on a persist:false agent still returns 200 (no store to truncate)");
    assert.deepEqual(
      cleared.body,
      { cleared: true, agentId: "alice" },
      "the clear body is unchanged for a persist:false agent: " + flat(cleared.body),
    );

    const after = await snapshot(c, "alice");
    assert.deepEqual(after.records, [], "the ring is emptied even with no persisted store: " + flat(after.records));

    // The child must not have reported any thrown handler error from the clear.
    assert.ok(
      !c.lines.some((l) => l.startsWith("ERR:")),
      "clearing a persist:false agent must not throw: " + flat(c.lines.filter((l) => l.startsWith("ERR:"))),
    );
    // Server still healthy.
    const roster = await fetch(api(c, "/api/agents")).then((r) => r.status);
    assert.equal(roster, 200, "the server survives a persist:false clear");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Clear-F — EventStore.clear() UNIT test (import the store module directly).
// Pins: after append+flush the file has lines; clear+flush truncates it to empty
// and window() (fresh re-load) returns []; the interleaved append -> clear ->
// append order is enforced by the SAME serialized promise chain (only the
// post-clear append survives on disk). Best-effort clear() never throws, and
// works for persist:false (store null path) and a path-hostile id (filePath null).
// ===========================================================================

test("inspector(clear): EventStore.clear() truncates the file on the serialized chain; a re-load window() returns []", async () => {
  const mod = (await import(STORE_URL).catch(() => null)) as any;
  assert.ok(mod && typeof mod.EventStore === "function", "the store module must export an EventStore class");
  const { EventStore } = mod;

  const dataDir = fs.mkdtempSync(path.join(TMP, "store-clear-"));
  const cfg = { maxPersistedEntries: 5000, retentionMs: 0, persist: true };
  const agentId = "alice";
  const filePath = path.join(dataDir, agentId, "events.jsonl");

  const mk = (seq: number, at: number, text: string) => ({
    seq,
    at,
    kind: "log",
    agentId,
    payload: { data: { level: "info", pluginId: "core:test", text } },
  });

  // 1) Fresh store, append three records, flush → the file exists with 3 lines.
  const store = await EventStore.load(dataDir, agentId, cfg);
  store.append(mk(1, Date.now(), "L1"));
  store.append(mk(2, Date.now(), "L2"));
  store.append(mk(3, Date.now(), "L3"));
  await store.flush();

  const before = fs.readFileSync(filePath, "utf8");
  const beforeLines = before.split("\n").filter((l) => l.length > 0);
  assert.equal(beforeLines.length, 3, "the file holds the three appended lines before clear: " + flat(beforeLines));

  // 2) clear() must exist and truncate on the SAME chain. It empties in-memory
  //    state immediately; the disk truncate is queued — flush() awaits it.
  assert.equal(typeof store.clear, "function", "EventStore must expose a clear(): void method");
  store.clear();
  await store.flush();

  const after = fs.readFileSync(filePath, "utf8");
  const afterLines = after.split("\n").filter((l) => l.length > 0);
  assert.equal(afterLines.length, 0, "the file is truncated to zero lines after clear+flush: " + flat(afterLines));

  // 3) A FRESH re-load of the same file returns an empty restored window.
  const reloaded = await EventStore.load(dataDir, agentId, cfg);
  assert.deepEqual(reloaded.window(), [], "a re-loaded store window() is empty after a clear");
});

test("inspector(clear): interleaved append -> clear -> append leaves ONLY the post-clear append on disk (serialized-chain order)", async () => {
  const mod = (await import(STORE_URL).catch(() => null)) as any;
  assert.ok(mod && typeof mod.EventStore === "function", "the store module must export an EventStore class");
  const { EventStore } = mod;

  const dataDir = fs.mkdtempSync(path.join(TMP, "store-order-"));
  const cfg = { maxPersistedEntries: 5000, retentionMs: 0, persist: true };
  const agentId = "alice";
  const filePath = path.join(dataDir, agentId, "events.jsonl");

  const mk = (seq: number, text: string) => ({
    seq,
    at: Date.now(),
    kind: "log",
    agentId,
    payload: { data: { level: "info", pluginId: "core:test", text } },
  });

  const store = await EventStore.load(dataDir, agentId, cfg);

  // Queue a PRE-clear append, then clear, then a POST-clear append — WITHOUT
  // awaiting in between, so all three ride the single serialized chain. The spec
  // pins the ordering: appends queued BEFORE the clear land before the truncate;
  // appends AFTER the clear run after it. Net on-disk result = only PRE-clear got
  // truncated away; only the POST-clear line survives.
  store.append(mk(1, "PRE-CLEAR"));
  store.clear();
  store.append(mk(2, "POST-CLEAR"));
  await store.flush();

  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "exactly one line survives the append→clear→append sequence: " + flat(lines));
  assert.match(lines[0], /POST-CLEAR/, "the surviving line is the POST-clear append: " + flat(lines));
  assert.ok(!/PRE-CLEAR/.test(text), "the PRE-clear append (queued before clear) was truncated away by the clear");

  // A fresh re-load sees exactly the post-clear record.
  const reloaded = await EventStore.load(dataDir, agentId, cfg);
  const win = reloaded.window();
  assert.equal(win.length, 1, "the re-loaded window holds exactly the post-clear record: " + flat(win));
  assert.match(flat(win[0]), /POST-CLEAR/, "the re-loaded record is the post-clear append");
});

test("inspector(clear): EventStore.clear() is a best-effort no-op that never throws for persist:false and a path-hostile id", async () => {
  const mod = (await import(STORE_URL).catch(() => null)) as any;
  assert.ok(mod && typeof mod.EventStore === "function", "the store module must export an EventStore class");
  const { EventStore } = mod;

  const dataDir = fs.mkdtempSync(path.join(TMP, "store-noop-"));

  // persist:false ⇒ in-memory-only store (filePath null). clear() must not throw.
  const offStore = await EventStore.load(dataDir, "alice", {
    maxPersistedEntries: 5000,
    retentionMs: 0,
    persist: false,
  });
  assert.equal(typeof offStore.clear, "function", "EventStore must expose clear() even when persistence is off");
  offStore.clear(); // must not throw
  await offStore.flush();
  assert.deepEqual(offStore.window(), [], "a persist:false store's window stays empty after clear");

  // A path-hostile agentId degrades to in-memory-only (filePath null). clear()
  // must still be a safe no-op (never touch the disk, never throw).
  const hostileStore = await EventStore.load(dataDir, "../escape", {
    maxPersistedEntries: 5000,
    retentionMs: 0,
    persist: true,
  });
  hostileStore.clear(); // must not throw
  await hostileStore.flush();
  assert.deepEqual(hostileStore.window(), [], "a path-hostile store's window stays empty after clear");
  // Nothing escaped the dataDir.
  assert.ok(
    !fs.existsSync(path.join(dataDir, "..", "escape")) && !fs.existsSync(path.join(dataDir, "escape")),
    "a path-hostile id never created a file on disk",
  );
});

// ===========================================================================
// Clear-G — after a clear, NEWLY captured events flow normally into /snapshot
// (post-clear capture is unaffected; highestSeq stays monotonic so new seqs are
// strictly greater than the pre-clear ones — the counter is NOT reset).
// ===========================================================================

test("inspector(clear): after a clear, newly-captured events appear in /snapshot (capture flows normally)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // Seed, capture the pre-clear max seq, then clear.
    await sendAndWait(c, "in alice OLD-1", "in");
    await sendAndWait(c, "in alice OLD-2", "in");
    const pre = await waitSnapshot(c, "alice", (rs) => rs.length >= 2);
    const preMaxSeq = Math.max(...pre.map((r) => r.seq));

    const cleared = await clear(c, "alice");
    assert.equal(cleared.status, 200, "the clear succeeds");
    const empty = await snapshot(c, "alice");
    assert.deepEqual(empty.records, [], "the ring is empty immediately after the clear");

    // Capture a NEW event post-clear — it must land in the snapshot.
    await sendAndWait(c, "in alice NEW-AFTER-CLEAR", "in");
    const recs = await waitSnapshot(c, "alice", (rs) =>
      rs.some((r) => /NEW-AFTER-CLEAR/.test(flat(r.payload))),
    );
    const fresh = recs.find((r) => /NEW-AFTER-CLEAR/.test(flat(r.payload)));
    assert.ok(fresh, "a post-clear event is captured and visible in /snapshot: " + flat(recs));
    // The ring restarts from this one record (nothing stale carried over).
    assert.ok(
      !recs.some((r) => /OLD-1|OLD-2/.test(flat(r.payload))),
      "no pre-clear record reappears after the clear: " + flat(recs),
    );
    // seq is NOT reset — the post-clear record's seq is strictly greater than the
    // highest pre-clear seq (the monotonic counter survives the clear).
    assert.ok(
      typeof fresh.seq === "number" && fresh.seq > preMaxSeq,
      "the post-clear seq (" + fresh.seq + ") must exceed the pre-clear max (" + preMaxSeq + ") — highestSeq is not reset",
    );
  } finally {
    await c.close();
  }
});

test("inspector(clear): a live SSE client stays connected across a clear and receives post-clear records", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const s = await openSSE(c, "alice");
    assert.equal(s.status, 200, "the stream opens for alice");

    // A pre-clear record streams to the client.
    await sendAndWait(c, "in alice SSE-PRE", "in");
    assert.ok(
      await waitEvents(s.events, (e) => e.some((x) => x.type === "record" && /SSE-PRE/.test(flat(x.record)))),
      "the pre-clear record arrives over SSE",
    );

    // Clear — per spec, SSE clients STAY connected.
    const cleared = await clear(c, "alice");
    assert.equal(cleared.status, 200, "the clear succeeds while an SSE client is attached");

    // A post-clear record must still reach the SAME (still-open) SSE connection.
    await sendAndWait(c, "in alice SSE-POST", "in");
    assert.ok(
      await waitEvents(s.events, (e) => e.some((x) => x.type === "record" && /SSE-POST/.test(flat(x.record)))),
      "the post-clear record reaches the still-connected SSE client (clear did not close streams): " + flat(s.events),
    );
    s.close();
  } finally {
    await c.close();
  }
});
