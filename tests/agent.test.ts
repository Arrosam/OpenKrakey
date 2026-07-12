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
 * the repo cwd or the network. A modest `intervalMs` (10s) keeps the real frame
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
 * so a thrown assertion can never leak a live frame timer (which would otherwise
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
// must reject, and crucially NO live frame timer may survive.
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
    "an agent stopped during start() must NOT leave a live frame timer (no clock.tick)",
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

// ===========================================================================
// EXT — CORE LOG BRIDGE: agent_instance hands the per-Agent core modules
// (orchestrator + loader) a BUS-BRIDGING Logger, so every diagnostic line a
// core module emits via its injected Logger (info/warn/error) is ALSO published
// on THAT Agent's eventbus as a `log.entry` event (shared/actions Events.LOG),
// exactly like a plugin's ctx.log.* — but tagged with a `core:<module>` source
// in the payload's `pluginId` field ("core:orchestrator" / "core:loader").
//
// No new event name, no contract change: log.entry's pluginId is a plain string.
// Console output is unchanged; plugin logs keep their plugin-id tag (regression).
//
// Black-box at the agent boundary: we only drive start()/stop(). To OBSERVE
// what reaches the bus we inject plugins (written as module SOURCE strings —
// they cannot import the test's constants, so event names are literal) that
// subscribe to "log.entry" in setup and append every entry's
// {level, pluginId, text} to an exported, module-level array. ESM caches by
// resolved URL, so the test re-imports the SAME file the loader imported and
// reads the array back. We do NOT couple to the exact core message wording.
// ===========================================================================

/**
 * A plugin that, in setup, (a) subscribes to "log.entry" and pushes every
 * entry's {level, pluginId, text} into the exported `logs` array, and (b)
 * registers a context block (via ctx.setBlock) whose render() THROWS. The
 * orchestrator renders each block in isolation during a frame; a throwing
 * render() is caught and logged as a WARNING by the orchestrator's (now
 * bus-bridged) logger — the deterministic, spec-level trigger for a core log.
 */
function throwingRenderRecorderPlugin(id: string, blockId = "boom"): string {
  return `
export const logs = []; // { level, pluginId, text } in arrival order
export default () => ({
  manifest: { id: ${JSON.stringify(id)}, version: "1" },
  setup(ctx) {
    ctx.events.on("log.entry", (p) => {
      const d = p && p.data ? p.data : {};
      logs.push({ level: d.level, pluginId: d.pluginId, text: d.text });
    });
    ctx.setBlock({
      id: ${JSON.stringify(blockId)},
      priority: 100,
      render() { throw new Error("render-boom"); },
    });
    // METHOD B: compose happens on demand, so stand in for llm-core — pull a
    // prompt.compose each frame so the throwing block actually renders (and the
    // orchestrator logs the caught failure as a core:orchestrator warn).
    ctx.events.on("clock.tick", () => {
      if (ctx.actions.has("prompt.compose")) ctx.actions.invoke("prompt.compose").catch(() => {});
    });
  },
});
`;
}

/**
 * A pure recorder plugin: subscribes to "log.entry" and records every entry's
 * {level, pluginId, text}. Registers NO block and logs nothing itself, so on a
 * clean frame it must observe NO `core:*` entry (negative / regression probe).
 */
function logRecorderPlugin(id: string): string {
  return `
export const logs = []; // { level, pluginId, text } in arrival order
export default () => ({
  manifest: { id: ${JSON.stringify(id)}, version: "1" },
  setup(ctx) {
    ctx.events.on("log.entry", (p) => {
      const d = p && p.data ? p.data : {};
      logs.push({ level: d.level, pluginId: d.pluginId, text: d.text });
    });
  },
});
`;
}

// ---- Cover 1 + 2: a core diagnostic reaches the bus, tagged core:orchestrator

test("core-log: a throwing render() makes the orchestrator emit a log.entry tagged pluginId === 'core:orchestrator', level 'warn', non-empty text", async () => {
  writePublicPlugin("rec-core-warn", throwingRenderRecorderPlugin("rec-core-warn"));
  const agent = make(
    // small interval so a frame actually fires and renders the throwing block
    bareDef("core-warn", { intervalMs: 25, plugins: ["rec-core-warn"] }),
    baseDeps(),
  );

  await agent.start();
  const mod = await importPublicPlugin("rec-core-warn");
  await waitUntil(
    () => mod.logs.some((l: any) => l.pluginId === "core:orchestrator"),
    1500,
  );
  await agent.stop();

  const core = mod.logs.filter((l: any) => l.pluginId === "core:orchestrator");
  assert.ok(
    core.length >= 1,
    "the orchestrator's diagnostic must reach the bus as a log.entry tagged core:orchestrator",
  );
  // At least one such entry must be a WARNING with real text (don't pin wording).
  const warn = core.find((l: any) => l.level === "warn");
  assert.ok(warn, "the caught throwing-render must be logged at level 'warn'");
  assert.equal(typeof warn.text, "string", "core log text must be a string");
  assert.ok(warn.text.length > 0, "core log text must be non-empty");
});

test("core-log: the orchestrator entry's pluginId is the SOURCE TAG 'core:orchestrator' (starts with 'core:')", async () => {
  writePublicPlugin("rec-core-tag", throwingRenderRecorderPlugin("rec-core-tag"));
  const agent = make(
    bareDef("core-tag", { intervalMs: 25, plugins: ["rec-core-tag"] }),
    baseDeps(),
  );

  await agent.start();
  const mod = await importPublicPlugin("rec-core-tag");
  await waitUntil(
    () => mod.logs.some((l: any) => l.pluginId === "core:orchestrator"),
    1500,
  );
  await agent.stop();

  const core = mod.logs.filter(
    (l: any) => typeof l.pluginId === "string" && l.pluginId.startsWith("core:"),
  );
  assert.ok(core.length >= 1, "at least one core-tagged log.entry must have been observed");
  // Every core-tagged entry seen here must be the orchestrator (it is the only
  // core module that logs on this path) — and must NOT collide with a plugin id.
  for (const l of core) {
    assert.equal(
      l.pluginId,
      "core:orchestrator",
      "a core log.entry from the orchestrator path must be tagged exactly 'core:orchestrator'",
    );
    assert.notEqual(
      l.pluginId,
      "rec-core-tag",
      "a core log must NOT be tagged with the observing plugin's id",
    );
  }
});

// ---- Cover 3: plugin logs still work / are NOT mis-tagged (regression)

test("plugin-log regression: a plugin's ctx.log.info emits log.entry tagged with the PLUGIN id, never a core: tag", async () => {
  // Emitter: logs once in setup. Recorder (separate plugin) captures the bus.
  writePublicPlugin(
    "emitter-info",
    `
export default () => ({
  manifest: { id: "emitter-info", version: "1" },
  setup(ctx) { ctx.log.info("hi"); },
});
`,
  );
  writePublicPlugin("rec-plugin-info", logRecorderPlugin("rec-plugin-info"));
  // Recorder FIRST so it is subscribed before the emitter's setup runs (the
  // loader sets plugins up in declared order).
  const agent = make(
    bareDef("plug-info", {
      intervalMs: 10_000,
      plugins: ["rec-plugin-info", "emitter-info"],
    }),
    baseDeps(),
  );

  await agent.start();
  const mod = await importPublicPlugin("rec-plugin-info");
  await waitUntil(
    () => mod.logs.some((l: any) => l.text === "hi"),
    1500,
  );
  await agent.stop();

  const hi = mod.logs.filter((l: any) => l.text === "hi");
  assert.ok(hi.length >= 1, "the plugin's ctx.log.info line must reach the bus as a log.entry");
  for (const l of hi) {
    assert.equal(l.pluginId, "emitter-info", "a plugin log.entry must be tagged with the plugin's id");
    assert.equal(l.level, "info", "ctx.log.info must carry level 'info'");
    assert.ok(
      typeof l.pluginId === "string" && !l.pluginId.startsWith("core:"),
      "a plugin log MUST NOT be mis-tagged with a core: source",
    );
  }
});

test("plugin-log regression: a plugin's ctx.print emits log.entry level 'print' tagged with the plugin id (not core:)", async () => {
  writePublicPlugin(
    "emitter-print",
    `
export default () => ({
  manifest: { id: "emitter-print", version: "1" },
  setup(ctx) { ctx.print("awake"); },
});
`,
  );
  writePublicPlugin("rec-plugin-print", logRecorderPlugin("rec-plugin-print"));
  const agent = make(
    bareDef("plug-print", {
      intervalMs: 10_000,
      plugins: ["rec-plugin-print", "emitter-print"],
    }),
    baseDeps(),
  );

  await agent.start();
  const mod = await importPublicPlugin("rec-plugin-print");
  await waitUntil(() => mod.logs.some((l: any) => l.text === "awake"), 1500);
  await agent.stop();

  const awake = mod.logs.filter((l: any) => l.text === "awake");
  assert.ok(awake.length >= 1, "ctx.print must reach the bus as a log.entry");
  for (const l of awake) {
    assert.equal(l.pluginId, "emitter-print", "ctx.print's log.entry must carry the plugin id");
    assert.equal(l.level, "print", "ctx.print must carry level 'print'");
    assert.ok(
      !l.pluginId.startsWith("core:"),
      "ctx.print must NOT be tagged with a core: source",
    );
  }
});

// ---- Cover 4: R3 not broken — a clean bare frame invents NO core:* logs

test("R3 + no-spurious-core: a recorder-only agent (no throwing block, nothing logging) runs clean frames and records ZERO core:* log.entry", async () => {
  writePublicPlugin("rec-clean", logRecorderPlugin("rec-clean"));
  const agent = make(
    // small interval so a frame or two actually fires during the window
    bareDef("clean-frame", { intervalMs: 25, plugins: ["rec-clean"] }),
    baseDeps(),
  );

  await assert.doesNotReject(() => agent.start(), "a recorder-only agent must start cleanly");
  const mod = await importPublicPlugin("rec-clean");
  // Let a frame or two pass so the orchestrator definitely ran a clean frame.
  await waitUntil(() => false, 200);
  await assert.doesNotReject(() => agent.stop(), "and stop cleanly");

  const core = mod.logs.filter(
    (l: any) => typeof l.pluginId === "string" && l.pluginId.startsWith("core:"),
  );
  assert.deepEqual(
    core,
    [],
    "the bridge must NOT invent spurious core:* log.entry on a clean frame",
  );
});

// ---- Cover 5: a core:loader entry on the plugin error path (teardown throws)
//
// The loader contract documents that teardown tears every loaded plugin down
// with ISOLATED errors, and the NEW behavior says the loader logs on a plugin
// error path via its bus-bridged Logger. A plugin whose teardown() throws is a
// contract-level (not implementation-coupled) error path, inducible during
// agent.stop(). Determinism note: load order is the declared order, teardown is
// REVERSE order — so we load the RECORDER first (tears down LAST) and the
// THROWER second (tears down FIRST). When the thrower's teardown throws, the
// recorder is still set up and its "log.entry" listener captures the loader's
// core:loader error. We assert ONLY pluginId + level + non-empty text.

test("core-log: a plugin whose teardown() throws makes the loader emit a log.entry tagged 'core:loader', level 'error', during stop()", async () => {
  writePublicPlugin("rec-core-loader", logRecorderPlugin("rec-core-loader"));
  writePublicPlugin(
    "thrower-teardown",
    `
export default () => ({
  manifest: { id: "thrower-teardown", version: "1" },
  setup(ctx) { /* nothing — no block, no log */ },
  teardown() { throw new Error("teardown-boom"); },
});
`,
  );
  // Recorder first (teardown LAST), thrower second (teardown FIRST).
  const agent = make(
    bareDef("core-loader", {
      intervalMs: 10_000,
      plugins: ["rec-core-loader", "thrower-teardown"],
    }),
    baseDeps(),
  );

  await agent.start();
  const mod = await importPublicPlugin("rec-core-loader");
  // stop() drives teardown; an isolated teardown error must NOT reject stop().
  await assert.doesNotReject(
    () => agent.stop(),
    "an isolated teardown error must be caught (loader teardown is isolated), not rejected",
  );
  // The loader's diagnostic for that caught error must have reached the bus.
  await waitUntil(
    () => mod.logs.some((l: any) => l.pluginId === "core:loader"),
    1500,
  );

  const loaderLogs = mod.logs.filter((l: any) => l.pluginId === "core:loader");
  assert.ok(
    loaderLogs.length >= 1,
    "the loader's teardown-error diagnostic must reach the bus tagged core:loader",
  );
  const err = loaderLogs.find((l: any) => l.level === "error");
  assert.ok(err, "the loader must log the caught teardown error at level 'error'");
  assert.equal(typeof err.text, "string");
  assert.ok(err.text.length > 0, "the core:loader error log must carry non-empty text");
});

// ---- Cover 6 (REGRESSION GUARD): a plugin log line is mirrored to the bus
// EXACTLY ONCE — never duplicated as a core:* entry.
//
// The bug this guards against: the loader echoes plugin log lines to the console
// through its INJECTED logger. If that loader logger is itself bus-bridged
// (core:loader), every plugin ctx.log.* line gets mirrored a SECOND time as a
// `core:loader` log.entry carrying the same text. The contract is: a plugin's
// ctx.log.warn("X") yields ONE log.entry on the bus, tagged with the PLUGIN's id,
// text "X" — and ZERO log.entry whose pluginId starts with "core:" carrying that
// same text.
//
// We make the plugin self-observing: in setup it subscribes to "log.entry" FIRST
// (so it is guaranteed to see its own subsequent line), THEN calls ctx.log.warn.
// The log fires during setup, so no frame is needed (large interval = no noise).
// We re-import the SAME module file (ESM URL cache) to read its exported entries.

test("plugin-log dedup regression: ctx.log.warn yields EXACTLY ONE log.entry (plugin-tagged); NO core:* duplicate of the same text", async () => {
  // Subscribe BEFORE logging so the plugin observes its own line; log in setup.
  writePublicPlugin(
    "dedup-warn",
    `
export const logs = []; // { level, pluginId, text } in arrival order
export default () => ({
  manifest: { id: "dedup-warn", version: "1" },
  setup(ctx) {
    ctx.events.on("log.entry", (p) => {
      const d = p && p.data ? p.data : {};
      logs.push({ level: d.level, pluginId: d.pluginId, text: d.text });
    });
    ctx.log.warn("UNIQ-PLUGIN-LINE-7");
  },
});
`,
  );
  const agent = make(
    // large interval so no frame noise — the warn fires during setup
    bareDef("dedup-plug", { intervalMs: 10_000, plugins: ["dedup-warn"] }),
    baseDeps(),
  );

  await agent.start();
  const mod = await importPublicPlugin("dedup-warn");
  await waitUntil(
    () => mod.logs.some((l: any) => typeof l.text === "string" && l.text.includes("UNIQ-PLUGIN-LINE-7")),
    1500,
  );
  await agent.stop();

  // Every captured entry carrying our unique text.
  const matching = mod.logs.filter(
    (l: any) => typeof l.text === "string" && l.text.includes("UNIQ-PLUGIN-LINE-7"),
  );
  // EXACTLY ONE mirrored line — and it is the plugin's own, not a core: tag.
  assert.equal(
    matching.length,
    1,
    "a plugin's ctx.log.warn must be mirrored to the bus EXACTLY once (no core:loader duplicate)",
  );
  assert.equal(
    matching[0].pluginId,
    "dedup-warn",
    "the single mirrored entry must be tagged with the PLUGIN's id",
  );

  // ZERO core:* duplicate of that same plugin line.
  const coreDupes = mod.logs.filter(
    (l: any) =>
      typeof l.pluginId === "string" &&
      l.pluginId.startsWith("core:") &&
      typeof l.text === "string" &&
      l.text.includes("UNIQ-PLUGIN-LINE-7"),
  );
  assert.deepEqual(
    coreDupes,
    [],
    "a plugin log line MUST NOT be re-mirrored as a core:* (e.g. core:loader) log.entry",
  );
});

// ---- Cover 7 (RE-ENTRANCY REGRESSION): a log.entry subscriber that itself logs
// must NOT trigger infinite synchronous recursion / stack overflow.
//
// The bus `emit` is SYNCHRONOUS in-line fan-out, and a core diagnostic is mirrored
// onto the Agent bus as a `log.entry` event. If a `log.entry` subscriber calls
// ctx.log.* from INSIDE its handler, the unguarded path recurses forever:
//   ctx.log -> pushLogEntry -> emit(log.entry) -> same handler -> ctx.log -> ...
// blowing the stack ("Maximum call stack size exceeded") and crashing the agent.
//
// The fix adds a re-entrancy guard: a `log.entry` emit triggered from WITHIN
// another `log.entry` emit is dropped (no recursion), while a non-re-emitting
// subscriber keeps working. The guard must NOT permanently latch — once the
// outermost log.entry fan-out unwinds, the NEXT independent ctx.log.* (e.g. the
// single "kick") must still be delivered to the subscriber at least once.
//
// CRITICAL SAFETY: a RED (unfixed) run stack-overflows or hangs. To keep the
// suite from hanging we run this scenario in a CHILD process (mirroring the
// "inflight stop" test): the child builds the agent, runs start()/stop(), reports
// { crashed, count, completed } as a RESULT JSON line, and force-exits in a
// finally so a runaway can't keep the parent alive. The parent asserts the child
// completed cleanly with a BOUNDED entry count.

test("re-entrancy regression: a log.entry subscriber that re-logs does NOT infinitely recurse / crash; entry count stays bounded", () => {
  const agentEntry = pathToFileURL(
    path.resolve("packages", "agent_instance", "src", "index.ts"),
  ).href;

  // A plugin whose log.entry handler RE-LOGS on every entry. It also counts each
  // observed entry, and kicks the chain once with a single ctx.log.info("kick").
  // If the bus had no re-entrancy guard, the first kicked log.entry would re-enter
  // the handler, which logs again, ... -> unbounded recursion -> stack overflow.
  const reentrantPlugin = `
export const logs = []; // observed log.entry payloads (texts), in arrival order
export default () => ({
  manifest: { id: "rec-reentrant", version: "1" },
  setup(ctx) {
    ctx.events.on("log.entry", (p) => {
      const d = p && p.data ? p.data : {};
      logs.push(d.text);
      // Re-log from INSIDE the log.entry handler. With the guard this nested
      // emit is dropped (no recursion); without it, it recurses to a crash.
      ctx.log.info("echo");
    });
    // Kick the chain exactly once now that the subscriber is wired.
    ctx.log.info("kick");
  },
});
`;

  const script = `
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentInstance } from ${JSON.stringify(agentEntry)};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-reentrant-"));
const publicPluginDir = path.join(tmp, "public_plugin");
const agentsDir = path.join(tmp, "agents");
const pdir = path.join(publicPluginDir, "rec-reentrant");
fs.mkdirSync(pdir, { recursive: true });
fs.mkdirSync(agentsDir, { recursive: true });
fs.writeFileSync(path.join(pdir, "index.ts"), ${JSON.stringify(reentrantPlugin)}, "utf8");

const result = { crashed: false, count: -1, completed: false };
try {
  // Large interval: the recursion is driven by the setup-time ctx.log, not a frame.
  const agent = createAgentInstance(
    { id: "reentrant-log", intervalMs: 10000, plugins: ["rec-reentrant"] },
    { publicPluginDir, agentsDir },
  );
  await agent.start();
  // Let any (erroneously) deferred re-emits settle.
  await new Promise((r) => setTimeout(r, 50));
  await agent.stop();

  const mod = await import(pathToFileURL(path.join(pdir, "index.ts")).href);
  result.count = mod.logs.length;
  result.completed = true; // start()/stop() both returned without throwing
} catch (e) {
  // A stack overflow surfaces as a thrown RangeError ("Maximum call stack size
  // exceeded"). Any throw on this path is a crash for our purposes.
  result.crashed = true;
  try {
    const mod = await import(pathToFileURL(path.join(pdir, "index.ts")).href);
    result.count = mod.logs.length;
  } catch {}
} finally {
  console.log("RESULT:" + JSON.stringify(result));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0); // force exit: a runaway must not hang the child (or the suite)
}
`;
  // .mts forces ESM (temp dir has no package.json) so top-level await is allowed.
  const scriptPath = path.join(tmp, "reentrant-child.mts");
  fs.writeFileSync(scriptPath, script, "utf8");

  const run = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: path.resolve("."), // repo root so the child resolves tsx + packages
    encoding: "utf8",
    timeout: 30_000,
  });

  // A RED implementation may not even reach the RESULT line if it overflows the
  // stack before the catch unwinds, or it may exceed the spawn timeout (hang).
  assert.equal(run.error, undefined, "child must not time out / fail to spawn (a hang implies runaway recursion)");
  const line = (run.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
  assert.ok(
    line,
    "child must report a RESULT line (a missing line implies a hard stack-overflow crash) — stderr: " +
      (run.stderr ?? ""),
  );
  const result = JSON.parse(line!.slice("RESULT:".length));

  assert.equal(
    result.crashed,
    false,
    "a re-logging log.entry subscriber must NOT crash the agent (no stack overflow)",
  );
  assert.equal(
    result.completed,
    true,
    "start()/stop() must both complete without throwing despite the re-logging subscriber",
  );
  assert.ok(
    result.count >= 1,
    "the subscriber must still observe at least the initial 'kick' log.entry (the guard must not permanently latch)",
  );
  assert.ok(
    result.count < 50,
    "the observed log.entry count must stay BOUNDED (no runaway recursion) — got " + result.count,
  );
});

