import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Actions, Events } from "../../shared/actions";
import type { ConversationMessage } from "../../shared/actions";
import type { Plugin, PluginContext } from "../../contracts/plugin";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the rewritten `history` plugin.
//
// Spec: history folds three generic events into an ordered list of Hermes
// chat turns, each an `llm` Message PLUS provenance (`source`) + `at`:
//   input.message  -> { role:"user",      content, name:channel, source:channel }
//   llm.return(ok) -> { role:"assistant", content, toolCalls?, source:"assistant" }
//   tool.result    -> { role:"tool", content, toolCallId:id, name, source:name }
// It persists every turn to <dataDir>/history.jsonl (memory across restarts) and
// exposes the current conversation via the `conversation.get` action. It NO LONGER
// contributes a context block. Derived only from the spec + contracts; the impl is
// loaded via a guarded import so a missing module is a clean assertion failure.
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

async function conversation(actions: any): Promise<ConversationMessage[]> {
  return (await actions.invoke(Actions.CONVERSATION_GET)) as ConversationMessage[];
}

// emit helpers in the well-known envelope shapes
const input = (events: any, text: string, channel?: string, at = 1000) =>
  events.emit(Events.INPUT_MESSAGE, { at, data: channel ? { text, channel } : { text } });
const ret = (events: any, content: string, toolCalls?: unknown[], at = 2000) =>
  events.emit(Events.LLM_RETURN, {
    id: "r",
    at,
    ok: true,
    data: toolCalls ? { content, toolCalls } : { content },
  });
const toolRes = (events: any, id: string, name: string, data: unknown, at = 3000) =>
  events.emit(Events.TOOL_RESULT, { id, at, ok: true, data, name });

// ===========================================================================
// 1. manifest + action registration
// ===========================================================================

test("manifest: id 'history' and provides 'conversation.get'", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "history");
  assert.ok(p.manifest.provides?.includes("conversation.get"), "must provide conversation.get");
});

test("setup: registers the conversation.get action", async (t) => {
  const { actions } = await setup(t);
  assert.equal(actions.has(Actions.CONVERSATION_GET), true);
});

test("setup: a brand-new agent has an empty conversation", async (t) => {
  const { actions } = await setup(t);
  assert.deepEqual(await conversation(actions), []);
});

// ===========================================================================
// 2. user input -> user turn (source = channel, surfaced via name)
// ===========================================================================

test("input.message -> a user turn carrying content, name=channel, source=channel, at", async (t) => {
  const { events, actions } = await setup(t);
  input(events, "hello krakey", "web", 1234);
  await settle();
  const [turn, ...rest] = await conversation(actions);
  assert.equal(rest.length, 0, "exactly one turn");
  assert.equal(turn.role, "user");
  assert.equal(turn.content, "hello krakey");
  assert.equal(turn.name, "web", "the channel is surfaced via the wire `name`");
  assert.equal(turn.source, "web");
  assert.equal(turn.at, 1234, "the turn carries the event timestamp");
});

test("input.message without a channel -> source 'user'", async (t) => {
  const { events, actions } = await setup(t);
  input(events, "hi");
  await settle();
  const [turn] = await conversation(actions);
  assert.equal(turn.source, "user");
});

test("input.message with a non-string text is ignored", async (t) => {
  const { events, actions } = await setup(t);
  events.emit(Events.INPUT_MESSAGE, { at: 1, data: { text: 42 } });
  await settle();
  assert.deepEqual(await conversation(actions), []);
});

// ===========================================================================
// 3. llm.return -> assistant turn (+ toolCalls)
// ===========================================================================

test("llm.return(ok) -> an assistant turn with content and source 'assistant'", async (t) => {
  const { events, actions } = await setup(t);
  ret(events, "the answer is 42");
  await settle();
  const [turn] = await conversation(actions);
  assert.equal(turn.role, "assistant");
  assert.equal(turn.content, "the answer is 42");
  assert.equal(turn.source, "assistant");
  assert.equal("toolCalls" in turn, false, "no toolCalls when none were returned");
});

test("llm.return with toolCalls -> an assistant turn carrying those toolCalls", async (t) => {
  const { events, actions } = await setup(t);
  ret(events, "", [{ id: "c1", name: "time.now", arguments: {} }]);
  await settle();
  const [turn] = await conversation(actions);
  assert.equal(turn.role, "assistant");
  assert.equal(turn.content, "");
  assert.deepEqual(turn.toolCalls, [{ id: "c1", name: "time.now", arguments: {} }]);
});

test("llm.return with ok:false records nothing", async (t) => {
  const { events, actions } = await setup(t);
  events.emit(Events.LLM_RETURN, { id: "r", at: 1, ok: false, error: "boom" });
  await settle();
  assert.deepEqual(await conversation(actions), []);
});

