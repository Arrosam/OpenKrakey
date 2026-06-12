/**
 * Black-box INTEGRATION tests for the `agent` contract as implemented by the
 * `agent_instance` node.
 *
 * Scope: ONLY the public lifecycle surface promised by `contracts/agent`:
 *   - AgentDefinition = { id, intervalMs, plugins: string[], privatePlugins?, config? }
 *   - Agent extends AgentHandle = { readonly id, start(): Promise<void>, stop(): Promise<void> }
 *   - both start and stop are "idempotent-safe" (contract behavioral constraints)
 *
 * These are true black-box tests: we never read or assume the node's internals
 * (clock / event-system / orchestrator / loader wiring). We construct an Agent
 * via the documented factory and drive only its external handle.
 *
 *   createAgentInstance(
 *     def: AgentDefinition,
 *     deps?: { library?, log?, publicPluginDir?, agentsDir? },
 *   ): Agent
 *
 * R3 acceptance: a bare ZERO-plugin Agent comes up and tears down without error.
 *
 * Isolation: every test gets brand-new, EMPTY OS temp dirs for `publicPluginDir`
 * and `agentsDir` (created in beforeEach, removed in afterEach). Empty dirs mean
 * there is nothing to load, so the bare agent loads no plugins and never touches
 * the repo cwd or the network. A modest `intervalMs` (10s) keeps the real beat
 * clock from actually firing inside a sub-second test, and EVERY started agent is
 * stopped (per-test cleanup + a top-level afterEach sweep) so no timer leaks
 * across tests and keeps the process alive.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createAgentInstance } from "../packages/agent_instance/src";
import type { AgentDefinition } from "../contracts/agent";
import { Events } from "../shared/actions";

// ---------------------------------------------------------------------------
// per-test temp sandbox (all ABSOLUTE paths; both dirs start EMPTY)
// ---------------------------------------------------------------------------

let tmp: string;
let publicPluginDir: string;
let agentsDir: string;

/**
 * Agents started during a test. The top-level afterEach stops every one of them
 * so a thrown assertion can never leak a live beat timer (which would otherwise
 * keep the test process from exiting). Stopping is idempotent per the contract,
 * so double-stopping a per-test-cleaned agent here is harmless.
 */
let started: Array<{ stop(): Promise<void> }> = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-agent-"));
  publicPluginDir = path.join(tmp, "public_plugin");
  agentsDir = path.join(tmp, "agents");
  fs.mkdirSync(publicPluginDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  started = [];
});

