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
 * `run` starts real agents (with their frame timers); every returned handle is
 * tracked and stopped in afterEach so no timer leaks across tests.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentConfigs, loadLLMConfig, run } from "../packages/boot/src";
import * as bootModule from "../packages/boot/src";
// createCommunicatorLibrary is the llm-gateway node's PUBLIC seam (the factory boot
// calls to turn an LLMConfig into a CommunicatorLibrary). Imported here only as that
// public entry point — its implementation is not inspected.
import { createCommunicatorLibrary } from "../packages/llm-gateway/src";
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
  // Stop every agent run() started so its frame timer cannot outlive the test.
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

/** A bare, valid AgentDefinition: long frame, no plugins. */
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

// ===========================================================================
// loadLLMConfig — communicators-key NORMALIZATION (pin #1)
//
// A file that is VALID JSON but is MISSING the `communicators` key must still
// yield a normalized LLMConfig whose `.communicators` is an EMPTY OBJECT (never
// `undefined`). Downstream (createCommunicatorLibrary) iterates that map, so an
// absent key has to be filled in, not passed through as undefined.
// ===========================================================================

test("loadLLMConfig: valid JSON object WITHOUT a communicators key -> communicators normalized to {}", () => {
  // `default` present, but no `communicators` key at all.
  writeLLMRaw(JSON.stringify({ default: "x" }));

  const got = loadLLMConfig(llmPathFor());
  // The key must exist and be an (empty) object — not undefined.
  assert.notEqual(got.communicators, undefined);
  assert.deepEqual(got.communicators, {});
});

test("loadLLMConfig: valid JSON object WITHOUT a communicators key preserves other keys (e.g. default)", () => {
  writeLLMRaw(JSON.stringify({ default: "x" }));

  const got = loadLLMConfig(llmPathFor());
  // Normalization fills communicators but must not drop the rest of the object.
  assert.equal(got.default, "x");
});

test("loadLLMConfig: an EMPTY JSON object {} -> { communicators: {} } (key normalized in)", () => {
  writeLLMRaw(JSON.stringify({}));

  const got = loadLLMConfig(llmPathFor());
  assert.notEqual(got.communicators, undefined);
  assert.deepEqual(got, { communicators: {} });
});

// ===========================================================================
// run — DEGRADE-NOT-CRASH (spec R3) (pin #2)
//
// Given a batch where one def is unbuildable (its loader import fails) and one is
// a bare zero-plugin def, run() must NOT reject: it degrades, dropping the broken
// agent and returning ONLY the good agent's handle. The good handle must then
// stop() cleanly.
// ===========================================================================

test("run: a def whose plugin import fails is dropped; the good def still yields exactly one handle (R3)", async () => {
  const bad: AgentDefinition = {
    id: "broken",
    intervalMs: 10000,
    plugins: ["definitely-not-a-real-plugin"],
    privatePlugins: [],
    config: {},
  };
  const good = bareDef("survivor");

  let handles: AgentHandle[] = [];
  await assert.doesNotReject(async () => {
    handles = trackAll(await run([bad, good], { library: stubLibrary() }));
  });

  // Exactly one handle — and it is the GOOD agent, not the broken one.
  assert.equal(handles.length, 1);
  assert.equal(handles[0].id, "survivor");
});

test("run: after a degraded batch, the surviving handle stop()s cleanly (R3)", async () => {
  const bad: AgentDefinition = {
    id: "broken",
    intervalMs: 10000,
    plugins: ["definitely-not-a-real-plugin"],
    privatePlugins: [],
    config: {},
  };
  const good = bareDef("survivor");

  const handles = trackAll(await run([bad, good], { library: stubLibrary() }));
  assert.equal(handles.length, 1);
  // The good agent is fully wired and must shut down without error.
  await assert.doesNotReject(() => handles[0].stop());
});

// ===========================================================================
// createCommunicatorLibrary — RESILIENCE to degenerate config (pin #3)
//
// The llm-gateway factory boot calls. Handed a config with no communicators
// (empty object, or one that only carries a `default`), it must NOT throw and
// must yield an EMPTY library: list() is empty and withCapability("chat") is
// empty. (Cast as any: these are the degenerate shapes loadLLMConfig normalizes
// toward; the test only cares about runtime behavior, not the static type.)
// ===========================================================================

