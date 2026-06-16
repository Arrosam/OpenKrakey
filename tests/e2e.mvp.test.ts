/**
 * E2E — the crown-jewel MVP integration test.
 *
 * A REAL `agent_instance` runs the REAL `public_plugin/` code (llm-core, persona,
 * history, web, notes, toolbox) against a LOCAL stub LLM server, driven through the
 * WEB channel over HTTP. This is the full Phase-1 loop end-to-end:
 *
 *   POST /api/agents/e2e-agent/message {text:"hello krakey"}
 *     -> web: input.message Notify (channel "web") + clock.fire_now
 *     -> clock.tick -> orchestrator beat -> prompt.gather -> compose (persona -> <persona>) -> llm.request
 *     -> llm-core: chat({ system:<persona>, messages:<conversation from history>, tools })
 *     -> stub server: FIRST call returns a time.now tool_call; orchestrator dispatches
 *        the tool -> tool.result -> history records an assistant(toolCalls) turn + a tool turn
 *     -> LATER beat -> chat #2+ (messages now carry those Hermes turns) -> "E2E-FINAL-REPLY"
 *     -> llm.return (ok + content) -> llm-core emits output.message
 *     -> web streams { type:"output", text:"E2E-FINAL-REPLY" } over SSE to the browser
 *
 * The contracts that pin the wire shapes:
 *   - shared/actions: Events.* + the Notify/Request/Reply envelopes, Actions.CLOCK_*
 *   - contracts/llm:  LLMResponse { content, toolCalls }, ToolDef { name }
 *   - contracts/agent: AgentDefinition { id, intervalMs, plugins, config }
 *   - the plugin overviews (overviews/nodes/*.md) for each plugin's behavior
 *
 * RED-STATE rule: if the web plugin (or the others) is absent the loader has nothing
 * to wire — the web server never binds, the stub server sees < 2 requests, and the
 * SSE stream never delivers the reply. Every assertion FAILS on an assertion, and
 * nothing HANGS:
 *   - the stub server is always closed in a finally,
 *   - every wait has a hard deadline,
 *   - the child always force-exits after a fixed window, and the parent SIGKILLs it.
 *
 * The agent_instance + llm-gateway nodes ARE implemented (status: done), so the
 * harness imports them directly (harness-only imports are allowed; they are not the
 * plugins under test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(".");

// ---------------------------------------------------------------------------
// Stub OpenAI chat-completions server (unchanged): call #1 -> time.now tool_call,
// call #2+ -> "E2E-FINAL-REPLY".
// ---------------------------------------------------------------------------

interface StubServer {
  url: string;
  requests: any[];
  close(): Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const requests: any[] = [];

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url || !req.url.includes("/chat/completions")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = { __unparseable: true };
      }
      requests.push(body);

      const callNo = requests.length;
      const message =
        callNo === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "time.now", arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "E2E-FINAL-REPLY" };
      const finish_reason = callNo === 1 ? "tool_calls" : "stop";

      const payload = {
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "m",
        choices: [{ index: 0, message, finish_reason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    await new Promise<void>((r) => server.close(() => r()));
    throw new Error("stub server failed to bind a port");
  }
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          (server as any).closeAllConnections?.();
        } catch {
          /* older node: best effort */
        }
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// The child driver: boots a REAL agent (web on an ephemeral port) against the stub
// server, prints the bound URL ("PRINT:✦ Web chat: http://localhost:<port>"), and
// stays alive for the parent to drive over HTTP. Force-exits after a fixed window.
// ---------------------------------------------------------------------------

function childScript(serverUrl: string, agentsDir: string, publicPluginDir: string): string {
  const gatewayEntry = pathToFileURL(
    path.join(REPO_ROOT, "packages", "llm-gateway", "src", "index.ts"),
  ).href;
  const agentEntry = pathToFileURL(
    path.join(REPO_ROOT, "packages", "agent_instance", "src", "index.ts"),
  ).href;

  return `
import { createCommunicatorLibrary } from ${JSON.stringify(gatewayEntry)};
import { createAgentInstance } from ${JSON.stringify(agentEntry)};

async function main() {
  const library = createCommunicatorLibrary({
    communicators: {
      stub: {
        provider: "openai-completion",
        model: "m",
        apiKey: "k",
        baseURL: ${JSON.stringify(serverUrl + "/v1")},
      },
    },
  });

  const def = {
    id: "e2e-agent",
    intervalMs: 250,
    plugins: ["llm-core", "persona", "history", "web", "notes", "toolbox"],
    privatePlugins: ["history"],
    config: {
      persona: { text: "PERSONA-MARK" },
      "llm-core": { communicator: "stub" },
      web: { port: 0 },
    },
  };

  const agent = createAgentInstance(def, {
    library,
    publicPluginDir: ${JSON.stringify(publicPluginDir)},
    agentsDir: ${JSON.stringify(agentsDir)},
    print: (t) => { console.log("PRINT:" + t); },
  });

  await agent.start();

  // Stay alive for the parent to drive over HTTP, then force-exit no matter what.
  setTimeout(() => {
    try { agent.stop(); } catch {}
    process.exit(0);
  }, 15000);
}

main().catch((err) => {
  console.log("BOOT_ERROR:" + (err && err.stack ? err.stack : String(err)));
  process.exit(0);
});
`;
}

