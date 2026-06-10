import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";
import type { PluginContext, Plugin } from "../../contracts/plugin";
import type {
  CommunicatorLibrary,
  Communicator,
  LLMRequest,
  LLMResponse,
} from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `history` plugin.
//
// Derived ONLY from overviews/nodes/history.md + the L1 contracts (plugin,
// context, llm) + shared/actions. The plugin implementation does NOT exist yet
// (public_plugin/history/index.ts is unwritten), so the module is loaded with a
// GUARDED dynamic import: a missing module becomes a clean per-test assertion
// failure ("not implemented yet"), never a file-level crash.
//
// We never read implementation internals. We drive the plugin entirely through
// its public contract surface:
//   * load the default export (a `Plugin`), call setup(ctx) / teardown()
//   * a REAL event-system carries input.message / llm.return / tool.result
//   * a Map-backed block store captures the registered ContextBlock; we read its
//     render() output (the only observable behaviour) and the on-disk JSONL.
// ---------------------------------------------------------------------------

// Guarded import: resolves to the module, or null if the file does not exist.
const mod: any = await import("../../public_plugin/history/index.ts").then(
  (m) => m,
  () => null,
);

/** The plugin under test, or a clean assertion failure if not implemented. */
function loadPlugin(): Plugin {
  assert.ok(mod?.default, "history plugin not implemented yet (no default export)");
  const p = mod.default as Plugin;
  assert.equal(typeof p.setup, "function", "plugin must expose setup()");
  return p;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A Map-backed block store; mirrors the orchestrator's BY-ID block surface. */
function makeBlockStore() {
  const blocks = new Map<string, ContextBlock>();
  return {
    blocks,
    setBlock(block: ContextBlock) {
      blocks.set(block.id, block);
    },
    getBlock(id: string): ContextBlock | undefined {
      return blocks.get(id);
    },
    removeBlock(id: string): boolean {
      return blocks.delete(id);
    },
    listBlocks(): Array<{ id: string; priority: number }> {
      return [...blocks.values()].map((b) => ({ id: b.id, priority: b.priority }));
    },
  };
}

/** A no-op chat communicator (history never calls the LLM, but ctx.llm must exist). */
function stubCommunicator(): Communicator {
  return {
    name: "stub",
    provider: "stub",
    model: "stub-1",
    capabilities: ["chat"],
    input: ["text"],
    output: ["text"],
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return { content: "" };
    },
  };
}

function stubLibrary(): CommunicatorLibrary {
  const c = stubCommunicator();
  return {
    get: (name: string) => (name === c.name ? c : undefined),
    has: (name: string) => name === c.name,
    list: () => [c.name],
    withCapability: (cap) => (cap === "chat" ? [c.name] : []),
  };
}

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));
}

/**
 * Build a PluginContext over a real event-system + a Map block store. Returns the
 * pieces a test needs to drive the bus and observe the block / disk.
 */
function makeCtx(opts: { config?: unknown; dataDir?: string } = {}) {
  const sys = createEventSystem();
  const store = makeBlockStore();
  const dataDir = opts.dataDir ?? tmpDataDir();
  const ctx: PluginContext = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config: opts.config ?? {},
    dataDir,
    llm: stubLibrary(),
    setBlock: store.setBlock,
    getBlock: store.getBlock,
    removeBlock: store.removeBlock,
    listBlocks: store.listBlocks,
    log: () => {},
  };
  return { sys, store, ctx, dataDir, events: sys.events };
}

/** Render the registered history block (string | Promise<string>). */
async function renderHistory(store: ReturnType<typeof makeBlockStore>): Promise<string> {
  const block = store.getBlock("history");
  assert.ok(block, "history block must be registered under id 'history'");
  return await block!.render();
}

/** Setup the plugin, register an automatic teardown, return ctx bundle. */
async function startPlugin(
  t: { after(fn: () => void | Promise<void>): void },
  opts: { config?: unknown; dataDir?: string } = {},
) {
  const plugin = loadPlugin();
  const bundle = makeCtx(opts);
  await plugin.setup(bundle.ctx);
  t.after(async () => {
    try {
      await plugin.teardown?.();
    } catch {
      /* teardown must never throw the test */
    }
  });
  return { plugin, ...bundle };
}

