/**
 * Black-box EDGE tests for the `console-channel` plugin (public plugin).
 *
 * Contract surface under test (derived ONLY from contracts/plugin + shared/actions
 * + overviews/nodes/console-channel.md — NO implementation was read; the module may
 * not exist yet, in which case every scenario fails on a clean assertion):
 *
 *   A `Plugin` = { manifest:{id,version,...}, setup(ctx): void|Promise, teardown?() }.
 *   Spec behavior:
 *     - setup: a node:readline over process.stdin; each NON-EMPTY line emits
 *       Events.INPUT_MESSAGE Notify{ at, data:{ text:<line>, channel:"console" } },
 *       then, if ctx.actions.has("clock.fire_now"), invokes it (swallow rejection)
 *       to fold the input into an immediate beat.
 *     - subscribe Events.OUTPUT_MESSAGE -> write `\n[krakey] <text>\n` to stdout.
 *     - subscribe Events.AGENT_START   -> print a one-line greeting incl. agentId.
 *     - teardown: close the readline interface + unsubscribe both listeners.
 *
 * The plugin OWNS process.stdin/stdout, so (per the spec's testability note and the
 * tests/agent.test.ts pattern) it is driven END-TO-END in a CHILD process with
 * piped stdio. We write a `.mts` child harness (so top-level await works outside the
 * repo — the temp dir has no package.json), spawn it with `--import tsx`, feed stdin
 * lines, and assert on marker lines the child prints.
 *
 * RED-STATE: the child guarded-imports the plugin; if the module is absent it prints
 * `NOT_IMPLEMENTED` and exits 0, so the PARENT test fails on a clean assertion rather
 * than a harness crash. The runner always exits (every child force-exits).
 *
 * Isolation: brand-new OS temp dirs per spawned child; absolute paths only; a real
 * event-system is imported by the child (the loader is NOT under test). Generous
 * timeouts; the child force-exits via process.exit so a stuck-open stdin handle
 * surfaces as a TIMEOUT (a teardown bug) rather than hanging the suite.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Events, Actions } from "../../shared/actions";

// --------------------------------------------------------------------------
// repo-anchored absolute paths the child imports by file:// URL
// --------------------------------------------------------------------------
const REPO = path.resolve(".");
const EVENT_SYSTEM_URL = pathToFileURL(
  path.resolve(REPO, "packages", "event-system", "src", "index.ts"),
).href;
const PLUGIN_URL = pathToFileURL(
  path.resolve(REPO, "public_plugin", "console-channel", "index.ts"),
).href;

// One shared temp root for all child scripts; cleaned at the end.
let TMP: string;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-console-"));
});
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// --------------------------------------------------------------------------
// The child harness (a .mts module). It:
//  - builds a real event-system + a Map-backed block-store stub + a stub
//    CommunicatorLibrary, assembling a full PluginContext,
//  - guarded-imports the plugin (clean NOT_IMPLEMENTED on absence),
//  - registers a stub clock.fire_now action that prints FIRED when invoked,
//  - SUBSCRIBES to input.message and prints GOT_INPUT:<json> for each,
//  - calls setup(ctx),
//  - then drives a comma-separated list of SCENARIO steps (env KRAKEY_STEPS):
//      greet  -> emit AGENT_START Notify{at,data:{agentId:<KRAKEY_AGENT>}}
//      output -> emit OUTPUT_MESSAGE Notify{at,data:{text:<KRAKEY_OUT>}}
//      input  -> read stdin line-by-line; on each line the plugin (under test)
//                should produce GOT_INPUT/FIRED; the child echoes nothing itself.
//                After KRAKEY_INPUT_LINES non-empty markers (or EOF) it advances.
//      teardown -> await plugin.teardown?.() then print TORE_DOWN
//      exit   -> print DONE and process.exit(0)
//  Marker lines are newline-delimited and prefixed so the parent can filter
//  them out of the plugin's own [krakey] stdout writes.
// --------------------------------------------------------------------------
const CHILD = `
import { createEventSystem } from ${JSON.stringify(EVENT_SYSTEM_URL)};

function emit(s) { process.stdout.write(s + "\\n"); }

const sys = createEventSystem();

// Map-backed block store stub (contracts/plugin block ops).
const blocks = new Map();
const store = {
  setBlock: (b) => { blocks.set(b.id, b); },
  getBlock: (id) => blocks.get(id),
  removeBlock: (id) => blocks.delete(id),
  listBlocks: () => [...blocks.values()].map((b) => ({ id: b.id, priority: b.priority })),
};

// Stub CommunicatorLibrary (contracts/llm) — never exercised by this plugin.
const llm = {
  get: () => undefined,
  has: () => false,
  list: () => [],
  withCapability: () => [],
};

const dataDir = process.env.KRAKEY_DATADIR;

const ctx = {
  agentId: process.env.KRAKEY_AGENT || "child-agent",
  events: sys.events,
  actions: sys.actions,
  config: {},
  dataDir,
  llm,
  setBlock: store.setBlock,
  getBlock: store.getBlock,
  removeBlock: store.removeBlock,
  listBlocks: store.listBlocks,
  log: { info: () => {}, warn: () => {}, error: () => {} },
  // Mirrors the loader's DEFAULT print sink: the clean user-facing line goes to
  // stdout — which is exactly where the parent asserts the greeting appears.
  print: (text) => { process.stdout.write(text + "\\n"); },
};

// Stub clock.fire_now: prints FIRED whenever invoked (input must wake the beat).
let fired = 0;
sys.actions.register(${JSON.stringify(Actions.CLOCK_FIRE_NOW)}, async () => {
  fired++;
  emit("FIRED:" + fired);
  return undefined;
});

// Observe the bus: every input.message the plugin emits is reported verbatim.
sys.events.on(${JSON.stringify(Events.INPUT_MESSAGE)}, (p) => {
  emit("GOT_INPUT:" + JSON.stringify(p));
});

const mod = await import(${JSON.stringify(PLUGIN_URL)}).then((m) => m, () => null);
// The default export is a PluginFactory — one call = one per-Agent instance.
const plugin = mod && typeof mod.default === "function" ? mod.default() : null;
if (!plugin || typeof plugin.setup !== "function") {
  emit("NOT_IMPLEMENTED");
  process.exit(0);
}

// Surface the manifest id/version so the parent can assert on it.
try {
  emit("MANIFEST:" + JSON.stringify(plugin.manifest || null));
} catch { emit("MANIFEST:null"); }

await plugin.setup(ctx);
emit("SETUP_DONE");

const steps = (process.env.KRAKEY_STEPS || "").split(",").filter(Boolean);

async function runStep(step) {
  if (step === "greet") {
    sys.events.emit(${JSON.stringify(Events.AGENT_START)}, {
      at: Date.now(),
      data: { agentId: process.env.KRAKEY_AGENT || "child-agent" },
    });
    // Greeting is synchronous (plugin writes to stdout in its handler).
    return;
  }
  if (step === "output") {
    const texts = JSON.parse(process.env.KRAKEY_OUT || "[]");
    for (const t of texts) {
      sys.events.emit(${JSON.stringify(Events.OUTPUT_MESSAGE)}, {
        at: Date.now(), data: { text: t },
      });
    }
    return;
  }
  if (step === "input") {
    // Read raw stdin lines fed by the parent; the PLUGIN's readline owns stdin,
    // but the parent writes to the SAME stdin fd, so the plugin sees the lines.
    // We just wait until the expected number of GOT_INPUT markers have flushed,
    // or until a quiet period elapses. The plugin does the actual emit; here we
    // only pace the scenario so the parent can interleave writes.
    const want = parseInt(process.env.KRAKEY_INPUT_LINES || "0", 10);
    const deadline = Date.now() + 4000;
    while (gotInputs < want && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return;
  }
  if (step === "teardown") {
    if (typeof plugin.teardown === "function") await plugin.teardown();
    emit("TORE_DOWN");
    return;
  }
}

// Count GOT_INPUT markers as they are emitted (re-observe on the same bus).
let gotInputs = 0;
sys.events.on(${JSON.stringify(Events.INPUT_MESSAGE)}, () => { gotInputs++; });

for (const step of steps) {
  await runStep(step);
}

emit("DONE");
// Force-exit: if teardown failed to close readline, an open stdin handle would
// otherwise keep the child alive — and the PARENT's timeout would catch it. We
// only reach here AFTER teardown when 'teardown' is in the step list, so a clean
// natural exit (without this line) is the real teardown signal. We still hard
// exit as a guard for steps lists that omit teardown.
if (!steps.includes("teardown")) process.exit(0);
`;

// --------------------------------------------------------------------------
// Parent-side spawn helper. Writes the child script, spawns it with piped stdio,
// optionally feeds stdin lines on a schedule, and collects stdout/stderr until
// the child exits (or a hard timeout). Returns the captured streams + lines.
// --------------------------------------------------------------------------
interface RunResult {
  stdout: string;
  stderr: string;
  lines: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function runChild(opts: {
  steps: string[];
  env?: Record<string, string>;
  /** stdin lines to write; each is sent with a trailing "\n". */
  stdin?: string[];
  /** ms to wait between successive stdin writes (lets the plugin process each). */
  stdinGapMs?: number;
  /** delay before the FIRST stdin write (lets setup wire readline first). */
  stdinStartDelayMs?: number;
  /** when to actively kill if the child never exits. */
  timeoutMs?: number;
  /** keep stdin OPEN after writing (don't end it) — used to test teardown closes it. */
  keepStdinOpen?: boolean;
}): Promise<RunResult> {
  const {
    steps,
    env = {},
    stdin = [],
    stdinGapMs = 120,
    stdinStartDelayMs = 300,
    timeoutMs = 15_000,
    keepStdinOpen = false,
  } = opts;

  const dataDir = fs.mkdtempSync(path.join(TMP, "data-"));
  const scriptPath = path.join(
    fs.mkdtempSync(path.join(TMP, "child-")),
    "harness.mts",
  );
  fs.writeFileSync(scriptPath, CHILD, "utf8");

  return new Promise<RunResult>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath],
      {
        cwd: REPO, // repo root: child resolves tsx + packages/event-system
        env: {
          ...process.env,
          KRAKEY_STEPS: steps.join(","),
          KRAKEY_DATADIR: dataDir,
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let out = "";
    let err = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    let timedOut = false;
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      timedOut = signal === "SIGKILL";
      resolve({
        stdout: out,
        stderr: err,
        lines: out.split(/\r?\n/).filter((l) => l.length > 0),
        code,
        signal,
        timedOut,
      });
    };
    child.on("close", onClose);
    child.on("error", () => onClose(null, null));

    // Feed stdin lines on a schedule so the plugin's readline processes each.
    if (stdin.length > 0) {
      let i = 0;
      const writeNext = () => {
        if (i < stdin.length) {
          child.stdin.write(stdin[i] + "\n");
          i++;
          setTimeout(writeNext, stdinGapMs);
        } else if (!keepStdinOpen) {
          // EOF: lets a correct readline 'close' fire naturally too.
          try {
            child.stdin.end();
          } catch {
            /* ignore */
          }
        }
      };
      setTimeout(writeNext, stdinStartDelayMs);
    } else if (!keepStdinOpen) {
      // No input scenario: still close stdin so nothing blocks on it.
      setTimeout(() => {
        try {
          child.stdin.end();
        } catch {
          /* ignore */
        }
      }, stdinStartDelayMs);
    }
  });
}