// ---------------------------------------------------------------------------
// Run the whole e2e scenario once: start server, spawn child, read the bound port,
// open the agent's SSE stream, POST a message, collect streamed output until the
// final reply or a deadline. Returns the collected artifacts for assertion.
// ---------------------------------------------------------------------------

interface E2EResult {
  stdout: string;
  stderr: string;
  portBound: boolean;
  bootError: boolean;
  sseOutputs: string[];
  requests: any[];
}

/** Read SSE from an agent stream into `out`; resolve when `pred` holds or deadline. */
async function collectSSE(
  port: number,
  id: string,
  token: string,
  out: string[],
  pred: (texts: string[]) => boolean,
  ms: number,
): Promise<void> {
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), ms);
  try {
    const qs = token ? "?token=" + encodeURIComponent(token) : "";
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/${id}/stream${qs}`, { signal: ac.signal });
    if (!res.body) return;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
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
            const ev = JSON.parse(dl.slice(5).trim());
            if (ev && ev.type === "output" && typeof ev.text === "string") out.push(ev.text);
          } catch {
            /* skip */
          }
        }
      }
      if (pred(out)) break;
    }
  } catch {
    /* aborted / connection closed */
  } finally {
    clearTimeout(deadline);
    ac.abort();
  }
}

async function runE2E(): Promise<E2EResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-e2e-"));
  const agentsDir = path.join(tmp, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const publicPluginDir = path.join(REPO_ROOT, "public_plugin");

  const server = await startStubServer();
  const scriptPath = path.join(tmp, "e2e-child.mts");
  fs.writeFileSync(scriptPath, childScript(server.url, agentsDir, publicPluginDir), "utf8");

  let stdout = "";
  let stderr = "";
  let port = 0;
  let token = "";
  const sseOutputs: string[] = [];

  const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  try {
    // 1. Wait for the web server to print its bound URL (or a boot error).
    const portDeadline = Date.now() + 12_000;
    while (Date.now() < portDeadline) {
      if (stdout.includes("BOOT_ERROR")) break;
      const m = /PRINT:[^\n]*http:\/\/[^\s:]+:(\d+)/.exec(stdout);
      if (m) {
        port = parseInt(m[1], 10);
        const tk = /[?&]token=([^\s&]+)/.exec(stdout);
        token = tk ? tk[1] : "";
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    // 2. Drive the loop over HTTP: open the stream FIRST (so we miss nothing),
    //    then POST the message; collect until the final reply or a deadline.
    if (port > 0) {
      const collected = collectSSE(
        port,
        "e2e-agent",
        token,
        sseOutputs,
        (texts) => texts.some((t) => t.includes("E2E-FINAL-REPLY")),
        15_000,
      );
      await new Promise((r) => setTimeout(r, 150)); // let the stream attach
      const qs = token ? "?token=" + encodeURIComponent(token) : "";
      await fetch(`http://127.0.0.1:${port}/api/agents/e2e-agent/message${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello krakey" }),
      }).catch(() => {});
      await collected;
    }
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return {
    stdout,
    stderr,
    portBound: port > 0,
    bootError: stdout.includes("BOOT_ERROR"),
    sseOutputs,
    requests: server.requests,
  };
}

// A single shared run drives all assertions (the loop is expensive to boot).
let RESULT: E2EResult | null = null;
let RUN_ERROR: unknown = null;
try {
  RESULT = await runE2E();
} catch (err) {
  RUN_ERROR = err;
}

function result(): E2EResult {
  assert.ok(!RUN_ERROR, "e2e harness must run without crashing: " + String(RUN_ERROR));
  assert.ok(RESULT, "e2e harness produced no result");
  return RESULT!;
}

/** The system message content sent on a request (openai wire: role:'system'). */
function systemText(reqBody: any): string {
  const sys = (reqBody?.messages ?? []).find((m: any) => m?.role === "system");
  const c = sys?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  return "";
}

/** All wire messages of a given role across one request. */
function messagesOfRole(reqBody: any, role: string): any[] {
  return (reqBody?.messages ?? []).filter((m: any) => m?.role === role);
}

