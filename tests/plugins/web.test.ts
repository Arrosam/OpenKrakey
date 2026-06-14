/**
 * Black-box EDGE tests for the `web` plugin (public plugin) — the browser chat channel.
 *
 * Contract surface under test (derived ONLY from contracts/plugin + shared/actions
 * + overviews/nodes/web.md — NO implementation read; the module may not exist yet,
 * in which case every scenario fails on a clean assertion):
 *
 *   A `Plugin` = { manifest:{id,version}, setup(ctx): void|Promise, teardown?() }.
 *   The plugin owns a PROCESS resource — one node:http server shared (refcounted)
 *   by every per-Agent instance in the process (boot runs many agents in one
 *   process). HTTP surface:
 *     - GET  /                         -> text/html chat page
 *     - GET  /api/agents               -> { agents: string[] } (online ids)
 *     - POST /api/agents/:id/message   -> { id, status:"sent" }; emits input.message
 *         (channel "web", meta.msgId=id) + clock.fire_now on THAT agent's bus.
 *         empty text -> 400; unknown id -> 404.
 *     - GET  /api/agents/:id/stream    -> SSE; first event { type:"output", text:<greeting> }
 *         then { type:"output", text } per output.message on that agent's bus, and
 *         { type:"status", id, status:"sent"|"read" } per message lifecycle. unknown id -> 404.
 *   sent = appended to the queue (POST). read = processed: flipped when llm.return
 *   fires on that agent's bus. R6: an agent's stream carries ONLY its own events.
 *   Lifecycle: first setup binds the server; last teardown closes it (port freed).
 *
 * Driven END-TO-END in a CHILD process: the child builds N per-Agent instances
 * sharing the hub on an EPHEMERAL port (first agent config.port=0), reports the
 * bound port, observes each agent's bus (GOT_INPUT/FIRED), and runs a stdin command
 * loop (out/return/down/quit) so the parent can emit output.message / llm.return on
 * a chosen agent's bus while driving the REAL server over HTTP (fetch + SSE).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { Events, Actions } from "../../shared/actions";

const REPO = path.resolve(".");
const EVENT_SYSTEM_URL = pathToFileURL(
  path.resolve(REPO, "packages", "event-system", "src", "index.ts"),
).href;
const PLUGIN_URL = pathToFileURL(
  path.resolve(REPO, "public_plugin", "web", "index.ts"),
).href;

let TMP: string;
test.before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-web-"));
});
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// --------------------------------------------------------------------------
// Child harness: builds N web-plugin instances sharing the module hub, reports
// the bound port (PORT:<n>), echoes each agent's input.message (GOT_INPUT:<id>:<json>)
// and fire_now (FIRED:<id>), and runs a stdin command loop:
//   out <id> <text>   -> emit output.message{text} on <id>'s bus
//   req <id> <reqId>  -> emit llm.request{id:reqId} on <id>'s bus (a beat's request)
//   ret <id> <reqId>  -> emit llm.return{id:reqId} on <id>'s bus (that request's return)
//   down <id>         -> teardown that agent's instance (TORE_DOWN:<id>)
//   quit              -> teardown all + exit
// --------------------------------------------------------------------------
const CHILD = `
import { createEventSystem } from ${JSON.stringify(EVENT_SYSTEM_URL)};
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
function emit(s){ process.stdout.write(s + "\\n"); }

const AGENTS = (process.env.WEB_AGENTS || "alice,bob").split(",").filter(Boolean);
const instances = {};

function makeCtx(agentId, port){
  const sys = createEventSystem();
  const blocks = new Map();
  sys.actions.register(${JSON.stringify(Actions.CLOCK_FIRE_NOW)}, async () => { emit("FIRED:" + agentId); });
  sys.events.on(${JSON.stringify(Events.INPUT_MESSAGE)}, (p) => { emit("GOT_INPUT:" + agentId + ":" + JSON.stringify(p)); });
  // PER-AGENT dataDir: each agent gets its OWN isolated subdir under WEB_DATADIR.
  // This (a) isolates one agent's persisted transcript from another's (R6), and
  // (b) lets a SECOND child process reuse the same WEB_DATADIR to load an agent's
  // prior transcript from disk (the "survives restart" property).
  const agentDataDir = path.join(process.env.WEB_DATADIR, agentId);
  fs.mkdirSync(agentDataDir, { recursive: true });
  return { sys, ctx: {
    agentId,
    events: sys.events,
    actions: sys.actions,
    config: { port },
    dataDir: agentDataDir,
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

let firstPort = 0;
let isFirst = true;
for (const a of AGENTS) {
  const { sys, ctx } = makeCtx(a, isFirst ? 0 : 7717);
  isFirst = false;
  const plugin = mod.default();
  await plugin.setup(ctx);
  instances[a] = { plugin, sys };
}
emit("SETUP_DONE");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const t = line.trim(); if (!t) return;
  const sp = t.indexOf(" ");
  const op = sp === -1 ? t : t.slice(0, sp);
  const rest = sp === -1 ? "" : t.slice(sp + 1);
  if (op === "out") {
    const c = rest.indexOf(" ");
    const id = rest.slice(0, c);
    const text = rest.slice(c + 1);
    instances[id] && instances[id].sys.events.emit(${JSON.stringify(Events.OUTPUT_MESSAGE)}, { at: Date.now(), data: { text } });
  } else if (op === "req") {
    const s2 = rest.indexOf(" ");
    const id = s2 === -1 ? rest : rest.slice(0, s2);
    const rid = s2 === -1 ? "r" : rest.slice(s2 + 1);
    instances[id] && instances[id].sys.events.emit(${JSON.stringify(Events.LLM_REQUEST)}, { id: rid, at: Date.now(), data: { context: { text: "" } } });
  } else if (op === "ret") {
    const s2 = rest.indexOf(" ");
    const id = s2 === -1 ? rest : rest.slice(0, s2);
    const rid = s2 === -1 ? "r" : rest.slice(s2 + 1);
    instances[id] && instances[id].sys.events.emit(${JSON.stringify(Events.LLM_RETURN)}, { id: rid, at: Date.now(), ok: true, data: { content: "ok", toolCalls: [] } });
  } else if (op === "down") {
    if (instances[rest] && instances[rest].plugin.teardown) await instances[rest].plugin.teardown();
    emit("TORE_DOWN:" + rest);
    delete instances[rest];
  } else if (op === "quit") {
    for (const k of Object.keys(instances)) { try { instances[k].plugin.teardown && await instances[k].plugin.teardown(); } catch {} }
    emit("BYE");
    process.exit(0);
  }
});
`;

interface Child {
  proc: ChildProcess;
  port: number;
  token: string;
  lines: string[];
  send(cmd: string): void;
  waitFor(pred: (lines: string[]) => boolean, ms?: number): Promise<boolean>;
  close(): Promise<void>;
  notImplemented: boolean;
}

async function startChild(
  agents: string[],
  opts: { dataDir?: string } = {},
): Promise<Child> {
  // Each agent gets its OWN subdir under this WEB_DATADIR (created in the child).
  // Default: a FRESH temp dir (existing callers stay isolated & unchanged).
  // Pass opts.dataDir to REUSE a fixed root across two child processes — the
  // restart test points child #1 and child #2 at the same root so child #2
  // loads child #1's persisted transcript from disk.
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(TMP, "data-"));
  const scriptPath = path.join(fs.mkdtempSync(path.join(TMP, "child-")), "web-harness.mts");
  fs.writeFileSync(scriptPath, CHILD, "utf8");

  const proc = spawn(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: REPO,
    env: { ...process.env, WEB_AGENTS: agents.join(","), WEB_DATADIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
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

  // Wait for either NOT_IMPLEMENTED or SETUP_DONE + the PORT print.
  const up = await waitFor(
    (ls) => ls.includes("NOT_IMPLEMENTED") || (ls.includes("SETUP_DONE") && ls.some((l) => l.startsWith("PRINT:"))),
    9000,
  );
  if (!up) {
    await child.close();
    throw new Error("web child never came up. stderr:\n" + stderr.slice(0, 1200));
  }
  if (lines.includes("NOT_IMPLEMENTED")) {
    child.notImplemented = true;
    return child;
  }
  const urlLine = lines.find((l) => l.startsWith("PRINT:") && /http:\/\/[^\s]+:\d+/.test(l));
  const m = urlLine ? /:(\d+)\b/.exec(urlLine.replace("PRINT:", "")) : null;
  child.port = m ? parseInt(m[1], 10) : 0;
  const tk = urlLine ? /[?&]token=([^\s&]+)/.exec(urlLine) : null;
  child.token = tk ? decodeURIComponent(tk[1]) : "";
  return child;
}

function assertUp(c: Child): void {
  assert.ok(!c.notImplemented, "web plugin not implemented yet: public_plugin/web/index.ts missing or no setup()");
  assert.ok(c.port > 0, "the hub must bind a port and print its URL (got port " + c.port + ")");
}

const base = (c: Child) => "http://127.0.0.1:" + c.port;

/** A full /api URL carrying the session token (so authed requests pass). */
function api(c: Child, path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return base(c) + path + (c.token ? sep + "token=" + encodeURIComponent(c.token) : "");
}