let CLOCK = 1_000;
/** Monotonic timestamp for envelopes; arrival order = call order. */
function now(): number {
  return CLOCK++;
}

// Envelope helpers (shared/actions shapes).
function notify<T>(data: T) {
  return { at: now(), data };
}
function reply<T>(ok: boolean, extra: { data?: T; error?: string; name?: string } = {}) {
  return { id: `r${now()}`, at: now(), ok, ...extra };
}

/** Let any async append / persistence settle before asserting. */
function settle(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ===========================================================================
// 1. Block registration + empty render
// ===========================================================================

test("registers a 'history' block at priority 100 rendering '## Conversation' when empty", async (t) => {
  const { store } = await startPlugin(t);

  const listed = store.listBlocks().find((b) => b.id === "history");
  assert.ok(listed, "a block with id 'history' must be registered at setup");
  assert.equal(listed!.priority, 100, "history block priority must be 100 (low, volatile)");

  const out = await renderHistory(store);
  assert.equal(typeof out, "string", "render() must return a string");
  assert.ok(
    out.startsWith("## Conversation"),
    `empty render must start with '## Conversation' (got: ${JSON.stringify(out)})`,
  );
});

// ===========================================================================
// 2. input.message -> user entry
// ===========================================================================

test("input.message Notify{text} renders a 'user: <text>' line", async (t) => {
  const { store, events } = await startPlugin(t);

  events.emit(Events.INPUT_MESSAGE, notify({ text: "hello" }));
  await settle();

  const out = await renderHistory(store);
  assert.ok(out.includes("user: hello"), `expected 'user: hello' in:\n${out}`);
});

test("input.message renders empty-string text without throwing", async (t) => {
  const { store, events } = await startPlugin(t);

  events.emit(Events.INPUT_MESSAGE, notify({ text: "" }));
  await settle();

  const out = await renderHistory(store);
  assert.ok(out.includes("user:"), `expected a 'user:' line for empty text in:\n${out}`);
});

// ===========================================================================
// 3. llm.return -> assistant entry (+ tool-call records)
// ===========================================================================

test("llm.return Reply{ok,data:{content}} renders an 'assistant: <content>' line", async (t) => {
  const { store, events } = await startPlugin(t);

  events.emit(Events.LLM_RETURN, reply(true, { data: { content: "yo" } }));
  await settle();

  const out = await renderHistory(store);
  assert.ok(out.includes("assistant: yo"), `expected 'assistant: yo' in:\n${out}`);
});

test("llm.return with toolCalls also records each call line containing the tool name", async (t) => {
  const { store, events } = await startPlugin(t);

  events.emit(
    Events.LLM_RETURN,
    reply(true, {
      data: {
        content: "",
        toolCalls: [{ id: "tc1", name: "time.now", arguments: {} }],
      },
    }),
  );
  await settle();

  const out = await renderHistory(store);
  assert.ok(out.includes("time.now"), `expected a tool-call line mentioning 'time.now' in:\n${out}`);
});

// ===========================================================================
// 4. tool.result -> tool entry (ok and failure)
// ===========================================================================

test("tool.result ok:true renders a line with the tool name and JSON data", async (t) => {
  const { store, events } = await startPlugin(t);

  events.emit(Events.TOOL_RESULT, reply(true, { data: { x: 1 }, name: "time.now" }));
  await settle();

  const out = await renderHistory(store);
  assert.ok(out.includes("time.now"), `expected tool name 'time.now' in:\n${out}`);
  assert.ok(
    /\{[^}]*"x"\s*:\s*1[^}]*\}/.test(out),
    `expected JSON data {"x":1} rendered in:\n${out}`,
  );
});

test("tool.result ok:false renders a failure line containing the error marker", async (t) => {
  const { store, events } = await startPlugin(t);

  events.emit(
    Events.TOOL_RESULT,
    reply(false, { error: "boom-xyz", name: "time.now" }),
  );
  await settle();

  const out = await renderHistory(store);
  assert.ok(out.includes("time.now"), `expected tool name 'time.now' in failure line:\n${out}`);
  assert.ok(out.includes("boom-xyz"), `expected the error text 'boom-xyz' in:\n${out}`);
});