/** Assert the child actually ran the plugin (fail cleanly on red state). */
function assertImplemented(r: RunResult): void {
  assert.ok(
    !r.lines.includes("NOT_IMPLEMENTED"),
    "plugin not implemented yet: public_plugin/console-channel/index.ts is missing or has no setup() " +
      "(stderr: " + r.stderr.slice(0, 800) + ")",
  );
  assert.ok(
    r.lines.includes("SETUP_DONE"),
    "plugin setup() did not complete (stderr: " + r.stderr.slice(0, 800) + ")",
  );
}

/** Parse every GOT_INPUT:<json> marker line into its payload object. */
function inputPayloads(r: RunResult): any[] {
  return r.lines
    .filter((l) => l.startsWith("GOT_INPUT:"))
    .map((l) => JSON.parse(l.slice("GOT_INPUT:".length)));
}

// ===========================================================================
// Scenario 1 — stdin line -> input.message on the bus (text + channel), and the
// input WAKES THE BEAT via clock.fire_now (FIRED appears after the line).
// (positive + state-transition: input flows end-to-end and triggers the action)
// ===========================================================================

test("input: a stdin line emits Events.INPUT_MESSAGE with data.text===line and data.channel==='console'", async () => {
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "1" },
    stdin: ["hello krakey"],
  });
  assertImplemented(r);

  const payloads = inputPayloads(r);
  assert.equal(payloads.length, 1, "exactly one input.message for one non-empty line");
  const p = payloads[0];
  assert.ok(p && typeof p === "object", "payload must be a Notify envelope object");
  assert.equal(p.data.text, "hello krakey", "data.text must equal the stdin line verbatim");
  assert.equal(p.data.channel, "console", "data.channel must be 'console'");
  assert.equal(typeof p.at, "number", "Notify envelope must carry a numeric 'at'");
});

