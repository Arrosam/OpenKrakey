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
 *         then { type:"output", text } per web.send_message tool call dispatched to that
 *         agent, and { type:"status", id, status:"sent"|"read" } per message lifecycle. unknown id -> 404.
 *   sent = appended to the queue (POST). read = processed: flipped when llm.return
 *   fires on that agent's bus. R6: an agent's stream carries ONLY its own events.
 *   Lifecycle: first setup binds the server; last teardown closes it (port freed).
 *
 * Driven END-TO-END in a CHILD process: the child builds N per-Agent instances
 * sharing the hub on an EPHEMERAL port (first agent config.port=0), reports the
 * bound port, observes each agent's bus (GOT_INPUT/FIRED), and runs a stdin command
 * loop (out/raw/return/down/quit) so the parent can invoke web.send_message / emit llm.return on
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

/** The chat-tool action the agent invokes to speak to the web channel. */
const SEND_ACTION = "web.send_message";

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
//   out <id> <text>   -> invoke web.send_message{text} (the agent's explicit send) on <id>'s bus
//   raw <id> <text>   -> emit a bare output.message{text} (the monologue hook; web ignores it)
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
  // Mock the tool registry (llm-core's llm.register_tool action) so web can declare
  // its chat tool; surface the registered ToolDef so a test can assert it.
  sys.actions.register("llm.register_tool", async (def) => { emit("TOOL_REGISTERED:" + agentId + ":" + JSON.stringify(def)); return true; });
  // PER-AGENT dataDir: each agent gets its OWN isolated subdir under WEB_DATADIR.
  // This (a) isolates one agent's persisted transcript from another's (R6), and
  // (b) lets a SECOND child process reuse the same WEB_DATADIR to load an agent's
  // prior transcript from disk (the "survives restart" property).
  const agentDataDir = path.join(process.env.WEB_DATADIR, agentId);
  fs.mkdirSync(agentDataDir, { recursive: true });
  // Optional CONFIGURED token, injected via WEB_TOKEN, lands FLAT on ctx.config —
  // web reads its per-plugin slice flat (ctx.config.token), as the loader delivers
  // it. Left unset by default so every existing caller keeps the random-token path.
  // An empty WEB_TOKEN ("") is forwarded verbatim (a falsy configured token).
  const cfg = { port };
  if (process.env.WEB_TOKEN !== undefined) cfg.token = process.env.WEB_TOKEN;
  return { sys, blocks, ctx: {
    agentId,
    events: sys.events,
    actions: sys.actions,
    config: cfg,
    dataDir: agentDataDir,
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b) => {
      blocks.set(b.id, b);
      // Surface the registered block (BLOCK_SET:<agent>:<json>) so a test can assert
      // web's guidance block — id/label/priority + rendered text. render() is sync
      // here; if a future block renders async, text is reported null (fine for web).
      let text = null;
      try { const r = b.render(); if (typeof r === "string") text = r; } catch {}
      emit("BLOCK_SET:" + agentId + ":" + JSON.stringify({ id: b.id, label: b.label, priority: b.priority, target: b.target, text }));
    },
    getBlock: (id) => blocks.get(id),
    // Surface removals (BLOCK_REMOVED:<agent>:<id>) so a test can assert teardown
    // drops the block. Preserve the contract return (true iff a block was removed).
    removeBlock: (id) => { const had = blocks.delete(id); emit("BLOCK_REMOVED:" + agentId + ":" + id); return had; },
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
  const { sys, ctx, blocks } = makeCtx(a, isFirst ? 0 : 7717);
  isFirst = false;
  const plugin = mod.default();
  await plugin.setup(ctx);
  instances[a] = { plugin, sys, blocks };
}
emit("SETUP_DONE");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const t = line.trim(); if (!t) return;
  const sp = t.indexOf(" ");
  const op = sp === -1 ? t : t.slice(0, sp);
  const rest = sp === -1 ? "" : t.slice(sp + 1);
  if (op === "out" || op === "raw") {
    // Shared parse, guarded like req/ret: "<id> <text>"; a missing text -> "".
    const sp2 = rest.indexOf(" ");
    const id = sp2 === -1 ? rest : rest.slice(0, sp2);
    const text = sp2 === -1 ? "" : rest.slice(sp2 + 1);
    if (op === "out") {
      // The agent speaks ONLY by invoking its explicit chat tool — the orchestrator
      // dispatches a web.send_message tool call to this action on the agent's bus.
      // Surface (don't swallow) a send error so a real failure isn't an opaque timeout.
      instances[id] &&
        instances[id].sys.actions
          .invoke(${JSON.stringify(SEND_ACTION)}, { text })
          .catch((e) => emit("SEND_ERROR:" + id + ":" + String(e && e.message ? e.message : e)));
    } else {
      // A bare output.message on the bus — the LLM's private monologue hook. web must
      // IGNORE it for display now (decoupling): it must NOT reach the browser stream.
      instances[id] &&
        instances[id].sys.events.emit(${JSON.stringify(Events.OUTPUT_MESSAGE)}, { at: Date.now(), data: { text } });
    }
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
  } else if (op === "render") {
    // render <id> <blockId> -> emit BLOCK_RENDER:<id>:<blockId>:<json> (a block's rendered output)
    const s2 = rest.indexOf(" ");
    const rid = s2 === -1 ? rest : rest.slice(0, s2);
    const bid = s2 === -1 ? "" : rest.slice(s2 + 1);
    const b = instances[rid] && instances[rid].blocks.get(bid);
    if (b) Promise.resolve(b.render()).then((out) => emit("BLOCK_RENDER:" + rid + ":" + bid + ":" + JSON.stringify(out)), () => {});
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
  opts: { dataDir?: string; token?: string } = {},
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
    env: {
      ...process.env,
      WEB_AGENTS: agents.join(","),
      WEB_DATADIR: dataDir,
      // Forward a CONFIGURED token only when the caller asked for one (so the
      // child sets config.web.token). Unset by default → child omits it → the
      // server mints a random token, exactly as every existing test expects.
      ...(opts.token !== undefined ? { WEB_TOKEN: opts.token } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Writing to a child that has already exited (e.g. it CRASHED on a malformed
  // request, which is exactly what the FIX-1 robustness tests provoke) surfaces
  // EPIPE as an async 'error' event on stdin — which would otherwise become an
  // uncaught exception attributed to an unrelated finishing test. Swallow it; a
  // crash is then observed cleanly by the follow-up health-check probe instead.
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
        // If the child already exited (e.g. it crashed on a malformed request),
        // 'close' will never fire again — resolve immediately so the test's
        // finally never hangs and we don't write to a dead stdin.
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

/**
 * Fetch and report whether the server ANSWERED vs DROPPED the connection. A
 * crashed/killed process yields a rejected fetch (ECONNREFUSED / ECONNRESET /
 * socket hang up) — that rejection is the "dropped" signal a crash detector
 * needs. Never throws; resolves to a small descriptor. (Mirrors inspector's
 * probe(): drain the body so the socket is released and keep-alive can't wedge.)
 */
async function probe(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(url, init);
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
// Scenario 3b — monologue decoupling + chat-tool registration
//   web renders to the browser ONLY via the explicit web.send_message tool; a bare
//   output.message (the LLM monologue hook llm-core still emits) must be IGNORED.
// ===========================================================================

test("web: a bare output.message (the LLM monologue) is NOT streamed to the browser", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const a = await openSSE(c, "alice");
    await waitEvents(a.events, (e) => e.some((x) => x.type === "output")); // greeting

    // The monologue hook fires on the bus, but web is decoupled from it now.
    c.send("raw alice MONOLOGUE-GHOST");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      !a.events.some((x) => x.type === "output" && x.text === "MONOLOGUE-GHOST"),
      "a bare output.message must NOT reach the browser stream (web no longer renders it)",
    );

    // ...but an explicit web.send_message DOES reach the stream.
    c.send("out alice REAL-SEND");
    assert.ok(
      await waitEvents(a.events, (e) => e.some((x) => x.type === "output" && x.text === "REAL-SEND")),
      "an explicit web.send_message must reach the browser stream",
    );
    a.close();
  } finally {
    await c.close();
  }
});

test("web: registers a 'web.send_message' chat tool (ToolDef with a string text param)", async () => {
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    assert.ok(
      await c.waitFor((ls) => ls.some((l) => l.startsWith("TOOL_REGISTERED:alice:"))),
      "web must declare a tool via llm.register_tool",
    );
    const line = c.lines.find((l) => l.startsWith("TOOL_REGISTERED:alice:"))!;
    const def = JSON.parse(line.slice("TOOL_REGISTERED:alice:".length));
    assert.equal(def.name, "web.send_message", "the tool is named web.send_message");
    assert.ok(
      typeof def.description === "string" && def.description.length > 0,
      "the tool carries a description for the LLM",
    );
    const props = def.parameters && def.parameters.properties;
    assert.ok(
      props && props.text && props.text.type === "string",
      "the tool takes a string `text` parameter",
    );
  } finally {
    await c.close();
  }
});

test("web: contributes a guidance context block stating the monologue rule + naming web.send_message", async () => {
  // The send tool gives the LLM the MECHANISM to speak; this block gives it the RULE.
  // Structural (offline) check: web must put the speak-vs-think rule into the composed
  // prompt — not rely solely on the tool description — so a real model is far likelier
  // to call web.send_message instead of "replying" in plain text (which web renders to
  // no one). It can NOT prove a live model obeys the rule; that needs a reachable LLM.
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    // Select web's GUIDANCE block by id (web also registers a web.conversation block).
    const prefix = "BLOCK_SET:alice:";
    const isGuidance = (l: string) => l.startsWith(prefix) && l.includes('"id":"web.guidance"');
    assert.ok(
      await c.waitFor((ls) => ls.some(isGuidance)),
      "web must register the web.guidance context block via ctx.setBlock",
    );
    const block = JSON.parse(c.lines.find(isGuidance)!.slice(prefix.length));

    // web's OWN block (namespaced id), placed just BELOW persona's stable 10000 so
    // persona stays the top cache-prefix, but well above any volatile content.
    assert.match(block.id, /^web\./, "the block id is web-namespaced (e.g. web.guidance)");
    assert.ok(
      block.priority < 10000,
      "priority must sit BELOW persona's stable 10000 so persona stays the prompt-cache prefix on top (got " + block.priority + ")",
    );
    assert.ok(
      block.priority >= 1000,
      "but it is a high/stable priority, not buried among volatile blocks (got " + block.priority + ")",
    );

    // The rendered guidance must (a) name the explicit send tool and (b) state the
    // monologue rule: a plain reply is private / delivered to no one.
    assert.ok(typeof block.text === "string" && block.text.length > 0, "the block renders non-empty guidance text");
    assert.match(block.text, /web\.send_message/, "the guidance names the web.send_message tool");
    assert.match(block.text, /monologue/i, "the guidance states the reply-is-a-monologue rule");
    assert.match(
      block.text,
      /private|no one|never|silen/i,
      "the guidance must make clear a plain reply is NOT delivered to the user",
    );

    // Symmetry: the block is registered in setup and REMOVED on teardown.
    c.send("down alice");
    assert.ok(await c.waitFor((ls) => ls.includes("TORE_DOWN:alice")), "alice tears down");
    assert.ok(
      c.lines.includes("BLOCK_REMOVED:alice:" + block.id),
      "teardown must remove web's guidance block; saw " +
        JSON.stringify(c.lines.filter((l) => l.startsWith("BLOCK_REMOVED:"))),
    );
  } finally {
    await c.close();
  }
});

