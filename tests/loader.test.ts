/**
 * Black-box edge tests for the `loader` contract (`createLoader`).
 *
 * Scope: ONLY the public surface of a Loader built by
 *   createLoader({ agentId, def, events, orchestrator, library,
 *                  publicPluginDir, agentDir, log? }) : Loader
 * with `load(): Promise<void>` / `teardown(): Promise<void>` (contracts/loader),
 * driven against:
 *   - a REAL event-system (createEventSystem) so plugin wiring is genuine,
 *   - a STUB Orchestrator whose block-store is a plain Map (so we can observe the
 *     PluginContext block-op delegation),
 *   - a SENTINEL CommunicatorLibrary (so we can prove the key-less `llm` library
 *     is injected by identity into every PluginContext),
 *   - real plugin modules written to a per-test OS temp dir and dynamically
 *     imported by the loader.
 *
 * Plugins are made OBSERVABLE: each writes an `index.ts` whose DEFAULT EXPORT
 * is a FACTORY (contracts/plugin PluginFactory — the loader calls it once per
 * Agent) and which exports a module-level `calls` array; every instance's setup
 * pushes its PluginContext there. ESM caches the MODULE by resolved file URL,
 * so the test re-imports the same file and inspects `mod.calls[0]` — the very
 * context object the loader passed. Every test gets a FRESH temp dir, so each
 * plugin file has a unique URL and there is no cross-test ESM cache bleed.
 *
 * Nothing here reads node/contract source or assumes implementation internals;
 * behavior is taken from contracts/loader, contracts/plugin and the loader
 * overviews (overviews/contracts/loader.md, overviews/nodes/loader.md).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createLoader } from "../packages/loader/src";
import { createEventSystem } from "../packages/event-system/src";
import { DependencyError, PluginLoadError } from "../shared/errors";
import type { Orchestrator } from "../contracts/orchestrator";
import type { CommunicatorLibrary } from "../contracts/llm";
import type { ContextBlock } from "../contracts/context";
import type { AgentDefinition } from "../contracts/agent";

// ---------------------------------------------------------------------------
// per-test sandbox (all ABSOLUTE paths) + teardown
// ---------------------------------------------------------------------------

let tmp: string;
/** public_plugin/ — shared/public plugin source location. */
let publicPluginDir: string;
/** agents/<id>/ — this Agent's home (its private plugins live in plugins/). */
let agentDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-loader-"));
  publicPluginDir = path.join(tmp, "public_plugin");
  agentDir = path.join(tmp, "agents", "ag1");
  fs.mkdirSync(publicPluginDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SENTINEL library — proves the exact (key-less) library object is injected.
// `list()` returns a recognizable marker so we can also deep-equal through ctx.
// ---------------------------------------------------------------------------

const library: CommunicatorLibrary = {
  get: () => undefined,
  has: () => false,
  list: () => ["SENTINEL"],
};

// ---------------------------------------------------------------------------
// STUB orchestrator — implements Orchestrator; block-store is a plain Map so we
// can verify the loader wires PluginContext's block ops THROUGH to it.
// ---------------------------------------------------------------------------

function stubOrchestrator(): Orchestrator & { blocks: Map<string, ContextBlock> } {
  const blocks = new Map<string, ContextBlock>();
  return {
    blocks,
    start() {},
    stop() {},
    setBlock(b: ContextBlock) {
      blocks.set(b.id, b);
    },
    getBlock(id: string) {
      return blocks.get(id);
    },
    removeBlock(id: string) {
      return blocks.delete(id);
    },
    listBlocks() {
      return [...blocks.values()].map((b) => ({ id: b.id, priority: b.priority }));
    },
  };
}

// ---------------------------------------------------------------------------
// plugin writers — emit real `index.ts` modules into <dir>/<id>/.
// ---------------------------------------------------------------------------

/**
 * Write a minimal, OBSERVABLE plugin. `body` is the module source whose default
 * export is a FACTORY returning at least { manifest, setup }. The module
 * also exports a `calls` array; the supplied body's setup is expected to push
 * the ctx into it (the default body below does so).
 */
function writePlugin(dir: string, id: string, body: string): string {
  const pdir = path.join(dir, id);
  fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, "index.ts");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/**
 * The canonical observable plugin source: records every setup ctx in `calls`,
 * and (optionally) records teardown invocations in `teardowns`. `version` and
 * `marker` distinguish two same-id copies (public vs private). `requires` is
 * baked into the manifest verbatim. `setupBody` lets a test add extra behavior
 * inside setup (e.g. ctx.setBlock(...)). `orderFile`/`orderTag`, when given,
 * make teardown append a tag to a shared on-disk JSON array (for cross-module
 * ordering assertions). `throwOnTeardown` makes teardown throw.
 *
 * The module also exports an `obs` object; `setupBody` may write observations
 * into it (e.g. obs.x = ctx.getBlock(...)) WITHOUT mutating the (possibly frozen)
 * ctx, so read-through assertions stay implementation-agnostic.
 */
function observablePlugin(opts: {
  id: string;
  version?: string;
  marker?: string;
  requires?: string[];
  setupBody?: string;
  orderFile?: string;
  orderTag?: string;
  throwOnTeardown?: boolean;
}): string {
  const {
    id,
    version = "1",
    marker = id,
    requires,
    setupBody = "",
    orderFile,
    orderTag = id,
    throwOnTeardown = false,
  } = opts;

  const requiresLiteral = requires ? `, requires: ${JSON.stringify(requires)}` : "";

  // teardown appends to a shared order file (if given), optionally then throws.
  const appendOrder = orderFile
    ? `
    const fs = await import("node:fs");
    const f = ${JSON.stringify(orderFile)};
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    arr.push(${JSON.stringify(orderTag)});
    fs.writeFileSync(f, JSON.stringify(arr), "utf8");`
    : "";
  const throwStmt = throwOnTeardown ? `\n    throw new Error("teardown of ${id} blew up");` : "";

  return `
export const calls = [];
export const teardowns = [];
export const obs = {};
export const MARKER = ${JSON.stringify(marker)};
export default () => ({
  manifest: { id: ${JSON.stringify(id)}, version: ${JSON.stringify(version)}${requiresLiteral} },
  async setup(ctx) {
    calls.push(ctx);
    ${setupBody}
  },
  async teardown() {
    teardowns.push(${JSON.stringify(orderTag)});${appendOrder}${throwStmt}
  },
});
`;
}

/**
 * Re-import the SAME module file the loader imported. ESM caches by URL, so this
 * returns the identical MODULE — its module-level `calls`/`teardowns` accumulate
 * across every per-agent instance the loader created from the factory.
 */
async function importPlugin(dir: string, id: string): Promise<any> {
  const file = path.join(dir, id, "index.ts");
  return import(pathToFileURL(file).href);
}

/**
 * Build a loader for a given AgentDefinition wired to this test's sandbox.
 * `io` lets a test CAPTURE the loader's Logger lines and `print` sink output
 * (both optional — defaults swallow logs and omit the print sink entirely).
 */
function makeLoader(
  def: AgentDefinition,
  orchestrator = stubOrchestrator(),
  io?: {
    log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
    print?: (text: string) => void;
  },
) {
  const sys = createEventSystem();
  const loader = createLoader({
    agentId: def.id,
    def,
    events: sys,
    orchestrator,
    library,
    publicPluginDir,
    agentDir,
    log: io?.log ?? { info: () => {}, warn: () => {}, error: () => {} },
    ...(io?.print ? { print: io.print } : {}),
  });
  return { loader, sys, orchestrator };
}

/** A representative AgentDefinition (override fields as needed). */
function def(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: "ag1", intervalMs: 1000, plugins: [], ...over };
}

// ===========================================================================
// Factory / shape
// ===========================================================================

test("createLoader returns an object exposing load() and teardown()", () => {
  const { loader } = makeLoader(def());
  assert.ok(loader, "factory should return a value");
  assert.equal(typeof loader, "object");
  assert.equal(typeof loader.load, "function");
  assert.equal(typeof loader.teardown, "function");
});

test("createLoader works without the optional `log` dep", async () => {
  const sys = createEventSystem();
  const loader = createLoader({
    agentId: "ag1",
    def: def(),
    events: sys,
    orchestrator: stubOrchestrator(),
    library,
    publicPluginDir,
    agentDir,
    // no log
  });
  await assert.doesNotReject(loader.load(), "empty load must resolve without a logger");
});

// ===========================================================================
// Behavior 1 — empty plugins/privatePlugins => load()/teardown() are no-ops
// ===========================================================================

test("empty def: load() resolves and nothing is loaded; teardown() also resolves", async () => {
  const { loader, orchestrator } = makeLoader(def({ plugins: [], privatePlugins: [] }));
  await assert.doesNotReject(loader.load(), "a bare agent's load() must resolve");
  assert.deepEqual(orchestrator.listBlocks(), [], "no plugin => no blocks registered");
  await assert.doesNotReject(loader.teardown(), "teardown with nothing loaded must resolve");
});

test("empty def: plugins/privatePlugins omitted entirely still resolves cleanly", async () => {
  // Only the required AgentDefinition fields; plugins:[] is required by the type
  // but privatePlugins is omitted.
  const { loader } = makeLoader(def({ plugins: [] }));
  await assert.doesNotReject(loader.load());
});

test("empty def: teardown() before load() does not reject", async () => {
  const { loader } = makeLoader(def({ plugins: [] }));
  await assert.doesNotReject(loader.teardown(), "teardown() with no prior load must be safe");
});

// ===========================================================================
// Behavior 2 — load a declared PUBLIC plugin; verify the built PluginContext
// ===========================================================================