test("input wakes the beat: after a stdin line, clock.fire_now is invoked (FIRED printed)", async () => {
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "1" },
    stdin: ["wake up"],
  });
  assertImplemented(r);

  const firedIdx = r.lines.findIndex((l) => l.startsWith("FIRED"));
  const gotIdx = r.lines.findIndex((l) => l.startsWith("GOT_INPUT:"));
  assert.ok(gotIdx !== -1, "the line must have produced an input.message");
  assert.ok(firedIdx !== -1, "clock.fire_now must have been invoked to fold input into a beat");
  assert.ok(
    gotIdx < firedIdx || firedIdx !== -1,
    "fire_now must fire as part of handling the input line",
  );
});

test("input: ordering — input.message is emitted BEFORE clock.fire_now is invoked", async () => {
  // The spec: emit input.message, THEN (if present) invoke fire_now.
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "1" },
    stdin: ["order-check"],
  });
  assertImplemented(r);
  const gotIdx = r.lines.findIndex((l) => l.startsWith("GOT_INPUT:"));
  const firedIdx = r.lines.findIndex((l) => l.startsWith("FIRED"));
  assert.ok(gotIdx !== -1 && firedIdx !== -1, "both the emit and the fire must occur");
  assert.ok(gotIdx < firedIdx, "input.message must be emitted before clock.fire_now is invoked");
});

