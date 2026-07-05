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

// ---------------------------------------------------------------------------
// SECOND block: a trailing, lowest-priority MESSAGE-target block that restates
// the operating rule at the END of the prompt (recency). Added in the SAME
// setup() alongside the unchanged system block above.
//   id:       "system-prompt.reminder"
//   target:   "messages" (lands in the messages array, not the system text)
//   priority: 200 default (well below every other message block -> renders LAST)
//   render(): Message[] with exactly ONE { role:"user", name:"operating-reminder", content: REMINDER_TEXT }
// REMINDER_TEXT is pinned EXACTLY below.
// ---------------------------------------------------------------------------
const REMINDER_BLOCK_ID = "system-prompt.reminder";
const REMINDER_DEFAULT_PRIORITY = 200;
const REMINDER_TEXT =
  "[Operating reminder] Your plain text this frame is a PRIVATE MONOLOGUE — to affect anything (reply to anyone, use any capability) you MUST call a tool. Check the current situation now: re-read the most recent user message and any status notes above, and act only on what is genuinely NEW and unaddressed this frame. If you are mid-task, re-read the newest user message FIRST — it may have changed your priorities or asked you to stop.";

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

// Run setup() once and return BOTH registered blocks from the shared store.
async function setupAndGetReminderBlock(config: unknown) {
  const p = plugin();
  const { ctx, store, sys } = makeCtx(config);
  await p.setup(ctx);
  const block = store.get(REMINDER_BLOCK_ID);
  assert.ok(block, "setup must register a second block under id 'system-prompt.reminder'");
  return { p, store, sys, block: block as ContextBlock };
}
// A messages-target block renders a Message[]; this helper renders + asserts shape.
const renderMessages = async (b: ContextBlock): Promise<any[]> => {
  const out = await b.render();
  assert.ok(Array.isArray(out), "a messages-target block must render an array of messages");
  return out as any[];
};

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
  // Channel-agnostic: never name a specific channel or its send tool.
  assert.ok(!text.includes("web-chat"), "must NOT name the web-chat channel (channel-agnostic)");
  assert.ok(!text.includes("web chat"), "must NOT reference a specific channel");
  assert.ok(!text.includes("send_message"), "must NOT name a specific channel send tool (channel-agnostic)");
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

test("default text carries the NEW frame-loop / situational-judgment paragraph (distinctive substrings)", async () => {
  const { block } = await setupAndGetBlock({});
  const text = await renderOf(block);
  // Paragraph 3 was REPLACED: the old "nothing worth doing / never force an action
  // just to act" line is gone; the new paragraph teaches frame-loop-aware judgment.
  assert.ok(
    text.includes("FRAME LOOP"),
    "new paragraph 3 must introduce the recurring FRAME LOOP model",
  );
  assert.ok(
    text.includes("do not re-send a message you've already sent"),
    "new paragraph 3 must warn against re-sending an already-sent message",
  );
  assert.ok(
    text.includes("Doing nothing is the right move when nothing is new"),
    "new paragraph 3 must end on the doing-nothing-is-right rule",
  );

  // The OLD paragraph-3 wording must be GONE (guards against a stale default).
  assert.ok(
    !text.includes("nothing worth doing"),
    "old paragraph-3 wording 'nothing worth doing' must be removed",
  );
  assert.ok(
    !text.includes("never force an action just to act"),
    "old paragraph-3 wording 'never force an action just to act' must be removed",
  );
});