test("public load: a declared public plugin's setup runs exactly once", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await loader.load();

  const mod = await importPlugin(publicPluginDir, "p1");
  assert.equal(mod.calls.length, 1, "setup must be called exactly once");
});

test("public load: PluginContext carries agentId === def.id and buses WIRED to the Agent's own bus (behavioral, not identity)", async () => {
  // The loader may hand each plugin a THIN TRACKED WRAPPER over the per-Agent
  // buses (so a failed setup's partial registrations can be undone — required by
  // skip-and-continue). So we assert the ctx buses TALK TO the Agent's bus in
  // BOTH directions, not that they are the same object reference.
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const { loader, sys } = makeLoader(def({ id: "ag1", plugins: ["p1"] }));
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  assert.ok(ctx, "a ctx must have been captured");
  assert.equal(ctx.agentId, "ag1", "ctx.agentId must equal def.id");

  // --- events: ctx.events.emit -> a listener on sys.events receives it ---
  let sawOnSys: unknown;
  const unsubSys = sys.events.on("probe.up", (p) => {
    sawOnSys = p;
  });
  ctx.events.emit("probe.up", { n: 1 });
  assert.deepEqual(sawOnSys, { n: 1 }, "ctx.events.emit must reach a listener on the Agent's eventbus");
  unsubSys();

  // --- events: sys.events.emit -> a listener registered via ctx.events receives it ---
  let sawOnCtx: unknown;
  const unsubCtx = ctx.events.on("probe.down", (p) => {
    sawOnCtx = p;
  });
  assert.equal(typeof unsubCtx, "function", "ctx.events.on must return an Unsub");
  sys.events.emit("probe.down", { n: 2 });
  assert.deepEqual(sawOnCtx, { n: 2 }, "a listener added via ctx.events must receive emits on the Agent's eventbus");
  unsubCtx();

  // --- actions: register via ctx.actions -> visible + invokable through sys.actions ---
  ctx.actions.register("probe.act.up", async (params) => ({ echo: params }));
  assert.equal(sys.actions.has("probe.act.up"), true, "an action registered via ctx must appear on the Agent's actionbus");
  assert.deepEqual(
    await sys.actions.invoke("probe.act.up", "PING"),
    { echo: "PING" },
    "invoking through the Agent's actionbus must reach the handler registered via ctx",
  );

  // --- actions: register via sys.actions -> visible + invokable through ctx.actions ---
  sys.actions.register("probe.act.down", async (params) => ({ got: params }));
  assert.equal(ctx.actions.has("probe.act.down"), true, "an action registered on the Agent's bus must be visible via ctx.actions");
  assert.deepEqual(
    await ctx.actions.invoke("probe.act.down", "PONG"),
    { got: "PONG" },
    "invoking through ctx.actions must reach the handler registered on the Agent's bus",
  );
});

test("public load: ctx.dataDir === <publicPluginDir>/p1/data (public => shared location)", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  assert.equal(
    ctx.dataDir,
    path.join(publicPluginDir, "p1", "data"),
    "a public plugin's dataDir must follow its public code location",
  );
});

test("public load: ctx.llm === the injected library (identity) and is key-less", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  // Identity: the very CommunicatorLibrary handed to createLoader is injected.
  assert.equal(ctx.llm, library, "ctx.llm must be the exact key-less library object");
  assert.deepEqual(ctx.llm.list(), ["SENTINEL"], "ctx.llm.list() proves it is OUR sentinel library");
  // The key-less surface exposes only get/has/list — no secrets/wire-format.
  assert.equal(typeof ctx.llm.get, "function");
  assert.equal(typeof ctx.llm.has, "function");
  assert.equal(typeof ctx.llm.list, "function");
});

test("public load: ctx.config is def.config[pluginId] when present", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const cfg = { city: "Oslo", units: "metric" };
  const { loader } = makeLoader(def({ plugins: ["p1"], config: { p1: cfg } }));
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  assert.deepEqual(ctx.config, cfg, "ctx.config must be the plugin's slice of def.config");
});

test("public load: ctx.config defaults to {} when def.config has no slice for the plugin", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  // def.config present but without a p1 key.
  const { loader } = makeLoader(def({ plugins: ["p1"], config: { other: { a: 1 } } }));
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  assert.deepEqual(ctx.config, {}, "missing config slice must default to an empty object");
});

test("public load: ctx.config defaults to {} when def.config is entirely absent", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const { loader } = makeLoader(def({ plugins: ["p1"] })); // no config at all
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  assert.deepEqual(ctx.config, {}, "absent def.config must still yield {} for the slice");
});

test("public load: ctx exposes the full PluginContext block-op + log surface", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  assert.equal(typeof ctx.setBlock, "function");
  assert.equal(typeof ctx.getBlock, "function");
  assert.equal(typeof ctx.removeBlock, "function");
  assert.equal(typeof ctx.listBlocks, "function");
  // contracts/plugin v1.1: log is a LEVELED logger, print is the plugin's
  // clean user-facing line (its "starting message" during setup).
  assert.equal(typeof ctx.log, "object", "ctx.log must be a leveled logger object");
  assert.equal(typeof ctx.log.info, "function");
  assert.equal(typeof ctx.log.warn, "function");
  assert.equal(typeof ctx.log.error, "function");
  assert.equal(typeof ctx.print, "function");
});

test("public load: two declared public plugins both load, each with its own ctx", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  writePlugin(publicPluginDir, "p2", observablePlugin({ id: "p2" }));
  const { loader } = makeLoader(def({ plugins: ["p1", "p2"] }));
  await loader.load();

  const m1 = await importPlugin(publicPluginDir, "p1");
  const m2 = await importPlugin(publicPluginDir, "p2");
  assert.equal(m1.calls.length, 1, "p1.setup ran once");
  assert.equal(m2.calls.length, 1, "p2.setup ran once");
  assert.equal(m1.calls[0].dataDir, path.join(publicPluginDir, "p1", "data"));
  assert.equal(m2.calls[0].dataDir, path.join(publicPluginDir, "p2", "data"));
});

// ===========================================================================
// Behavior 3 — PluginContext block ops delegate to the orchestrator's store
// ===========================================================================

test("block delegation: ctx.setBlock in setup lands in the orchestrator's store", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({
      id: "p1",
      setupBody: `ctx.setBlock({ id: "b", priority: 1, render: () => "x" });`,
    }),
  );
  const { loader, orchestrator } = makeLoader(def({ plugins: ["p1"] }));
  await loader.load();

  const got = orchestrator.getBlock("b");
  assert.ok(got, "the block set via ctx must be recorded in the orchestrator store");
  assert.equal(got!.id, "b");
  assert.equal(got!.priority, 1);
  assert.equal(got!.render(), "x", "render must be preserved through the delegation");
});

test("block delegation: ctx.getBlock/listBlocks read THROUGH the orchestrator store", async () => {
  // Pre-seed a block in the shared orchestrator, then have the plugin read it.
  const orchestrator = stubOrchestrator();
  orchestrator.setBlock({ id: "pre", priority: 7, render: () => "PRE" });
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({
      id: "p1",
      // Record what the plugin observed via ctx into the module-level `obs`
      // (never mutate ctx itself — it may be frozen).
      setupBody: `
        obs.sawPre = ctx.getBlock("pre");
        obs.list = ctx.listBlocks();`,
    }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }), orchestrator);
  await loader.load();

  const obs = (await importPlugin(publicPluginDir, "p1")).obs;
  assert.ok(obs.sawPre, "ctx.getBlock must return the orchestrator's pre-existing block");
  assert.equal(obs.sawPre.priority, 7);
  assert.deepEqual(obs.list, [{ id: "pre", priority: 7 }], "ctx.listBlocks reflects the store");
});

test("block delegation: ctx.removeBlock deletes from the orchestrator store", async () => {
  const orchestrator = stubOrchestrator();
  orchestrator.setBlock({ id: "gone", priority: 1, render: () => "G" });
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({
      id: "p1",
      setupBody: `obs.removed = ctx.removeBlock("gone");`,
    }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }), orchestrator);
  await loader.load();

  const obs = (await importPlugin(publicPluginDir, "p1")).obs;
  assert.equal(obs.removed, true, "removeBlock should report it removed an existing block");
  assert.equal(orchestrator.getBlock("gone"), undefined, "the block must be gone from the store");
});

// ===========================================================================
// Behavior 4 — private folder OVERRIDES same-id public
// ===========================================================================

test("override: a private same-id plugin is loaded INSTEAD of the public one", async () => {
  // Same id "p1" in both public and the agent's private plugins folder, with
  // distinct markers/versions so we can tell which one ran.
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1", version: "PUB", marker: "PUBLIC" }));
  const privDir = path.join(agentDir, "plugins");
  writePlugin(privDir, "p1", observablePlugin({ id: "p1", version: "PRIV", marker: "PRIVATE" }));

  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await loader.load();

  const pub = await importPlugin(publicPluginDir, "p1");
  const priv = await importPlugin(privDir, "p1");

  assert.equal(priv.calls.length, 1, "the PRIVATE copy must be the one that ran");
  assert.equal(pub.calls.length, 0, "the PUBLIC copy must NOT run when a private overrides it");
  assert.equal(priv.MARKER, "PRIVATE", "sanity: we imported the private module");
});

test("override: the overriding private plugin's dataDir follows the PRIVATE location", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1", marker: "PUBLIC" }));
  const privDir = path.join(agentDir, "plugins");
  writePlugin(privDir, "p1", observablePlugin({ id: "p1", marker: "PRIVATE" }));

  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await loader.load();

  const ctx = (await importPlugin(privDir, "p1")).calls[0];
  assert.equal(
    ctx.dataDir,
    path.join(privDir, "p1", "data"),
    "an overriding private plugin's dataDir must be agent-isolated (under agents/<id>/plugins/)",
  );
});