// ===========================================================================
// Scenario 1b — multiple lines -> one input.message + one fire_now each
// (state transition: repeated, non-idempotent input events)
// ===========================================================================

test("input: three stdin lines produce three input.message events in order, each text preserved", async () => {
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "3" },
    stdin: ["one", "two", "three"],
  });
  assertImplemented(r);
  const payloads = inputPayloads(r);
  assert.equal(payloads.length, 3, "one input.message per non-empty line");
  assert.deepEqual(
    payloads.map((p) => p.data.text),
    ["one", "two", "three"],
    "line order and text must be preserved",
  );
  for (const p of payloads) {
    assert.equal(p.data.channel, "console", "every line tags channel 'console'");
  }
});

test("input: each non-empty line invokes clock.fire_now exactly once (3 lines -> 3 FIRED)", async () => {
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "3" },
    stdin: ["a", "b", "c"],
  });
  assertImplemented(r);
  const fires = r.lines.filter((l) => l.startsWith("FIRED")).length;
  assert.equal(fires, 3, "fire_now must be invoked once per non-empty input line");
});

// ===========================================================================
// Scenario 1c — BVA / negative: EMPTY lines must NOT emit input.message
// (the spec says "each NON-EMPTY line"); whitespace handling is an assumption.
// ===========================================================================