test("default text carries the NEW tool-failure reflection rule (F2), CHANNEL-AGNOSTIC", async () => {
  const { block } = await setupAndGetBlock({});
  const text = await renderOf(block);
  // NEW: DEFAULT_TEXT gains ONE appended sentence teaching that a tool which
  // failed with the SAME error twice will not succeed if called again unchanged
  // — reflect in the monologue, change approach or stop.
  assert.match(
    text,
    /same error twice/i,
    "default text must warn that the same error twice means a repeat call won't succeed",
  );
  assert.match(
    text,
    /reflect/i,
    "default text must tell the model to reflect (in the monologue) rather than blindly retry",
  );
  // The reflection sentence must stay CHANNEL-AGNOSTIC: it must not mandate any
  // channel/send tool. Guard the new wording specifically against 'send_message'.
  assert.ok(
    !text.includes("send_message"),
    "the F2 reflection rule must NOT name a specific channel send tool (channel-agnostic)",
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

test("registers exactly two context blocks and NO actions (pure context blocks)", async () => {
  const { store, sys } = await setupAndGetBlock({});
  // The system block (@9000) PLUS the trailing reminder block (@200).
  assert.equal(store.size, 2);
  assert.ok(store.get(BLOCK_ID), "the system block must be registered");
  assert.ok(store.get(REMINDER_BLOCK_ID), "the reminder block must be registered");
  assert.deepEqual(sys.actions.list(), [], "must not register actions");
});

// ---------------------------------------------------------------------------
// SECOND block: "system-prompt.reminder" — trailing, lowest-priority MESSAGE
// block restating the operating rule at the END of the prompt (recency).
// ---------------------------------------------------------------------------

test("setup({}) registers a SECOND block 'system-prompt.reminder' targeting 'messages' at default priority 200", async () => {
  const { block } = await setupAndGetReminderBlock({});
  assert.equal(block.id, REMINDER_BLOCK_ID);
  assert.equal((block as any).target, "messages", "reminder must target the messages array");
  assert.equal(
    block.priority,
    REMINDER_DEFAULT_PRIORITY,
    "reminder default priority must be 200 (well below every other message block)",
  );
});

test("reminder render() returns ONE user message named 'operating-reminder' whose content === REMINDER_TEXT (exact)", async () => {
  const { block } = await setupAndGetReminderBlock({});
  const msgs = await renderMessages(block);
  assert.equal(msgs.length, 1, "reminder must render exactly ONE message");
  const [m] = msgs;
  assert.equal(m.role, "user", "the reminder message role must be 'user'");
  assert.equal(m.name, "operating-reminder", "the reminder message name must be 'operating-reminder'");
  assert.equal(m.content, REMINDER_TEXT, "the reminder message content must equal REMINDER_TEXT verbatim");
});

test("reminder is CHANNEL-AGNOSTIC (no 'web-chat', 'web chat', or 'send_message')", async () => {
  const { block } = await setupAndGetReminderBlock({});
  const msgs = await renderMessages(block);
  const content: string = msgs[0].content;
  const lower = content.toLowerCase();
  assert.ok(!lower.includes("web-chat"), "must NOT name the web-chat channel (channel-agnostic)");
  assert.ok(!lower.includes("web chat"), "must NOT reference a specific channel");
  assert.ok(!lower.includes("send_message"), "must NOT name a specific channel send tool (channel-agnostic)");
});

test("reminder carries the distinctive operating-rule substrings", async () => {
  const { block } = await setupAndGetReminderBlock({});
  const msgs = await renderMessages(block);
  const content: string = msgs[0].content;
  assert.ok(
    content.includes("PRIVATE MONOLOGUE"),
    "reminder must restate the private-monologue rule",
  );
  assert.ok(
    content.includes("re-read the newest user message"),
    "reminder must tell the model to re-read the newest user message",
  );
  assert.ok(
    content.includes("MUST call a tool"),
    "reminder must state you MUST call a tool to act",
  );
});

test("teardown() removes BOTH the system block and the reminder block", async () => {
  const { p, store } = await setupAndGetBlock({});
  assert.equal(typeof p.teardown, "function");
  assert.equal(store.size, 2, "both blocks present before teardown");
  await p.teardown();
  assert.equal(store.get(BLOCK_ID), undefined);
  assert.equal(store.get(REMINDER_BLOCK_ID), undefined, "teardown must also remove the reminder block");
  assert.equal(store.size, 0);
});
