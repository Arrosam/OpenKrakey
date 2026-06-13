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
//   return <id>       -> emit llm.return (ok) on <id>'s bus  (flips sent -> read)
//   down <id>         -> teardown that agent's instance (TORE_DOWN:<id>)
//   quit              -> teardown all + exit
// --------------------------------------------------------------------------
const CHILD = `
import { createEventSystem } from ${JSON.stringify(EVENT_SYSTEM_URL)};
import * as readline from "node:readline";
function emit(s){ process.stdout.write(s + "\\n"); }

const AGENTS = (process.env.WEB_AGENTS || "alice,bob").split(",").filter(Boolean);
const instances = {};

function makeCtx(agentId, port){
  const sys = createEventSystem();
  const blocks = new Map();
  sys.actions.register(${JSON.stringify(Actions.CLOCK_FIRE_NOW)}, async () => { emit("FIRED:" + agentId); });
  sys.events.on(${JSON.stringify(Events.INPUT_MESSAGE)}, (p) => { emit("GOT_INPUT:" + agentId + ":" + JSON.stringify(p)); });
  return { sys, ctx: {
    agentId,
    events: sys.events,
    actions: sys.actions,
    config: { port },
    dataDir: process.env.WEB_DATADIR,
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
  } else if (op === "return") {
    instances[rest] && instances[rest].sys.events.emit(${JSON.stringify(Events.LLM_RETURN)}, { id: "x", at: Date.now(), ok: true, data: { content: "ok", toolCalls: [] } });
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
  lines: string[];
  send(cmd: string): void;
  waitFor(pred: (lines: string[]) => boolean, ms?: number): Promise<boolean>;
  close(): Promise<void>;
  notImplemented: boolean;
}

async function startChild(agents: string[]): Promise<Child> {
  const dataDir = fs.mkdtempSync(path.join(TMP, "data-"));
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
  return child;
}

function assertUp(c: Child): void {
  assert.ok(!c.notImplemented, "web plugin not implemented yet: public_plugin/web/index.ts missing or no setup()");
  assert.ok(c.port > 0, "the hub must bind a port and print its URL (got port " + c.port + ")");
}

const base = (c: Child) => "http://127.0.0.1:" + c.port;

/** Open an SSE stream and accumulate parsed events into the returned array. */
async function openSSE(
  c: Child,
  id: string,
): Promise<{ events: any[]; status: number; close: () => void }> {
  const ac = new AbortController();
  const res = await fetch(base(c) + "/api/agents/" + id + "/stream", { signal: ac.signal });
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
    const res = await fetch(base(c) + "/api/agents");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: string[] };
    assert.deepEqual([...body.agents].sort(), ["alice", "bob"], "both agents are listed online");
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

// ===========================================================================
// Scenario 2 — POST a message routes input.message + fire_now to EXACTLY that
// agent's bus (not another's), and returns { id, status:"sent" }
// ===========================================================================

test("web: POST /api/agents/:id/message emits input.message + fire_now on THAT agent only", async () => {
  const c = await startChild(["alice", "bob"]);
  try {
    assertUp(c);
    const res = await fetch(base(c) + "/api/agents/alice/message", {
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
    const res = await fetch(base(c) + "/api/agents/ghost/message", {
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
    const res = await fetch(base(c) + "/api/agents/alice/message", {
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
    const res = await fetch(base(c) + "/api/agents/ghost/stream");
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

    const res = await fetch(base(c) + "/api/agents/alice/message", {
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

    c.send("return alice"); // the beat that folded the message completes
    assert.ok(await waitEvents(a.events, (e) => e.some((x) => x.type === "status" && x.id === id && x.status === "read")),
      "llm.return flips the message to 'read'");
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
    const stillUp = await fetch(base(c) + "/api/agents").then((r) => r.status).catch(() => 0);
    assert.equal(stillUp, 200, "server stays up while bob is still registered");
    const agents = (await fetch(base(c) + "/api/agents").then((r) => r.json())) as { agents: string[] };
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