/** Names of all tool defs sent on a request (openai wire: tools[].function.name). */
function toolNames(reqBody: any): string[] {
  const tools = reqBody?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t: any) => t?.function?.name ?? t?.name).filter((n: any) => typeof n === "string");
}

// ===========================================================================
// Assertion 1 — boot health: no BOOT_ERROR, and the web server bound a port.
// ===========================================================================

test("e2e/1: the agent boots cleanly (no BOOT_ERROR) and the web server binds a port", () => {
  const r = result();
  assert.equal(
    r.bootError,
    false,
    "agent bring-up emitted BOOT_ERROR (plugins missing or contract misuse):\n" + r.stdout + "\n--stderr--\n" + r.stderr,
  );
  assert.equal(r.portBound, true, "the web plugin must bind + print its server URL");
});

// ===========================================================================
// Assertion 2 — the loop turns over: the stub server saw >= 2 chat requests.
// ===========================================================================

test("e2e/2: the stub LLM server received >= 2 chat requests (the beat loop turned over)", () => {
  const r = result();
  assert.ok(
    r.requests.length >= 2,
    "expected >= 2 chat requests (beat -> tool call -> beat); got " + r.requests.length,
  );
});

// ===========================================================================
// Assertion 3 — composition: the wrapped persona rides `system`, the user input is
// a real role:'user' turn tagged with its source channel, and the MVP tool defs ride.
// ===========================================================================

test("e2e/3: persona rides `system`, the user input is a role:'user' turn with its source, plus the MVP tool defs", () => {
  const r = result();
  assert.ok(r.requests.length >= 1, "no chat request reached the server at all");

  // The wrapped persona is present on request #1 — as the system message once a
  // conversation exists, or as the fallback user message before any input lands.
  const first = r.requests[0];
  const personaRe = /<persona>\s*PERSONA-MARK\s*<\/persona>/;
  const firstHasPersona =
    personaRe.test(systemText(first)) ||
    messagesOfRole(first, "user").some(
      (m) => typeof m.content === "string" && personaRe.test(m.content),
    );
  assert.ok(firstHasPersona, "request #1 must carry the wrapped persona (system or fallback user message)");

  // The user input shows up as a real role:'user' turn in messages[] (Hermes), and
  // its source channel is surfaced to the model via `name`.
  const hello = r.requests
    .flatMap((req) => messagesOfRole(req, "user"))
    .find((m) => typeof m.content === "string" && m.content.includes("hello krakey"));
  assert.ok(hello, "the user input must appear as a role:'user' turn in some request's messages[]");
  assert.equal(hello.name, "web", "the user turn's source channel must be surfaced via name");

  const names = toolNames(first);
  for (const expected of ["time.now", "clock.set_interval", "clock.set_default_interval", "note.save"]) {
    assert.ok(
      names.includes(expected),
      "tools[] must include the def '" + expected + "'; saw [" + names.join(", ") + "]",
    );
  }
});

// ===========================================================================
// Assertion 4 — the tool round-trip lands in messages[] as an assistant(tool_calls)
// turn + a matching role:'tool' result turn (history's Hermes folding).
// ===========================================================================

test("e2e/4: the tool round-trip folds back as an assistant(tool_calls) turn + a tool result turn", () => {
  const r = result();
  assert.ok(r.requests.length >= 2, "need >= 2 requests to observe the folded tool round");

  const assistantToolCall = r.requests
    .flatMap((req) => messagesOfRole(req, "assistant"))
    .some(
      (m) =>
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((tc: any) => tc?.function?.name === "time.now"),
    );
  assert.ok(assistantToolCall, "some request must carry an assistant turn with the time.now tool_call");

  const toolTurn = r.requests
    .flatMap((req) => messagesOfRole(req, "tool"))
    .some((m) => {
      const c = typeof m.content === "string" ? m.content : "";
      const hasPayload =
        /"?iso"?\s*[:=]/.test(c) || /epochMs/.test(c) || /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(c);
      return typeof m.tool_call_id === "string" && hasPayload;
    });
  assert.ok(toolTurn, "some request must carry a role:'tool' turn (tool_call_id + the time.now payload)");
});

// ===========================================================================
// Assertion 5 — the reply reaches the browser: the agent's SSE stream delivered
// an output event carrying "E2E-FINAL-REPLY" (llm.return -> output.message -> web SSE).
// ===========================================================================

test("e2e/5: the final reply travels llm.return -> output.message -> web SSE stream", () => {
  const r = result();
  assert.ok(
    r.sseOutputs.some((t) => t.includes("E2E-FINAL-REPLY")),
    "the web SSE stream must deliver the assistant reply; got events:\n" + JSON.stringify(r.sseOutputs),
  );
});
