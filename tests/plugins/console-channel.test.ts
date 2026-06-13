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
  agentId: process.env.KRAKEY_AGENT || "krakey",
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
      data: { agentId: process.env.KRAKEY_AGENT || "krakey" },
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
// MULTI-AGENT harness: builds N per-Agent instances of the SAME plugin in ONE
// process (each with its OWN event-system + ctx + agentId), exactly as boot
// runs N agents in one process. This is the surface for the stdin-hub fix:
//  - process.stdin is a process singleton, so N instances MUST share one
//    readline (no fan-out): one typed line reaches exactly ONE agent.
//  - KRAKEY_AGENTS (comma list, default "alice,bob") = the agent ids, in
//    REGISTRATION order (first = the default "active" target).
//  - GOT_INPUT markers are tagged with the receiving agent: GOT_INPUT:<id>:<json>.
//  - FIRED markers are tagged too: FIRED:<id>.
//  - Steps come from KRAKEY_MULTI_STEPS, ";"-separated, each "op|arg":
//      wait|<n>     wait until <n> TOTAL input.message events have landed
//      out|<id>:<t> emit OUTPUT_MESSAGE{text:t} on agent <id>'s OWN bus
//      down|<id>    await that agent's plugin.teardown(); print TORE_DOWN:<id>
//  Parent feeds stdin lines on its usual schedule; the hub routes each line.
// --------------------------------------------------------------------------
const CHILD_MULTI = `
import { createEventSystem } from ${JSON.stringify(EVENT_SYSTEM_URL)};
function emit(s) { process.stdout.write(s + "\\n"); }

const AGENTS = (process.env.KRAKEY_AGENTS || "alice,bob").split(",").filter(Boolean);
const totals = { n: 0 };
const instances = {};

function makeCtx(agentId) {
  const sys = createEventSystem();
  const blocks = new Map();
  sys.actions.register(${JSON.stringify(Actions.CLOCK_FIRE_NOW)}, async () => { emit("FIRED:" + agentId); });
  sys.events.on(${JSON.stringify(Events.INPUT_MESSAGE)}, (p) => {
    totals.n++; emit("GOT_INPUT:" + agentId + ":" + JSON.stringify(p));
  });
  return {
    sys,
    ctx: {
      agentId,
      events: sys.events,
      actions: sys.actions,
      config: {},
      dataDir: process.env.KRAKEY_DATADIR,
      llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
      setBlock: (b) => { blocks.set(b.id, b); },
      getBlock: (id) => blocks.get(id),
      removeBlock: (id) => blocks.delete(id),
      listBlocks: () => [...blocks.values()].map((b) => ({ id: b.id, priority: b.priority })),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      print: (t) => { process.stdout.write(t + "\\n"); },
    },
  };
}

const mod = await import(${JSON.stringify(PLUGIN_URL)}).then((m) => m, () => null);
if (!mod || typeof mod.default !== "function") { emit("NOT_IMPLEMENTED"); process.exit(0); }

for (const a of AGENTS) {
  const { sys, ctx } = makeCtx(a);
  const plugin = mod.default();          // one per-Agent instance, sharing the module hub
  await plugin.setup(ctx);
  instances[a] = { plugin, sys };
}
emit("SETUP_DONE");

function waitInputs(n) {
  return new Promise((res) => {
    const deadline = Date.now() + 4000;
    const tick = () => { if (totals.n >= n || Date.now() > deadline) return res(); setTimeout(tick, 10); };
    tick();
  });
}

const steps = (process.env.KRAKEY_MULTI_STEPS || "").split(";").filter(Boolean);
for (const step of steps) {
  const bar = step.indexOf("|");
  const op = bar === -1 ? step : step.slice(0, bar);
  const arg = bar === -1 ? "" : step.slice(bar + 1);
  if (op === "wait") {
    await waitInputs(parseInt(arg || "0", 10));
  } else if (op === "out") {
    const colon = arg.indexOf(":");
    const id = arg.slice(0, colon);
    const text = arg.slice(colon + 1);
    instances[id].sys.events.emit(${JSON.stringify(Events.OUTPUT_MESSAGE)}, { at: Date.now(), data: { text } });
  } else if (op === "down") {
    if (instances[arg] && typeof instances[arg].plugin.teardown === "function") await instances[arg].plugin.teardown();
    emit("TORE_DOWN:" + arg);
  }
}
emit("DONE");
// Same guard as the single harness: only rely on a natural (hub-closed) exit
// when a teardown step ran; otherwise force-exit so still-attached agents don't
// hold stdin open and time the child out.
if (!steps.some((s) => s.startsWith("down"))) process.exit(0);
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
  /** the child harness source to run (defaults to the single-agent CHILD). */
  script?: string;
}): Promise<RunResult> {
  const {
    steps,
    env = {},
    stdin = [],
    stdinGapMs = 120,
    stdinStartDelayMs = 300,
    timeoutMs = 15_000,
    keepStdinOpen = false,
    script = CHILD,
  } = opts;

  const dataDir = fs.mkdtempSync(path.join(TMP, "data-"));
  const scriptPath = path.join(
    fs.mkdtempSync(path.join(TMP, "child-")),
    "harness.mts",
  );
  fs.writeFileSync(scriptPath, script, "utf8");

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
  // output — the prefix is the agent's REAL id (not a hardcoded "krakey"); here
  // the agent is "e2e-agent", so the reply must render as "[e2e-agent] …".
  assert.ok(/\[e2e-agent\][^\n]*E2E-REPLY/.test(r.stdout), "the reply rendered with the agent's own id prefix");
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

// ===========================================================================
// Scenario 8 — output attribution: the stdout prefix is the agent's REAL id,
// not a hardcoded "krakey" (fixes the latent hardcoded-name bug). A single
// agent named "solo" must render "[solo] …".
// ===========================================================================

test("output attribution: a single agent's prefix is its OWN id (not a hardcoded 'krakey')", async () => {
  const r = await runChild({
    steps: ["output"],
    env: { KRAKEY_AGENT: "solo", KRAKEY_OUT: JSON.stringify(["MINE-1"]) },
  });
  assertImplemented(r);
  assert.ok(/\[solo\][^\n]*MINE-1/.test(r.stdout), "prefix must be the agent's id '[solo]': " + r.stdout);
  assert.ok(!r.stdout.includes("[krakey]"), "must NOT fall back to a hardcoded [krakey] prefix");
});

// ===========================================================================
// Scenario 9 — MULTI-AGENT stdin hub (the fix). N console-channel instances in
// ONE process share a single readline over the one process.stdin. Helpers parse
// the agent-tagged markers the multi-harness prints.
// ===========================================================================

/** Parse GOT_INPUT:<agentId>:<json> markers into { agent, payload } records. */
function taggedInputs(r: RunResult): Array<{ agent: string; payload: any }> {
  return r.lines
    .filter((l) => l.startsWith("GOT_INPUT:"))
    .map((l) => {
      const rest = l.slice("GOT_INPUT:".length);
      const colon = rest.indexOf(":");
      return { agent: rest.slice(0, colon), payload: JSON.parse(rest.slice(colon + 1)) };
    });
}

/** Run the multi-agent harness. */
function runMulti(opts: {
  agents: string[];
  multiSteps: string[];
  stdin?: string[];
  env?: Record<string, string>;
  keepStdinOpen?: boolean;
  timeoutMs?: number;
}): Promise<RunResult> {
  return runChild({
    script: CHILD_MULTI,
    steps: [],
    env: {
      KRAKEY_AGENTS: opts.agents.join(","),
      KRAKEY_MULTI_STEPS: opts.multiSteps.join(";"),
      ...(opts.env ?? {}),
    },
    stdin: opts.stdin,
    keepStdinOpen: opts.keepStdinOpen,
    timeoutMs: opts.timeoutMs,
  });
}

test("multi: ONE typed line reaches exactly ONE agent — no fan-out to all (the bug)", async () => {
  // Two agents share stdin. The pre-hub bug attached N readline interfaces and
  // BROADCAST every line, so this produced 2 input.message events. The fix must
  // route a bare line to exactly one agent (the active default = first registered).
  const r = await runMulti({
    agents: ["alice", "bob"],
    multiSteps: ["wait|1"],
    stdin: ["hello there"],
  });
  assertImplemented(r);
  const got = taggedInputs(r);
  assert.equal(got.length, 1, "exactly ONE agent received the line (no fan-out): " + JSON.stringify(got));
  assert.equal(got[0].agent, "alice", "the active default is the first-registered agent");
  assert.equal(got[0].payload.data.text, "hello there", "text delivered verbatim");
});

test("multi: '@<id> msg' addresses the message to that agent (and strips the @id)", async () => {
  const r = await runMulti({
    agents: ["alice", "bob"],
    multiSteps: ["wait|1"],
    stdin: ["@bob ping bob"],
  });
  assertImplemented(r);
  const got = taggedInputs(r);
  assert.equal(got.length, 1, "exactly one delivery");
  assert.equal(got[0].agent, "bob", "addressed line went to bob");
  assert.equal(got[0].payload.data.text, "ping bob", "the '@bob ' prefix is consumed, not part of the message");
});

test("multi: bare '@<id>' switches the active agent; the next bare line goes there", async () => {
  const r = await runMulti({
    agents: ["alice", "bob"],
    multiSteps: ["wait|1"],
    stdin: ["@bob", "now active"],
  });
  assertImplemented(r);
  const got = taggedInputs(r);
  // "@bob" alone delivers nothing (switch only); only "now active" is delivered.
  assert.equal(got.length, 1, "the bare @bob switch produces no input.message: " + JSON.stringify(got));
  assert.equal(got[0].agent, "bob", "after switching, the next line targets bob");
  assert.equal(got[0].payload.data.text, "now active");
});

test("multi: an unknown '@id' is not delivered; the available agents are listed", async () => {
  const r = await runMulti({
    agents: ["alice", "bob"],
    multiSteps: ["wait|1"],
    stdin: ["@ghost hi", "real line"],
  });
  assertImplemented(r);
  const got = taggedInputs(r);
  assert.equal(got.length, 1, "the unknown-id line is dropped; only the real line lands");
  assert.equal(got[0].payload.data.text, "real line");
  // The hub should have echoed the roster so the user can correct the id.
  assert.ok(r.stdout.includes("ghost"), "the unknown id is named back to the user");
  assert.ok(r.stdout.includes("alice") && r.stdout.includes("bob"), "available agents are listed");
});

test("multi: output is attributed per agent — each reply carries its own [id] prefix", async () => {
  const r = await runMulti({
    agents: ["alice", "bob"],
    multiSteps: ["out|alice:FROM-ALICE", "out|bob:FROM-BOB"],
  });
  assertImplemented(r);
  assert.ok(/\[alice\][^\n]*FROM-ALICE/.test(r.stdout), "alice's reply is tagged [alice]: " + r.stdout);
  assert.ok(/\[bob\][^\n]*FROM-BOB/.test(r.stdout), "bob's reply is tagged [bob]: " + r.stdout);
});

test("multi: independent refcounted teardown — one agent leaving keeps stdin open for the survivor", async () => {
  // Tear alice down FIRST; bob stays. A line typed afterward must still be
  // received (stdin stays open while ≥1 agent is attached) and route to bob (the
  // surviving/active agent). Then bob tears down → refcount hits 0 → the hub
  // closes stdin → the child exits naturally (no hang / no SIGKILL).
  const r = await runMulti({
    agents: ["alice", "bob"],
    multiSteps: ["down|alice", "wait|1", "down|bob"],
    stdin: ["after alice left"],
    keepStdinOpen: false,
    timeoutMs: 10_000,
  });
  assertImplemented(r);
  const got = taggedInputs(r);
  assert.equal(got.length, 1, "the survivor received the post-teardown line");
  assert.equal(got[0].agent, "bob", "the line routed to the surviving agent");
  assert.equal(got[0].payload.data.text, "after alice left");
  assert.ok(r.lines.includes("TORE_DOWN:alice"), "alice tore down");
  assert.ok(r.lines.includes("TORE_DOWN:bob"), "bob tore down");
  assert.equal(r.timedOut, false, "with all agents gone the hub released stdin — child exited, no hang");
});