/** Open an SSE stream and accumulate parsed events into the returned array. */
async function openSSE(
  c: Child,
  id: string,
): Promise<{ events: any[]; status: number; close: () => void }> {
  const ac = new AbortController();
  const res = await fetch(api(c, "/api/agents/" + id + "/stream"), { signal: ac.signal });
  const events: any[] = [];
  if (res.body) {
    (async () => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dl = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (dl) {
              try {
                events.push(JSON.parse(dl.slice(5).trim()));
              } catch {
                /* skip */
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

const waitEvents = async (events: any[], pred: (e: any[]) => boolean, ms = 6000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!pred(events)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 15));
  }
  return true;
};

// ===========================================================================
// Scenario 1 — GET /api/agents lists the online agents
// ===========================================================================

test("web: GET /api/agents lists every registered agent", async () => {
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

test("web: the server URL is announced DURING setup (in the agent's startup block), not asynchronously after", async () => {
  // Regression: the URL must print while setup() runs (so the startup report
  // shows it indented under the agent), NOT from an async listen callback that
  // fires after setup returns and after the run summary.
  const c = await startChild(["solo"]);
  try {
    assertUp(c);
    const printIdx = c.lines.findIndex((l) => l.startsWith("PRINT:") && /Web chat/.test(l));
    const doneIdx = c.lines.findIndex((l) => l === "SETUP_DONE");
    assert.ok(printIdx !== -1, "the web URL must be printed: " + JSON.stringify(c.lines));
    assert.ok(doneIdx !== -1, "setup must complete");
    assert.ok(
      printIdx < doneIdx,
      "the URL must be announced before setup completes (so it lands in the agent's startup block); " +
        "print@" + printIdx + " vs SETUP_DONE@" + doneIdx,
    );
  } finally {
    await c.close();
  }
});

test("web: GET / serves an HTML chat page", async () => {
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

test("web: the chat page uses Bootstrap Icons (not unicode glyphs) and wires browser notifications", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const html = await fetch(base(c) + "/").then((r) => r.text());
    assert.match(html, /bootstrap-icons/, "the Bootstrap Icons stylesheet must be loaded");
    assert.match(html, /\bbi-send/, "the send control must use a Bootstrap icon (bi-send*)");
    assert.match(html, /\bbi-check-all\b/, "the read tick must use the bi-check-all icon");
    assert.match(html, /\bbi-check\b/, "the sent tick must use the bi-check icon");
    assert.ok(
      !/&#8593;|&#10003;/.test(html),
      "no raw unicode arrow/check glyphs should remain in the page",
    );
    assert.match(html, /Notification/, "the page must wire the browser Notifications API for replies");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 2 — POST a message routes input.message + fire_now to EXACTLY that
// agent's bus (not another's), and returns { id, status:"sent" }
// ===========================================================================

test("web: POST /api/agents/:id/message emits input.message + fire_now on THAT agent only", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello alice" }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { id: number; status: string };
    assert.equal(body.status, "sent", "the POST acks the message as sent");
    assert.equal(typeof body.id, "number", "a message id is assigned");

    await c.waitFor((ls) => ls.some((l) => l.startsWith("GOT_INPUT:alice:")));
    const got = c.lines.find((l) => l.startsWith("GOT_INPUT:alice:"));
    assert.ok(got, "alice's bus received the input.message");
    const payload = JSON.parse(got!.slice("GOT_INPUT:alice:".length));
    assert.equal(payload.data.text, "hello alice", "text delivered verbatim");
    assert.equal(payload.data.channel, "web", "channel tagged 'web'");
    assert.ok(c.lines.includes("FIRED:alice"), "the message woke alice's beat (fire_now)");

    assert.ok(!c.lines.some((l) => l.startsWith("GOT_INPUT:bob:")), "bob's bus must NOT receive alice's message (no fan-out)");
    assert.ok(!c.lines.includes("FIRED:bob"), "bob's beat must not fire for a message addressed to alice");
  } finally {
    await c.close();
  }
});

test("web: POST to an unknown agent id -> 404", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/ghost/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "anyone?" }),
    });
    assert.equal(res.status, 404, "unknown agent id is rejected");
  } finally {
    await c.close();
  }
});