// ===========================================================================
// Behavior 5 — privatePlugins: NO code copy. The code stays in public_plugin/
// (relative imports keep resolving; the factory already gives each Agent its
// own instance); "independent" means an agent-private dataDir under
// agents/<id>/plugins/<pid>/data.
// ===========================================================================

test("privatePlugins: code is NOT copied — loaded from public_plugin/ with an agent-private dataDir", async () => {
  writePlugin(publicPluginDir, "p2", observablePlugin({ id: "p2", marker: "SRC" }));
  const dest = path.join(agentDir, "plugins", "p2");

  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["p2"] }));
  await loader.load();

  assert.equal(
    fs.existsSync(path.join(dest, "index.ts")),
    false,
    "load() must NOT copy the plugin code into the agent",
  );

  // Loaded from the PUBLIC location...
  const mod = await importPlugin(publicPluginDir, "p2");
  assert.equal(mod.calls.length, 1, "the declared independent must be loaded (setup ran)");
  // ...but with the agent-private dataDir.
  assert.equal(
    mod.calls[0].dataDir,
    path.join(agentDir, "plugins", "p2", "data"),
    "an independent's dataDir is agent-isolated under agents/<id>/plugins/<pid>/data",
  );
});

test("privatePlugins: a REAL repo plugin (with relative imports) loads as a declared independent", async () => {
  // Regression for the copy-era failure: copied code's `../../contracts/...`
  // imports resolved against the agent folder and crashed every start. With no
  // copy, the real persona plugin must load from the repo's public_plugin/.
  const repoPublic = path.resolve("public_plugin");
  const orchestrator = stubOrchestrator();
  const sys = createEventSystem();
  const loader = createLoader({
    agentId: "ag1",
    def: { id: "ag1", intervalMs: 1000, plugins: [], privatePlugins: ["persona"] },
    events: sys,
    orchestrator,
    library,
    publicPluginDir: repoPublic,
    agentDir,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  await assert.doesNotReject(loader.load(), "the real persona plugin must load when declared private");
  assert.ok(orchestrator.blocks.has("persona"), "persona registered its block via the real code");
  await loader.teardown();
});

test("privatePlugins: custom code already in agents/<id>/plugins/ still overrides (its data stays beside the code)", async () => {
  // Public source has marker SRC; the agent carries CUSTOM code for the same id.
  writePlugin(publicPluginDir, "p2", observablePlugin({ id: "p2", marker: "SRC" }));
  const privDir = path.join(agentDir, "plugins");
  writePlugin(privDir, "p2", observablePlugin({ id: "p2", marker: "CUSTOM" }));
  const sentinel = path.join(privDir, "p2", "SENTINEL.txt");
  fs.writeFileSync(sentinel, "keep-me", "utf8");

  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["p2"] }));
  await loader.load();

  assert.equal(fs.existsSync(sentinel), true, "the custom private code must be left intact");
  const priv = await importPlugin(privDir, "p2");
  assert.equal(priv.MARKER, "CUSTOM", "the custom private-folder code is the one loaded");
  assert.equal(priv.calls.length, 1, "the custom private code is loaded");
  assert.equal(
    priv.calls[0].dataDir,
    path.join(privDir, "p2", "data"),
    "custom private code keeps its data beside the code",
  );
});

test("privatePlugins: a pre-existing agent-private data/ folder does NOT shadow the public code (re-load is stable)", async () => {
  // Regression: an independent's dataDir is agents/<id>/plugins/<pid>/data, so
  // after one load the folder agents/<id>/plugins/<pid>/ exists holding only
  // data/ — it must NOT be mistaken for custom code on the next load.
  writePlugin(publicPluginDir, "p2", observablePlugin({ id: "p2", marker: "PUBLIC" }));
  const dataOnly = path.join(agentDir, "plugins", "p2", "data");
  fs.mkdirSync(dataOnly, { recursive: true });
  fs.writeFileSync(path.join(dataOnly, "state.txt"), "kept", "utf8");

  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["p2"] }));
  await assert.doesNotReject(
    loader.load(),
    "a data-only private folder must not be treated as a (codeless) plugin",
  );

  const mod = await importPlugin(publicPluginDir, "p2");
  assert.equal(mod.MARKER, "PUBLIC", "the public code is loaded (the data folder is not code)");
  assert.equal(fs.existsSync(path.join(dataOnly, "state.txt")), true, "pre-existing data survives");
});

test("privatePlugins: missing public source => load() rejects with PluginLoadError", async () => {
  // Declare an independent whose public source does NOT exist.
  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["ghost"] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

test("privatePlugins: missing source leaves nothing behind in the agent folder", async () => {
  const dest = path.join(agentDir, "plugins", "ghost");
  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["ghost"] }));
  await assert.rejects(loader.load(), PluginLoadError);
  assert.equal(fs.existsSync(dest), false, "a failed load must not create a destination dir");
});

// ===========================================================================
// Behavior 6 — manifest.requires verification
// ===========================================================================

test("requires: an unmet requirement => the plugin is SKIPPED with a warning naming it; load() resolves", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", requires: ["nope.missing"] }),
  );
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["p1"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "an unmet requirement must skip the plugin, not reject load()");

  const mod = await importPlugin(publicPluginDir, "p1");
  assert.equal(mod.calls.length, 0, "the plugin with an unmet requirement must be skipped (never set up)");
  assert.ok(
    warns.some((m) => m.includes("p1") && m.includes("nope.missing")),
    "the skip must warn, naming the plugin and its missing requirement",
  );
});

test("requires: a dotted action name present on the actionbus => loads OK", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", requires: ["svc.ready"] }),
  );
  const { loader, sys } = makeLoader(def({ plugins: ["p1"] }));
  // Register the required action on the bus BEFORE load so `has` is true.
  sys.actions.register("svc.ready", async () => "ok");

  await assert.doesNotReject(loader.load(), "a satisfied action requirement must load");
  const mod = await importPlugin(publicPluginDir, "p1");
  assert.equal(mod.calls.length, 1, "the plugin must have been set up");
});

test("requires: a dotted action name absent from the bus => the plugin is SKIPPED with a warning; load() resolves", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", requires: ["svc.absent"] }),
  );
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["p1"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  // Nothing registered on the bus, so the dotted-action requirement can never be met.
  await assert.doesNotReject(loader.load(), "an absent dotted-action requirement must skip, not reject");

  const mod = await importPlugin(publicPluginDir, "p1");
  assert.equal(mod.calls.length, 0, "the plugin whose action requirement is unmet must be skipped");
  assert.ok(
    warns.some((m) => m.includes("p1") && m.includes("svc.absent")),
    "the skip must warn, naming the plugin and the missing dotted action",
  );
});

test("requires: an already-loaded plugin id (earlier in def.plugins) is satisfied", async () => {
  writePlugin(publicPluginDir, "dep", observablePlugin({ id: "dep" }));
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1", requires: ["dep"] }));
  // dep is listed FIRST so it is loaded before p1's requirement check.
  const { loader } = makeLoader(def({ plugins: ["dep", "p1"] }));

  await assert.doesNotReject(loader.load(), "a plugin-id requirement met by an earlier load must pass");
  const p1 = await importPlugin(publicPluginDir, "p1");
  assert.equal(p1.calls.length, 1, "p1 must be set up once its dep is present");
});

test("requires: a plugin-id requirement NOT among loaded plugins => the plugin is SKIPPED with a warning; load() resolves", async () => {
  // p1 requires "dep" but "dep" is never declared/loaded — a never-declared
  // provider, which the contract handles by skipping the dependent (not rejecting).
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1", requires: ["dep"] }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["p1"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "a never-declared plugin-id requirement must skip, not reject");

  const mod = await importPlugin(publicPluginDir, "p1");
  assert.equal(mod.calls.length, 0, "the dependent of a never-declared provider must be skipped");
  assert.ok(
    warns.some((m) => m.includes("p1") && m.includes("dep")),
    "the skip must warn, naming the plugin and the never-declared requirement",
  );
});

test("requires: an empty requires array imposes no constraint (loads OK)", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1", requires: [] }));
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await assert.doesNotReject(loader.load(), "requires:[] must never block loading");
});

// ===========================================================================
// Behavior 7 — invalid / unloadable modules are SKIPPED (skip-and-continue).
//   importPlugin covers module resolution, evaluation, shape validation and
//   factory construction; ANY of those throwing means SKIP that plugin, warn
//   (naming its id), leave siblings unaffected, and RESOLVE load(). A healthy
//   sibling "ok" is loaded alongside each bad fixture to prove the skip does not
//   abort the rest. (Pass-0 id validation stays FATAL — see EXT-2 below.)
// ===========================================================================