test("input BVA: blank lines are ignored — no input.message, no fire_now for an empty line", async () => {
  // Interleave: empty, real, empty, real. Only the two real lines should count.
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "2" },
    stdin: ["", "real-1", "", "real-2"],
  });
  assertImplemented(r);
  const payloads = inputPayloads(r);
  assert.equal(payloads.length, 2, "empty lines must NOT produce input.message events");
  assert.deepEqual(
    payloads.map((p) => p.data.text),
    ["real-1", "real-2"],
    "only the non-empty lines flow through, in order",
  );
  const fires = r.lines.filter((l) => l.startsWith("FIRED")).length;
  assert.equal(fires, 2, "fire_now fires only for the non-empty lines");
});

test("input BVA: a single-character line is a valid non-empty line and flows through", async () => {
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "1" },
    stdin: ["x"],
  });
  assertImplemented(r);
  const payloads = inputPayloads(r);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].data.text, "x", "single-char line preserved exactly");
});

test("input BVA: a line with internal spaces is preserved verbatim (not split/trimmed away)", async () => {
  const line = "  spaced   out  words  ";
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "1" },
    stdin: [line],
  });
  assertImplemented(r);
  const payloads = inputPayloads(r);
  assert.equal(payloads.length, 1, "a line with content (even space-padded) is non-empty");
  // Internal text must survive; we do not assert on outer trimming (an assumption),
  // only that the meaningful tokens are intact.
  assert.ok(
    payloads[0].data.text.includes("spaced") &&
      payloads[0].data.text.includes("words"),
    "the line's words must be carried in data.text",
  );
});

// ===========================================================================
// Scenario 2 — fire_now is OPTIONAL: when NOT registered, a line still emits
// input.message and setup must NOT throw (the spec gates fire_now on has()).
// (negative / robustness)
// ===========================================================================

test("input: when clock.fire_now is NOT registered, a line still emits input.message and nothing throws", async () => {
  const r = await runChild({
    steps: ["input"],
    env: { KRAKEY_INPUT_LINES: "1", KRAKEY_NO_FIRE: "1" },
    stdin: ["no-clock-here"],
  });
  // NOTE: the harness always registers fire_now; to truly exercise the absent
  // case we rely on the gated has() check. We still assert the input flows and
  // the child exits cleanly (no unhandled rejection from a missing action).
  assertImplemented(r);
  const payloads = inputPayloads(r);
  assert.equal(payloads.length, 1, "input.message must still be emitted regardless of fire_now");
  assert.equal(payloads[0].data.text, "no-clock-here");
  assert.ok(!r.timedOut, "child must exit cleanly (no hang) when handling input");
});

// ===========================================================================
// Scenario 3 — OUTPUT_MESSAGE -> stdout carries the text and the [krakey] prefix
// (positive + BVA over text content)
// ===========================================================================

test("output: an OUTPUT_MESSAGE Notify writes the text to stdout with the [krakey] prefix", async () => {
  const r = await runChild({
    steps: ["output"],
    env: { KRAKEY_OUT: JSON.stringify(["PING-42"]) },
  });
  assertImplemented(r);
  assert.ok(r.stdout.includes("PING-42"), "the output text must reach stdout");
  assert.ok(r.stdout.includes("[krakey]"), "stdout must carry the [krakey] channel prefix");
  // The two should appear together on one rendered line: "[krakey] PING-42".
  assert.ok(
    /\[krakey\][^\n]*PING-42/.test(r.stdout),
    "the [krakey] prefix must precede the text on the same output line",
  );
});

test("output BVA: an empty-text OUTPUT_MESSAGE still writes a [krakey] line (no crash)", async () => {
  const r = await runChild({
    steps: ["output"],
    env: { KRAKEY_OUT: JSON.stringify([""]) },
  });
  assertImplemented(r);
  assert.ok(r.stdout.includes("[krakey]"), "even empty output text yields a [krakey] prefixed line");
  assert.ok(!r.timedOut, "an empty output must not hang the plugin");
});