// ===========================================================================
// EXT — GRACEFUL-RESTART SEAM: when boot wires a `requestRestart` callback,
// the agent registers a core-owned `core.restart` action that DELEGATES to it
// (forwarding delayMs). Without the dep, the action is simply NOT registered, so
// a plugin's ctx.actions.has("core.restart") is false and it must not invoke.
// Black-box: we observe via a plugin that records has() and invokes once.
// ===========================================================================

/** A plugin that, in setup, records whether core.restart exists and invokes it once. */
function restartCallerPlugin(id: string, delayMs = 1234): string {
  return `
export const observed = { has: null, invoked: false };
export default () => ({
  manifest: { id: ${JSON.stringify(id)}, version: "1" },
  async setup(ctx) {
    observed.has = ctx.actions.has("core.restart");
    if (observed.has) {
      try { await ctx.actions.invoke("core.restart", { delayMs: ${delayMs} }); observed.invoked = true; } catch {}
    }
  },
});
`;
}

test("deps.requestRestart: the agent registers core.restart; a plugin invoking it reaches the callback with delayMs", async () => {
  writePublicPlugin("restart-caller", restartCallerPlugin("restart-caller", 1234));
  const calls: number[] = [];
  const agent = make(
    bareDef("rr-on", { intervalMs: 10_000, plugins: ["restart-caller"] }),
    baseDeps({ requestRestart: async (ms: number) => { calls.push(ms); } }),
  );
  await agent.start();
  const mod = await importPublicPlugin("restart-caller");
  assert.equal(mod.observed.has, true, "core.restart must be registered when requestRestart is provided");
  assert.equal(mod.observed.invoked, true, "the plugin's core.restart invoke resolved");
  assert.deepEqual(calls, [1234], "requestRestart received the delayMs the plugin passed");
  await agent.stop();
});

test("no deps.requestRestart: core.restart is NOT registered; a plugin's has() is false and it never invokes", async () => {
  writePublicPlugin("restart-caller-off", restartCallerPlugin("restart-caller-off"));
  const agent = make(
    bareDef("rr-off", { intervalMs: 10_000, plugins: ["restart-caller-off"] }),
    baseDeps(), // no requestRestart wired
  );
  await assert.doesNotReject(() => agent.start());
  const mod = await importPublicPlugin("restart-caller-off");
  assert.equal(mod.observed.has, false, "core.restart must be absent without the dep");
  assert.equal(mod.observed.invoked, false, "the plugin must not invoke a missing action");
  await agent.stop();
});