test("invalid module: no default export => the plugin is SKIPPED with a warning; the sibling loads; load() resolves", async () => {
  // A module that exports `calls` but NO default Plugin.
  writePlugin(publicPluginDir, "bad", `export const calls = [];`);
  writePlugin(publicPluginDir, "ok", observablePlugin({ id: "ok" }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["bad", "ok"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "a shapeless module must be skipped, not reject load()");

  const ok = await importPlugin(publicPluginDir, "ok");
  assert.equal(ok.calls.length, 1, "the healthy sibling still sets up");
  assert.ok(warns.some((m) => m.includes("bad")), "the skipped plugin must be named in a warning");
});

test("invalid module: default missing `manifest` => the plugin is SKIPPED with a warning; the sibling loads; load() resolves", async () => {
  // A module whose default export lacks `calls`, so setup is unobservable there;
  // the sibling's setup running is the proof the skip continued.
  writePlugin(
    publicPluginDir,
    "bad",
    `export default () => ({ async setup(_ctx) {} });`,
  );
  writePlugin(publicPluginDir, "ok", observablePlugin({ id: "ok" }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["bad", "ok"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "a manifest-less plugin must be skipped, not reject load()");

  const ok = await importPlugin(publicPluginDir, "ok");
  assert.equal(ok.calls.length, 1, "the healthy sibling still sets up");
  assert.ok(warns.some((m) => m.includes("bad")), "the skipped plugin must be named in a warning");
});

test("invalid module: default missing `setup` => the plugin is SKIPPED with a warning; the sibling loads; load() resolves", async () => {
  writePlugin(
    publicPluginDir,
    "bad",
    `export default () => ({ manifest: { id: "bad", version: "1" } });`,
  );
  writePlugin(publicPluginDir, "ok", observablePlugin({ id: "ok" }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["bad", "ok"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "a setup-less plugin must be skipped, not reject load()");

  const ok = await importPlugin(publicPluginDir, "ok");
  assert.equal(ok.calls.length, 1, "the healthy sibling still sets up");
  assert.ok(warns.some((m) => m.includes("bad")), "the skipped plugin must be named in a warning");
});

test("invalid module: declared public plugin directory does not exist => the plugin is SKIPPED with a warning; the sibling loads; load() resolves", async () => {
  // "missing" is declared but no public_plugin/missing/ exists at all.
  writePlugin(publicPluginDir, "ok", observablePlugin({ id: "ok" }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["missing", "ok"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "an unresolvable plugin dir must be skipped, not reject load()");

  const ok = await importPlugin(publicPluginDir, "ok");
  assert.equal(ok.calls.length, 1, "the healthy sibling still sets up");
  assert.ok(warns.some((m) => m.includes("missing")), "the skipped plugin must be named in a warning");
});

test("invalid module: a module whose evaluation throws => the plugin is SKIPPED with a warning (underlying error included); the sibling loads; load() resolves", async () => {
  writePlugin(
    publicPluginDir,
    "boom",
    `throw new Error("module side-effect explosion");\nexport default {};`,
  );
  writePlugin(publicPluginDir, "ok", observablePlugin({ id: "ok" }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["boom", "ok"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "a module whose evaluation throws must be skipped, not reject load()");

  const ok = await importPlugin(publicPluginDir, "ok");
  assert.equal(ok.calls.length, 1, "the healthy sibling still sets up");
  const warnLine = warns.find((m) => m.includes("boom"));
  assert.ok(warnLine, "the skipped plugin must be named in a warning");
  assert.ok(
    warnLine!.toLowerCase().includes("explosion"),
    "the underlying evaluation error should be included in the warning line",
  );
});

// ===========================================================================
// Behavior 8 — teardown() runs each teardown? in REVERSE load order, isolated
// ===========================================================================

test("teardown: plugins are torn down in REVERSE load order", async () => {
  const orderFile = path.join(tmp, "teardown-order.json");
  writePlugin(
    publicPluginDir,
    "first",
    observablePlugin({ id: "first", orderFile, orderTag: "first" }),
  );
  writePlugin(
    publicPluginDir,
    "second",
    observablePlugin({ id: "second", orderFile, orderTag: "second" }),
  );

  // Load order: first, then second.
  const { loader } = makeLoader(def({ plugins: ["first", "second"] }));
  await loader.load();
  await loader.teardown();

  const order = JSON.parse(fs.readFileSync(orderFile, "utf8"));
  assert.deepEqual(
    order,
    ["second", "first"],
    "teardown must run in REVERSE of load order (last loaded torn down first)",
  );
});

test("teardown: one plugin's throwing teardown does NOT prevent the other's teardown", async () => {
  const orderFile = path.join(tmp, "teardown-order.json");
  // First-loaded throws on teardown; second-loaded must still tear down.
  writePlugin(
    publicPluginDir,
    "first",
    observablePlugin({ id: "first", orderFile, orderTag: "first", throwOnTeardown: true }),
  );
  writePlugin(
    publicPluginDir,
    "second",
    observablePlugin({ id: "second", orderFile, orderTag: "second" }),
  );

  const { loader } = makeLoader(def({ plugins: ["first", "second"] }));
  await loader.load();

  // teardown() itself must not reject even though one plugin throws.
  await assert.doesNotReject(loader.teardown(), "a single failing teardown must not reject teardown()");

  const order = JSON.parse(fs.readFileSync(orderFile, "utf8"));
  // "second" tears down first (reverse order) and writes its tag; "first" throws
  // AFTER appending its tag — both must appear, proving isolation didn't skip one.
  assert.ok(order.includes("second"), "the non-throwing plugin must still tear down");
  assert.ok(order.includes("first"), "the throwing plugin's teardown was still invoked");
  assert.deepEqual(order, ["second", "first"], "reverse order is preserved despite the throw");
});

test("teardown: a plugin WITHOUT a teardown? is skipped without error", async () => {
  // Plugin with no teardown method at all.
  writePlugin(
    publicPluginDir,
    "noteardown",
    `
export const calls = [];
export default () => ({
  manifest: { id: "noteardown", version: "1" },
  async setup(ctx) { calls.push(ctx); },
});
`,
  );
  const { loader } = makeLoader(def({ plugins: ["noteardown"] }));
  await loader.load();
  await assert.doesNotReject(loader.teardown(), "missing teardown? must be safely skipped");
});

test("teardown: each loaded plugin's teardown is invoked exactly once", async () => {
  writePlugin(publicPluginDir, "a", observablePlugin({ id: "a" }));
  writePlugin(publicPluginDir, "b", observablePlugin({ id: "b" }));
  const { loader } = makeLoader(def({ plugins: ["a", "b"] }));
  await loader.load();
  await loader.teardown();

  const ma = await importPlugin(publicPluginDir, "a");
  const mb = await importPlugin(publicPluginDir, "b");
  assert.deepEqual(ma.teardowns, ["a"], "a.teardown invoked once");
  assert.deepEqual(mb.teardowns, ["b"], "b.teardown invoked once");
});

// ===========================================================================
// Cross-cutting — isolation between separate loaders/orchestrators
// ===========================================================================

test("isolation: a plugin's blocks land only in ITS loader's orchestrator", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({
      id: "p1",
      setupBody: `ctx.setBlock({ id: "owned", priority: 3, render: () => "O" });`,
    }),
  );

  const orcA = stubOrchestrator();
  const orcB = stubOrchestrator();
  const { loader } = makeLoader(def({ plugins: ["p1"] }), orcA);
  await loader.load();

  assert.ok(orcA.getBlock("owned"), "the loading orchestrator must hold the block");
  assert.equal(orcB.getBlock("owned"), undefined, "an unrelated orchestrator must not see it");
});

// ###########################################################################
// EXTENSION — newly-specified loader behaviors (contracts/loader updated).
// All plugin sources below are self-contained & observable (export module-level
// arrays/flags) so assertions read the SAME module the loader imported.
// ###########################################################################

// ---------------------------------------------------------------------------
// extra plugin writers (kept local so existing helpers stay untouched)
// ---------------------------------------------------------------------------

/**
 * A "good" plugin that, on setup, registers a uniquely-named action on the
 * actionbus and records setupCalled; on teardown it UNREGISTERS that action and
 * records teardownCalled. The action name is the plugin id so two loaders that
 * both load this plugin would collide on the bus UNLESS the first run's teardown
 * (rollback) unregistered it. Module-level `state` is observable across re-import.
 */
function goodRegistrarPlugin(id: string, action: string): string {
  return `
export const state = { setupCalled: false, teardownCalled: false };
export const calls = [];
export default () => {
  let unsub; // per-instance closure: each agent's instance owns its own Unsub
  return {
    manifest: { id: ${JSON.stringify(id)}, version: "1" },
    async setup(ctx) {
      calls.push(ctx);
      unsub = ctx.actions.register(${JSON.stringify(action)}, async () => "ok");
      state.setupCalled = true;
    },
    async teardown() {
      if (typeof unsub === "function") unsub();
      state.teardownCalled = true;
    },
  };
};
`;
}

/** A plugin that throws during module evaluation (import fails). */
function explodingModule(id: string): string {
  return `throw new Error("import of ${id} exploded");\nexport default {};`;
}

/**
 * A plugin whose manifest carries `provides` (a capability another plugin's
 * `requires` may name). Observable via module-level `calls`.
 */
function providerPlugin(opts: { id: string; provides?: string[]; requires?: string[] }): string {
  const { id, provides, requires } = opts;
  const provLit = provides ? `, provides: ${JSON.stringify(provides)}` : "";
  const reqLit = requires ? `, requires: ${JSON.stringify(requires)}` : "";
  return `
export const calls = [];
export default () => ({
  manifest: { id: ${JSON.stringify(id)}, version: "1"${provLit}${reqLit} },
  async setup(ctx) { calls.push(ctx); },
});
`;
}

// ===========================================================================
// EXT-1 — Skip-and-continue (Finding C): one broken plugin never takes the
//          Agent down. A failing plugin is SKIPPED with a warning; siblings that
//          already set up STAY up (no rollback); load() RESOLVES. Warnings are
//          observable via the loader's `log.warn` sink AND the bus `log.entry`
//          mirror (loader self-diagnostics carry pluginId "core:loader").
// ===========================================================================

test("skip-and-continue: a later plugin's import failure is SKIPPED with a warning; the earlier good plugin still sets up; load() resolves", async () => {
  writePlugin(publicPluginDir, "aa-good", goodRegistrarPlugin("aa-good", "aa-good.act"));
  writePlugin(publicPluginDir, "zz-bad", explodingModule("zz-bad"));

  // Under skip-and-continue the failing zz-bad is dropped, but aa-good — declared
  // and processed regardless of order — is set up normally. load() must resolve.
  const warns: string[] = [];
  const { loader, sys } = makeLoader(def({ plugins: ["aa-good", "zz-bad"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "a broken sibling must NOT reject the whole load()");

  const good = await importPlugin(publicPluginDir, "aa-good");
  assert.equal(
    good.state.setupCalled,
    true,
    "skip-and-continue: the healthy plugin must be set up despite a broken sibling",
  );
  assert.equal(
    sys.actions.has("aa-good.act"),
    true,
    "the healthy plugin's setup effects (its action registration) must remain in place",
  );
  // The broken plugin was warned about, naming it (and, per the contract, the
  // underlying error is included in the log line).
  assert.ok(
    warns.some((m) => m.includes("zz-bad")),
    "the skipped plugin must be named in a warning",
  );
  assert.ok(
    warns.some((m) => m.includes("zz-bad") && m.toLowerCase().includes("explod")),
    "the underlying import error must be included in the warning line",
  );
});

test("skip-and-continue: an unmet-requires plugin is skipped; the earlier good plugin's setup is NOT torn down; load() resolves", async () => {
  writePlugin(publicPluginDir, "aa-good", goodRegistrarPlugin("aa-good", "aa-good.r2"));
  // zz-needy requires a plugin/capability nobody provides -> it is unsatisfiable.
  writePlugin(publicPluginDir, "zz-needy", providerPlugin({ id: "zz-needy", requires: ["nobody"] }));

  const warns: string[] = [];
  const { loader, sys } = makeLoader(def({ plugins: ["aa-good", "zz-needy"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "an unmet-requires plugin must NOT reject the load");

  const good = await importPlugin(publicPluginDir, "aa-good");
  assert.equal(good.state.setupCalled, true, "the good plugin set up");
  assert.equal(
    good.state.teardownCalled,
    false,
    "NO rollback: the good plugin's teardown must NOT run just because a sibling was skipped",
  );
  assert.equal(
    sys.actions.has("aa-good.r2"),
    true,
    "the good plugin's registration must stay up (it was never torn down)",
  );
  assert.ok(
    warns.some((m) => m.includes("zz-needy") && m.includes("nobody")),
    "the skipped dependent must be warned about, naming the missing requirement",
  );
});

test("skip-and-continue: the skipped plugin's actions are never registered while the good plugin's remain (proven on ONE shared bus)", async () => {
  // Reframed from the old rollback proof: there is no rollback anymore. Instead
  // we prove selectivity — only the FAILING plugin's effects are absent; the
  // healthy plugin's effects are present — using a plugin whose setup registers
  // an action and then throws (so its setup runs partway, then fails).
  writePlugin(publicPluginDir, "aa-good", goodRegistrarPlugin("aa-good", "aa-good.keep"));
  writePlugin(
    publicPluginDir,
    "zz-selfdestruct",
    `
export const calls = [];
export default () => ({
  manifest: { id: "zz-selfdestruct", version: "1" },
  async setup(ctx) {
    calls.push(ctx);
    ctx.actions.register("zz-selfdestruct.leak", async () => "leak");
    throw new Error("setup of zz-selfdestruct blew up after registering");
  },
});
`,
  );

  const warns: string[] = [];
  const { loader, sys } = makeLoader(
    def({ plugins: ["aa-good", "zz-selfdestruct"] }),
    stubOrchestrator(),
    { log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} } },
  );
  await assert.doesNotReject(loader.load(), "a plugin whose setup throws must be skipped, not fatal");

  // The healthy plugin's action is registered and stays...
  assert.equal(sys.actions.has("aa-good.keep"), true, "the good plugin's action remains registered");
  // ...and the good plugin was NOT torn down (no rollback on a sibling's failure).
  const good = await importPlugin(publicPluginDir, "aa-good");
  assert.equal(good.state.teardownCalled, false, "the good plugin must not be torn down");
  assert.ok(
    warns.some((m) => m.includes("zz-selfdestruct")),
    "the plugin whose setup threw must be named in a warning",
  );
});

// ===========================================================================
// EXT-2 — Plugin id validation happens BEFORE any filesystem copy or import
// ===========================================================================

test("id validation: a public plugin id containing '..' rejects with PluginLoadError before any import", async () => {
  // Provide a real, importable plugin so failure can ONLY come from id validation.
  const { loader } = makeLoader(def({ plugins: ["../evil"] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

test("id validation: a public plugin id of exactly '..' rejects with PluginLoadError", async () => {
  const { loader } = makeLoader(def({ plugins: [".."] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

test("id validation: a privatePlugins id containing '..' rejects BEFORE any filesystem copy (no traversal artifacts)", async () => {
  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["../evil"] }));
  await assert.rejects(loader.load(), PluginLoadError);

  // No agents/<id>/plugins/ tree may have been created from the bad id, and no
  // path-traversal artifact may exist above the agent's plugins dir.
  const escaped = path.join(agentDir, "plugins", "..", "evil");
  assert.equal(fs.existsSync(escaped), false, "id validation must precede any copy (no traversal artifact)");
});

test("id validation: a privatePlugins id of exactly '..' rejects with PluginLoadError", async () => {
  const { loader } = makeLoader(def({ plugins: [], privatePlugins: [".."] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

// ===========================================================================
// EXT-3 — requires resolve against the WHOLE load set (order-independent)
// ===========================================================================

test("requires (load-set): private 'aaa' requires 'zzz' — even though 'aaa' sorts first, load() SUCCEEDS", async () => {
  const privDir = path.join(agentDir, "plugins");
  // "aaa" requires plugin id "zzz" (no dot => plugin-id/capability requirement).
  writePlugin(privDir, "aaa", providerPlugin({ id: "aaa", requires: ["zzz"] }));
  writePlugin(privDir, "zzz", providerPlugin({ id: "zzz" }));

  // privatePlugins are auto-loaded from the private folder, sorted by name:
  // "aaa" before "zzz" — yet the requirement is checked against the FULL set.
  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["aaa", "zzz"] }));
  await assert.doesNotReject(
    loader.load(),
    "a plugin-id requirement satisfied LATER in the load order must still pass",
  );

  const aaa = await importPlugin(privDir, "aaa");
  const zzz = await importPlugin(privDir, "zzz");
  assert.equal(aaa.calls.length, 1, "aaa was set up");
  assert.equal(zzz.calls.length, 1, "zzz was set up");
});

test("requires (load-set): 'alpha' requires capability 'storage' provided by sibling 'zeta' => SUCCEEDS", async () => {
  writePlugin(publicPluginDir, "alpha", providerPlugin({ id: "alpha", requires: ["storage"] }));
  writePlugin(publicPluginDir, "zeta", providerPlugin({ id: "zeta", provides: ["storage"] }));

  // alpha listed FIRST; its capability requirement is met by zeta's provides
  // regardless of order.
  const { loader } = makeLoader(def({ plugins: ["alpha", "zeta"] }));
  await assert.doesNotReject(loader.load(), "a `provides` capability anywhere in the load set satisfies `requires`");

  const alpha = await importPlugin(publicPluginDir, "alpha");
  assert.equal(alpha.calls.length, 1, "alpha was set up once its capability requirement was met");
});

test("requires (load-set): a non-dotted requirement matched by NOBODY's id/provides => alpha is SKIPPED, zeta still loads, load() resolves", async () => {
  writePlugin(publicPluginDir, "alpha", providerPlugin({ id: "alpha", requires: ["storage"] }));
  // A sibling that provides something ELSE — does NOT satisfy "storage".
  writePlugin(publicPluginDir, "zeta", providerPlugin({ id: "zeta", provides: ["cache"] }));

  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["alpha", "zeta"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(loader.load(), "an unsatisfiable capability requirement must skip that plugin, not reject");

  const alpha = await importPlugin(publicPluginDir, "alpha");
  const zeta = await importPlugin(publicPluginDir, "zeta");
  assert.equal(alpha.calls.length, 0, "alpha's capability requirement is unmet => alpha is skipped");
  assert.equal(zeta.calls.length, 1, "the unrelated sibling zeta still loads (skip did not abort the rest)");
  assert.ok(
    warns.some((m) => m.includes("alpha") && m.includes("storage")),
    "the skip must warn, naming alpha and the missing capability",
  );
});

// ===========================================================================
// EXT-4 — Action-name requires (dotted) are still checked at SETUP time against
//          the actionbus, hence order-dependent: provider must set up first.
// ===========================================================================

test("requires (action, ordered): provider sorts first and registers the action => dependent loads OK", async () => {
  // "a-provider" registers action "svc.ready" in its setup; "b-consumer"
  // requires that dotted action. "a-" sorts before "b-", so the action exists
  // on the bus by the time the consumer's setup-time check runs.
  writePlugin(
    publicPluginDir,
    "a-provider",
    `
export const calls = [];
export default () => ({
  manifest: { id: "a-provider", version: "1" },
  async setup(ctx) { calls.push(ctx); ctx.actions.register("svc.ready", async () => "ok"); },
});
`,
  );
  writePlugin(publicPluginDir, "b-consumer", providerPlugin({ id: "b-consumer", requires: ["svc.ready"] }));

  const { loader } = makeLoader(def({ plugins: ["a-provider", "b-consumer"] }));
  await assert.doesNotReject(
    loader.load(),
    "a dotted action requirement met by an EARLIER plugin's setup must pass",
  );

  const consumer = await importPlugin(publicPluginDir, "b-consumer");
  assert.equal(consumer.calls.length, 1, "the consumer was set up after the action became available");
});

// ===========================================================================
// EXT-4b — Setup order is DEPENDENCY-DRIVEN, not strict array order. A plugin
//           whose dotted action `requires` are not yet registered is DEFERRED
//           until a later-declared plugin provides them; only a genuinely
//           unsatisfiable set (cycle / missing provider) fails. This is the fix
//           for the onboarding wizard emitting plugins in alphabetical order
//           (e.g. history before memory-note, krakeycode before llm-core).
// ===========================================================================

test("requires (action, out of order): a consumer declared BEFORE its action provider is deferred and loads OK", async () => {
  // "early-consumer" is listed FIRST but needs an action only "late-provider"
  // registers in setup. The loader must defer the consumer until the provider
  // has set up — the exact shape of the wizard's alphabetical config. Strict
  // array-order setup (the old behavior) would have failed here.
  writePlugin(
    publicPluginDir,
    "late-provider",
    `
export const calls = [];
export default () => ({
  manifest: { id: "late-provider", version: "1" },
  async setup(ctx) { calls.push(ctx); ctx.actions.register("svc.ready", async () => "ok"); },
});
`,
  );
  writePlugin(
    publicPluginDir,
    "early-consumer",
    observablePlugin({ id: "early-consumer", requires: ["svc.ready"] }),
  );

  const { loader } = makeLoader(def({ plugins: ["early-consumer", "late-provider"] }));
  await assert.doesNotReject(
    loader.load(),
    "a dotted action requirement met by a LATER-declared plugin must still load (deferred setup)",
  );

  const consumer = await importPlugin(publicPluginDir, "early-consumer");
  assert.equal(consumer.calls.length, 1, "the deferred consumer was set up once, after its provider");
});

test("requires (action cycle): two plugins each needing the other's action => BOTH are SKIPPED (each warned); a third unrelated plugin still loads; load() resolves", async () => {
  // x needs y.act, y needs x.act — neither can ever become ready. Under
  // skip-and-continue the cycle does NOT fail the load: each stuck plugin is
  // skipped one at a time with a warning naming the missing requirement, and an
  // unrelated third plugin still loads. load() resolves (bare-agent invariant).
  writePlugin(
    publicPluginDir,
    "x",
    observablePlugin({ id: "x", requires: ["y.act"], setupBody: `ctx.actions.register("x.act", async () => 1);` }),
  );
  writePlugin(
    publicPluginDir,
    "y",
    observablePlugin({ id: "y", requires: ["x.act"], setupBody: `ctx.actions.register("y.act", async () => 1);` }),
  );
  writePlugin(publicPluginDir, "z-free", observablePlugin({ id: "z-free" }));

  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["x", "y", "z-free"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(
    loader.load(),
    "an unbreakable action-dependency cycle must skip the cycle members, not reject the whole load",
  );

  const x = await importPlugin(publicPluginDir, "x");
  const y = await importPlugin(publicPluginDir, "y");
  const z = await importPlugin(publicPluginDir, "z-free");
  assert.equal(x.calls.length, 0, "cycle member x is skipped (its requirement can never be met)");
  assert.equal(y.calls.length, 0, "cycle member y is skipped (its requirement can never be met)");
  assert.equal(z.calls.length, 1, "an unrelated third plugin still loads — the cascade did not abort the rest");
  // Each cycle member is individually warned, naming its missing requirement.
  assert.ok(
    warns.some((m) => m.includes("x") && m.includes("y.act")),
    "x's skip must warn, naming its missing requirement y.act",
  );
  assert.ok(
    warns.some((m) => m.includes("y") && m.includes("x.act")),
    "y's skip must warn, naming its missing requirement x.act",
  );
});

test("setup order: independent plugins (no requirements) keep their declared array order", async () => {
  // Nothing forces a reorder, so the listed order is preserved. Each plugin
  // prints its id in setup; the captured print order is the setup order.
  for (const id of ["zeta", "alpha", "mid"]) {
    writePlugin(publicPluginDir, id, observablePlugin({ id, setupBody: `ctx.print(${JSON.stringify(id)});` }));
  }
  const prints: string[] = [];
  const { loader } = makeLoader(
    def({ plugins: ["zeta", "alpha", "mid"] }),
    stubOrchestrator(),
    { print: (t) => prints.push(t) },
  );
  await loader.load();
  assert.deepEqual(prints, ["zeta", "alpha", "mid"], "independents keep their declared order when no dep forces a reorder");
});

// ===========================================================================
// EXT-5 — Independent copy is CODE-ONLY: the source's accumulated data/ is NOT
//          visible to a declared independent (agent-private dataDir).
// ===========================================================================

test("data isolation: a declared independent does NOT see the public plugin's accumulated data", async () => {
  // The public source has accumulated shared data; the agent-private dataDir
  // must start EMPTY (no copy, no sharing) — the whole point of "independent".
  writePlugin(publicPluginDir, "p2", observablePlugin({ id: "p2" }));
  const srcDataDir = path.join(publicPluginDir, "p2", "data");
  fs.mkdirSync(srcDataDir, { recursive: true });
  fs.writeFileSync(path.join(srcDataDir, "seed.txt"), "accumulated", "utf8");

  const { loader } = makeLoader(def({ plugins: [], privatePlugins: ["p2"] }));
  await loader.load();

  const mod = await importPlugin(publicPluginDir, "p2");
  const dataDir = mod.calls[0].dataDir;
  assert.equal(
    dataDir,
    path.join(agentDir, "plugins", "p2", "data"),
    "the independent's dataDir is the agent's own",
  );
  assert.equal(
    fs.existsSync(path.join(dataDir, "seed.txt")),
    false,
    "the public plugin's accumulated data must NOT leak into the private dataDir",
  );
});

// ===========================================================================
// EXT-6 — index.js fallback: a plugin dir with ONLY index.js (ESM) loads.
// ===========================================================================

test("index.js fallback: a plugin dir containing only index.js loads successfully", async () => {
  const pdir = path.join(publicPluginDir, "jsonly");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(
    path.join(pdir, "index.js"),
    `
export const calls = [];
export default () => ({
  manifest: { id: "jsonly", version: "1" },
  async setup(ctx) { calls.push(ctx); },
});
`,
    "utf8",
  );

  const { loader } = makeLoader(def({ plugins: ["jsonly"] }));
  await assert.doesNotReject(loader.load(), "a plugin exposing only index.js must load");

  const mod = await import(pathToFileURL(path.join(pdir, "index.js")).href);
  assert.equal(mod.calls.length, 1, "the index.js plugin's setup ran exactly once");
});

// ===========================================================================
// EXT-2 — The FACTORY contract (contracts/plugin PluginFactory) + per-Agent
//          instantiation (R6): plugins share CODE, never live state.
// ===========================================================================

test("factory contract: a LEGACY object default export (not a factory) => the plugin is SKIPPED with a warning; the sibling loads; load() resolves", async () => {
  writePlugin(
    publicPluginDir,
    "legacy",
    `export default { manifest: { id: "legacy", version: "1" }, async setup(_ctx) {} };`,
  );
  writePlugin(publicPluginDir, "ok", observablePlugin({ id: "ok" }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["legacy", "ok"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(
    loader.load(),
    "an object default export is not a factory and must be skipped, not reject load()",
  );

  const ok = await importPlugin(publicPluginDir, "ok");
  assert.equal(ok.calls.length, 1, "the healthy sibling still sets up");
  assert.ok(warns.some((m) => m.includes("legacy")), "the skipped legacy plugin must be named in a warning");
});

test("factory contract: a factory that THROWS during construction => the plugin is SKIPPED with a warning (underlying error included); the sibling loads; load() resolves", async () => {
  writePlugin(
    publicPluginDir,
    "boomfactory",
    `export default () => { throw new Error("construction exploded"); };`,
  );
  writePlugin(publicPluginDir, "ok", observablePlugin({ id: "ok" }));
  const warns: string[] = [];
  const { loader } = makeLoader(def({ plugins: ["boomfactory", "ok"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await assert.doesNotReject(
    loader.load(),
    "a factory that throws during construction must be skipped, not reject load()",
  );

  const ok = await importPlugin(publicPluginDir, "ok");
  assert.equal(ok.calls.length, 1, "the healthy sibling still sets up");
  const warnLine = warns.find((m) => m.includes("boomfactory"));
  assert.ok(warnLine, "the skipped plugin must be named in a warning");
  assert.ok(
    warnLine!.toLowerCase().includes("construction"),
    "the underlying construction error should be included in the warning line",
  );
});

test("R6: two agents loading the SAME public plugin get independent instances (shared code, shared dataDir, never shared state)", async () => {
  // A factory whose per-instance state is observable through a module-level
  // `instances` array: one entry per factory call, mutated only by that call's
  // own instance.
  writePlugin(
    publicPluginDir,
    "solo",
    `
export const instances = [];
export default () => {
  const inst = { agentId: null, dataDir: null, torndown: false };
  instances.push(inst);
  let unsub;
  return {
    manifest: { id: "solo", version: "1" },
    async setup(ctx) {
      inst.agentId = ctx.agentId;
      inst.dataDir = ctx.dataDir;
      unsub = ctx.actions.register("solo.act", async () => "ok");
    },
    async teardown() {
      if (typeof unsub === "function") unsub();
      inst.torndown = true;
    },
  };
};
`,
  );

  // Two distinct agents, each with its own event-system (makeLoader builds one
  // per call), both loading the one public "solo".
  const a = makeLoader(def({ id: "agA", plugins: ["solo"] }));
  const b = makeLoader(def({ id: "agB", plugins: ["solo"] }));
  await a.loader.load();
  await assert.doesNotReject(
    b.loader.load(),
    "a second agent must load the same public plugin without instance collision",
  );

  const mod = await importPlugin(publicPluginDir, "solo");
  assert.equal(mod.instances.length, 2, "the factory ran once PER AGENT (two instances)");
  const [ia, ib] = mod.instances;
  assert.equal(ia.agentId, "agA", "instance 1 was set up with agent A's context");
  assert.equal(ib.agentId, "agB", "instance 2 was set up with agent B's context");
  // The shared-data exception still holds: SAME dataDir for both agents.
  assert.equal(
    ia.dataDir,
    ib.dataDir,
    "public plugins still SHARE dataDir (the explicit shared-knowledge semantics)",
  );
  // Each instance registered on ITS OWN bus.
  assert.equal(a.sys.actions.has("solo.act"), true, "agent A's bus has A's action");
  assert.equal(b.sys.actions.has("solo.act"), true, "agent B's bus has B's action");

  // Teardown isolation: tearing agent A down must not touch agent B.
  await a.loader.teardown();
  assert.equal(ia.torndown, true, "A's instance was torn down");
  assert.equal(ib.torndown, false, "B's instance must be untouched by A's teardown");
  assert.equal(a.sys.actions.has("solo.act"), false, "A's action left A's bus");
  assert.equal(b.sys.actions.has("solo.act"), true, "B's action survives A's teardown");

  await b.loader.teardown();
  assert.equal(ib.torndown, true, "B's instance tears down independently");
});

// ===========================================================================
// EXT — plugin console output (contracts/plugin v1.1):
//   - ctx.log is a LEVELED logger { info, warn, error }: lines go to the
//     loader's Logger tagged with the plugin id;
//   - ctx.print(text) is the plugin's clean USER-FACING line (during setup it
//     is the plugin's "starting message"): routed VERBATIM to the LoaderDeps
//     `print` sink (default: stdout), never wrapped in diagnostic prefixes;
//   - every log/print is ALSO pushed on the agent's own bus as a `log.entry`
//     Notify<{ level, pluginId, text }> so channel plugins can mirror it.
// ===========================================================================

test("ctx.log.warn routes to the loader Logger's warn, tagged with the plugin id", async () => {
  const warns: string[] = [];
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", setupBody: `ctx.log.warn("W1");` }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }), stubOrchestrator(), {
    log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  await loader.load();

  assert.equal(warns.length, 1, "exactly one warn line");
  assert.ok(warns[0].includes("W1"), "the message text survives");
  assert.ok(warns[0].includes("p1"), "the line is attributable to the plugin");
});

test("ctx.log.info and ctx.log.error route to the matching Logger levels", async () => {
  const infos: string[] = [];
  const errors: string[] = [];
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", setupBody: `ctx.log.info("I1"); ctx.log.error("E1");` }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }), stubOrchestrator(), {
    log: { info: (m) => infos.push(m), warn: () => {}, error: (m) => errors.push(m) },
  });
  await loader.load();

  assert.ok(infos.some((m) => m.includes("I1")), "info went to Logger.info");
  assert.ok(errors.some((m) => m.includes("E1")), "error went to Logger.error");
});

test("ctx.print routes the EXACT text to the print sink — no prefixes, no levels", async () => {
  const prints: string[] = [];
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", setupBody: `ctx.print("Web chat: http://localhost:7717");` }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }), stubOrchestrator(), {
    print: (t) => prints.push(t),
  });
  await loader.load();

  assert.deepEqual(
    prints,
    ["Web chat: http://localhost:7717"],
    "print must deliver the text verbatim to the sink",
  );
});

test("ctx.print with NO print sink configured still works (default sink; no throw)", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", setupBody: `ctx.print("starting message");` }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await assert.doesNotReject(loader.load(), "the default print sink must be safe");
});

test("every ctx.log call is pushed on the agent's bus as a log.entry Notify", async () => {
  const { Events } = await import("../shared/actions");
  assert.equal((Events as any).LOG, "log.entry", "Events.LOG must name the log.entry event");

  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", setupBody: `ctx.log.warn("pushed-W");` }),
  );
  const orch = stubOrchestrator();
  const { loader, sys } = makeLoader(def({ plugins: ["p1"] }), orch);
  const seen: any[] = [];
  sys.events.on("log.entry", (p) => seen.push(p));
  await loader.load();

  const hit = seen.find((p) => p?.data?.text === "pushed-W");
  assert.ok(hit, "the warn line was pushed as a log.entry event");
  assert.equal(typeof hit.at, "number", "Notify envelope: at is a timestamp");
  assert.equal(hit.data.level, "warn", "payload carries the level");
  assert.equal(hit.data.pluginId, "p1", "payload carries the plugin id");
});

test("ctx.print is pushed as a log.entry with level 'print'", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", setupBody: `ctx.print("hello-print");` }),
  );
  const orch = stubOrchestrator();
  const { loader, sys } = makeLoader(def({ plugins: ["p1"] }), orch, { print: () => {} });
  const seen: any[] = [];
  sys.events.on("log.entry", (p) => seen.push(p));
  await loader.load();

  const hit = seen.find((p) => p?.data?.text === "hello-print");
  assert.ok(hit, "the print was pushed as a log.entry event");
  assert.equal(hit.data.level, "print", "prints carry level 'print'");
  assert.equal(hit.data.pluginId, "p1", "payload carries the plugin id");
});

test("log.entry stays on the OWN agent's bus: agent B sees none of agent A's entries", async () => {
  writePlugin(
    publicPluginDir,
    "chatty",
    observablePlugin({ id: "chatty", setupBody: `ctx.log.info("from-" + ctx.agentId);` }),
  );
  const agentDirA = path.join(tmp, "agents", "agA");
  const agentDirB = path.join(tmp, "agents", "agB");
  fs.mkdirSync(agentDirA, { recursive: true });
  fs.mkdirSync(agentDirB, { recursive: true });

  const make = (id: string, dir: string) => {
    const sys = createEventSystem();
    const loader = createLoader({
      agentId: id,
      def: { id, intervalMs: 1000, plugins: ["chatty"] },
      events: sys,
      orchestrator: stubOrchestrator(),
      library,
      publicPluginDir,
      agentDir: dir,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    return { sys, loader };
  };

  const a = make("agA", agentDirA);
  const b = make("agB", agentDirB);
  const seenA: any[] = [];
  const seenB: any[] = [];
  a.sys.events.on("log.entry", (p) => seenA.push(p));
  b.sys.events.on("log.entry", (p) => seenB.push(p));

  await a.loader.load();
  assert.equal(seenA.filter((p) => p?.data?.text === "from-agA").length, 1, "A saw its entry");
  assert.equal(seenB.length, 0, "B's bus is silent while only A loads (R6)");

  await b.loader.load();
  assert.equal(seenB.filter((p) => p?.data?.text === "from-agB").length, 1, "B saw its own");
  assert.equal(
    seenB.some((p) => p?.data?.text === "from-agA"),
    false,
    "A's entries never leak onto B's bus",
  );

  await a.loader.teardown();
  await b.loader.teardown();
});

// ===========================================================================
// EXT — the loader mirrors its OWN diagnostics onto the bus as log.entry,
//   tagged pluginId "core:loader" (same bus-mirroring it does for plugin
//   ctx.log.* lines, which carry the plugin's id). Inducible diagnostic: when a
//   loaded plugin's teardown() THROWS during loader.teardown(), the loader
//   catches it (isolated — teardown must not reject) and logs an ERROR; that
//   error line is now ALSO emitted on the bus as a log.entry with
//   { level: "error", pluginId: "core:loader" } and a non-empty text.
// ===========================================================================

test("loader self-diagnostic: a throwing plugin teardown is mirrored on the bus as a core:loader error log.entry (teardown still resolves)", async () => {
  // A plugin whose teardown() throws — the inducible loader diagnostic.
  writePlugin(
    publicPluginDir,
    "boomtd",
    observablePlugin({ id: "boomtd", throwOnTeardown: true }),
  );

  const { loader, sys } = makeLoader(def({ plugins: ["boomtd"] }));

  // Subscribe to log.entry on the SAME bus handed to the loader.
  const seen: any[] = [];
  sys.events.on("log.entry", (p) => seen.push(p));

  await loader.load();

  // teardown() must isolate the plugin's throw (not reject)...
  await assert.doesNotReject(
    loader.teardown(),
    "teardown() must isolate a plugin's throwing teardown and resolve",
  );

  // ...and the loader's OWN error diagnostic must be mirrored on the bus,
  // attributed to the core source "core:loader" (not the plugin id), at error
  // level, with a non-empty text. (Assert on pluginId + level + non-empty text;
  // do NOT couple to the exact diagnostic wording.)
  const hit = seen.find(
    (p) => p?.data?.pluginId === "core:loader" && p?.data?.level === "error",
  );
  assert.ok(
    hit,
    "the loader's own teardown-failure ERROR must be emitted on the bus as a core:loader log.entry",
  );
  assert.equal(typeof hit.at, "number", "Notify envelope: at is a timestamp");
  assert.equal(typeof hit.data.text, "string", "the entry carries text");
  assert.ok(hit.data.text.length > 0, "the diagnostic text must be non-empty");
});

// ===========================================================================
// EXT-7 — Skip-and-continue semantics in depth (Finding C). A single broken
//   plugin never aborts the Agent: it is SKIPPED with a warning, siblings are
//   unaffected, load() RESOLVES, and a plugin whose `requires` can never be met
//   is itself skipped (cascading one-at-a-time, each logged, never aborting the
//   rest). id-validation failures remain FATAL (covered by EXT-2 above). Warnings
//   are pinned via BOTH the loader `log.warn` sink and the bus `log.entry` mirror
//   (loader self-diagnostics carry pluginId "core:loader", source 'core:loader').
// ===========================================================================

// (a) import-throw => skipped with a warning naming the plugin id + underlying
//     error; siblings load. Pinned on the bus mirror (source core:loader) too.
test("skip (import throw): the failing plugin is skipped with a warning naming its id + underlying error; siblings load; load() resolves", async () => {
  writePlugin(publicPluginDir, "good-a", observablePlugin({ id: "good-a" }));
  writePlugin(publicPluginDir, "boom-b", explodingModule("boom-b"));
  writePlugin(publicPluginDir, "good-c", observablePlugin({ id: "good-c" }));

  const warns: string[] = [];
  const { loader, sys } = makeLoader(
    def({ plugins: ["good-a", "boom-b", "good-c"] }),
    stubOrchestrator(),
    { log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} } },
  );
  const seen: any[] = [];
  sys.events.on("log.entry", (p) => seen.push(p));

  await assert.doesNotReject(loader.load(), "an import throw must never reject load()");

  // Both healthy siblings set up exactly once; the broken one did not.
  const a = await importPlugin(publicPluginDir, "good-a");
  const c = await importPlugin(publicPluginDir, "good-c");
  assert.equal(a.calls.length, 1, "the sibling before the failure set up");
  assert.equal(c.calls.length, 1, "the sibling after the failure set up (skip continued)");

  // Warning via the log sink: names the plugin id and includes the import error.
  const warnLine = warns.find((m) => m.includes("boom-b"));
  assert.ok(warnLine, "a warning must name the skipped plugin id");
  assert.ok(
    warnLine!.toLowerCase().includes("explod"),
    "the warning must include the underlying import error text",
  );

  // Warning via the bus mirror: a core:loader warn log.entry naming the plugin.
  const busWarn = seen.find(
    (p) =>
      p?.data?.level === "warn" &&
      p?.data?.pluginId === "core:loader" &&
      typeof p?.data?.text === "string" &&
      p.data.text.includes("boom-b"),
  );
  assert.ok(busWarn, "the skip warning must be mirrored on the bus as a core:loader warn log.entry");
});

// (b) setup-throw => skipped; EARLIER siblings not torn down; LATER independent
//     siblings still set up.
test("skip (setup throw): the plugin is skipped, EARLIER siblings are NOT torn down, and LATER independent siblings still set up", async () => {
  writePlugin(publicPluginDir, "before-x", goodRegistrarPlugin("before-x", "before-x.act"));
  writePlugin(
    publicPluginDir,
    "boom-setup",
    `
export const calls = [];
export default () => ({
  manifest: { id: "boom-setup", version: "1" },
  async setup(ctx) { calls.push(ctx); throw new Error("setup of boom-setup rejected"); },
});
`,
  );
  writePlugin(publicPluginDir, "after-z", goodRegistrarPlugin("after-z", "after-z.act"));

  const warns: string[] = [];
  const { loader, sys } = makeLoader(
    def({ plugins: ["before-x", "boom-setup", "after-z"] }),
    stubOrchestrator(),
    { log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} } },
  );
  await assert.doesNotReject(loader.load(), "a setup throw must never reject load()");

  const before = await importPlugin(publicPluginDir, "before-x");
  const after = await importPlugin(publicPluginDir, "after-z");

  // Earlier sibling: set up and LEFT UP (no rollback).
  assert.equal(before.state.setupCalled, true, "the earlier sibling set up");
  assert.equal(before.state.teardownCalled, false, "the earlier sibling must NOT be torn down");
  assert.equal(sys.actions.has("before-x.act"), true, "the earlier sibling's action stays registered");

  // Later independent sibling: still set up despite the mid failure.
  assert.equal(after.state.setupCalled, true, "the later independent sibling still set up");
  assert.equal(sys.actions.has("after-z.act"), true, "the later sibling's action registered");

  // The failing plugin's setup ran (partway) but it is otherwise skipped and warned.
  const boom = await importPlugin(publicPluginDir, "boom-setup");
  assert.equal(boom.calls.length, 1, "the failing plugin's setup was attempted once");
  assert.ok(warns.some((m) => m.includes("boom-setup")), "the setup-throwing plugin must be warned about");
});

// (c) a dependent of a skipped provider is itself skipped with a warning naming
//     the missing dependency, and does NOT cascade-abort the rest (a third
//     unrelated plugin still loads).
test("skip (cascade): a dependent of a skipped provider is skipped naming the missing dep; an unrelated third plugin still loads", async () => {
  // provider-p throws on import => skipped. dependent-q requires provider-p =>
  // its requirement can never be met => skipped, naming provider-p. unrelated-r
  // has no requirements => must still load. The cascade never aborts the rest.
  writePlugin(publicPluginDir, "provider-p", explodingModule("provider-p"));
  writePlugin(
    publicPluginDir,
    "dependent-q",
    providerPlugin({ id: "dependent-q", requires: ["provider-p"] }),
  );
  writePlugin(publicPluginDir, "unrelated-r", observablePlugin({ id: "unrelated-r" }));

  const warns: string[] = [];
  const { loader } = makeLoader(
    def({ plugins: ["provider-p", "dependent-q", "unrelated-r"] }),
    stubOrchestrator(),
    { log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} } },
  );
  await assert.doesNotReject(loader.load(), "a cascade of skips must never reject load()");

  const q = await importPlugin(publicPluginDir, "dependent-q");
  const r = await importPlugin(publicPluginDir, "unrelated-r");

  assert.equal(q.calls.length, 0, "the dependent of a skipped provider must itself be skipped (never set up)");
  assert.equal(r.calls.length, 1, "an unrelated third plugin must still load — the cascade did not abort the rest");

  // The dependent's skip warning must name the missing requirement (provider-p).
  assert.ok(
    warns.some((m) => m.includes("dependent-q") && m.includes("provider-p")),
    "the cascaded skip must warn, naming both the skipped dependent and its missing requirement",
  );
  // The provider was independently warned about (each skip logged one at a time).
  assert.ok(
    warns.some((m) => m.includes("provider-p")),
    "the originally-broken provider must be logged on its own",
  );
});

// (d) ALL plugins skip-fail => load() resolves, zero loaded, agent still usable
//     (teardown() resolves too).
test("skip (all fail): every plugin skips => load() resolves with zero loaded, no blocks, and teardown() also resolves", async () => {
  writePlugin(publicPluginDir, "boom-1", explodingModule("boom-1"));
  writePlugin(publicPluginDir, "boom-2", explodingModule("boom-2"));
  writePlugin(
    publicPluginDir,
    "boom-3",
    `
export const calls = [];
export default () => ({
  manifest: { id: "boom-3", version: "1" },
  async setup(ctx) { calls.push(ctx); throw new Error("boom-3 setup failed"); },
});
`,
  );

  const orchestrator = stubOrchestrator();
  const warns: string[] = [];
  const { loader } = makeLoader(
    def({ plugins: ["boom-1", "boom-2", "boom-3"] }),
    orchestrator,
    { log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} } },
  );

  // The bare-agent invariant (R3): all plugins skipping still resolves load().
  await assert.doesNotReject(loader.load(), "all plugins skipping must still resolve load()");
  assert.deepEqual(orchestrator.listBlocks(), [], "zero plugins loaded => no context blocks registered");

  // Every failing plugin was warned about (each individually logged).
  for (const id of ["boom-1", "boom-2", "boom-3"]) {
    assert.ok(warns.some((m) => m.includes(id)), `${id} must be individually warned about`);
  }

  // The agent is still usable: teardown() over an all-skipped load must resolve.
  await assert.doesNotReject(
    loader.teardown(),
    "teardown() after an all-skip load must resolve (agent stays usable)",
  );
});

// (e) dotted-action requires on a skipped provider => dependent skipped via the
//     SAME skip machinery (assert the warning), not a distinct error path.
test("skip (dotted-action on skipped provider): the dependent is skipped via the same warn machinery, not a distinct error path", async () => {
  // provider-svc would register the dotted action "svc.ready" in setup, but its
  // setup throws => it is skipped and "svc.ready" is never registered. consumer
  // requires that dotted action => at setup time the action is absent => the
  // consumer is skipped through the SAME skip-and-warn path. unrelated-ok proves
  // the rest still loads.
  writePlugin(
    publicPluginDir,
    "provider-svc",
    `
export const calls = [];
export default () => ({
  manifest: { id: "provider-svc", version: "1" },
  async setup(ctx) {
    calls.push(ctx);
    ctx.actions.register("svc.ready", async () => "ok");
    throw new Error("provider-svc setup blew up AFTER registering");
  },
});
`,
  );
  writePlugin(
    publicPluginDir,
    "consumer-svc",
    providerPlugin({ id: "consumer-svc", requires: ["svc.ready"] }),
  );
  writePlugin(publicPluginDir, "unrelated-ok", observablePlugin({ id: "unrelated-ok" }));

  const warns: string[] = [];
  const { loader, sys } = makeLoader(
    def({ plugins: ["provider-svc", "consumer-svc", "unrelated-ok"] }),
    stubOrchestrator(),
    { log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} } },
  );
  await assert.doesNotReject(loader.load(), "a dotted-action requirement on a skipped provider must not reject load()");

  const consumer = await importPlugin(publicPluginDir, "consumer-svc");
  const ok = await importPlugin(publicPluginDir, "unrelated-ok");

  assert.equal(
    consumer.calls.length,
    0,
    "the dotted-action dependent of a skipped provider must itself be skipped",
  );
  assert.equal(ok.calls.length, 1, "an unrelated plugin still loads");

  // Same skip machinery: a warning names the skipped consumer + its missing
  // dotted requirement (NOT a thrown DependencyError / distinct rejection path).
  assert.ok(
    warns.some((m) => m.includes("consumer-svc") && m.includes("svc.ready")),
    "the skip must be warned (same machinery), naming the missing dotted action requirement",
  );
});
