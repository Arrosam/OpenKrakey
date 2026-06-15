import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Events } from "../../shared/actions";
import type { Message } from "../../contracts/llm";
import type { Plugin, PluginContext } from "../../contracts/plugin";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `history` plugin (conversation.snapshot vocab).
//
// Spec: history folds four generic events into an ordered list of stored chat
// turns (each a wire `Message` PLUS provenance `source` + `at`):
//   input.message  -> { role:"user",      content, name:source,        source, at }
//   llm.return(ok) -> { role:"assistant", content, toolCalls?,  source:"assistant", at }
//   tool.result    -> { role:"tool", content, toolCallId:id, name, source:name, at }
// On EVERY prompt.gather it EMITS Events.CONVERSATION_SNAPSHOT carrying the
// current conversation as WIRE `Message[]` — each stored turn with `at` + `source`
// STRIPPED OUT (role/content kept; whichever of toolCallId/name/toolCalls present).
// It persists every FULL stored turn to <dataDir>/history.jsonl (one JSON line)
// and reloads it at setup (last `maxEntries`, default 200), skipping malformed /
// foreign lines. It registers NO actions and its manifest has NO `provides`
// ("conversation.get" is gone). The impl is loaded via a guarded import so a
// missing module is a clean assertion failure, not an unhandled rejection.
// ---------------------------------------------------------------------------

const mod: any = await import("../../public_plugin/history/index.ts").then(
  (m) => m,
  () => null,
);

function plugin(): Plugin {
  assert.equal(
    typeof mod?.default,
    "function",
    "history plugin not implemented — default export must be a PluginFactory",
  );
  return (mod.default as () => Plugin)();
}

/** A no-op key-less llm library (history never calls the LLM directly). */
const STUB_LLM = {
  get: () => undefined,
  has: () => false,
  list: () => [],
  withCapability: () => [],
};

function makeCtx(dataDir: string, config?: unknown) {
  const sys = createEventSystem();
  const ctx: PluginContext = {
    agentId: "agent-1",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir,
    llm: STUB_LLM,
    setBlock: () => {},
    getBlock: () => undefined,
    removeBlock: () => false,
    listBlocks: () => [],
    log: { info: () => {}, warn: () => {}, error: () => {} },
    print: () => {},
  };
  return { sys, ctx, events: sys.events, actions: sys.actions };
}

async function setup(t: { after(fn: () => void): void }, config?: unknown) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  const p = plugin();
  const h = makeCtx(dataDir, config);
  await p.setup(h.ctx);
  t.after(async () => {
    try {
      await p.teardown?.();
    } catch {
      /* teardown must never throw the suite */
    }
  });
  return { ...h, p, dataDir };
}

function settle(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drive one prompt.gather and capture the conversation.snapshot it provokes.
 * Subscribes BEFORE emitting (so a synchronous re-emit is caught), unsubscribes
 * after, and returns the wire `messages` from the LAST snapshot seen.
 * Returns `null` if no snapshot was emitted (e.g. after teardown).
 */
async function snapshot(events: any, seq = 1): Promise<Message[] | null> {
  let captured: Message[] | null = null;
  const off = events.on(Events.CONVERSATION_SNAPSHOT, (payload: any) => {
    // payload is Notify<{ messages: Message[] }>
    captured = payload?.data?.messages ?? null;
  });
  try {
    events.emit(Events.PROMPT_GATHER, { at: 9000 + seq, data: { seq } });
    await settle();
  } finally {
    off();
  }
  return captured;
}

// emit helpers in the well-known envelope shapes
const input = (events: any, text: unknown, channel?: string, at = 1000) =>
  events.emit(Events.INPUT_MESSAGE, {
    at,
    data: channel !== undefined ? { text, channel } : { text },
  });
const ret = (events: any, content: unknown, toolCalls?: unknown[], at = 2000) =>
  events.emit(Events.LLM_RETURN, {
    id: "r",
    at,
    ok: true,
    data: toolCalls ? { content, toolCalls } : { content },
  });
const toolRes = (events: any, id: string, name: string, data: unknown, at = 3000) =>
  events.emit(Events.TOOL_RESULT, { id, at, ok: true, data, name });

/** True when an object literally lacks a key (vs. having it set to undefined). */
function hasKey(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

// ===========================================================================
// 1. manifest + (non-)registration  — positive + negative
// ===========================================================================

test("manifest: id 'history', version '0.1.0', and NO `provides`", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "history");
  assert.equal(p.manifest.version, "0.1.0");
  // It must NOT advertise conversation.get (or anything) as a capability.
  assert.ok(
    p.manifest.provides === undefined || p.manifest.provides.length === 0,
    "history must not provide any capability",
  );
  assert.equal(
    (p.manifest.provides ?? []).includes("conversation.get"),
    false,
    "the conversation.get capability has been removed",
  );
});

