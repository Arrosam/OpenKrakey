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

/** Build a loader for a given AgentDefinition wired to this test's sandbox. */
function makeLoader(def: AgentDefinition, orchestrator = stubOrchestrator()) {
  const sys = createEventSystem();
  const loader = createLoader({
    agentId: def.id,
    def,
    events: sys,
    orchestrator,
    library,
    publicPluginDir,
    agentDir,
    log: { info: () => {}, warn: () => {}, error: () => {} },
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

test("public load: PluginContext carries agentId === def.id and the real buses", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1" }));
  const { loader, sys } = makeLoader(def({ id: "ag1", plugins: ["p1"] }));
  await loader.load();

  const ctx = (await importPlugin(publicPluginDir, "p1")).calls[0];
  assert.ok(ctx, "a ctx must have been captured");
  assert.equal(ctx.agentId, "ag1", "ctx.agentId must equal def.id");
  assert.equal(ctx.events, sys.events, "ctx.events must be the Agent's eventbus (identity)");
  assert.equal(ctx.actions, sys.actions, "ctx.actions must be the Agent's actionbus (identity)");
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
  assert.equal(typeof ctx.log, "function");
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

test("requires: an unmet requirement => load() rejects with DependencyError", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", requires: ["nope.missing"] }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await assert.rejects(loader.load(), DependencyError);
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

test("requires: a dotted action name absent from the bus => DependencyError", async () => {
  writePlugin(
    publicPluginDir,
    "p1",
    observablePlugin({ id: "p1", requires: ["svc.absent"] }),
  );
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  // Nothing registered on the bus.
  await assert.rejects(loader.load(), DependencyError);
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

test("requires: a plugin-id requirement NOT among loaded plugins => DependencyError", async () => {
  // p1 requires "dep" but "dep" is never declared/loaded.
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1", requires: ["dep"] }));
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await assert.rejects(loader.load(), DependencyError);
});

test("requires: an empty requires array imposes no constraint (loads OK)", async () => {
  writePlugin(publicPluginDir, "p1", observablePlugin({ id: "p1", requires: [] }));
  const { loader } = makeLoader(def({ plugins: ["p1"] }));
  await assert.doesNotReject(loader.load(), "requires:[] must never block loading");
});

// ===========================================================================
// Behavior 7 — invalid / unloadable modules => PluginLoadError
// ===========================================================================

test("invalid module: no default export => load() rejects with PluginLoadError", async () => {
  // A module that exports `calls` but NO default Plugin.
  writePlugin(publicPluginDir, "bad", `export const calls = [];`);
  const { loader } = makeLoader(def({ plugins: ["bad"] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

test("invalid module: default missing `manifest` => PluginLoadError", async () => {
  writePlugin(
    publicPluginDir,
    "bad",
    `export default () => ({ async setup(_ctx) {} });`,
  );
  const { loader } = makeLoader(def({ plugins: ["bad"] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

test("invalid module: default missing `setup` => PluginLoadError", async () => {
  writePlugin(
    publicPluginDir,
    "bad",
    `export default () => ({ manifest: { id: "bad", version: "1" } });`,
  );
  const { loader } = makeLoader(def({ plugins: ["bad"] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

test("invalid module: declared public plugin directory does not exist => PluginLoadError", async () => {
  // "missing" is declared but no public_plugin/missing/ exists at all.
  const { loader } = makeLoader(def({ plugins: ["missing"] }));
  await assert.rejects(loader.load(), PluginLoadError);
});

test("invalid module: a module whose evaluation throws => PluginLoadError", async () => {
  writePlugin(
    publicPluginDir,
    "boom",
    `throw new Error("module side-effect explosion");\nexport default {};`,
  );
  const { loader } = makeLoader(def({ plugins: ["boom"] }));
  await assert.rejects(loader.load(), PluginLoadError);
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
// EXT-1 — All-or-nothing rollback: a later failure tears down earlier plugins
//          in reverse order (and that teardown really un-did setup's effects)
// ===========================================================================

test("fail-fast: a later plugin's import failure rejects load() BEFORE any setup runs (zero side effects)", async () => {
  writePlugin(publicPluginDir, "aa-good", goodRegistrarPlugin("aa-good", "aa-good.act"));
  writePlugin(publicPluginDir, "zz-bad", explodingModule("zz-bad"));

  // The whole load set is imported + validated BEFORE any setup runs, so
  // zz-bad's import failure aborts the load while aa-good has had NO side
  // effects at all — stronger than rollback (nothing to roll back).
  const { loader, sys } = makeLoader(def({ plugins: ["aa-good", "zz-bad"] }));
  await assert.rejects(loader.load(), "a downstream failure must reject the whole load()");

  const good = await importPlugin(publicPluginDir, "aa-good");
  assert.equal(
    good.state.setupCalled,
    false,
    "fail-fast: the earlier plugin must never have been set up when a later import fails",
  );
  assert.equal(
    sys.actions.has("aa-good.act"),
    false,
    "no registration may leak from an aborted load",
  );
});

test("rollback: an UNMET-requires failure also tears down the earlier good plugin", async () => {
  writePlugin(publicPluginDir, "aa-good", goodRegistrarPlugin("aa-good", "aa-good.r2"));
  // zz-needy requires a plugin/capability nobody provides -> DependencyError.
  writePlugin(publicPluginDir, "zz-needy", providerPlugin({ id: "zz-needy", requires: ["nobody"] }));

  const { loader } = makeLoader(def({ plugins: ["aa-good", "zz-needy"] }));
  await assert.rejects(loader.load(), DependencyError);

  const good = await importPlugin(publicPluginDir, "aa-good");
  assert.equal(good.state.teardownCalled, true, "rollback ran the good plugin's teardown");
});

test("rollback: proven by a SECOND loader on the SAME event-system loading aa-good without an 'already registered' collision", async () => {
  writePlugin(publicPluginDir, "aa-good", goodRegistrarPlugin("aa-good", "aa-good.unique"));
  writePlugin(publicPluginDir, "zz-bad", explodingModule("zz-bad"));

  // Share ONE event-system across both loaders so a leaked action registration
  // would collide on the bus.
  const sys = createEventSystem();
  const make = (d: AgentDefinition) =>
    createLoader({
      agentId: d.id,
      def: d,
      events: sys,
      orchestrator: stubOrchestrator(),
      library,
      publicPluginDir,
      agentDir,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

  // First loader fails at zz-bad; rollback must un-register aa-good's action.
  const l1 = make(def({ plugins: ["aa-good", "zz-bad"] }));
  await assert.rejects(l1.load());
  assert.equal(sys.actions.has("aa-good.unique"), false, "rollback must leave the bus clean");

  // Second loader (same bus) loads aa-good alone: must NOT throw a duplicate-
  // registration error — proving the first run's teardown actually ran.
  const l2 = make(def({ id: "ag1", plugins: ["aa-good"] }));
  await assert.doesNotReject(
    l2.load(),
    "re-registering on the same bus must succeed because rollback unregistered it",
  );
  assert.equal(sys.actions.has("aa-good.unique"), true, "the second load registered the action");
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

test("requires (load-set): a non-dotted requirement matched by NOBODY's id/provides => DependencyError", async () => {
  writePlugin(publicPluginDir, "alpha", providerPlugin({ id: "alpha", requires: ["storage"] }));
  // A sibling that provides something ELSE — does NOT satisfy "storage".
  writePlugin(publicPluginDir, "zeta", providerPlugin({ id: "zeta", provides: ["cache"] }));

  const { loader } = makeLoader(def({ plugins: ["alpha", "zeta"] }));
  await assert.rejects(loader.load(), DependencyError);
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

test("factory contract: a LEGACY object default export (not a factory) => PluginLoadError", async () => {
  writePlugin(
    publicPluginDir,
    "legacy",
    `export default { manifest: { id: "legacy", version: "1" }, async setup(_ctx) {} };`,
  );
  const { loader } = makeLoader(def({ plugins: ["legacy"] }));
  await assert.rejects(
    loader.load(),
    PluginLoadError,
    "an object default export is not a factory and must be rejected",
  );
});

test("factory contract: a factory that THROWS during construction => PluginLoadError", async () => {
  writePlugin(
    publicPluginDir,
    "boomfactory",
    `export default () => { throw new Error("construction exploded"); };`,
  );
  const { loader } = makeLoader(def({ plugins: ["boomfactory"] }));
  await assert.rejects(loader.load(), PluginLoadError);
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
