/**
 * Black-box edge tests for the `boot` node's PURE functions.
 *
 * Scope: ONLY the three importable, side-effect-controlled functions exposed by
 * `packages/boot/src` —
 *   - loadAgentConfigs(agentsDir): AgentDefinition[]
 *   - loadLLMConfig(llmPath): LLMConfig
 *   - run(defs, opts?: { library?, log? }): Promise<AgentHandle[]>
 *
 * `main()` is deliberately NOT tested: it launches every agent, builds the real
 * llm-gateway library, and installs a SIGINT handler / keeps the process alive —
 * none of which is a pure, assertable unit.
 *
 * Contract shapes pinned (and therefore asserted against):
 *   - AgentDefinition = { id, intervalMs, plugins: string[], privatePlugins?, config? }
 *     (contracts/agent)
 *   - AgentHandle     = { readonly id, start(): Promise<void>, stop(): Promise<void> }
 *     (contracts/agent)
 *   - CommunicatorLibrary = { get(name), has(name), list() }   (contracts/llm)
 *   - LLMConfig = { communicators: Record<string, CommunicatorDef>, default? }
 *     (shared/config) — re-derived here only to build deep-equal expectations.
 *
 * Behavior pinned by the boot node overview (overviews/nodes/boot.md):
 *   - loadAgentConfigs: read agents/<id>/config.json; skip unreadable/invalid; a
 *     missing agents dir yields [].
 *   - loadLLMConfig: read config/llm.json; missing OR invalid -> { communicators: {} }.
 *   - run: build + start each agent_instance, returning one AgentHandle per def.
 *
 * Path handling: loadAgentConfigs / loadLLMConfig resolve their argument against
 * process.cwd() via path.resolve(cwd, arg). path.resolve leaves an ABSOLUTE path
 * unchanged, so every path passed below is an absolute path inside a per-test OS
 * temp dir — keeping tests independent of cwd and of the repo layout.
 *
 * Isolation: a brand-new temp dir per test (beforeEach), removed in afterEach.
 * `run` starts real agents (with their beat timers); every returned handle is
 * tracked and stopped in afterEach so no timer leaks across tests.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentConfigs, loadLLMConfig, run } from "../packages/boot/src";
import type { AgentDefinition, AgentHandle } from "../contracts/agent";
import type { CommunicatorLibrary } from "../contracts/llm";

// ---------------------------------------------------------------------------
// per-test temp sandbox + started-handle bookkeeping
// ---------------------------------------------------------------------------

let tmp: string;
/** Every handle `run` hands back this test — stopped in afterEach. */
let started: AgentHandle[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-boot-"));
  started = [];
});