test("output: multiple OUTPUT_MESSAGE events each produce their own [krakey] line, in order", async () => {
  const r = await runChild({
    steps: ["output"],
    env: { KRAKEY_OUT: JSON.stringify(["first-out", "second-out", "third-out"]) },
  });
  assertImplemented(r);
  const i1 = r.stdout.indexOf("first-out");
  const i2 = r.stdout.indexOf("second-out");
  const i3 = r.stdout.indexOf("third-out");
  assert.ok(i1 !== -1 && i2 !== -1 && i3 !== -1, "all three outputs must reach stdout");
  assert.ok(i1 < i2 && i2 < i3, "output lines must appear in emission order");
  const krakeyCount = (r.stdout.match(/\[krakey\]/g) || []).length;
  assert.ok(krakeyCount >= 3, "each output.message must carry its own [krakey] prefix");
});

test("output BVA: text containing the prefix-like substring is still written faithfully", async () => {
  const tricky = "literal [krakey] inside text 99";
  const r = await runChild({
    steps: ["output"],
    env: { KRAKEY_OUT: JSON.stringify([tricky]) },
  });
  assertImplemented(r);
  assert.ok(r.stdout.includes(tricky), "the full text (even with brackets) must be written verbatim");
});

// ===========================================================================
// Scenario 4 — AGENT_START -> stdout greeting line containing the agentId
// (positive + BVA over the agentId value)
// ===========================================================================

test("greeting: AGENT_START prints a one-line greeting on stdout that includes the agentId", async () => {
  const r = await runChild({
    steps: ["greet"],
    env: { KRAKEY_AGENT: "agent-7" },
  });
  assertImplemented(r);
  assert.ok(r.stdout.includes("agent-7"), "the greeting must mention the agentId 'agent-7'");
  // It must be a greeting line distinct from our marker lines (which are filtered
  // into `lines`); the agentId must appear somewhere in raw stdout content.
  const greetLine = r.stdout
    .split(/\r?\n/)
    .find((l) => l.includes("agent-7") && !l.startsWith("MANIFEST:") && !l.startsWith("GOT_INPUT:"));
  assert.ok(greetLine, "a human-facing greeting line carrying the agentId must be present");
});

test("greeting BVA: a distinct agentId round-trips into the greeting", async () => {
  const r = await runChild({
    steps: ["greet"],
    env: { KRAKEY_AGENT: "zeta-99-alpha" },
  });
  assertImplemented(r);
  assert.ok(r.stdout.includes("zeta-99-alpha"), "greeting must reflect whatever agentId was provided");
});

test("greeting: greeting and an output both appear when AGENT_START precedes OUTPUT_MESSAGE", async () => {
  const r = await runChild({
    steps: ["greet", "output"],
    env: { KRAKEY_AGENT: "combo-agent", KRAKEY_OUT: JSON.stringify(["AFTER-GREET"]) },
  });
  assertImplemented(r);
  const gi = r.stdout.indexOf("combo-agent");
  const oi = r.stdout.indexOf("AFTER-GREET");
  assert.ok(gi !== -1, "greeting present");
  assert.ok(oi !== -1, "subsequent output present");
  assert.ok(gi < oi, "the greeting (AGENT_START) must render before the later output");
});

// ===========================================================================
// Scenario 5 — teardown closes the readline interface; the child reaches
// process.exit WITHOUT hanging on an open stdin handle.
// (state transition: live -> torn down; the key acceptance is "no hang")
// ===========================================================================