// ===========================================================================
// 4. tool.result -> tool turn (toolCallId = call id, source = tool name)
// ===========================================================================

test("tool.result(ok) -> a tool turn: content=JSON(data), toolCallId=id, name+source=tool", async (t) => {
  const { events, actions } = await setup(t);
  toolRes(events, "c1", "time.now", { iso: "2026-06-15T10:00:00Z", epochMs: 1 }, 5555);
  await settle();
  const [turn] = await conversation(actions);
  assert.equal(turn.role, "tool");
  assert.equal(turn.toolCallId, "c1", "pairs with the assistant tool_call id");
  assert.equal(turn.name, "time.now");
  assert.equal(turn.source, "time.now");
  assert.equal(turn.at, 5555);
  assert.match(turn.content as string, /"iso":/, "the tool payload is serialized into content");
});

test("tool.result with ok:false -> a tool turn whose content is an error string", async (t) => {
  const { events, actions } = await setup(t);
  events.emit(Events.TOOL_RESULT, { id: "c2", at: 1, ok: false, error: "exploded", name: "note.save" });
  await settle();
  const [turn] = await conversation(actions);
  assert.equal(turn.role, "tool");
  assert.equal(turn.toolCallId, "c2");
  assert.match(turn.content as string, /exploded/);
});

// ===========================================================================
// 5. ordering, snapshot isolation
// ===========================================================================

test("turns preserve emit order: user -> assistant(toolCall) -> tool -> assistant", async (t) => {
  const { events, actions } = await setup(t);
  input(events, "what time is it?", "web");
  ret(events, "", [{ id: "c1", name: "time.now", arguments: {} }]);
  toolRes(events, "c1", "time.now", { iso: "x" });
  ret(events, "it is 10am");
  await settle();
  const roles = (await conversation(actions)).map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
});

test("conversation.get returns a SNAPSHOT — mutating it does not change history", async (t) => {
  const { events, actions } = await setup(t);
  input(events, "hi", "web");
  await settle();
  const first = await conversation(actions);
  first.push({ role: "user", content: "injected", source: "x", at: 0 } as ConversationMessage);
  const second = await conversation(actions);
  assert.equal(second.length, 1, "the internal list must be unaffected by mutating a returned snapshot");
});

// ===========================================================================
// 6. persistence + reload + bounding
// ===========================================================================

test("persistence: each turn is appended to <dataDir>/history.jsonl as one JSON line", async (t) => {
  const { events, dataDir } = await setup(t);
  input(events, "one", "web");
  ret(events, "two");
  await settle();
  const lines = fs
    .readFileSync(path.join(dataDir, "history.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).content, "one");
  assert.equal(JSON.parse(lines[1]).role, "assistant");
});

test("reload: a fresh instance over the same dataDir restores prior turns", async (t) => {
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
  await settle();
  await pa.teardown?.();

  const b = makeCtx(dataDir);
  const pb = plugin();
  await pb.setup(b.ctx);
  const turns = await conversation(b.actions);
  await pb.teardown?.();
  assert.ok(
    turns.some((m) => m.content === "remembered" && m.source === "web"),
    "the persisted user turn must reload from JSONL",
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
    JSON.stringify({ role: "user", content: "keep", source: "web", at: 1 }) +
      "\n" +
      JSON.stringify({ at: 2, kind: "user", text: "old-schema (no role/content)" }) +
      "\n" +
      "{ not json at all\n",
  );
  const h = makeCtx(dataDir);
  const p = plugin();
  await p.setup(h.ctx);
  const turns = await conversation(h.actions);
  await p.teardown?.();
  assert.equal(turns.length, 1, "only the well-formed turn loads");
  assert.equal(turns[0].content, "keep");
});

test("bounding: maxEntries keeps only the most recent turns", async (t) => {
  const { events, actions } = await setup(t, { maxEntries: 3 });
  for (let i = 0; i < 5; i++) input(events, `m${i}`, "web");
  await settle();
  const turns = await conversation(actions);
  assert.equal(turns.length, 3, "older turns are trimmed from the front");
  assert.deepEqual(turns.map((m) => m.content), ["m2", "m3", "m4"]);
});

// ===========================================================================
// 7. teardown
// ===========================================================================

test("teardown: unregisters conversation.get and stops folding events", async (t) => {
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
  assert.equal(h.actions.has(Actions.CONVERSATION_GET), true);
  await p.teardown?.();
  assert.equal(h.actions.has(Actions.CONVERSATION_GET), false, "action unregistered on teardown");
});