test("web: POST with empty text -> 400 (nothing enqueued)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(res.status, 400, "an empty message is rejected");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!c.lines.some((l) => l.startsWith("GOT_INPUT:alice:")), "no input.message for an empty body");
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 3 — SSE stream: greeting on connect, then output.message text; an
// agent's stream carries ONLY its own output (R6 isolation)
// ===========================================================================

test("web: GET /api/agents/:id/stream greets on connect then streams that agent's output", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const a = await openSSE(c, "alice");
    assert.equal(a.status, 200);
    assert.ok(await waitEvents(a.events, (e) => e.some((x) => x.type === "output" && /awake/.test(x.text || ""))),
      "the stream sends a greeting output event on connect");

    c.send("out alice STREAMED-REPLY");
    assert.ok(await waitEvents(a.events, (e) => e.some((x) => x.type === "output" && x.text === "STREAMED-REPLY")),
      "alice's output.message reaches alice's stream");
    a.close();
  } finally {
    await c.close();
  }
});

test("web: an agent's stream does NOT receive another agent's output (R6)", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const a = await openSSE(c, "alice");
    const b = await openSSE(c, "bob");
    await waitEvents(a.events, (e) => e.length > 0);
    await waitEvents(b.events, (e) => e.length > 0);

    c.send("out alice ALICE-ONLY");
    assert.ok(await waitEvents(a.events, (e) => e.some((x) => x.text === "ALICE-ONLY")), "alice got her output");
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(!b.events.some((x) => x.text === "ALICE-ONLY"), "bob's stream must NOT carry alice's output");
    a.close();
    b.close();
  } finally {
    await c.close();
  }
});