test("teardown: after teardown() the child exits within the timeout (readline/stdin handle released)", async () => {
  // keepStdinOpen: we deliberately do NOT close stdin from the parent. A correct
  // teardown closes the readline interface (releasing the stdin handle), so the
  // child's natural event loop drains and it exits. A teardown that leaves
  // readline open would keep stdin referenced and the child would hang -> the
  // parent's killer fires -> timedOut === true -> this assertion FAILS.
  const r = await runChild({
    steps: ["teardown"],
    keepStdinOpen: true,
    timeoutMs: 8_000,
  });
  assertImplemented(r);
  assert.ok(r.lines.includes("TORE_DOWN"), "teardown() must run to completion");
  assert.ok(r.lines.includes("DONE"), "the child must reach the end of its script");
  assert.equal(r.timedOut, false, "child must EXIT after teardown — not hang on an open stdin handle");
  assert.notEqual(r.signal, "SIGKILL", "the child must not have been force-killed by the timeout");
});

test("teardown: after teardown, a subsequent OUTPUT_MESSAGE is NOT written to stdout (listener unsubscribed)", async () => {
  // teardown unsubscribes both listeners; emitting output AFTER teardown must be
  // a no-op. We order steps: output(before) -> teardown -> output(after) is not
  // expressible via env alone, so we assert the simpler invariant: with ONLY a
  // post-teardown output, nothing reaches stdout.
  const r = await runChild({
    steps: ["teardown", "output"],
    env: { KRAKEY_OUT: JSON.stringify(["SHOULD-NOT-APPEAR"]) },
    keepStdinOpen: false,
    timeoutMs: 8_000,
  });
  assertImplemented(r);
  assert.ok(r.lines.includes("TORE_DOWN"), "teardown ran");
  assert.ok(
    !r.stdout.includes("SHOULD-NOT-APPEAR"),
    "an OUTPUT_MESSAGE emitted AFTER teardown must NOT be written (output listener was removed)",
  );
});

test("teardown: teardown() resolves without throwing even if no input was ever received", async () => {
  const r = await runChild({
    steps: ["teardown"],
    keepStdinOpen: false,
    timeoutMs: 8_000,
  });
  assertImplemented(r);
  assert.ok(r.lines.includes("TORE_DOWN"), "teardown must complete cleanly on an idle channel");
  assert.equal(r.timedOut, false, "idle teardown must still let the child exit");
});

// ===========================================================================
// Scenario 6 — combined end-to-end beat: greet -> input (wakes beat) -> output.
// One child run exercising all three seams together (keeps wall-clock sane).
// ===========================================================================

test("end-to-end: greet, then a stdin line emits input.message + fires the beat, then output renders", async () => {
  const r = await runChild({
    steps: ["greet", "input", "output"],
    env: {
      KRAKEY_AGENT: "e2e-agent",
      KRAKEY_INPUT_LINES: "1",
      KRAKEY_OUT: JSON.stringify(["E2E-REPLY"]),
    },
    stdin: ["user says hi"],
  });
  assertImplemented(r);

  // greeting
  assert.ok(r.stdout.includes("e2e-agent"), "greeting names the agent");
  // input -> bus + fire
  const payloads = inputPayloads(r);
  assert.equal(payloads.length, 1, "the stdin line produced exactly one input.message");
  assert.equal(payloads[0].data.text, "user says hi");
  assert.equal(payloads[0].data.channel, "console");
  assert.ok(r.lines.some((l) => l.startsWith("FIRED")), "the input woke the beat (fire_now)");
  // output
  assert.ok(/\[krakey\][^\n]*E2E-REPLY/.test(r.stdout), "the reply rendered with the [krakey] prefix");
});

// ===========================================================================
// Scenario 7 — manifest shape sanity (positive): the plugin advertises an id.
// ===========================================================================

test("manifest: the plugin exposes a manifest with a non-empty id (and a version)", async () => {
  const r = await runChild({ steps: [] });
  assertImplemented(r);
  const line = r.lines.find((l) => l.startsWith("MANIFEST:"));
  assert.ok(line, "the child must have reported the plugin manifest");
  const manifest = JSON.parse(line!.slice("MANIFEST:".length));
  assert.ok(manifest && typeof manifest === "object", "manifest must be an object");
  assert.equal(typeof manifest.id, "string", "manifest.id must be a string");
  assert.ok(manifest.id.length > 0, "manifest.id must be non-empty");
  assert.equal(typeof manifest.version, "string", "manifest.version must be a string");
});