test("setup: registers NO actions — in particular not 'conversation.get'", async (t) => {
  const { actions } = await setup(t);
  assert.equal(
    actions.has("conversation.get"),
    false,
    "conversation.get is gone — history must not register it",
  );
  assert.deepEqual(actions.list(), [], "history registers no actions at all");
});

// ===========================================================================
// 2. snapshot basics — emitted on prompt.gather, empty when no turns
// ===========================================================================

test("prompt.gather on a brand-new agent emits a snapshot with messages: []", async (t) => {
  const { events } = await setup(t);
  const msgs = await snapshot(events);
  assert.notEqual(msgs, null, "a snapshot is emitted even with zero turns");
  assert.deepEqual(msgs, []);
});

test("snapshot is emitted on EVERY prompt.gather (not just the first)", async (t) => {
  const { events } = await setup(t);
  const first = await snapshot(events, 1);
  assert.deepEqual(first, []);
  input(events, "hello", "web");
  await settle();
  const second = await snapshot(events, 2);
  assert.deepEqual(second, [{ role: "user", content: "hello", name: "web" }]);
  // and a third gather with no new turns still emits, unchanged
  const third = await snapshot(events, 3);
  assert.deepEqual(third, [{ role: "user", content: "hello", name: "web" }]);
});

// ===========================================================================
// 3. user input -> wire user turn (channel surfaced via `name`; no at/source)
// ===========================================================================

test("input.message -> wire user turn { role:'user', content, name:channel } (no at, no source)", async (t) => {
  const { events } = await setup(t);
  input(events, "hello krakey", "web", 1234);
  await settle();
  const msgs = (await snapshot(events))!;
  assert.equal(msgs.length, 1, "exactly one wire message");
  const m = msgs[0];
  assert.equal(m.role, "user");
  assert.equal(m.content, "hello krakey");
  assert.equal(m.name, "web", "the channel is surfaced via the wire `name`");
  assert.equal(hasKey(m, "at"), false, "`at` is stripped from the wire message");
  assert.equal(hasKey(m, "source"), false, "`source` is stripped from the wire message");
  assert.equal(hasKey(m, "toolCallId"), false);
  assert.equal(hasKey(m, "toolCalls"), false);
});

test("input.message without a channel -> name 'user' (source defaulted then surfaced)", async (t) => {
  const { events } = await setup(t);
  input(events, "hi");
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "user");
  assert.equal(m.content, "hi");
  assert.equal(m.name, "user", "absent channel -> source 'user' -> wire name 'user'");
});

test("input.message with a non-string channel -> name falls back to 'user'", async (t) => {
  const { events } = await setup(t);
  // channel present but not a string: source must default to "user".
  events.emit(Events.INPUT_MESSAGE, { at: 1, data: { text: "hey", channel: 123 } });
  await settle();
  const msgs = (await snapshot(events))!;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].name, "user");
});

test("input.message with empty-string text is still a user turn (content '')", async (t) => {
  const { events } = await setup(t);
  input(events, "", "web");
  await settle();
  const msgs = (await snapshot(events))!;
  assert.equal(msgs.length, 1, "empty string is a valid string -> recorded");
  assert.equal(msgs[0].content, "");
  assert.equal(msgs[0].role, "user");
});

test("input.message with a non-string text is ignored (no turn)", async (t) => {
  const { events } = await setup(t);
  events.emit(Events.INPUT_MESSAGE, { at: 1, data: { text: 42 } });
  events.emit(Events.INPUT_MESSAGE, { at: 2, data: { text: null } });
  events.emit(Events.INPUT_MESSAGE, { at: 3, data: {} });
  await settle();
  assert.deepEqual(await snapshot(events), []);
});

// ===========================================================================
// 4. llm.return -> wire assistant turn (+ toolCalls only when non-empty)
// ===========================================================================