test("web: SSE to an unknown agent id -> 404", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(api(c, "/api/agents/ghost/stream"));
    assert.equal(res.status, 404);
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 4 — sent/read lifecycle: POST -> "sent"; llm.return -> "read"
// ===========================================================================

test("web: a message is 'sent' on POST then flips to 'read' when the beat completes (llm.return)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const a = await openSSE(c, "alice");
    await waitEvents(a.events, (e) => e.length > 0); // greeting

    const res = await fetch(api(c, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "track me" }),
    });
    const { id } = (await res.json()) as { id: number };

    assert.ok(await waitEvents(a.events, (e) => e.some((x) => x.type === "status" && x.id === id && x.status === "sent")),
      "a 'sent' status is streamed for the message");

    // Not yet read.
    assert.ok(!a.events.some((x) => x.type === "status" && x.id === id && x.status === "read"),
      "the message must not be 'read' before the agent processes it");

    // The beat that folded the message in: its request carries the message, then
    // that request returns.
    c.send("req alice R1");
    c.send("ret alice R1");
    assert.ok(await waitEvents(a.events, (e) => e.some((x) => x.type === "status" && x.id === id && x.status === "read")),
      "the return of the request that carried the message flips it to 'read'");
    a.close();
  } finally {
    await c.close();
  }
});