// ===========================================================================
// 5. Ordering — oldest first, in arrival order
// ===========================================================================

test("entries render in arrival order, oldest first (user then assistant)", async (t) => {
  const { store, events } = await startPlugin(t);

  events.emit(Events.INPUT_MESSAGE, notify({ text: "first-msg" }));
  await settle(5);
  events.emit(Events.LLM_RETURN, reply(true, { data: { content: "second-reply" } }));
  await settle();

  const out = await renderHistory(store);
  const iUser = out.indexOf("first-msg");
  const iAsst = out.indexOf("second-reply");
  assert.ok(iUser >= 0, "user entry must be present");
  assert.ok(iAsst >= 0, "assistant entry must be present");
  assert.ok(iUser < iAsst, `oldest (user) must render before newest (assistant):\n${out}`);
});

// ===========================================================================
// 6. Bounding — config.maxEntries keeps only the last N
// ===========================================================================

test("config.maxEntries=3 keeps only the LAST 3 of 5 inputs", async (t) => {
  const { store, events } = await startPlugin(t, { config: { maxEntries: 3 } });

  for (const txt of ["m1", "m2", "m3", "m4", "m5"]) {
    events.emit(Events.INPUT_MESSAGE, notify({ text: txt }));
    await settle(3);
  }
  await settle();

  const out = await renderHistory(store);
  assert.ok(!out.includes("m1"), `oldest 'm1' must be evicted:\n${out}`);
  assert.ok(!out.includes("m2"), `oldest 'm2' must be evicted:\n${out}`);
  assert.ok(out.includes("m3"), `'m3' must remain:\n${out}`);
  assert.ok(out.includes("m4"), `'m4' must remain:\n${out}`);
  assert.ok(out.includes("m5"), `'m5' must remain:\n${out}`);
});

test("config.maxEntries=1 keeps only the single most-recent entry", async (t) => {
  const { store, events } = await startPlugin(t, { config: { maxEntries: 1 } });

  events.emit(Events.INPUT_MESSAGE, notify({ text: "old-one" }));
  await settle(3);
  events.emit(Events.INPUT_MESSAGE, notify({ text: "new-one" }));
  await settle();

  const out = await renderHistory(store);
  assert.ok(!out.includes("old-one"), `'old-one' must be evicted at maxEntries=1:\n${out}`);
  assert.ok(out.includes("new-one"), `'new-one' must remain:\n${out}`);
});

// ===========================================================================
// 7. Persistence — JSONL on disk + reload across a fresh setup
// ===========================================================================

test("each entry is appended to dataDir/history.jsonl as one JSON line", async (t) => {
  const { dataDir, events } = await startPlugin(t);

  events.emit(Events.INPUT_MESSAGE, notify({ text: "persist-me" }));
  await settle(5);
  events.emit(Events.LLM_RETURN, reply(true, { data: { content: "persist-reply" } }));
  await settle();

  const file = path.join(dataDir, "history.jsonl");
  assert.ok(fs.existsSync(file), "history.jsonl must exist after events");

  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 2, `expected one JSON line per entry (2), got ${lines.length}`);
  for (const line of lines) {
    const obj = JSON.parse(line); // must be valid JSON — throws the test on failure
    assert.equal(typeof obj, "object");
    assert.ok("kind" in obj, "each persisted entry should carry a 'kind' field");
  }
});

test("a fresh setup over the same dataDir re-renders previously persisted entries (no new events)", async (t) => {
  // First plugin instance writes some history, then tears down.
  const plugin1 = loadPlugin();
  const first = makeCtx();
  await plugin1.setup(first.ctx);
  first.events.emit(Events.INPUT_MESSAGE, notify({ text: "survivor-text" }));
  await settle(15);
  await plugin1.teardown?.();

  // A SECOND, independent instance over the SAME dataDir — but a fresh module is
  // not available, so reuse the default export with a brand-new context. No new
  // events are emitted; persisted history alone must render.
  const plugin2 = loadPlugin();
  const second = makeCtx({ dataDir: first.dataDir });
  await plugin2.setup(second.ctx);
  t.after(async () => {
    try {
      await plugin2.teardown?.();
    } catch {
      /* ignore */
    }
  });

  const out = await renderHistory(second.store);
  assert.ok(
    out.includes("survivor-text"),
    `restart must reload persisted entry 'survivor-text':\n${out}`,
  );
});