test("llm.return(ok) -> wire assistant turn { role:'assistant', content } and NO toolCalls key", async (t) => {
  const { events } = await setup(t);
  ret(events, "the answer is 42");
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "assistant");
  assert.equal(m.content, "the answer is 42");
  assert.equal(hasKey(m, "toolCalls"), false, "no toolCalls key when none were returned");
  assert.equal(hasKey(m, "at"), false);
  assert.equal(hasKey(m, "source"), false);
});

test("llm.return with non-string content -> content coerced to '' ", async (t) => {
  const { events } = await setup(t);
  events.emit(Events.LLM_RETURN, { id: "r", at: 1, ok: true, data: { content: undefined } });
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "assistant");
  assert.equal(m.content, "", "missing/non-string content becomes the empty string");
});

test("llm.return with non-empty toolCalls -> they are preserved on the wire assistant turn", async (t) => {
  const { events } = await setup(t);
  const calls = [{ id: "c1", name: "time.now", arguments: {} }];
  ret(events, "", calls);
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "assistant");
  assert.equal(m.content, "");
  assert.equal(hasKey(m, "toolCalls"), true, "toolCalls present when the model emitted some");
  assert.deepEqual(m.toolCalls, calls);
});

test("llm.return with an EMPTY toolCalls array -> the toolCalls key is omitted", async (t) => {
  const { events } = await setup(t);
  // length 0 -> spec says toolCalls is attached ONLY if length > 0.
  events.emit(Events.LLM_RETURN, { id: "r", at: 1, ok: true, data: { content: "hi", toolCalls: [] } });
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "assistant");
  assert.equal(hasKey(m, "toolCalls"), false, "empty toolCalls must not appear on the wire");
});

test("llm.return with ok:false records nothing", async (t) => {
  const { events } = await setup(t);
  events.emit(Events.LLM_RETURN, { id: "r", at: 1, ok: false, error: "boom" });
  await settle();
  assert.deepEqual(await snapshot(events), []);
});

test("llm.return ok:true but missing data records nothing", async (t) => {
  const { events } = await setup(t);
  events.emit(Events.LLM_RETURN, { id: "r", at: 1, ok: true });
  await settle();
  assert.deepEqual(await snapshot(events), []);
});

// ===========================================================================
// 5. tool.result -> wire tool turn (toolCallId = call id, name = tool name)
// ===========================================================================

test("tool.result(ok) -> wire tool turn { role:'tool', content=JSON(data), toolCallId=id, name } (no at/source)", async (t) => {
  const { events } = await setup(t);
  toolRes(events, "c1", "time.now", { iso: "2026-06-15T10:00:00Z", epochMs: 1 }, 5555);
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "tool");
  assert.equal(m.toolCallId, "c1", "pairs with the assistant tool_call id");
  assert.equal(m.name, "time.now");
  assert.equal(hasKey(m, "at"), false);
  assert.equal(hasKey(m, "source"), false);
  assert.match(m.content as string, /"iso":/, "the tool payload is serialized into content");
  assert.equal(m.content, JSON.stringify({ iso: "2026-06-15T10:00:00Z", epochMs: 1 }));
});

test("tool.result(ok) with no data -> content is the JSON literal 'null'", async (t) => {
  const { events } = await setup(t);
  events.emit(Events.TOOL_RESULT, { id: "c9", at: 1, ok: true, name: "noop.tool" });
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "tool");
  assert.equal(m.content, "null", "data ?? null -> JSON.stringify(null) === 'null'");
});

test("tool.result with ok:false -> content is an 'Error: ...' string carrying the error", async (t) => {
  const { events } = await setup(t);
  events.emit(Events.TOOL_RESULT, { id: "c2", at: 1, ok: false, error: "exploded", name: "note.save" });
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "tool");
  assert.equal(m.toolCallId, "c2");
  assert.equal(m.name, "note.save");
  assert.match(m.content as string, /^Error: /);
  assert.match(m.content as string, /exploded/);
});

test("tool.result with ok:false and NO error -> content 'Error: tool failed'", async (t) => {
  const { events } = await setup(t);
  events.emit(Events.TOOL_RESULT, { id: "c3", at: 1, ok: false, name: "broken.tool" });
  await settle();
  const m = (await snapshot(events))![0];
  assert.equal(m.role, "tool");
  assert.equal(m.content, "Error: tool failed");
});