test("web: read is tied to the request that carried the message — a stale earlier return does NOT mark it read", async () => {
  // The race: a timer-driven request is already outstanding when the browser posts
  // a message (orchestrator beats end at llm.request, so returns can overlap and
  // arrive out of order). The EARLIER request's return — composed before the
  // message existed — must NOT mark the new message read.
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const a = await openSSE(c, "alice");
    await waitEvents(a.events, (e) => e.length > 0); // greeting

    // A request is already in flight BEFORE the message is posted.
    c.send("req alice OLD");

    const res = await fetch(api(c, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "race me" }),
    });
    const { id } = (await res.json()) as { id: number };
    await waitEvents(a.events, (e) => e.some((x) => x.type === "status" && x.id === id && x.status === "sent"));

    // The OLD request (composed before the message) returns first.
    c.send("ret alice OLD");
    await new Promise((r) => setTimeout(r, 350));
    assert.ok(
      !a.events.some((x) => x.type === "status" && x.id === id && x.status === "read"),
      "a stale earlier return must NOT prematurely mark the message read",
    );

    // The request that actually carried the message returns -> now read.
    c.send("req alice NEW");
    c.send("ret alice NEW");
    assert.ok(
      await waitEvents(a.events, (e) => e.some((x) => x.type === "status" && x.id === id && x.status === "read")),
      "the message flips to read only when ITS request returns",
    );
    a.close();
  } finally {
    await c.close();
  }
});

// ===========================================================================
// Scenario 5 — refcounted lifecycle: the server is shared, and the port is
// released only after the LAST agent tears down.
// ===========================================================================

test("web: the port stays open while >=1 agent is registered and closes after the last teardown", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const port = c.port;

    // Tear down alice — server must stay up for bob.
    c.send("down alice");
    await c.waitFor((ls) => ls.includes("TORE_DOWN:alice"));
    const stillUp = await fetch(api(c, "/api/agents")).then((r) => r.status).catch(() => 0);
    assert.equal(stillUp, 200, "server stays up while bob is still registered");
    const agents = (await fetch(api(c, "/api/agents")).then((r) => r.json())) as { agents: string[] };
    assert.deepEqual(agents.agents, ["bob"], "alice is gone from the roster, bob remains");

    // Tear down bob — now the port must close.
    c.send("down bob");
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
// Scenario 6 — token auth + loopback bind: the API is gated by a session token
// that only the console (which ran the program) sees; the server binds loopback.
// ===========================================================================

test("web: the startup URL carries a session token and binds loopback (127.0.0.1)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    assert.ok(c.token.length >= 16, "a non-trivial session token is generated: " + JSON.stringify(c.token));
    const urlLine = c.lines.find((l) => l.startsWith("PRINT:") && /Web chat/.test(l)) || "";
    assert.match(urlLine, /127\.0\.0\.1/, "the server binds loopback (URL is 127.0.0.1, not all interfaces)");
    assert.match(urlLine, /[?&]token=/, "the printed URL carries the token");
  } finally {
    await c.close();
  }
});

