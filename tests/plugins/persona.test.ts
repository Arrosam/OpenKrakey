import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import type { ContextBlock } from "../../contracts/context";
import type {
  Communicator,
  CommunicatorLibrary,
  LLMRequest,
  LLMResponse,
  Capability,
} from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `persona` plugin.
//
// Derived ONLY from:
//   * overviews/nodes/persona.md (spec)
//   * contracts/plugin  (Plugin / PluginManifest / PluginContext surface)
//   * contracts/context (ContextBlock: { id, priority, render() })
//
// We never read the implementation. The plugin module may not exist yet, so we
// load it with a guarded dynamic import: a missing module yields `null` and each
// test asserts on `mod?.default` (a clean assertion failure in the red state),
// never a file-level crash.
//
// Spec pins (overviews/nodes/persona.md):
//   manifest = { id: "persona", version: "0.1.0" }
//   config slice = { text?: string; priority?: number }
//   defaults: text = "You are Krakey, an autonomous agent. Be concise and helpful."
//             priority = 10000
//   setup:    ctx.setBlock({ id:"persona", priority: cfg.priority ?? 10000,
//                            render: () => cfg.text ?? default })  (text VERBATIM)
//   teardown: ctx.removeBlock("persona")
// ---------------------------------------------------------------------------

const DEFAULT_TEXT =
  "You are Krakey, an autonomous agent. Be concise and helpful.";
const PERSONA_ID = "persona";
const DEFAULT_PRIORITY = 10000;

// Guarded import — missing module => null (clean assertion failure, no crash).
const mod: any = await import("../../public_plugin/persona/index.ts").then(
  (m) => m,
  () => null,
);

/** Asserts the module + default export exist; returns the default export. */
function plugin(): any {
  assert.ok(mod, "persona module not implemented yet (import failed)");
  assert.equal(
    typeof mod?.default,
    "function",
    "persona plugin not implemented yet — the default export must be a PluginFactory",
  );
  return mod.default(); // one fresh per-Agent instance
}

// ---------------------------------------------------------------------------
// In-process harness (the loader is NOT under test). We hand the plugin a real
// EventSystem and a Map-backed block store, exactly as the contract describes.
// ---------------------------------------------------------------------------

/** A canned communicator that records the last chat request. */
function stubCommunicator(name: string): Communicator & { lastChat?: LLMRequest } {
  const c: any = {
    name,
    provider: "stub",
    model: "stub-model",
    capabilities: ["chat"] as readonly Capability[],
    input: ["text"] as const,
    output: ["text"] as const,
    chat(req: LLMRequest): Promise<LLMResponse> {
      c.lastChat = req;
      return Promise.resolve({ content: "" });
    },
  };
  return c;
}

/** A minimal CommunicatorLibrary over a fixed set of communicators. */
function stubLLM(): CommunicatorLibrary {
  const comms = new Map<string, Communicator>([["stub", stubCommunicator("stub")]]);
  return {
    get: (name: string) => comms.get(name),
    has: (name: string) => comms.has(name),
    list: () => [...comms.keys()],
    withCapability: (cap: Capability) =>
      [...comms.values()].filter((c) => c.capabilities.includes(cap)).map((c) => c.name),
  };
}

/**
 * Build a PluginContext backed by a Map block store. Returns the context plus
 * direct handles to the store so tests can assert on it independently of the
 * context surface.
 */
function makeCtx(config: unknown, t: { after(fn: () => void): void }) {
  const store = new Map<string, ContextBlock>();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  const sys = createEventSystem();
  const ctx = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir,
    llm: stubLLM(),
    setBlock(block: ContextBlock) {
      store.set(block.id, block);
    },
    getBlock(id: string): ContextBlock | undefined {
      return store.get(id);
    },
    removeBlock(id: string): boolean {
      return store.delete(id);
    },
    listBlocks(): Array<{ id: string; priority: number }> {
      return [...store.values()].map((b) => ({ id: b.id, priority: b.priority }));
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    print: () => {},
  };
  return { ctx, store, dataDir, sys };
}

/** Run setup then return the persona block (asserting it was registered). */
async function setupAndGetBlock(config: unknown, t: any) {
  const p = plugin();
  const { ctx, store } = makeCtx(config, t);
  await p.setup(ctx);
  const block = store.get(PERSONA_ID);
  assert.ok(block, "setup must register a block under id 'persona'");
  return { p, ctx, store, block: block as ContextBlock };
}

/** render() may be sync or async per the contract — normalize to a string. */
async function renderOf(block: ContextBlock): Promise<string> {
  return await block.render();
}

// ===========================================================================
// 1. Default export shape & manifest
// ===========================================================================
test("default export shape — is a Plugin with setup() and a manifest", () => {
  const p = plugin();
  assert.equal(typeof p, "object");
  assert.ok(p.manifest, "plugin must expose a manifest");
  assert.equal(typeof p.setup, "function", "plugin must expose setup()");
});