afterEach(async () => {
  // Belt-and-suspenders: ensure no started agent leaves a pending timer behind.
  for (const a of started) {
    try {
      await a.stop();
    } catch {
      /* teardown must never throw / mask the real assertion */
    }
  }
  started = [];
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Default deps that pin the agent to the empty temp sandbox (no repo cwd). */
function baseDeps(extra?: Record<string, unknown>) {
  return { publicPluginDir, agentsDir, ...(extra ?? {}) };
}

/**
 * A minimal valid AgentDefinition for a BARE agent: no public plugins, no
 * private plugins, a large interval so the clock does not fire during the test.
 */
function bareDef(id: string, over?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id,
    intervalMs: 10_000,
    plugins: [],
    ...over,
  };
}

/**
 * Construct an agent and register it for guaranteed teardown. Any agent we
 * later start gets tracked in `started` as well (so even a mid-test throw is
 * cleaned). Construction itself must not need start/stop, but we register a
 * defensive stop regardless.
 */
function make(def: AgentDefinition, deps?: Record<string, unknown>) {
  const agent = createAgentInstance(def, deps ?? baseDeps());
  started.push(agent); // tracked for the afterEach sweep
  return agent;
}

// ===========================================================================
// Behavior 1 — factory shape: id + start/stop functions
// ===========================================================================

test("factory: createAgentInstance returns a handle with id === def.id and start/stop functions", () => {
  const def = bareDef("agent-shape");
  const agent = make(def, baseDeps());

  assert.ok(agent, "factory should return a value");
  assert.equal(typeof agent, "object");
  assert.equal(agent.id, "agent-shape", "handle id must equal def.id");
  assert.equal(typeof agent.start, "function", "start must be a function");
  assert.equal(typeof agent.stop, "function", "stop must be a function");
});

test("factory: id reflects whatever def.id was given (distinct ids round-trip)", () => {
  const a = make(bareDef("alpha"), baseDeps());
  const b = make(bareDef("beta"), baseDeps());
  assert.equal(a.id, "alpha");
  assert.equal(b.id, "beta");
  assert.notEqual(a.id, b.id, "two definitions yield two independent ids");
});

test("factory: an empty-string id is accepted and reflected verbatim", () => {
  const agent = make(bareDef(""), baseDeps());
  assert.equal(agent.id, "", "empty-string id must round-trip through the handle");
  assert.equal(typeof agent.start, "function");
  assert.equal(typeof agent.stop, "function");
});

test("factory: start() and stop() return thenables (Promise-shaped)", () => {
  const agent = make(bareDef("thenable"), baseDeps());
  const sp = agent.start();
  assert.equal(typeof (sp as { then?: unknown }).then, "function", "start() must return a Promise");
  return sp.then(() => {
    const tp = agent.stop();
    assert.equal(typeof (tp as { then?: unknown }).then, "function", "stop() must return a Promise");
    return tp;
  });
});

// ===========================================================================
// Behavior 2 — R3: a bare zero-plugin agent starts and stops without error
// ===========================================================================

test("R3: a bare zero-plugin agent (empty dirs, no library) starts without throwing", async () => {
  const agent = make(bareDef("bare-up"), baseDeps());
  await assert.doesNotReject(
    () => agent.start(),
    "a bare agent with nothing to load must start() cleanly",
  );
  await agent.stop();
});

test("R3: a bare zero-plugin agent stops without throwing after a clean start", async () => {
  const agent = make(bareDef("bare-down"), baseDeps());
  await agent.start();
  await assert.doesNotReject(() => agent.stop(), "a bare agent must tear down cleanly");
});

test("R3: full bring-up + teardown of a bare agent resolves end-to-end", async () => {
  const agent = make(bareDef("bare-roundtrip"), baseDeps());
  // The whole point of the project: a zero-plugin Agent completes a lifecycle.
  await agent.start();
  await agent.stop();
  assert.ok(true, "start() then stop() on a bare agent completed without error");
});

test("R3: bare agent with explicit empty privatePlugins still starts and stops", async () => {
  const agent = make(bareDef("bare-empty-private", { privatePlugins: [] }), baseDeps());
  await assert.doesNotReject(() => agent.start());
  await assert.doesNotReject(() => agent.stop());
});

test("R3: bare agent with an empty config object still starts and stops", async () => {
  const agent = make(bareDef("bare-empty-config", { config: {} }), baseDeps());
  await assert.doesNotReject(() => agent.start());
  await assert.doesNotReject(() => agent.stop());
});

// ===========================================================================
// Behavior 3 — start() is idempotent (calling twice does not throw)
// ===========================================================================

test("idempotency: start() called twice (sequentially) does not throw", async () => {
  const agent = make(bareDef("start-twice-seq"), baseDeps());
  await assert.doesNotReject(() => agent.start(), "first start() must resolve");
  await assert.doesNotReject(() => agent.start(), "second start() must be a safe no-op");
  await agent.stop();
});

test("idempotency: two start() calls awaited together both resolve", async () => {
  const agent = make(bareDef("start-twice-par"), baseDeps());
  // Await both — a re-entrant/concurrent second start() must not reject.
  await assert.doesNotReject(
    () => Promise.all([agent.start(), agent.start()]),
    "concurrent double start() must both resolve",
  );
  await agent.stop();
});

test("idempotency: start() three times still leaves the agent stoppable", async () => {
  const agent = make(bareDef("start-thrice"), baseDeps());
  await agent.start();
  await agent.start();
  await agent.start();
  await assert.doesNotReject(() => agent.stop(), "after repeated starts a single stop() suffices");
});

// ===========================================================================
// Behavior 4 — stop() is idempotent + safe no-op BEFORE any start()
// ===========================================================================

test("idempotency: stop() BEFORE any start() is a safe no-op (does not throw)", async () => {
  const agent = make(bareDef("stop-before-start"), baseDeps());
  await assert.doesNotReject(
    () => agent.stop(),
    "stop() on a never-started agent must be a harmless no-op",
  );
});

test("idempotency: stop() called twice after a start() does not throw", async () => {
  const agent = make(bareDef("stop-twice"), baseDeps());
  await agent.start();
  await assert.doesNotReject(() => agent.stop(), "first stop() must resolve");
  await assert.doesNotReject(() => agent.stop(), "second stop() must be a safe no-op");
});

test("idempotency: stop() twice with NO start() at all does not throw", async () => {
  const agent = make(bareDef("stop-twice-nostart"), baseDeps());
  await assert.doesNotReject(() => agent.stop());
  await assert.doesNotReject(() => agent.stop());
});

test("idempotency: two stop() calls awaited together both resolve", async () => {
  const agent = make(bareDef("stop-twice-par"), baseDeps());
  await agent.start();
  await assert.doesNotReject(
    () => Promise.all([agent.stop(), agent.stop()]),
    "concurrent double stop() must both resolve",
  );
});

// ===========================================================================
// Behavior 4b — state transitions across the full lifecycle
// ===========================================================================

test("lifecycle: start -> stop -> start -> stop cycles cleanly (restartable)", async () => {
  const agent = make(bareDef("restartable"), baseDeps());
  await agent.start();
  await agent.stop();
  await assert.doesNotReject(() => agent.start(), "agent should be restartable after a stop()");
  await assert.doesNotReject(() => agent.stop(), "and stoppable again after the restart");
});

test("lifecycle: stop() before start(), then a normal start/stop, all resolve", async () => {
  const agent = make(bareDef("noop-then-cycle"), baseDeps());
  await agent.stop(); // no-op before start
  await agent.start(); // now actually start
  await assert.doesNotReject(() => agent.stop(), "a real start after a no-op stop still tears down");
});

// ===========================================================================
// Behavior 5 — multiple independent agents do not interfere
// ===========================================================================

test("isolation: two agents with different ids both start and both stop independently", async () => {
  const a = make(bareDef("multi-a"), baseDeps());
  const b = make(bareDef("multi-b"), baseDeps());

  assert.notEqual(a.id, b.id, "the two agents must be distinct instances");

  await assert.doesNotReject(() => a.start(), "agent A starts");
  await assert.doesNotReject(() => b.start(), "agent B starts independently");

  await assert.doesNotReject(() => a.stop(), "agent A stops without affecting B");
  await assert.doesNotReject(() => b.stop(), "agent B stops independently");
});

test("isolation: stopping one agent does not impede the other's continued lifecycle", async () => {
  const a = make(bareDef("iso-a"), baseDeps());
  const b = make(bareDef("iso-b"), baseDeps());

  await a.start();
  await b.start();

  // Tear A down entirely, then prove B is still fully operable (stop+restart).
  await a.stop();
  await assert.doesNotReject(() => b.stop(), "B unaffected by A's teardown");
  await assert.doesNotReject(() => b.start(), "B can restart after A is gone");
  await b.stop();
});

test("isolation: agents constructed with the SAME temp dirs still run independently", async () => {
  // Distinct ids but a shared (empty) sandbox: starting both must not collide.
  const a = make(bareDef("shared-dir-a"), baseDeps());
  const b = make(bareDef("shared-dir-b"), baseDeps());
  await Promise.all([a.start(), b.start()]);
  await assert.doesNotReject(() => Promise.all([a.stop(), b.stop()]));
});

// ===========================================================================
// Behavior 6 — a provided deps.library stub is accepted
// ===========================================================================

/** Minimal CommunicatorLibrary stub (shape from contracts/llm). */
function emptyLibrary() {
  return {
    get: (_name: string) => undefined,
    has: (_name: string) => false,
    list: () => [] as string[],
  };
}

test("deps.library: a stub CommunicatorLibrary is accepted; start/stop still succeed", async () => {
  const agent = make(bareDef("with-library"), baseDeps({ library: emptyLibrary() }));
  await assert.doesNotReject(() => agent.start(), "providing a library must not break bring-up");
  await assert.doesNotReject(() => agent.stop());
});

test("deps.library: factory still returns the right handle shape when a library is supplied", () => {
  const agent = make(bareDef("with-library-shape"), baseDeps({ library: emptyLibrary() }));
  assert.equal(agent.id, "with-library-shape");
  assert.equal(typeof agent.start, "function");
  assert.equal(typeof agent.stop, "function");
});

test("deps.library: a library-backed agent is restartable just like a bare one", async () => {
  const agent = make(bareDef("library-restart"), baseDeps({ library: emptyLibrary() }));
  await agent.start();
  await agent.stop();
  await assert.doesNotReject(() => agent.start());
  await assert.doesNotReject(() => agent.stop());
});

// ===========================================================================
// BVA — intervalMs boundary values still yield a clean bare lifecycle
// ===========================================================================
//
// We do NOT advance any clock here (no fake timers) — these tests only assert
// that constructing + bringing up + tearing down an agent is robust across the
// interval boundary values the contract leaves open. Stop() must always clear
// whatever timer the chosen interval armed.

test("BVA: intervalMs = 1 (tiny) — bare agent still starts and stops cleanly", async () => {
  const agent = make(bareDef("interval-1", { intervalMs: 1 }), baseDeps());
  await assert.doesNotReject(() => agent.start());
  await assert.doesNotReject(() => agent.stop());
});

test("BVA: intervalMs = 0 — bare agent still starts and stops cleanly", async () => {
  const agent = make(bareDef("interval-0", { intervalMs: 0 }), baseDeps());
  await assert.doesNotReject(() => agent.start());
  await assert.doesNotReject(() => agent.stop());
});

test("BVA: a very large intervalMs — bare agent starts and stops cleanly", async () => {
  const agent = make(bareDef("interval-huge", { intervalMs: 2_147_483_647 }), baseDeps());
  await assert.doesNotReject(() => agent.start());
  await assert.doesNotReject(() => agent.stop());
});

// ===========================================================================
// Behavior 7 — core events ACTIVATE plugins: agent.start is plugin-observable
//
// These are still black-box at the agent boundary (we only drive start/stop),
// but they exercise the contract promise from shared/actions: the core emits
// Events.AGENT_START to ACTIVATE plugins, so a plugin that subscribes during
// setup MUST observe agent.start once the agent is live. We make the plugin
// OBSERVABLE the same way the loader tests do: it writes its observations into
// exported module state, and the test re-imports the SAME file by URL (ESM
// caches by resolved URL) to read them back.
// ===========================================================================

/**
 * Write a public plugin under <publicPluginDir>/<id>/index.ts. A public plugin
 * named in def.plugins is loaded from this shared location (mirrors the loader
 * tests). `body` is the full module source.
 */
function writePublicPlugin(id: string, body: string): string {
  const pdir = path.join(publicPluginDir, id);
  fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, "index.ts");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/** Re-import the SAME module file the agent's loader imported (ESM URL cache). */
async function importPublicPlugin(id: string): Promise<any> {
  const file = path.join(publicPluginDir, id, "index.ts");
  return import(pathToFileURL(file).href);
}

/**
 * A recorder plugin: in setup it subscribes to the bus and appends every event
 * name it sees (in order) to exported `seen`, and records each agent.start
 * payload's agentId into `startIds`. `setupDelayMs`, if > 0, makes setup AWAIT
 * that long before returning (used to model an in-flight start()).
 *
 * Event names are passed literally so the module is self-contained (it cannot
 * import the test's `Events` constant), but the test asserts against the
 * Events.* constants to stay coupled to the contract vocabulary.
 */
function recorderPlugin(id: string, setupDelayMs = 0): string {
  const delay =
    setupDelayMs > 0
      ? `await new Promise((r) => setTimeout(r, ${setupDelayMs}));`
      : "";
  return `
export const seen = [];      // event names, in arrival order
export const startIds = [];  // agentId from each agent.start payload
export default () => ({
  manifest: { id: ${JSON.stringify(id)}, version: "1" },
  async setup(ctx) {
    ctx.events.on("agent.start", (p) => {
      seen.push("agent.start");
      startIds.push(p && p.data ? p.data.agentId : undefined);
    });
    ctx.events.on("clock.tick", () => { seen.push("clock.tick"); });
    ${delay}
  },
});
`;
}

/** Poll a synchronous predicate up to `timeoutMs`, resolving as soon as true. */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("activation: a plugin subscribing to Events.AGENT_START in setup observes agent.start after start() resolves", async () => {
  writePublicPlugin("rec-start", recorderPlugin("rec-start"));
  const agent = make(
    bareDef("act-1", { intervalMs: 10_000, plugins: ["rec-start"] }),
    baseDeps(),
  );

  await agent.start();
  // The contract: core emits AGENT_START to ACTIVATE plugins. By the time start()
  // has resolved, the subscribed plugin must have seen exactly one agent.start.
  const mod = await importPublicPlugin("rec-start");
  assert.equal(
    mod.seen.filter((e: string) => e === Events.AGENT_START).length,
    1,
    "the plugin subscribed in setup must observe agent.start exactly once",
  );

  await agent.stop();
});

test("activation: the agent.start payload's data.agentId equals the def id", async () => {
  writePublicPlugin("rec-id", recorderPlugin("rec-id"));
  const agent = make(
    bareDef("act-id-7", { intervalMs: 10_000, plugins: ["rec-id"] }),
    baseDeps(),
  );

  await agent.start();
  const mod = await importPublicPlugin("rec-id");
  assert.deepEqual(
    mod.startIds,
    ["act-id-7"],
    "agent.start must carry data.agentId === the AgentDefinition id",
  );

  await agent.stop();
});

test("activation/ordering: agent.start arrives BEFORE the first clock.tick", async () => {
  // A short interval so a tick actually fires within the test window.
  writePublicPlugin("rec-order", recorderPlugin("rec-order"));
  const agent = make(
    bareDef("act-order", { intervalMs: 25, plugins: ["rec-order"] }),
    baseDeps(),
  );

  await agent.start();
  // Wait until at least one tick has been recorded (or we time out).
  const mod = await importPublicPlugin("rec-order");
  await waitUntil(() => mod.seen.includes(Events.CLOCK_TICK), 1500);
  await agent.stop();

  assert.ok(mod.seen.includes(Events.AGENT_START), "agent.start must have been observed");
  assert.ok(mod.seen.includes(Events.CLOCK_TICK), "at least one clock.tick must have fired");
  assert.ok(
    mod.seen.indexOf(Events.AGENT_START) < mod.seen.indexOf(Events.CLOCK_TICK),
    "agent.start must be delivered BEFORE the first clock.tick",
  );
});

// ===========================================================================
// Behavior 8 — stop() during an in-flight start() lands genuinely stopped
//
// A plugin whose setup AWAITS keeps start() in flight. We call start() WITHOUT
// awaiting, immediately stop(), then await the original start() promise: neither
// must reject, and crucially NO live beat timer may survive.
//
// ISOLATION NOTE: this scenario runs in a CHILD process. A violating
// implementation leaks an unstoppable re-arming timer (stop() is latched, so
// nothing in-process can ever clear it), which would keep THIS process's event
// loop alive forever and hang the whole test run. The child makes the same
// observations, reports them as JSON, and force-exits, so the suite finishes
// in both the red and green states.
// ===========================================================================

test("inflight stop: stop() during an in-flight start() leaks NO live clock timer; both settle; a later cycle works", () => {
  const agentEntry = pathToFileURL(
    path.resolve("packages", "agent_instance", "src", "index.ts"),
  ).href;
  const script = `
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentInstance } from ${JSON.stringify(agentEntry)};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-inflight-"));
const publicPluginDir = path.join(tmp, "public_plugin");
const agentsDir = path.join(tmp, "agents");
const pdir = path.join(publicPluginDir, "rec-inflight");
fs.mkdirSync(pdir, { recursive: true });
fs.mkdirSync(agentsDir, { recursive: true });
fs.writeFileSync(path.join(pdir, "index.ts"), ${JSON.stringify(recorderPlugin("rec-inflight", 30))}, "utf8");

const result = { startRejected: false, stopRejected: false, ticks: -1, cycleOk: false };
try {
  const agent = createAgentInstance(
    { id: "act-inflight", intervalMs: 20, plugins: ["rec-inflight"] },
    { publicPluginDir, agentsDir },
  );
  // start() is in flight (its plugin setup awaits ~30ms). Do NOT await it.
  const p = agent.start();
  await agent.stop().catch(() => { result.stopRejected = true; });
  await p.catch(() => { result.startRejected = true; });

  // Give any (erroneously) armed timer well over 2x the interval to fire.
  await new Promise((r) => setTimeout(r, 20 * 5));
  const mod = await import(pathToFileURL(path.join(pdir, "index.ts")).href);
  result.ticks = mod.seen.filter((e) => e === "clock.tick").length;

  // The agent must end genuinely settled — a later start()/stop() pair must not reject.
  try { await agent.start(); await agent.stop(); result.cycleOk = true; } catch { result.cycleOk = false; }
} finally {
  console.log("RESULT:" + JSON.stringify(result));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0); // force exit: a violating impl's leaked timer must not hang the child
}
`;
  // .mts forces ESM: the temp dir has no package.json, so a .ts child would be
  // transpiled as CJS and reject the script's top-level await.
  const scriptPath = path.join(tmp, "inflight-child.mts");
  fs.writeFileSync(scriptPath, script, "utf8");

  const run = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: path.resolve("."), // repo root so the child resolves tsx + packages
    encoding: "utf8",
    timeout: 30_000,
  });
  const line = (run.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
  assert.ok(line, "child must report a RESULT line (stderr: " + (run.stderr ?? "") + ")");
  const result = JSON.parse(line!.slice("RESULT:".length));

  assert.equal(result.stopRejected, false, "stop() during an in-flight start() must resolve");
  assert.equal(result.startRejected, false, "the in-flight start() promise must not reject after stop()");
  assert.equal(
    result.ticks,
    0,
    "an agent stopped during start() must NOT leave a live beat timer (no clock.tick)",
  );
  assert.equal(result.cycleOk, true, "a later start()/stop() pair must settle without rejecting");
});

