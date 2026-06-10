/**
 * E2E — the crown-jewel MVP integration test.
 *
 * A REAL `agent_instance` runs the REAL `public_plugin/` code (llm-core, persona,
 * history, console-channel, notes, toolbox) against a LOCAL stub LLM server, driven
 * through the console channel. This is the full Phase-1 loop end-to-end:
 *
 *   stdin line
 *     -> console-channel: input.message Notify + clock.fire_now
 *     -> clock.tick -> orchestrator beat -> prompt.gather -> compose (persona 10000+
 *        on top, history 100 with the folded input) -> llm.request
 *     -> llm-core: chat({ messages:[{role:"user", content: context.text}], tools })
 *     -> stub server: FIRST call returns a time.now tool_call; orchestrator dispatches
 *        the tool -> tool.result -> history folds "assistant -> tool" + "tool -> {…}"
 *     -> LATER beat: context now carries the tool result -> chat #2+ -> "E2E-FINAL-REPLY"
 *     -> llm.return (ok + content) -> llm-core emits output.message
 *     -> console-channel prints "\n[krakey] E2E-FINAL-REPLY\n" to stdout
 *
 * The contracts that pin the wire shapes:
 *   - shared/actions: Events.* + the Notify/Request/Reply envelopes, Actions.CLOCK_*
 *   - contracts/llm:  LLMResponse { content, toolCalls }, ToolDef { name }
 *   - contracts/agent: AgentDefinition { id, intervalMs, plugins, config }
 *   - the plugin overviews (overviews/nodes/*.md) for each plugin's behavior
 *
 * RED-STATE rule: the six plugins under public_plugin/ DO NOT EXIST yet. With an
 * empty publicPluginDir-equivalent (the real public_plugin/ dir is empty), the
 * loader has nothing to load: no llm-core means no llm.request listener, no
 * console-channel means no greeting/stdin wiring, no output.message printer.
 * So until the plugins land, the server receives < 2 requests and stdout lacks the
 * markers — every assertion FAILS on an assertion, and nothing HANGS:
 *   - the stub server is always closed in a finally,
 *   - every wait has a hard deadline,
 *   - the child always force-exits (process.exit(0)) after a fixed run window.
 *
 * The agent_instance + llm-gateway nodes ARE implemented (status: done), so the
 * harness imports them directly (harness-only imports are allowed; they are not
 * the plugins under test).
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
// Stub OpenAI chat-completions server.
//
// Implements POST /v1/chat/completions (the openai-completion adapter targets
// `${baseURL}/chat/completions`, and we hand it baseURL = "<url>/v1"). It records
// every request body and answers:
//   - call #1  -> a tool_calls message asking for time.now (finish_reason
//                 "tool_calls"); content is null so NO output.message yet.
//   - call #2+ -> a plain assistant message "E2E-FINAL-REPLY" (finish_reason
//                 "stop") so the reply can travel llm.return -> output.message ->
//                 console stdout.
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
        // Drop keep-alive sockets so close() resolves promptly even if the child
        // left a connection open.
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
// The child driver script (.mts so ESM top-level await works in a temp dir with
// no package.json). It boots a REAL agent against the stub server, then force
// exits after ~4s of run time so a never-arriving reply can never hang the test.
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
    plugins: ["llm-core", "persona", "history", "console-channel", "notes", "toolbox"],
    config: {
      persona: { text: "PERSONA-MARK" },
      "llm-core": { communicator: "stub" },
    },
  };

  const agent = createAgentInstance(def, {
    library,
    publicPluginDir: ${JSON.stringify(publicPluginDir)},
    agentsDir: ${JSON.stringify(agentsDir)},
  });

  await agent.start();

  // Run for a fixed window, then force-exit no matter what (a missing reply must
  // never hang the parent). We do NOT depend on a graceful stop().
  setTimeout(() => {
    try { agent.stop(); } catch {}
    process.exit(0);
  }, 4000);
}

main().catch((err) => {
  // Any bring-up failure (plugins not implemented, bad contract usage, …) lands
  // here as a clean, assertable signal — never a hang.
  console.log("BOOT_ERROR:" + (err && err.stack ? err.stack : String(err)));
  process.exit(0);
});
`;
}

// ---------------------------------------------------------------------------
// Run the whole e2e scenario once: start server, spawn child, type a line, collect
// stdout, wait for exit. Returns the collected artifacts for assertion.
// ---------------------------------------------------------------------------

interface E2EResult {
  stdout: string;
  stderr: string;
  exited: boolean;
  bootError: boolean;
  requests: any[];
}

async function runE2E(): Promise<E2EResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-e2e-"));
  const agentsDir = path.join(tmp, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  // The REAL repo public_plugin/ dir holds the plugins under test.
  const publicPluginDir = path.join(REPO_ROOT, "public_plugin");

  const server = await startStubServer();
  const scriptPath = path.join(tmp, "e2e-child.mts");
  fs.writeFileSync(
    scriptPath,
    childScript(server.url, agentsDir, publicPluginDir),
    "utf8",
  );

  let stdout = "";
  let stderr = "";
  let exited = false;

  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath],
      { cwd: REPO_ROOT, env: process.env },
    );

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    // Feed one console line after the channel has had a moment to wire stdin.
    const typer = setTimeout(() => {
      try {
        child.stdin.write("hello krakey\n");
      } catch {
        /* child may already be gone */
      }
    }, 300);

    // Hard deadline so a hung child cannot hang the suite: kill it, then resolve.
    const exitCode: number | null = await new Promise((resolve) => {
      const deadline = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve(null);
      }, 25_000);

      child.on("exit", (code) => {
        clearTimeout(deadline);
        clearTimeout(typer);
        exited = true;
        resolve(code);
      });
      child.on("error", () => {
        clearTimeout(deadline);
        clearTimeout(typer);
        resolve(null);
      });
    });
    void exitCode;
  } finally {
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
    exited,
    bootError: stdout.includes("BOOT_ERROR"),
    requests: server.requests,
  };
}

