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
import { createAgentInstance } from "../packages/agent_instance/src";
import type { AgentDefinition } from "../contracts/agent";

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