test("createCommunicatorLibrary: empty config {} does not throw and yields an empty library", () => {
  let lib: CommunicatorLibrary | undefined;
  assert.doesNotThrow(() => {
    lib = createCommunicatorLibrary({} as any);
  });
  assert.ok(lib);
  assert.deepEqual(lib!.list(), []);
  assert.deepEqual(lib!.withCapability("chat"), []);
});

test("createCommunicatorLibrary: a config with only { default } (no communicators) yields an empty library", () => {
  let lib: CommunicatorLibrary | undefined;
  assert.doesNotThrow(() => {
    lib = createCommunicatorLibrary({ default: "x" } as any);
  });
  assert.ok(lib);
  assert.deepEqual(lib!.list(), []);
});

test("createCommunicatorLibrary: empty library reports nothing present (has/get/withCapability all empty)", () => {
  const lib = createCommunicatorLibrary({} as any);
  // Nothing registered: list empty, has() false, get() undefined, every
  // capability bucket empty.
  assert.deepEqual(lib.list(), []);
  assert.equal(lib.has("anything"), false);
  assert.equal(lib.get("anything"), undefined);
  for (const cap of ["chat", "embed", "rerank", "ocr"] as const) {
    assert.deepEqual(lib.withCapability(cap), []);
  }
});

// ===========================================================================
// EXT — startupHints: the friendly pre-flight messages main() prints so a new
//        user learns the NEXT step instead of staring at silence.
//        Resolved defensively: red on a missing export, never an import crash.
// ===========================================================================

const startupHints: any = (bootModule as any).startupHints;

/** A CommunicatorLibrary stub with nothing configured. */
const libWithNothing = (): CommunicatorLibrary => ({
  get: () => undefined,
  has: () => false,
  list: () => [],
  withCapability: () => [],
});

/** A CommunicatorLibrary stub with one (chat) communicator configured. */
const libWithOne = (): CommunicatorLibrary => ({
  get: () => undefined,
  has: (n) => n === "x",
  list: () => ["x"],
  withCapability: () => ["x"],
});

const hintDef = (id: string): AgentDefinition => ({ id, intervalMs: 60_000, plugins: [] });

test("startupHints: exported as a function from the boot node", () => {
  assert.equal(typeof startupHints, "function", "startupHints not implemented yet");
});

test("startupHints: no agents -> exactly one hint that names agents and points at `npm run cli`", () => {
  assert.equal(typeof startupHints, "function", "startupHints not implemented yet");
  const hints = startupHints([], libWithOne());
  assert.equal(hints.length, 1, "exactly one hint");
  assert.match(hints[0], /agent/i, "the hint must say what is missing (an agent)");
  assert.ok(hints[0].includes("npm run cli"), "the hint must give the exact next command");
});

test("startupHints: agents but NO AI service -> exactly one can't-reply warning pointing at `npm run cli`", () => {
  assert.equal(typeof startupHints, "function", "startupHints not implemented yet");
  const hints = startupHints([hintDef("a"), hintDef("b")], libWithNothing());
  assert.equal(hints.length, 1, "exactly one hint");
  assert.ok(hints[0].includes("npm run cli"), "the hint must give the exact next command");
  assert.match(
    hints[0],
    /provider|service|reply/i,
    "the hint must explain the consequence (no provider -> agents can't reply)",
  );
});

test("startupHints: agents + a configured service -> no hints at all", () => {
  assert.equal(typeof startupHints, "function", "startupHints not implemented yet");
  assert.deepEqual(startupHints([hintDef("a")], libWithOne()), []);
});

test("startupHints: nothing configured at all -> only the no-agents hint (provider warning is moot)", () => {
  assert.equal(typeof startupHints, "function", "startupHints not implemented yet");
  const hints = startupHints([], libWithNothing());
  assert.equal(hints.length, 1, "one hint, not two");
  assert.match(hints[0], /agent/i, "and it is the no-agents hint");
});

// ===========================================================================
// EXT — STARTUP REPORT: whichever console runs the start command gets a clear
// story: a starting line per agent, a started/FAILED verdict (failure carries
// the reason), and each plugin's own starting message (ctx.print) indented
// under its agent. Pins:
//   - run() gains opts.report (a line sink) and opts.publicPluginDir/agentsDir
//     pass-through (so a test sandbox can supply real plugins);
//   - pure helpers startBanner() / summaryLine(started, total) format the
//     frame main() prints around run().
// Resolved defensively: red on a missing export, never an import crash.
// ===========================================================================