test("web: API requests WITHOUT the token are rejected with 401", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const list = await fetch(base(c) + "/api/agents");
    assert.equal(list.status, 401, "GET /api/agents requires the token");
    const post = await fetch(base(c) + "/api/agents/alice/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "sneak in" }),
    });
    assert.equal(post.status, 401, "POST message requires the token");
    const stream = await fetch(base(c) + "/api/agents/alice/stream");
    assert.equal(stream.status, 401, "SSE stream requires the token");
    // The unauthorized POST must NOT have reached alice's bus.
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!c.lines.some((l) => l.startsWith("GOT_INPUT:alice:")), "a tokenless message never reaches the agent");
  } finally {
    await c.close();
  }
});

test("web: a WRONG token is rejected with 401", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const res = await fetch(base(c) + "/api/agents?token=not-the-real-token");
    assert.equal(res.status, 401, "a bad token is rejected");
  } finally {
    await c.close();
  }
});

test("web: GET / serves the page WITHOUT a token (the page holds no secrets)", async () => {
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
// NEW SECTION — PERSISTENT per-agent chat history (RED until `web` implements it)
// ---------------------------------------------------------------------------
// Surface under test is derived ONLY from the development spec for this feature
// (the wire contract below) — NO implementation was read; the behavior does not
// exist yet, so every scenario here fails on a clean assertion until it does.
//
//   The web plugin PERSISTS each agent's chat transcript under its `ctx.dataDir`
//   (agent-isolated) and REPLAYS it to the browser on connect, so history survives
//   agent-switches AND process restarts.
//     - PERSISTED: each USER message (on POST /api/agents/:id/message) and each
//       AGENT message (on output.message), to a file under that agent's ctx.dataDir.
//       (On-disk format is the impl's choice — we assert only observable SSE behavior.)
//     - REPLAY ON CONNECT: opening GET /api/agents/:id/stream sends — BEFORE the
//       greeting — exactly ONE event:
//          { type:"history",
//            messages:[ { role:"user"|"agent", text:string, id?:number, status?:string }, ... ] }
//       listing the stored transcript in chronological order (oldest first). Then
//       the existing greeting { type:"output", text:<greeting> }, then live events.
//       An agent with no stored messages still gets the history event (messages:[]).
//     - LOAD ON SETUP: a freshly-constructed web instance whose ctx.dataDir already
//       holds a prior transcript replays it on the next connect (loads from disk at
//       setup) — the "survives restart" property.
//     - R6: an agent's history contains ONLY its own messages.
//
// Harness changes that back these tests (see above):
//   * The child now gives each agent its OWN dataDir subdir
//     (path.join(WEB_DATADIR, agentId), created on construction) — per-agent
//     isolation, and lets a second child reuse the same WEB_DATADIR.
//   * startChild(agents, { dataDir }) accepts a caller-provided fixed root so two
//     child processes can share one WEB_DATADIR (restart test). Default is a fresh
//     temp dir, so every existing caller is unchanged.
// ===========================================================================

/** The single { type:"history" } event from a stream's parsed events (or undefined). */
function historyEvent(events: any[]): { type: "history"; messages: any[] } | undefined {
  return events.find((e) => e && e.type === "history");
}

/** All { type:"history" } events seen on a stream (to assert there is EXACTLY one). */
function historyEvents(events: any[]): any[] {
  return events.filter((e) => e && e.type === "history");
}

/** Reduce a history event's messages to ordered [role, text] pairs for comparison. */
function transcript(h: { messages: any[] } | undefined): Array<[string, string]> {
  if (!h || !Array.isArray(h.messages)) return [];
  return h.messages.map((m) => [m.role, m.text] as [string, string]);
}

/** True once a history event whose transcript matches `want` exactly has arrived. */
const historyMatches = (events: any[], want: Array<[string, string]>): boolean => {
  const h = historyEvent(events);
  if (!h) return false;
  const got = transcript(h);
  if (got.length !== want.length) return false;
  return got.every(([r, t], i) => r === want[i][0] && t === want[i][1]);
};

// --- Test H1: history event SHAPE on a fresh agent (sent BEFORE the greeting) ---
test("web: a fresh agent's stream sends { type:'history', messages:[] } FIRST, before the greeting", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const a = await openSSE(c, "alice");
    assert.equal(a.status, 200);

    // The very first decoded event is the (empty) history event.
    assert.ok(
      await waitEvents(a.events, (e) => e.length >= 1),
      "the stream must emit at least one event on connect",
    );
    assert.equal(a.events[0]?.type, "history", "the FIRST event must be the history event");
    assert.deepEqual(a.events[0]?.messages, [], "a fresh agent replays an EMPTY history (messages:[])");

    // ...and the existing greeting still arrives, AFTER the history event.
    assert.ok(
      await waitEvents(a.events, (e) => e.some((x) => x.type === "output")),
      "the greeting output event must still arrive after the history event",
    );
    const hIdx = a.events.findIndex((x) => x.type === "history");
    const gIdx = a.events.findIndex((x) => x.type === "output");
    assert.ok(hIdx !== -1 && gIdx !== -1 && hIdx < gIdx, "history must precede the greeting");

    // Exactly ONE history event per connection.
    assert.equal(historyEvents(a.events).length, 1, "exactly one history event per connect");
    a.close();
  } finally {
    await c.close();
  }
});