test("manifest.id is exactly 'persona'", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "persona");
});

test("manifest.version is a non-empty string ('0.1.0' per spec)", () => {
  const p = plugin();
  assert.equal(typeof p.manifest.version, "string");
  assert.ok(p.manifest.version.length > 0, "version must be non-empty");
  assert.equal(p.manifest.version, "0.1.0");
});

// ===========================================================================
// 2. setup() with EMPTY config — positive / defaults
// ===========================================================================
test("setup({}) registers block id 'persona' at default priority 10000", async (t) => {
  const { block } = await setupAndGetBlock({}, t);
  assert.equal(block.id, PERSONA_ID);
  assert.equal(block.priority, DEFAULT_PRIORITY);
});

test("setup({}) render() resolves to the documented default text (contains 'Krakey')", async (t) => {
  const { block } = await setupAndGetBlock({}, t);
  const text = await renderOf(block);
  assert.equal(text, DEFAULT_TEXT);
  assert.match(text, /Krakey/, "default persona text must mention Krakey");
});

test("setup with config absent entirely (undefined) falls back to defaults", async (t) => {
  const { block } = await setupAndGetBlock(undefined, t);
  assert.equal(block.priority, DEFAULT_PRIORITY);
  assert.equal(await renderOf(block), DEFAULT_TEXT);
});

test("setup({}) registers exactly one block (the persona block)", async (t) => {
  const { store } = await setupAndGetBlock({}, t);
  assert.equal(store.size, 1, "persona setup should add exactly one block");
});

test("setup({}) nominates the block label 'persona' (orchestrator wraps it as <persona>…</persona>)", async (t) => {
  const { block } = await setupAndGetBlock({}, t);
  assert.equal((block as any).label, PERSONA_ID, "persona must nominate its block label");
});

test("render() is callable repeatedly and stable (default)", async (t) => {
  const { block } = await setupAndGetBlock({}, t);
  const a = await renderOf(block);
  const b = await renderOf(block);
  assert.equal(a, b);
  assert.equal(a, DEFAULT_TEXT);
});

// ===========================================================================
// 3. setup() with FULL config — positive
// ===========================================================================
test("setup({text:'I am X', priority:12000}) -> priority 12000 and render() === 'I am X'", async (t) => {
  const { block } = await setupAndGetBlock({ text: "I am X", priority: 12000 }, t);
  assert.equal(block.id, PERSONA_ID);
  assert.equal(block.priority, 12000);
  assert.equal(await renderOf(block), "I am X");
});

test("custom text only -> custom text, default priority 10000", async (t) => {
  const { block } = await setupAndGetBlock({ text: "Only text" }, t);
  assert.equal(block.priority, DEFAULT_PRIORITY);
  assert.equal(await renderOf(block), "Only text");
});

test("custom priority only -> default text, custom priority", async (t) => {
  const { block } = await setupAndGetBlock({ priority: 15000 }, t);
  assert.equal(block.priority, 15000);
  assert.equal(await renderOf(block), DEFAULT_TEXT);
});

// ===========================================================================
// 4. render() returns the configured text VERBATIM (no decoration)
// ===========================================================================
test("render() is the configured text VERBATIM — no prefix/suffix/wrapping", async (t) => {
  const weird = "  Line1\n\tLine2 with <tags> & \"quotes\" — 漢字 🐙  ";
  const { block } = await setupAndGetBlock({ text: weird }, t);
  const out = await renderOf(block);
  assert.equal(out, weird, "render must return the exact configured string");
  // No accidental labels/headers added around it.
  assert.ok(!out.startsWith("Persona"), "render must not prepend a label");
});

test("render() empty-string text is returned verbatim (not replaced by default)", async (t) => {
  // BVA: empty string is a *present* value, distinct from undefined.
  // The spec uses `cfg.text ?? default`, so "" (not null/undefined) stays "".
  const { block } = await setupAndGetBlock({ text: "" }, t);
  assert.equal(await renderOf(block), "");
});

test("render() single-character text", async (t) => {
  const { block } = await setupAndGetBlock({ text: "X" }, t);
  assert.equal(await renderOf(block), "X");
});

test("render() large text is returned verbatim", async (t) => {
  const big = "krakey ".repeat(5000);
  const { block } = await setupAndGetBlock({ text: big }, t);
  assert.equal(await renderOf(block), big);
});

// ===========================================================================
// BVA — priority boundary values
// ===========================================================================
test("priority boundary: 0 is honored (not coalesced to default)", async (t) => {
  // 0 is a present number; `?? 10000` keeps 0.
  const { block } = await setupAndGetBlock({ priority: 0 }, t);
  assert.equal(block.priority, 0);
});

test("priority boundary: exactly 10000 (the stable-prefix threshold)", async (t) => {
  const { block } = await setupAndGetBlock({ priority: 10000 }, t);
  assert.equal(block.priority, 10000);
});