const startBanner: any = (bootModule as any).startBanner;
const summaryLine: any = (bootModule as any).summaryLine;

/** A plugin whose only job is to ctx.print one starting message during setup. */
function announcerPlugin(id: string, text: string): string {
  return `
export default () => ({
  manifest: { id: ${JSON.stringify(id)}, version: "1" },
  setup(ctx) { ctx.print(${JSON.stringify(text)}); },
});
`;
}

/** Write a public plugin into THIS test's temp public_plugin dir. */
function writeTmpPublicPlugin(id: string, body: string): string {
  const pdir = path.join(tmp, "public_plugin", id);
  fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, "index.ts");
  fs.writeFileSync(file, body, "utf8");
  return pdir;
}

test("startBanner: exported, and the banner says the program is starting", () => {
  assert.equal(typeof startBanner, "function", "startBanner not implemented yet");
  const line = startBanner();
  assert.equal(typeof line, "string");
  assert.match(line, /starting/i, "the banner must read as a starting message");
});

test("summaryLine: carries started/total counts (2/3) and how to stop", () => {
  assert.equal(typeof summaryLine, "function", "summaryLine not implemented yet");
  const line = summaryLine(2, 3);
  assert.ok(line.includes("2/3"), "the summary must show started/total: " + line);
  assert.match(line, /ctrl\+c/i, "the summary must say how to stop: " + line);
});

test("summaryLine: an all-fail batch still formats (0/2) — the verdict is visible", () => {
  assert.equal(typeof summaryLine, "function", "summaryLine not implemented yet");
  assert.ok(summaryLine(0, 2).includes("0/2"));
});

test("run report: a good agent yields a starting line then a started verdict (both naming it)", async () => {
  const lines: string[] = [];
  const handles = trackAll(
    await run([bareDef("hero")], { library: stubLibrary(), report: (l: string) => lines.push(l) } as any),
  );
  assert.equal(handles.length, 1);

  const startingIdx = lines.findIndex((l) => /starting/i.test(l) && l.includes("hero"));
  const startedIdx = lines.findIndex((l) => /started/i.test(l) && l.includes("hero"));
  assert.notEqual(startingIdx, -1, "a starting line names the agent: " + JSON.stringify(lines));
  assert.notEqual(startedIdx, -1, "a started verdict names the agent: " + JSON.stringify(lines));
  assert.ok(startingIdx < startedIdx, "starting comes before the verdict");
});

test("run report: a failing agent yields a FAILED verdict carrying the id AND the reason", async () => {
  const bad: AgentDefinition = {
    id: "broken",
    intervalMs: 10000,
    plugins: ["definitely-not-a-real-plugin"],
    privatePlugins: [],
    config: {},
  };
  const lines: string[] = [];
  trackAll(await run([bad], { library: stubLibrary(), report: (l: string) => lines.push(l) } as any));

  const failed = lines.find((l) => /fail/i.test(l) && l.includes("broken"));
  assert.ok(failed, "a FAILED line names the agent: " + JSON.stringify(lines));
  assert.ok(
    failed!.includes("definitely-not-a-real-plugin"),
    "the FAILED line must carry the reason (the offending plugin): " + failed,
  );
});

test("run report: mixed batch -> exactly one started verdict and one FAILED verdict", async () => {
  const bad: AgentDefinition = {
    id: "broken",
    intervalMs: 10000,
    plugins: ["definitely-not-a-real-plugin"],
    privatePlugins: [],
    config: {},
  };
  const lines: string[] = [];
  const handles = trackAll(
    await run([bad, bareDef("survivor")], {
      library: stubLibrary(),
      report: (l: string) => lines.push(l),
    } as any),
  );
  assert.equal(handles.length, 1);
  assert.equal(lines.filter((l) => /started/i.test(l)).length, 1, JSON.stringify(lines));
  assert.equal(lines.filter((l) => /fail/i.test(l)).length, 1, JSON.stringify(lines));
});