// --- Test H2: replay WITHIN a session (a user msg + an agent msg, in order) ---
test("web: a new stream replays this session's user + agent messages in order via the history event", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);

    // Watcher stream open FIRST so we can confirm the live agent output round-trips
    // (i.e. the server handled output.message, which is also when it persists).
    const live = await openSSE(c, "alice");
    await waitEvents(live.events, (e) => e.some((x) => x.type === "output")); // greeting

    const res = await fetch(api(c, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello-1" }),
    });
    assert.equal(res.status, 202, "the user message is accepted (and persisted on POST)");

    c.send("out alice reply-1");
    assert.ok(
      await waitEvents(live.events, (e) => e.some((x) => x.type === "output" && x.text === "reply-1")),
      "the agent output round-tripped live (so the server has handled & persisted it)",
    );
    live.close();

    // A brand-new connection must REPLAY both, oldest-first: user 'hello-1', agent 'reply-1'.
    const fresh = await openSSE(c, "alice");
    assert.ok(
      await waitEvents(fresh.events, (e) =>
        historyMatches(e, [["user", "hello-1"], ["agent", "reply-1"]]),
      ),
      "history must replay [user hello-1, agent reply-1] in chronological order; got " +
        JSON.stringify(transcript(historyEvent(fresh.events))),
    );
    fresh.close();
  } finally {
    await c.close();
  }
});