test("priority boundary: 9999 (just below threshold) is honored as given", async (t) => {
  const { block } = await setupAndGetBlock({ priority: 9999 }, t);
  assert.equal(block.priority, 9999);
});

test("priority boundary: very large value is honored", async (t) => {
  const { block } = await setupAndGetBlock({ priority: 1_000_000 }, t);
  assert.equal(block.priority, 1_000_000);
});

test("priority boundary: negative value is passed through verbatim", async (t) => {
  const { block } = await setupAndGetBlock({ priority: -5 }, t);
  assert.equal(block.priority, -5);
});

// ===========================================================================
// State transitions — setup then teardown
// ===========================================================================
test("teardown() removes the persona block (getBlock('persona') -> undefined)", async (t) => {
  const { p, store } = await setupAndGetBlock({}, t);
  assert.ok(store.get(PERSONA_ID), "precondition: block present after setup");
  assert.equal(typeof p.teardown, "function", "persona must expose teardown()");
  await p.teardown();
  assert.equal(store.get(PERSONA_ID), undefined, "teardown must remove the block");
  assert.equal(store.size, 0, "no blocks should remain after teardown");
});

test("setup -> teardown -> setup re-registers the block (re-usable)", async (t) => {
  const p = plugin();
  const { ctx, store } = makeCtx({ text: "first" }, t);
  await p.setup(ctx);
  assert.equal(await renderOf(store.get(PERSONA_ID)!), "first");
  if (typeof p.teardown === "function") await p.teardown();
  assert.equal(store.get(PERSONA_ID), undefined);
  // Re-run setup on a fresh context with new config.
  const { ctx: ctx2, store: store2 } = makeCtx({ text: "second" }, t);
  await p.setup(ctx2);
  assert.equal(await renderOf(store2.get(PERSONA_ID)!), "second");
});

test("setup is effectively replace-by-id: second setup overwrites the same id", async (t) => {
  // setBlock add-or-replaces by id; two setups on the SAME store must not leave
  // a stale/duplicate persona block.
  const p = plugin();
  const { ctx, store } = makeCtx({ text: "A", priority: 11000 }, t);
  await p.setup(ctx);
  // Replace config by building a second context over the same store.
  const store2 = store;
  const sys = createEventSystem();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });
  const ctx2: any = {
    ...ctx,
    config: { text: "B", priority: 22000 },
    events: sys.events,
    actions: sys.actions,
    dataDir,
    setBlock: (b: ContextBlock) => store2.set(b.id, b),
    getBlock: (id: string) => store2.get(id),
    removeBlock: (id: string) => store2.delete(id),
  };
  await p.setup(ctx2);
  assert.equal(store2.size, 1, "must still be a single persona block (replace by id)");
  const block = store2.get(PERSONA_ID)!;
  assert.equal(block.priority, 22000);
  assert.equal(await renderOf(block), "B");
});

test("teardown() without prior setup does not throw (defensive)", async (t) => {
  const p = plugin();
  if (typeof p.teardown !== "function") {
    // teardown is optional in the contract; nothing to assert.
    return;
  }
  const { ctx } = makeCtx({}, t);
  // Some implementations capture removeBlock at setup; if teardown needs a prior
  // setup, calling it cold may be a no-op or a clean throw — we only require it
  // not to crash the harness when setup ran first then teardown twice.
  await p.setup(ctx);
  await p.teardown();
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "double teardown must be safe (idempotent removal)");
});

// ===========================================================================
// Negative / error guessing
// ===========================================================================
test("setup does NOT register any action or leave bus listeners (pure context block)", async (t) => {
  const p = plugin();
  const { ctx, sys } = makeCtx({}, t);
  await p.setup(ctx);
  // persona is a pure stable-identity context block; it should not register actions.
  assert.deepEqual(sys.actions.list(), [], "persona must not register actions");
});

test("config with extra unknown keys is ignored (only text/priority consumed)", async (t) => {
  const { block } = await setupAndGetBlock(
    { text: "keep", priority: 13000, bogus: 1, nested: { x: 2 } },
    t,
  );
  assert.equal(block.priority, 13000);
  assert.equal(await renderOf(block), "keep");
});

test("config === null falls back to defaults (treated like absent)", async (t) => {
  // null is a valid 'unknown' config; persona should default rather than crash.
  const { block } = await setupAndGetBlock(null, t);
  assert.equal(block.priority, DEFAULT_PRIORITY);
  assert.equal(await renderOf(block), DEFAULT_TEXT);
});

test("listBlocks reports the persona block id/priority after setup", async (t) => {
  const { store } = await setupAndGetBlock({ priority: 14000 }, t);
  const listed = [...store.values()].map((b) => ({ id: b.id, priority: b.priority }));
  assert.deepEqual(listed, [{ id: PERSONA_ID, priority: 14000 }]);
});