test("web: contributes a 'web.conversation' messages-block rendering its transcript as clean turns", async () => {
  // Web owns its chat history: it persists the dialogue (user messages + agent sends)
  // and contributes it to the prompt as a message-target block. render() maps the
  // transcript to CLEAN wire turns — user -> {role:user,name:web}, agent send ->
  // {role:assistant} — with no monologue and no tool mechanics.
  const c = await startChild(["alice"]);
  try {
    assertUp(c);
    const prefix = "BLOCK_SET:alice:";
    const isConvo = (l: string) => l.startsWith(prefix) && l.includes('"id":"web.conversation"');
    assert.ok(await c.waitFor((ls) => ls.some(isConvo)), "web must register a web.conversation block");
    const blk = JSON.parse(c.lines.find(isConvo)!.slice(prefix.length));
    assert.equal(blk.target, "messages", "the conversation block targets the messages array");
    assert.equal(blk.priority, 5000, "median priority 5000 (other message-blocks can sit before or after)");

    // Populate the transcript: a user message (POST) and an agent send (web.send_message).
    const res = await fetch(api(c, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi there" }),
    });
    assert.equal(res.status, 202, "the user message is accepted (and stored)");
    c.send("out alice hello back");
    await new Promise((r) => setTimeout(r, 250)); // let the agent send append to the transcript

    // Render the block — it must yield exactly the two clean turns, in order.
    c.send("render alice web.conversation");
    assert.ok(
      await c.waitFor((ls) => ls.some((l) => l.startsWith("BLOCK_RENDER:alice:web.conversation:"))),
      "the conversation block must render its messages",
    );
    const rLine = c.lines.find((l) => l.startsWith("BLOCK_RENDER:alice:web.conversation:"))!;
    const msgs = JSON.parse(rLine.slice("BLOCK_RENDER:alice:web.conversation:".length));
    assert.deepEqual(
      msgs,
      [
        { role: "user", content: "hi there", name: "web" },
        { role: "assistant", content: "hello back" },
      ],
      "user -> {role:user,name:web}; agent send -> {role:assistant}; nothing else",
    );

    // Registered in setup, removed on teardown.
    c.send("down alice");
    assert.ok(await c.waitFor((ls) => ls.includes("TORE_DOWN:alice")), "alice tears down");
    assert.ok(
      c.lines.includes("BLOCK_REMOVED:alice:web.conversation"),
      "teardown must remove the conversation block",
    );
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

// ===========================================================================
// NEW SECTION — REGRESSION tests for two chat-history persistence FIXES
// ---------------------------------------------------------------------------
// These extend the persistence suite above with two properties that the current
// code gets WRONG (so they are RED today and GREEN once the fixes land). They
// reuse the SAME child harness — the per-agent dataDir (path.join(WEB_DATADIR,
// agentId)), the two-process restart pattern over a FIXED WEB_DATADIR
// (startChild(agents, { dataDir })), the stdin command loop (req/ret + POST),
// openSSE, and the { type:"history" } event parsing — with NO harness changes:
//   * Reading the new message's id   -> the POST already returns { id }.
//   * Waiting for live "read" state  -> the { type:"status", id, status:"read" }
//                                       event openSSE already parses.
//   * Restart / load-from-disk       -> startChild's existing opts.dataDir.
// Only two small READ-ONLY helpers are added below; every existing caller and
// the harness itself are untouched.
//
// The wire contract these rely on is the one already documented for the history
// event above: each replayed message is
//     { role:"user"|"agent", text:string, id?:number, status?:string }
// so a persisted USER message carries BOTH its numeric `id` and its `status`
// ("sent" until read, "read" after the beat that carried it completes).
//
// FIX M-9 — `read` status must be PERSISTED:
//   Today the llm.return handler broadcasts { status:"read" } to live clients but
//   never updates the STORED transcript, so a message that was read replays as
//   "sent" after a restart. After the fix the in-memory transcript entry is set
//   to status:"read" on llm.return and persisted (compacting rewrite on
//   teardown), so a clean restart replays it as "read".
//
// FIX M-8 — msgSeq must be SEEDED from persisted history:
//   Today msgSeq is module-global and resets to 0 each process, so after a
//   restart a new message reuses ids (1,2,…) that COLLIDE with replayed
//   historical ids. After the fix msgSeq is seeded from the max persisted id at
//   load, so a new message's id is strictly greater than every replayed id.
// ===========================================================================

/** The first replayed history message whose text === `text` (or undefined). */
function historyMsgByText(events: any[], text: string): any | undefined {
  const h = historyEvent(events);
  if (!h || !Array.isArray(h.messages)) return undefined;
  return h.messages.find((m) => m && m.text === text);
}

/** The max numeric `id` across a history event's replayed messages (-Infinity if none). */
function maxHistoryId(events: any[]): number {
  const h = historyEvent(events);
  if (!h || !Array.isArray(h.messages)) return -Infinity;
  return h.messages.reduce(
    (mx, m) => (m && typeof m.id === "number" ? Math.max(mx, m.id) : mx),
    -Infinity,
  );
}

// --- Test M-9: a READ message replays as "read" (not "sent") after a clean restart ---
test("web: read status survives a clean restart (a read message replays as 'read', not 'sent')", async () => {
  // One FIXED root shared by both child processes (per-agent subdirs live under it).
  const fixed = fs.mkdtempSync(path.join(TMP, "read-persist-"));

  // --- child #1: post a message, drive its beat to completion so it is marked
  // read LIVE, confirm the live "read" status, then quit (teardown persists). ---
  const c1 = await startChild(["alice"], { dataDir: fixed });
  try {
    assertUp(c1);
    const live = await openSSE(c1, "alice");
    await waitEvents(live.events, (e) => e.some((x) => x.type === "output")); // greeting

    const res = await fetch(api(c1, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "read-me" }),
    });
    assert.equal(res.status, 202);
    const { id } = (await res.json()) as { id: number };

    // It starts life "sent"...
    assert.ok(
      await waitEvents(live.events, (e) =>
        e.some((x) => x.type === "status" && x.id === id && x.status === "sent"),
      ),
      "the message is acked 'sent' live",
    );

    // ...then the beat that carried it (its llm.request) returns -> flips to "read".
    c1.send("req alice R1");
    c1.send("ret alice R1");
    assert.ok(
      await waitEvents(live.events, (e) =>
        e.some((x) => x.type === "status" && x.id === id && x.status === "read"),
      ),
      "the message flips to 'read' live when its request returns (precondition for persisting read)",
    );
    live.close();
  } finally {
    await c1.close(); // process exits; teardown must persist the READ status
  }

  // --- child #2: SAME root, brand-new process. The replayed message must be
  // status:"read" — NOT "sent". This is the regression: today read is never
  // written to the stored transcript, so it replays as "sent" (RED). ---
  const c2 = await startChild(["alice"], { dataDir: fixed });
  try {
    assertUp(c2);
    const fresh = await openSSE(c2, "alice");
    assert.ok(
      await waitEvents(fresh.events, (e) => historyMsgByText(e, "read-me") !== undefined),
      "child #2 must replay the persisted 'read-me' message in its history",
    );
    const msg = historyMsgByText(fresh.events, "read-me");
    assert.equal(msg.role, "user", "the replayed message is the user message");
    assert.equal(
      msg.status,
      "read",
      "a message that was READ before the restart must replay as 'read', not 'sent' (got " +
        JSON.stringify(msg.status) + ")",
    );
    fresh.close();
  } finally {
    await c2.close();
  }
});

// --- Test M-8: a NEW message's id does not collide with replayed ids after restart ---
test("web: a new message's id does not collide with replayed ids after a restart (msgSeq seeded from history)", async () => {
  // One FIXED root shared by both child processes.
  const fixed = fs.mkdtempSync(path.join(TMP, "seq-persist-"));

  // --- child #1: post TWO messages (ids ~1 and ~2), then quit (persist). ---
  const c1 = await startChild(["alice"], { dataDir: fixed });
  try {
    assertUp(c1);
    const post = async (text: string): Promise<number> => {
      const r = await fetch(api(c1, "/api/agents/alice/message"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      assert.equal(r.status, 202, "POST " + text + " accepted");
      const { id } = (await r.json()) as { id: number };
      assert.equal(typeof id, "number", "a numeric id is assigned to " + text);
      return id;
    };
    const id1 = await post("first");
    const id2 = await post("second");
    assert.ok(id2 > id1, "ids are monotonically increasing within a process (" + id1 + " < " + id2 + ")");
  } finally {
    await c1.close(); // process exits; the two ids are persisted to disk
  }

  // --- child #2: SAME root, brand-new process. POST a NEW message; its id must
  // be STRICTLY GREATER than the max id replayed from child #1's history.
  // Today msgSeq resets to 0 each process, so the new id is 1 and COLLIDES with a
  // replayed id (RED). After the fix msgSeq is seeded from the max persisted id,
  // so the new id is > every replayed id (GREEN). ---
  const c2 = await startChild(["alice"], { dataDir: fixed });
  try {
    assertUp(c2);

    // First, learn the max id present in the replayed history (must be >= 2).
    const fresh = await openSSE(c2, "alice");
    assert.ok(
      await waitEvents(fresh.events, (e) => historyEvent(e) !== undefined && historyEvent(e)!.messages.length >= 2),
      "child #2 must replay both prior messages so we can read their ids",
    );
    const replayedMax = maxHistoryId(fresh.events);
    assert.ok(
      Number.isFinite(replayedMax) && replayedMax >= 2,
      "the replayed history must carry numeric ids (max >= 2); got " + replayedMax,
    );
    fresh.close();

    // Now POST a brand-new message and inspect its assigned id.
    const r = await fetch(api(c2, "/api/agents/alice/message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "after-restart" }),
    });
    assert.equal(r.status, 202);
    const { id: newId } = (await r.json()) as { id: number };
    assert.equal(typeof newId, "number", "the new message gets a numeric id");
    assert.ok(
      newId > replayedMax,
      "a new message's id must be strictly greater than every replayed id (so it cannot collide); " +
        "new id " + newId + " must be > replayed max " + replayedMax,
    );
  } finally {
    await c2.close();
  }
});

// ###########################################################################
// SECURITY REGRESSION — robustness & token-from-config hardening (mirror of the
// inspector fixes). These reuse the SAME child harness (startChild / assertUp /
// base / api / c.token / probe) as every test above. Two of the three are RED on
// today's code and GREEN once the fixes land; the third is a guard that should
// already hold.
//
//   FIX 1 (RED today) — a MALFORMED percent-escape in the :id path segment must
//     not crash the shared process. The token-gated routes decode the id with
//     decodeURIComponent, which THROWS a URIError on a bad escape ("%", a
//     truncated multibyte like "%E0%A4%A"). Pre-fix that throw is uncaught and
//     takes down the whole process — every Agent sharing it. The route should
//     instead fail closed as a normal unknown-id 404, and the server must stay up.
//
//   FIX 2 — the config.web.token adopt policy must mirror inspector's: a
//     configured token is adopted only if it is a string of length >= 16 matching
//     ^[A-Za-z0-9._~+/=-]+$; anything else is DISCARDED and a fresh random token
//     is used. Two halves, asserted independently:
//       (a) an INVALID configured value must NOT authenticate (401);
//       (b) a VALID configured value MUST be adopted (200).
//     (b) is RED today — the current code does not adopt config.web.token at all
//     (it always mints a random token), so the configured valid token is ignored.
//     (a) is a guard that holds both before and after the fix (an unadopted bogus
//     value, and a discarded one, are both rejected) — it pins the rejection side
//     so a future "adopt verbatim" regression would turn it RED.
// ###########################################################################

// ===========================================================================
// FIX 1 — a malformed %-escape in the :id must yield a 4xx and NOT crash the
// server (the decisive assertion: a subsequent normal request still succeeds).
// ===========================================================================

// Each malformed id segment is an invalid percent-escape that decodeURIComponent
// rejects with a URIError: a lone "%" and a truncated multibyte "%E0%A4%A".
const MALFORMED_IDS = ["%", "%E0%A4%A"];

for (const badId of MALFORMED_IDS) {
  test(
    "web(security): GET /api/agents/<malformed id '" + badId + "'>/stream is a 4xx and does NOT crash the server",
    async () => {
      const c = await startChild(["alice"]);
      try {
        assertUp(c);

        // The token-gated stream route with a malformed :id. It must ANSWER
        // (not drop the socket) and resolve to a normal unknown-id 404 — a
        // malformed id is certainly not a live agent. Guard the fetch so a crash
        // surfaces as a clean assertion failure, not a hung test.
        const bad = await probe(api(c, "/api/agents/" + badId + "/stream"));
        assert.ok(
          bad.ok,
          "GET /api/agents/" + badId + "/stream must return a response, not drop the connection " +
            "(network error: " + (bad.error || "") + ")",
        );
        assert.ok(
          bad.status >= 400 && bad.status < 500,
          "a malformed percent-encoded id must be a 4xx, got " + bad.status,
        );
        assert.equal(bad.status, 404, "a malformed id resolves to a normal 404 (unknown agent)");

        // THE crash detector: a subsequent well-formed authed request must still
        // be served. Pre-fix the process is gone and this fetch is refused.
        const after = await probe(api(c, "/api/agents"));
        assert.ok(
          after.ok,
          "the server must still be alive after the malformed stream id (the follow-up " +
            "request was dropped — the process crashed: " + (after.error || "") + ")",
        );
        assert.equal(after.status, 200, "a normal GET /api/agents after the malformed id returns 200 (server survived)");

        // The per-agent state survived too.
        const body = (await fetch(api(c, "/api/agents")).then((r) => r.json())) as { agents: string[] };
        assert.deepEqual(body.agents, ["alice"], "the agent is still registered after the malformed id");
      } finally {
        await c.close();
      }
    },
  );

  test(
    "web(security): POST /api/agents/<malformed id '" + badId + "'>/message is a 4xx and does NOT crash the server",
    async () => {
      const c = await startChild(["alice"]);
      try {
        assertUp(c);

        const bad = await probe(api(c, "/api/agents/" + badId + "/message"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        });
        assert.ok(
          bad.ok,
          "POST /api/agents/" + badId + "/message must return a response, not drop the connection " +
            "(network error: " + (bad.error || "") + ")",
        );
        assert.ok(
          bad.status >= 400 && bad.status < 500,
          "a malformed percent-encoded id must be a 4xx, got " + bad.status,
        );
        assert.equal(bad.status, 404, "a malformed id resolves to a normal 404 (unknown agent)");

        // Crash detector + the malformed POST must NOT have reached any bus.
        const after = await probe(api(c, "/api/agents"));
        assert.ok(
          after.ok,
          "the server must still be alive after the malformed POST id (follow-up dropped — crashed: " +
            (after.error || "") + ")",
        );
        assert.equal(after.status, 200, "a normal GET /api/agents after the malformed POST id returns 200 (server survived)");
        assert.ok(
          !c.lines.some((l) => l.startsWith("GOT_INPUT:")),
          "a malformed-id POST must never reach an agent's bus",
        );
      } finally {
        await c.close();
      }
    },
  );
}

// ===========================================================================
// FIX 2 — an INVALID configured token is discarded (a fresh random token is
// used), so a request presenting the configured value gets 401; a VALID long
// configured token IS adopted (a request presenting it gets 200).
// ===========================================================================

/**
 * Read the session-cookie NAME the server sets on GET /?token=<valid>. Grounding
 * the cookie vector in the server's OWN Set-Cookie avoids hard-coding a name.
 * Returns undefined if no cookie is set (then the cookie vector is skipped).
 */
async function discoverCookieName(c: Child, validToken: string): Promise<string | undefined> {
  const sep = "?";
  const res = await fetch(base(c) + "/" + sep + "token=" + encodeURIComponent(validToken));
  const sc = res.headers.get("set-cookie");
  if (!sc) return undefined;
  const eq = sc.indexOf("=");
  return eq === -1 ? undefined : sc.slice(0, eq).trim();
}

// Each INVALID configured token violates the adopt policy (length >= 16 AND
// charset ^[A-Za-z0-9._~+/=-]+$): "x" is too short; "bad token!" has a space and
// "!" (and is too short). Neither may be adopted.
const INVALID_TOKENS: Array<{ label: string; value: string }> = [
  { label: "too short", value: "x" },
  { label: "illegal characters", value: "bad token!" },
];

for (const { label, value } of INVALID_TOKENS) {
  test(
    "web(security): an INVALID configured token (" + label + ") is rejected with 401 (not adopted)",
    async () => {
      const c = await startChild(["alice"], { token: value });
      try {
        assertUp(c);

        // The server must have minted a DIFFERENT (random, valid) token — never
        // the bogus configured value. (child.token is parsed from the printed URL.)
        assert.notEqual(
          c.token,
          value,
          "an invalid configured token must NOT be adopted as the live token (printed token=" +
            JSON.stringify(c.token) + ")",
        );
        assert.ok(
          c.token.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/.test(c.token),
          "the replacement token must be a valid random token: " + JSON.stringify(c.token),
        );

        // Presenting the bogus configured value via ?token= -> 401.
        const viaQuery = await fetch(
          base(c) + "/api/agents?token=" + encodeURIComponent(value),
        );
        assert.equal(viaQuery.status, 401, "the invalid configured token must be rejected via ?token=");

        // ...via Authorization: Bearer -> 401.
        const viaBearer = await fetch(base(c) + "/api/agents", {
          headers: { authorization: "Bearer " + value },
        });
        assert.equal(viaBearer.status, 401, "the invalid configured token must be rejected via Bearer");

        // ...via the session cookie (name discovered from the server's own
        // Set-Cookie on a valid token) -> 401. web reads its cookie raw.
        const cookieName = await discoverCookieName(c, c.token);
        if (cookieName) {
          const viaCookie = await fetch(base(c) + "/api/agents", {
            headers: { cookie: cookieName + "=" + value },
          });
          assert.equal(viaCookie.status, 401, "the invalid configured token must be rejected via cookie");
        }

        // Sanity: the ACTUAL minted token still authenticates (the gate works).
        const viaReal = await fetch(api(c, "/api/agents"));
        assert.equal(viaReal.status, 200, "the real (random) token still authenticates");
      } finally {
        await c.close();
      }
    },
  );
}

test("web(security): a VALID long configured token IS adopted (a request presenting it gets 200)", async () => {
  // 24 chars, all within ^[A-Za-z0-9._~+/=-]+$ — satisfies the adopt policy.
  const good = "Abc123._~-valid-token-okk";
  assert.ok(good.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/.test(good), "test token must satisfy the policy");

  const c = await startChild(["alice"], { token: good });
  try {
    assertUp(c);

    // The server must have adopted the configured token verbatim — so it is the
    // token printed in the startup URL.
    assert.equal(c.token, good, "a valid configured token must be adopted as the live token");

    // A request presenting the configured token authenticates (all three vectors).
    const viaQuery = await fetch(base(c) + "/api/agents?token=" + encodeURIComponent(good));
    assert.equal(viaQuery.status, 200, "the adopted token authenticates via ?token=");

    const viaBearer = await fetch(base(c) + "/api/agents", {
      headers: { authorization: "Bearer " + good },
    });
    assert.equal(viaBearer.status, 200, "the adopted token authenticates via Bearer");

    const cookieName = await discoverCookieName(c, good);
    if (cookieName) {
      const viaCookie = await fetch(base(c) + "/api/agents", {
        headers: { cookie: cookieName + "=" + good },
      });
      assert.equal(viaCookie.status, 200, "the adopted token authenticates via cookie");
    }

    // And a DIFFERENT (wrong) token is still rejected — the gate is real.
    const wrong = await fetch(base(c) + "/api/agents?token=" + encodeURIComponent(good + "X"));
    assert.equal(wrong.status, 401, "a token differing from the adopted one is still rejected");
  } finally {
    await c.close();
  }
});