test("tool.result with a non-string name is ignored (no turn)", async (t) => {
  const { events } = await setup(t);
  // `name` is the discriminator; a non-string name => skip.
  events.emit(Events.TOOL_RESULT, { id: "c4", at: 1, ok: true, data: { x: 1 }, name: 99 });
  await settle();
  assert.deepEqual(await snapshot(events), []);
});

// ===========================================================================
// 6. ordering, multi-turn round, snapshot isolation (copy semantics)
// ===========================================================================

test("turns preserve emit order: user -> assistant(toolCall) -> tool -> assistant", async (t) => {
  const { events } = await setup(t);
  input(events, "what time is it?", "web");
  ret(events, "", [{ id: "c1", name: "time.now", arguments: {} }]);
  toolRes(events, "c1", "time.now", { iso: "x" });
  ret(events, "it is 10am");
  await settle();
  const roles = (await snapshot(events))!.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
});

test("a full round produces exactly the three wire messages, in order, fully shaped", async (t) => {
  const { events } = await setup(t);
  const calls = [{ id: "c1", name: "time.now", arguments: {} }];
  input(events, "what time is it?", "web", 1000);
  ret(events, "let me check", calls, 2000);
  toolRes(events, "c1", "time.now", { iso: "2026-06-15T10:00:00Z" }, 3000);
  await settle();
  const msgs = (await snapshot(events))!;
  assert.deepEqual(msgs, [
    { role: "user", content: "what time is it?", name: "web" },
    { role: "assistant", content: "let me check", toolCalls: calls },
    {
      role: "tool",
      content: JSON.stringify({ iso: "2026-06-15T10:00:00Z" }),
      toolCallId: "c1",
      name: "time.now",
    },
  ]);
});

test("the snapshot is a COPY — mutating the emitted array does not corrupt the next snapshot", async (t) => {
  const { events } = await setup(t);
  input(events, "hi", "web");
  await settle();
  const first = (await snapshot(events))!;
  assert.equal(first.length, 1);
  // mutate the returned array AND its element objects
  first.push({ role: "user", content: "injected" } as Message);
  (first[0] as any).content = "corrupted";
  (first[0] as any).role = "system";
  const second = (await snapshot(events))!;
  assert.equal(second.length, 1, "internal list length must be unaffected by external mutation");
  assert.equal(second[0].content, "hi", "internal turn content must be unaffected");
  assert.equal(second[0].role, "user");
});

// ===========================================================================
// 7. persistence + reload + bounding + malformed-line skipping
// ===========================================================================

test("persistence: each turn is appended to <dataDir>/history.jsonl as one FULL JSON line (with at/source)", async (t) => {
  const { events, dataDir } = await setup(t);
  input(events, "one", "web", 1111);
  ret(events, "two", undefined, 2222);
  await settle();
  const lines = fs
    .readFileSync(path.join(dataDir, "history.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  assert.equal(lines.length, 2, "one JSON line per appended turn");
  const a = JSON.parse(lines[0]);
  assert.equal(a.role, "user");
  assert.equal(a.content, "one");
  assert.equal(a.source, "web", "the PERSISTED turn keeps provenance (source)");
  assert.equal(a.at, 1111, "the PERSISTED turn keeps its timestamp");
  const b = JSON.parse(lines[1]);
  assert.equal(b.role, "assistant");
  assert.equal(b.source, "assistant");
});

test("reload: a fresh instance over the same dataDir restores prior turns (seen via a post-reload snapshot)", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-reload-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  const a = makeCtx(dataDir);
  const pa = plugin();
  await pa.setup(a.ctx);
  input(a.events, "remembered", "web");
  ret(a.events, "ack");
  await settle();
  await pa.teardown?.();

  const b = makeCtx(dataDir);
  const pb = plugin();
  await pb.setup(b.ctx);
  const msgs = (await snapshot(b.events))!;
  await pb.teardown?.();
  assert.deepEqual(
    msgs,
    [
      { role: "user", content: "remembered", name: "web" },
      { role: "assistant", content: "ack" },
    ],
    "the persisted turns must reload from JSONL and re-emit as wire messages",
  );
});

test("reload: corrupt or foreign-schema lines are skipped (never poison the conversation)", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-bad-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  fs.writeFileSync(
    path.join(dataDir, "history.jsonl"),
    [
      JSON.stringify({ role: "user", content: "keep", source: "web", at: 1 }), // valid
      JSON.stringify({ at: 2, kind: "user", text: "old-schema (no role/content)" }), // foreign schema
      JSON.stringify({ role: "wizard", content: "unknown role", source: "x", at: 3 }), // unknown role
      JSON.stringify({ role: "assistant", content: 12345, source: "assistant", at: 4 }), // non-string content
      "{ not json at all", // unparseable
      "", // blank line
      JSON.stringify({ role: "assistant", content: "alsoKeep", source: "assistant", at: 5 }), // valid
    ].join("\n") + "\n",
  );
  const h = makeCtx(dataDir);
  const p = plugin();
  await p.setup(h.ctx);
  const msgs = (await snapshot(h.events))!;
  await p.teardown?.();
  assert.deepEqual(
    msgs,
    [
      { role: "user", content: "keep", name: "web" },
      { role: "assistant", content: "alsoKeep" },
    ],
    "only the two well-formed turns (valid role + string content) load",
  );
});