// ===========================================================================
// EXT — print-sink threading: createAgentInstance deps gains `print` and
// forwards it to the loader, so a plugin's ctx.print (its starting message)
// lands in whatever console the composition root (boot) wired in.
// ===========================================================================

test("deps.print: a plugin's ctx.print during setup reaches the injected sink verbatim", async () => {
  writePublicPlugin(
    "greeter",
    `
export default () => ({
  manifest: { id: "greeter", version: "1" },
  setup(ctx) { ctx.print("greeter is awake"); },
});
`,
  );
  const prints: string[] = [];
  const agent = make(
    bareDef("printy", { intervalMs: 10_000, plugins: ["greeter"] }),
    baseDeps({ print: (t: string) => prints.push(t) }),
  );

  await agent.start();
  assert.deepEqual(prints, ["greeter is awake"], "the sink received the exact text");
  await agent.stop();
});

test("deps.print omitted: a printing plugin still starts (default sink; no throw)", async () => {
  writePublicPlugin(
    "greeter-d",
    `
export default () => ({
  manifest: { id: "greeter-d", version: "1" },
  setup(ctx) { ctx.print("default sink"); },
});
`,
  );
  const agent = make(
    bareDef("printy-d", { intervalMs: 10_000, plugins: ["greeter-d"] }),
    baseDeps(),
  );
  await assert.doesNotReject(() => agent.start());
  await agent.stop();
});