test("run report: a plugin's ctx.print starting message appears INDENTED under its agent", async () => {
  writeTmpPublicPlugin("announcer", announcerPlugin("announcer", "Web chat ready at :7717"));
  const def: AgentDefinition = {
    id: "webby",
    intervalMs: 10000,
    plugins: ["announcer"],
    privatePlugins: [],
    config: {},
  };
  const lines: string[] = [];
  const handles = trackAll(
    await run([def], {
      library: stubLibrary(),
      report: (l: string) => lines.push(l),
      publicPluginDir: path.join(tmp, "public_plugin"),
      agentsDir: agentsDirPath(),
    } as any),
  );
  assert.equal(handles.length, 1, "the announcer agent started: " + JSON.stringify(lines));

  const printIdx = lines.findIndex((l) => l.includes("Web chat ready at :7717"));
  assert.notEqual(printIdx, -1, "the plugin's starting message reached the report");
  assert.match(lines[printIdx], /^\s+/, "the plugin line is indented under its agent");

  const startingIdx = lines.findIndex((l) => /starting/i.test(l) && l.includes("webby"));
  const startedIdx = lines.findIndex((l) => /started/i.test(l) && l.includes("webby"));
  assert.ok(
    startingIdx !== -1 && startingIdx < printIdx,
    "the agent's starting line precedes the plugin message",
  );
  assert.ok(printIdx < startedIdx, "the started verdict closes the agent's block");
});

test("run report: omitted report sink changes nothing (back-compat)", async () => {
  const handles = trackAll(await run([bareDef("quiet")], { library: stubLibrary() }));
  assert.equal(handles.length, 1);
  await assert.doesNotReject(() => handles[0].stop());
});

// ===========================================================================
// EXT — requestRestart: a GRACEFUL restart stops EVERY agent (teardown → flush
// best-effort state) BEFORE re-execing (spawn) and exiting. The re-exec/exit are
// INJECTED here so the test never actually spawns a child or exits the process.
// Resolved defensively: red on a missing export, never an import crash.
// ===========================================================================

const requestRestart: any = (bootModule as any).requestRestart;

/** A fake AgentHandle that records its stop() order and can simulate a teardown throw. */
function fakeHandle(id: string, order: string[], opts?: { throwOnStop?: boolean }): AgentHandle {
  return {
    id,
    start: async () => {},
    stop: async () => {
      order.push("stop:" + id);
      if (opts?.throwOnStop) throw new Error("teardown boom in " + id);
    },
  };
}

test("requestRestart: exported as a function from the boot node", () => {
  assert.equal(typeof requestRestart, "function", "requestRestart not implemented yet");
});

test("requestRestart: stops every handle BEFORE re-exec (spawn), spawn BEFORE exit, forwarding delayMs", async () => {
  assert.equal(typeof requestRestart, "function", "requestRestart not implemented yet");
  const order: string[] = [];
  const handles = [fakeHandle("a", order), fakeHandle("b", order)];
  let spawnedMs = -1;
  let exitCode = -1;
  await requestRestart(handles, 1234, {
    spawn: (ms: number) => { spawnedMs = ms; order.push("spawn"); },
    exit: (c: number) => { exitCode = c; order.push("exit"); },
  });
  assert.ok(order.indexOf("stop:a") < order.indexOf("spawn"), "agent a torn down before re-exec");
  assert.ok(order.indexOf("stop:b") < order.indexOf("spawn"), "agent b torn down before re-exec");
  assert.ok(order.indexOf("spawn") < order.indexOf("exit"), "replacement spawned before this process exits");
  assert.equal(spawnedMs, 1234, "delayMs is forwarded to the replacement");
  assert.equal(exitCode, 0, "exits with code 0");
});

test("requestRestart: a handle whose stop() rejects does NOT block the re-exec (allSettled)", async () => {
  assert.equal(typeof requestRestart, "function", "requestRestart not implemented yet");
  const order: string[] = [];
  const handles = [fakeHandle("ok", order), fakeHandle("bad", order, { throwOnStop: true })];
  let spawned = false;
  let exited = false;
  await assert.doesNotReject(() =>
    requestRestart(handles, 0, { spawn: () => { spawned = true; }, exit: () => { exited = true; } }),
  );
  assert.ok(spawned && exited, "still re-execs + exits even when a teardown throws");
});