test("bounding: maxEntries keeps only the most recent turns (live appends)", async (t) => {
  const { events } = await setup(t, { maxEntries: 3 });
  for (let i = 0; i < 5; i++) input(events, `m${i}`, "web");
  await settle();
  const msgs = (await snapshot(events))!;
  assert.equal(msgs.length, 3, "older turns are trimmed from the front");
  assert.deepEqual(
    msgs.map((m) => m.content),
    ["m2", "m3", "m4"],
  );
});

test("bounding: maxEntries=1 keeps a single turn", async (t) => {
  const { events } = await setup(t, { maxEntries: 1 });
  input(events, "a", "web");
  input(events, "b", "web");
  await settle();
  const msgs = (await snapshot(events))!;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, "b");
});

test("bounding: a non-positive / non-number maxEntries falls back to the default (turns are NOT dropped to 0)", async (t) => {
  // 0, negative, and non-number must not wipe history; default (200) applies.
  for (const bad of [{ maxEntries: 0 }, { maxEntries: -5 }, { maxEntries: "lots" }]) {
    const { events } = await setup(t, bad);
    input(events, "kept", "web");
    await settle();
    const msgs = (await snapshot(events))!;
    assert.equal(msgs.length, 1, `maxEntries=${JSON.stringify(bad)} must not drop turns to zero`);
    assert.equal(msgs[0].content, "kept");
  }
});

test("reload bounding: only the last maxEntries lines are restored", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-rb-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({ role: "user", content: `h${i}`, source: "web", at: i }));
  }
  fs.writeFileSync(path.join(dataDir, "history.jsonl"), lines.join("\n") + "\n");
  const h = makeCtx(dataDir, { maxEntries: 2 });
  const p = plugin();
  await p.setup(h.ctx);
  const msgs = (await snapshot(h.events))!;
  await p.teardown?.();
  assert.deepEqual(
    msgs.map((m) => m.content),
    ["h4", "h5"],
    "reload keeps only the last `maxEntries` turns",
  );
});

// ===========================================================================
// 8. teardown — listeners removed, no more snapshots / folding
// ===========================================================================

test("teardown: after teardown a prompt.gather emits NO snapshot", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-td-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  const h = makeCtx(dataDir);
  const p = plugin();
  await p.setup(h.ctx);
  // sanity: it DOES emit while alive
  assert.deepEqual(await snapshot(h.events), []);
  await p.teardown?.();
  assert.equal(
    await snapshot(h.events),
    null,
    "no conversation.snapshot is emitted after teardown",
  );
});

test("teardown: after teardown, input/llm/tool events are no longer folded", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-td2-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  const h = makeCtx(dataDir);
  const p = plugin();
  await p.setup(h.ctx);
  input(h.events, "before", "web");
  await settle();
  await p.teardown?.();
  // These must be ignored now (listeners unsubscribed).
  input(h.events, "after", "web");
  ret(h.events, "after-assistant");
  toolRes(h.events, "c1", "after.tool", { x: 1 });
  await settle();

  // A new instance over the same dataDir must NOT see the post-teardown events.
  const h2 = makeCtx(dataDir);
  const p2 = plugin();
  await p2.setup(h2.ctx);
  const msgs = (await snapshot(h2.events))!;
  await p2.teardown?.();
  assert.deepEqual(
    msgs.map((m) => m.content),
    ["before"],
    "events emitted after teardown must not be recorded or persisted",
  );
});