// ===========================================================================
// 8. Robustness — malformed payloads add nothing & never throw; bad JSONL skipped
// ===========================================================================

test("malformed event payloads add nothing and never throw", async (t) => {
  const { store, events } = await startPlugin(t);

  const before = await renderHistory(store);

  // undefined payload
  assert.doesNotThrow(() => events.emit(Events.INPUT_MESSAGE, undefined));
  // empty object (no .data / no .text)
  assert.doesNotThrow(() => events.emit(Events.INPUT_MESSAGE, {}));
  // notify with data but missing text field
  assert.doesNotThrow(() => events.emit(Events.INPUT_MESSAGE, notify({})));
  // llm.return that is NOT ok -> no assistant entry
  assert.doesNotThrow(() =>
    events.emit(Events.LLM_RETURN, reply(false, { error: "nope" })),
  );
  // llm.return ok:true but no data
  assert.doesNotThrow(() => events.emit(Events.LLM_RETURN, reply(true, {})));
  // tool.result undefined
  assert.doesNotThrow(() => events.emit(Events.TOOL_RESULT, undefined));
  await settle();

  const after = await renderHistory(store);
  assert.equal(
    after,
    before,
    `malformed payloads must not add any entry (render unchanged):\nBEFORE:\n${before}\nAFTER:\n${after}`,
  );
});

test("unparseable lines in a pre-existing history.jsonl are skipped on load", async (t) => {
  const dataDir = tmpDataDir();
  const file = path.join(dataDir, "history.jsonl");
  // Mix valid entries with junk that must be ignored.
  const goodA = JSON.stringify({ at: 1, kind: "user", text: "good-A" });
  const goodB = JSON.stringify({ at: 2, kind: "assistant", text: "good-B" });
  fs.writeFileSync(file, [goodA, "this-is-not-json{", "", "{broken", goodB].join("\n"), "utf8");

  const { store } = await startPlugin(t, { dataDir });

  const out = await renderHistory(store);
  assert.ok(out.includes("good-A"), `valid entry 'good-A' must load:\n${out}`);
  assert.ok(out.includes("good-B"), `valid entry 'good-B' must load:\n${out}`);
  assert.ok(!out.includes("not-json"), `junk line must be skipped:\n${out}`);
  assert.ok(!out.includes("broken"), `junk line must be skipped:\n${out}`);
});

// ===========================================================================
// 9. Teardown — removes the block and unsubscribes
// ===========================================================================

test("teardown removes the 'history' block from the store", async (t) => {
  const plugin = loadPlugin();
  const { store, ctx } = makeCtx();
  await plugin.setup(ctx);
  assert.ok(store.getBlock("history"), "block must be present after setup");

  await plugin.teardown?.();
  assert.equal(store.getBlock("history"), undefined, "teardown must removeBlock('history')");
  assert.equal(
    store.listBlocks().some((b) => b.id === "history"),
    false,
    "history block must no longer be listed after teardown",
  );
});

test("post-teardown events do not mutate the persisted store", async (t) => {
  const plugin = loadPlugin();
  const { ctx, dataDir, events } = makeCtx();
  await plugin.setup(ctx);
  events.emit(Events.INPUT_MESSAGE, notify({ text: "kept" }));
  await settle(10);
  await plugin.teardown?.();

  const file = path.join(dataDir, "history.jsonl");
  const sizeBefore = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  // After teardown the listener must be unsubscribed: this event is ignored.
  events.emit(Events.INPUT_MESSAGE, notify({ text: "after-teardown" }));
  await settle();

  const sizeAfter = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  assert.equal(
    sizeAfter,
    sizeBefore,
    "events after teardown must not append to history.jsonl (listener unsubscribed)",
  );
  assert.ok(!sizeAfter.includes("after-teardown"), "post-teardown text must not be persisted");
});