afterEach(async () => {
  // Stop every agent run() started so its beat timer cannot outlive the test.
  await Promise.allSettled(started.map((h) => h.stop()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A minimal stub CommunicatorLibrary (no real LLM, no secrets). `run` passes this
 * straight through to each agent_instance; a bare def loads zero plugins, so the
 * library is never actually queried — but it satisfies the wiring.
 */
function stubLibrary(): CommunicatorLibrary {
  return {
    get: () => undefined,
    has: () => false,
    list: () => [],
  };
}

/** A bare, valid AgentDefinition: long beat, no plugins. */
function bareDef(id: string): AgentDefinition {
  return {
    id,
    intervalMs: 10000,
    plugins: [],
    privatePlugins: [],
    config: {},
  };
}

/** Track + return handles so afterEach can stop them. */
function trackAll(handles: AgentHandle[]): AgentHandle[] {
  started.push(...handles);
  return handles;
}

/** Write `agents/<id>/config.json` under tmp with the given raw text. */
function writeAgentConfigRaw(id: string, raw: string): string {
  const dir = path.join(tmp, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, raw, "utf8");
  return file;
}

/** Write a valid AgentDefinition as `agents/<id>/config.json`. */
function writeAgentDef(def: AgentDefinition): void {
  writeAgentConfigRaw(def.id, JSON.stringify(def));
}

/** Absolute path to this test's agents dir (need not exist). */
function agentsDirPath(): string {
  return path.join(tmp, "agents");
}

/** Absolute path to this test's config/llm.json (need not exist). */
function llmPathFor(): string {
  return path.join(tmp, "config", "llm.json");
}

/** Write config/llm.json under tmp with the given raw text. */
function writeLLMRaw(raw: string): string {
  const file = llmPathFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw, "utf8");
  return file;
}

/** Order-insensitive comparison of AgentDefinition[] by id. */
function byId(a: AgentDefinition, b: AgentDefinition): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ===========================================================================
// loadAgentConfigs
// ===========================================================================

test("loadAgentConfigs: missing agents dir -> []", () => {
  // agentsDir never created under tmp.
  const got = loadAgentConfigs(agentsDirPath());
  assert.deepEqual(got, []);
});

test("loadAgentConfigs: empty agents dir -> []", () => {
  fs.mkdirSync(agentsDirPath(), { recursive: true });
  const got = loadAgentConfigs(agentsDirPath());
  assert.deepEqual(got, []);
});

test("loadAgentConfigs: two valid agents -> both defs (order-insensitive)", () => {
  const a = bareDef("a");
  const b = bareDef("b");
  // Make them distinguishable beyond id so a swap would be caught.
  a.intervalMs = 1000;
  b.intervalMs = 2000;
  writeAgentDef(a);
  writeAgentDef(b);

  const got = loadAgentConfigs(agentsDirPath());
  assert.equal(got.length, 2);
  assert.deepEqual([...got].sort(byId), [a, b].sort(byId));
});

test("loadAgentConfigs: a subdir WITHOUT config.json is skipped (not an error)", () => {
  // Valid agent "a" + a bare directory "b" with no config.json.
  writeAgentDef(bareDef("a"));
  fs.mkdirSync(path.join(tmp, "agents", "b"), { recursive: true });

  const got = loadAgentConfigs(agentsDirPath());
  assert.equal(got.length, 1);
  assert.deepEqual(got, [bareDef("a")]);
});

test("loadAgentConfigs: an INVALID-JSON config.json is skipped; others still load", () => {
  writeAgentConfigRaw("bad", "{ this is not json ::: ");
  writeAgentDef(bareDef("good"));

  let got: AgentDefinition[] = [];
  assert.doesNotThrow(() => {
    got = loadAgentConfigs(agentsDirPath());
  });
  // The good one survives; the broken one is dropped silently.
  assert.deepEqual(
    got.map((d) => d.id),
    ["good"],
  );
});

test("loadAgentConfigs: a single valid agent -> exactly that def", () => {
  const only = bareDef("solo");
  only.intervalMs = 1500;
  only.config = { persona: "p" };
  writeAgentDef(only);

  const got = loadAgentConfigs(agentsDirPath());
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], only);
});

test("loadAgentConfigs: a plain FILE among the agent dirs is skipped (no config.json beneath)", () => {
  // A stray file sitting directly in agents/ has no agents/<x>/config.json.
  writeAgentDef(bareDef("real"));
  fs.mkdirSync(agentsDirPath(), { recursive: true });
  fs.writeFileSync(path.join(agentsDirPath(), "notes.txt"), "hello", "utf8");

  const got = loadAgentConfigs(agentsDirPath());
  assert.deepEqual(
    got.map((d) => d.id),
    ["real"],
  );
});

// ===========================================================================
// loadLLMConfig
// ===========================================================================

test("loadLLMConfig: missing file -> { communicators: {} }", () => {
  // config/llm.json never created under tmp.
  const got = loadLLMConfig(llmPathFor());
  assert.deepEqual(got, { communicators: {} });
});

test("loadLLMConfig: a valid catalogue is parsed and returned (deep-equal)", () => {
  const cfg = {
    communicators: {
      claude: { provider: "anthropic", model: "m", apiKey: "k" },
    },
    default: "claude",
  };
  writeLLMRaw(JSON.stringify(cfg));

  const got = loadLLMConfig(llmPathFor());
  assert.deepEqual(got, cfg);
});

test("loadLLMConfig: invalid JSON -> { communicators: {} } (no throw)", () => {
  writeLLMRaw("{ not: valid json ");

  let got: unknown;
  assert.doesNotThrow(() => {
    got = loadLLMConfig(llmPathFor());
  });
  assert.deepEqual(got, { communicators: {} });
});

test("loadLLMConfig: an explicitly-empty communicators map round-trips", () => {
  const cfg = { communicators: {} };
  writeLLMRaw(JSON.stringify(cfg));

  const got = loadLLMConfig(llmPathFor());
  assert.deepEqual(got, { communicators: {} });
});

test("loadLLMConfig: multiple communicators + a full CommunicatorDef survive intact", () => {
  const cfg = {
    communicators: {
      claude: {
        provider: "anthropic",
        model: "claude-x",
        apiKey: "${ANTHROPIC_KEY}",
        temperature: 0.2,
        maxTokens: 1024,
      },
      local: {
        provider: "openai-completion",
        model: "llama",
        baseURL: "http://localhost:1234/v1",
      },
    },
    default: "claude",
  };
  writeLLMRaw(JSON.stringify(cfg));

  const got = loadLLMConfig(llmPathFor());
  assert.deepEqual(got, cfg);
});

// ===========================================================================
// run
// ===========================================================================

test("run: empty def list -> []", async () => {
  const handles = trackAll(await run([], { library: stubLibrary() }));
  assert.deepEqual(handles, []);
});

test("run: one bare def -> one started handle with matching id + start/stop fns", async () => {
  const def = bareDef("solo");
  const handles = trackAll(await run([def], { library: stubLibrary() }));

  assert.equal(handles.length, 1);
  const h = handles[0];
  assert.equal(h.id, def.id);
  assert.equal(typeof h.start, "function");
  assert.equal(typeof h.stop, "function");
  // afterEach stops it; stop() must be awaitable.
});

test("run: two bare defs -> two handles whose ids match the inputs (order-insensitive)", async () => {
  const a = bareDef("alpha");
  const b = bareDef("beta");
  const handles = trackAll(await run([a, b], { library: stubLibrary() }));

  assert.equal(handles.length, 2);
  for (const h of handles) {
    assert.equal(typeof h.start, "function");
    assert.equal(typeof h.stop, "function");
  }
  assert.deepEqual(handles.map((h) => h.id).sort(), ["alpha", "beta"]);
});

test("run: handle.stop() resolves (and is idempotent enough to call once here)", async () => {
  const handles = trackAll(await run([bareDef("stoppable")], { library: stubLibrary() }));
  assert.equal(handles.length, 1);
  // Explicitly exercise stop() as a Promise; afterEach will call it again and
  // Promise.allSettled tolerates a second stop on an already-stopped handle.
  await assert.doesNotReject(() => handles[0].stop());
});