// --- Test H3: survives RESTART — child #2 loads child #1's transcript from disk ---
test("web: history survives a RESTART (a new process loads the prior transcript from ctx.dataDir)", async () => {
  // One FIXED root shared by both child processes; per-agent subdirs live under it.
  const fixed = fs.mkdtempSync(path.join(TMP, "persist-"));

  // --- child #1: write a user message and an agent message, confirm stored, quit. ---
  const c1 = await startChild(["alice"], { dataDir: fixed });
  try {
    assertUp(c1);
    const live = await openSSE(c1, "alice");
    await waitEvents(live.events, (e) => e.some((x) => x.type === "output")); // greeting

    const res = await fetch(api(c1, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "persist-me" }),
    });
    assert.equal(res.status, 202);

    c1.send("out alice persisted-reply");
    assert.ok(
      await waitEvents(live.events, (e) => e.some((x) => x.type === "output" && x.text === "persisted-reply")),
      "the agent output round-tripped live in child #1 (so it has been persisted to disk)",
    );
    live.close();
  } finally {
    await c1.close(); // process exits; nothing in-memory survives
  }

  // --- child #2: SAME root, brand-new process. It must load the transcript at setup. ---
  const c2 = await startChild(["alice"], { dataDir: fixed });
  try {
    assertUp(c2);
    const fresh = await openSSE(c2, "alice");
    assert.ok(
      await waitEvents(fresh.events, (e) =>
        historyMatches(e, [["user", "persist-me"], ["agent", "persisted-reply"]]),
      ),
      "a freshly-started process must replay the on-disk transcript [user persist-me, agent persisted-reply]; got " +
        JSON.stringify(transcript(historyEvent(fresh.events))),
    );
    fresh.close();
  } finally {
    await c2.close();
  }
});

// --- Test H4: R6 isolation — agent B's history excludes agent A's messages ---
test("web: an agent's history contains ONLY its own messages (R6 isolation)", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);

    // Drive activity on ALICE only, confirming it round-trips (and persists) live.
    const aLive = await openSSE(c, "alice");
    await waitEvents(aLive.events, (e) => e.some((x) => x.type === "output")); // greeting
    const res = await fetch(api(c, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "for-A" }),
    });
    assert.equal(res.status, 202);
    c.send("out alice only-A");
    assert.ok(
      await waitEvents(aLive.events, (e) => e.some((x) => x.type === "output" && x.text === "only-A")),
      "alice's output round-tripped (and persisted) live",
    );
    aLive.close();

    // BOB's history must NOT contain any of alice's messages.
    const bFresh = await openSSE(c, "bob");
    assert.ok(
      await waitEvents(bFresh.events, (e) => historyEvent(e) !== undefined),
      "bob's stream must still send a history event",
    );
    const bMsgs = historyEvent(bFresh.events)!.messages;
    const bTexts = (Array.isArray(bMsgs) ? bMsgs : []).map((m: any) => m.text);
    assert.ok(!bTexts.includes("for-A"), "bob's history must NOT carry alice's user message 'for-A'");
    assert.ok(!bTexts.includes("only-A"), "bob's history must NOT carry alice's agent message 'only-A'");
    bFresh.close();
  } finally {
    await c.close();
  }
});

// --- Test H5: ordering — interleaved messages replay in strict chronological order ---
test("web: multiple messages replay in strict chronological order [user m1, agent r1, user m2, agent r2]", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);

    // Live watcher lets us SERIALIZE persistence: only post the next item once the
    // previous agent reply has round-tripped, pinning the on-disk order.
    const live = await openSSE(c, "alice");
    await waitEvents(live.events, (e) => e.some((x) => x.type === "output")); // greeting

    const post = async (text: string) => {
      const r = await fetch(api(c, "/api/agents/alice/message"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      assert.equal(r.status, 202, "POST " + text + " accepted");
    };
    const reply = async (text: string) => {
      c.send("out alice " + text);
      assert.ok(
        await waitEvents(live.events, (e) => e.some((x) => x.type === "output" && x.text === text)),
        "agent reply " + text + " round-tripped live (persisted in order)",
      );
    };

    await post("m1");
    await reply("r1");
    await post("m2");
    await reply("r2");
    live.close();

    const fresh = await openSSE(c, "alice");
    assert.ok(
      await waitEvents(fresh.events, (e) =>
        historyMatches(e, [
          ["user", "m1"],
          ["agent", "r1"],
          ["user", "m2"],
          ["agent", "r2"],
        ]),
      ),
      "history must be exactly [user m1, agent r1, user m2, agent r2]; got " +
        JSON.stringify(transcript(historyEvent(fresh.events))),
    );
    fresh.close();
  } finally {
    await c.close();
  }
});