// A single shared run drives all five assertions (the loop is expensive to boot;
// one run, many independent checks). Guarded so a thrown setup error surfaces as a
// clean assertion in each test rather than crashing the file.
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

/** Concatenated text of messages[0].content across helper shapes. */
function firstMessageText(reqBody: any): string {
  const m0 = reqBody?.messages?.[0];
  if (!m0) return "";
  const c = m0.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
      .join("\n");
  }
  return "";
}

/** Names of all tool defs sent on a request (openai wire: tools[].function.name). */
function toolNames(reqBody: any): string[] {
  const tools = reqBody?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t: any) => t?.function?.name ?? t?.name)
    .filter((n: any) => typeof n === "string");
}

// ===========================================================================
// Assertion 1 — boot health: no BOOT_ERROR, child exits within the timeout.
// ===========================================================================

test("e2e/1: the agent boots cleanly (no BOOT_ERROR) and the child exits within the timeout", () => {
  const r = result();
  assert.equal(
    r.bootError,
    false,
    "agent bring-up emitted BOOT_ERROR (plugins missing or contract misuse):\n" + r.stdout + "\n--stderr--\n" + r.stderr,
  );
  assert.equal(r.exited, true, "the child process must exit within the deadline (no hang)");
});

// ===========================================================================
// Assertion 2 — the loop turns over: the stub server saw >= 2 chat requests.
//
// Two requests means a full sub-loop completed: beat #1 produced a tool call, the
// tool was dispatched, and a later beat issued a second request carrying the result.
// ===========================================================================

test("e2e/2: the stub LLM server received >= 2 chat requests (the beat loop turned over)", () => {
  const r = result();
  assert.ok(
    r.requests.length >= 2,
    "expected >= 2 chat requests (beat -> tool call -> beat); got " + r.requests.length,
  );
});

// ===========================================================================
// Assertion 3 — request #1 composition: persona on top, history folded the input,
// and the four MVP tool defs (toolbox + notes) are present.
// ===========================================================================

test("e2e/3: request #1 carries the persona block + the folded user line, plus the MVP tool defs", () => {
  const r = result();
  assert.ok(r.requests.length >= 1, "no chat request reached the server at all");

  const text = firstMessageText(r.requests[0]);
  assert.match(
    text,
    /PERSONA-MARK/,
    "messages[0].content must contain the persona block text (priority 10000+, top of context)",
  );
  assert.match(
    text,
    /hello krakey/,
    "messages[0].content must contain the folded user input (history block)",
  );

  // Stable-prefix convention: the persona block sits ABOVE the history line.
  assert.ok(
    text.indexOf("PERSONA-MARK") < text.indexOf("hello krakey"),
    "persona (priority 10000+) must be rendered above the history input line (priority 100)",
  );

  const names = toolNames(r.requests[0]);
  for (const expected of [
    "time.now",
    "clock.set_interval",
    "clock.set_default_interval",
    "note.save",
  ]) {
    assert.ok(
      names.includes(expected),
      "tools[] must include the def '" + expected + "'; saw [" + names.join(", ") + "]",
    );
  }
});

// ===========================================================================
// Assertion 4 — tool-result folding: SOME later request's context shows the
// time.now result line history recorded ("time.now" + the iso/epoch payload).
// ===========================================================================

test("e2e/4: a later request's context shows the time.now tool result folded back in", () => {
  const r = result();
  assert.ok(r.requests.length >= 2, "need >= 2 requests to observe the folded tool result");

  // history records tool.result as `tool time.now -> <JSON data>` where data is
  // { iso, epochMs }. The folded line therefore mentions "time.now" AND an
  // iso/epoch payload fragment (an ISO timestamp digit-run or the epochMs key).
  const folded = r.requests.slice(1).some((req) => {
    const text = firstMessageText(req);
    const mentionsTool = text.includes("time.now");
    const mentionsPayload =
      /"?iso"?\s*[:=]/.test(text) || // an "iso": field from the result JSON
      /epochMs/.test(text) || // the epochMs key
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text); // a literal ISO timestamp
    return mentionsTool && mentionsPayload;
  });
  assert.ok(
    folded,
    "no later request's messages[0].content contained the folded 'time.now' tool result (iso/epoch payload)",
  );
});

// ===========================================================================
// Assertion 5 — the reply reaches the user: stdout carries "E2E-FINAL-REPLY"
// (it travelled llm.return -> output.message -> console-channel stdout).
// ===========================================================================

test("e2e/5: the final reply travels llm.return -> output.message -> console stdout", () => {
  const r = result();
  assert.match(
    r.stdout,
    /E2E-FINAL-REPLY/,
    "console stdout must contain the assistant reply printed by console-channel:\n" + r.stdout,
  );
});
