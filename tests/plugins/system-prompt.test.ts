import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import type { ContextBlock } from "../../contracts/context";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `system-prompt` plugin — a stable SYSTEM-target
// context block that introduces the LLM to the agent's OPERATING MODEL (the
// monologue rule + basic usage). It is CHANNEL-AGNOSTIC: it teaches the general
// "your reply is a private monologue; call a tool to act" model and never names a
// specific channel's send tool (that belongs to the channel's own tool description).
//
// Derived from contracts/plugin + contracts/context only (impl not read):
//   manifest = { id: "system-prompt", version: "0.1.0" }
//   config slice = { text?: string; priority?: number }
//   defaults: priority 9000 (just below persona's stable 10000); a default operating-model text
//   setup:    ctx.setBlock({ id:"system-prompt", label:"system-prompt",
//                            priority: cfg.priority ?? 9000, render: () => cfg.text ?? default })
//   teardown: ctx.removeBlock("system-prompt")
// ---------------------------------------------------------------------------

const BLOCK_ID = "system-prompt";
const DEFAULT_PRIORITY = 9000;

const mod: any = await import("../../public_plugin/system-prompt/index.ts").then(
  (m) => m,
  () => null,
);
// The default operating-model text is DUPLICATED: DEFAULT_TEXT (index.ts) and the
// `text` field default in config-schema.ts. They MUST stay in sync. We import the
// pure-data schema module separately (it has no runtime side effects).
const schemaMod: any = await import(
  "../../public_plugin/system-prompt/config-schema.ts"
).then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "system-prompt module not implemented yet (import failed)");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

function makeCtx(config: unknown) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const ctx: any = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir: "",
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => { store.set(b.id, b); },
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} },
    print() {},
  };
  return { ctx, store, sys };
}
async function setupAndGetBlock(config: unknown) {
  const p = plugin();
  const { ctx, store, sys } = makeCtx(config);
  await p.setup(ctx);
  const block = store.get(BLOCK_ID);
  assert.ok(block, "setup must register a block under id 'system-prompt'");
  return { p, store, sys, block: block as ContextBlock };
}
const renderOf = async (b: ContextBlock): Promise<string> => await b.render() as string;

test("manifest is { id:'system-prompt', version:'0.1.0' }", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "system-prompt");
  assert.equal(p.manifest.version, "0.1.0");
});

test("setup({}) registers block 'system-prompt' at default priority 9000, label 'system-prompt'", async () => {
  const { block } = await setupAndGetBlock({});
  assert.equal(block.id, BLOCK_ID);
  assert.equal(block.priority, DEFAULT_PRIORITY);
  assert.equal((block as any).label, BLOCK_ID);
});

test("it is a SYSTEM-target block (renders a string; target is not 'messages')", async () => {
  const { block } = await setupAndGetBlock({});
  assert.notEqual((block as any).target, "messages", "must NOT target the messages array");
  assert.equal(typeof (await renderOf(block)), "string", "a system block renders a string");
});

test("default text teaches the monologue/operating model, CHANNEL-AGNOSTIC (no channel tool named)", async () => {
  const { block } = await setupAndGetBlock({});
  const text = (await renderOf(block)).toLowerCase();
  assert.match(text, /monologue/, "must state the reply-is-a-monologue rule");
  assert.match(text, /\btool/, "must tell the model to call a tool to act");
  assert.ok(!text.includes("web.send_message"), "must NOT name a specific channel tool (channel-agnostic)");
  assert.ok(!text.includes("web chat"), "must NOT reference a specific channel");
});

test("default text EMPHASIZES the strengthened monologue model (distinctive new substrings)", async () => {
  const { block } = await setupAndGetBlock({});
  const text = await renderOf(block);
  // Assert distinctive substrings (NOT the whole string) so the test stays robust
  // to incidental wording tweaks while still pinning the strengthened model.
  assert.ok(
    text.includes("ALL of the plain text you produce"),
    "must emphasize that ALL plain output is the private monologue",
  );
  assert.ok(
    text.includes("read by NO ONE"),
    "must state the monologue is read by NO ONE",
  );
  assert.ok(
    text.includes("never stored, never acted upon"),
    "must state the monologue is never stored / never acted upon",
  );
  assert.ok(
    text.includes("call one of your tools"),
    "must state the only way to act is to call one of your tools",
  );
});

test("config-schema.ts `text` default stays in sync with the rendered DEFAULT_TEXT", async () => {
  assert.ok(
    schemaMod,
    "config-schema module not implemented yet (import failed)",
  );
  const schema = schemaMod.SYSTEM_PROMPT_SCHEMA;
  assert.ok(Array.isArray(schema), "SYSTEM_PROMPT_SCHEMA must be an array of ConfigField");
  const textField = schema.find((f: any) => f?.key === "text");
  assert.ok(textField, "config-schema must declare a 'text' field");
  assert.equal(
    typeof textField.default,
    "string",
    "config-schema 'text' field must carry a string default",
  );

  // The block rendered with NO config override must equal the schema's `text`
  // default — i.e. DEFAULT_TEXT (index.ts) and the schema default are one value.
  const { block } = await setupAndGetBlock({});
  const rendered = await renderOf(block);
  assert.equal(
    textField.default,
    rendered,
    "config-schema 'text' default must equal the plugin's rendered DEFAULT_TEXT",
  );

  // And that shared default must be the STRENGTHENED text — pin a distinctive
  // new substring on the schema side too, so a stale config-schema default
  // (out of sync with an updated index.ts, or vice versa) is caught.
  assert.ok(
    (textField.default as string).includes("read by NO ONE"),
    "config-schema 'text' default must carry the strengthened monologue wording",
  );
});

test("config.text overrides verbatim; config.priority overrides", async () => {
  const { block } = await setupAndGetBlock({ text: "CUSTOM", priority: 12345 });
  assert.equal(block.priority, 12345);
  assert.equal(await renderOf(block), "CUSTOM");
});

test("custom text only -> default priority 9000; empty string honored verbatim", async () => {
  const a = await setupAndGetBlock({ text: "only" });
  assert.equal(a.block.priority, DEFAULT_PRIORITY);
  assert.equal(await renderOf(a.block), "only");
  const b = await setupAndGetBlock({ text: "" });
  assert.equal(await renderOf(b.block), "");
});

test("priority boundaries: 0 and negative honored verbatim", async () => {
  assert.equal((await setupAndGetBlock({ priority: 0 })).block.priority, 0);
  assert.equal((await setupAndGetBlock({ priority: -5 })).block.priority, -5);
});

test("config null/undefined -> defaults", async () => {
  assert.equal((await setupAndGetBlock(null)).block.priority, DEFAULT_PRIORITY);
  assert.equal((await setupAndGetBlock(undefined)).block.priority, DEFAULT_PRIORITY);
});

test("registers exactly one block and NO actions (pure context block)", async () => {
  const { store, sys } = await setupAndGetBlock({});
  assert.equal(store.size, 1);
  assert.deepEqual(sys.actions.list(), [], "must not register actions");
});

test("teardown() removes the block", async () => {
  const { p, store } = await setupAndGetBlock({});
  assert.equal(typeof p.teardown, "function");
  await p.teardown();
  assert.equal(store.get(BLOCK_ID), undefined);
  assert.equal(store.size, 0);
});
