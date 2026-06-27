import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../packages/orchestrator/src";
import { createEventSystem } from "../packages/event-system/src";
import { Events, Actions } from "../shared/actions";
import type { Reply } from "../shared/actions";
import type { ContextBlock } from "../contracts/context";
import type { Clock } from "../contracts/clock";
import type { Message } from "../contracts/llm";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
//
// BLACK-BOX edge tests against the `orchestrator` contract and its event-driven
// frame. We drive and observe only the public surface:
//   * the block store (setBlock/getBlock/removeBlock/listBlocks)
//   * start()/stop()
//   * the bus: emit CLOCK_TICK (→ a body-less LLM_REQUEST trigger), invoke the
//     PROMPT_COMPOSE action (→ PROMPT_GATHER then the composed {context, messages}),
//     emit LLM_RETURN (→ tool dispatch → TOOL_RESULT), and the CLOCK_* actions.
//
// METHOD B: the orchestrator no longer composes on tick or guards the LLM round-
// trip. A tick emits a TRIGGER (Notify<{agentId}>); the round-trip plugin (llm-core)
// owns serialization and pulls a freshly-composed body by invoking PROMPT_COMPOSE.
// So compose behaviour is exercised by INVOKING prompt.compose, not by reading an
// LLM_REQUEST body.
//
// A REAL event-system carries the bus. The clock is a stub: the frame is driven by
// the CLOCK_TICK *event*, not the clock object.

/** Minimal no-op clock. The frame is driven via the CLOCK_TICK event, not this. */
function stubClock(): Clock {
  return {
    start() {},
    stop() {},
    setInterval(_ms: number) {},
    setDefaultInterval(_ms: number) {},
    fireNow() {},
    onFire(_handler: () => void) {},
  };
}

/** Fresh, fully isolated orchestrator + event-system per test (stop() on teardown). */
function freshOrc(t: { after(fn: () => void): void }) {
  const sys = createEventSystem();
  const clock = stubClock();
  const orc = createOrchestrator({ agentId: "a1", events: sys, clock });
  t.after(() => {
    try {
      orc.stop();
    } catch {
      /* teardown must never throw */
    }
  });
  return { orc, sys, events: sys.events, actions: sys.actions, clock };
}

/** A render-able context block with a fixed string. */
function block(id: string, priority: number, text: string): ContextBlock {
  return { id, priority, render: () => text };
}

/** Let asynchronous bus chains flush before asserting. */
function settle(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A render() that returns a genuinely-REJECTING promise (pre-caught at the source
 *  so a non-isolating compose can't crash the runner as an unhandledRejection). */
function rejectingRender(message: string): () => Promise<string> {
  return () => {
    const p = Promise.reject<string>(new Error(message));
    p.catch(() => {});
    return p;
  };
}

/** The composed frame body, pulled ON DEMAND via the PROMPT_COMPOSE action. */
interface Composed {
  context: { text: string };
  messages: Message[];
}
async function composeNow(h: ReturnType<typeof freshOrc>): Promise<Composed> {
  return (await h.actions.invoke(Actions.PROMPT_COMPOSE)) as Composed;
}

/** Register a MESSAGE-target block whose render() returns `messages` as its group. */
function setMessageBlock(
  orc: ReturnType<typeof freshOrc>["orc"],
  id: string,
  priority: number,
  messages: Message[],
): void {
  orc.setBlock({ id, priority, target: "messages", render: () => messages });
}

// ===========================================================================
// Factory / shape
// ===========================================================================

test("createOrchestrator returns an object exposing the full contract surface", (t) => {
  const { orc } = freshOrc(t);
  assert.equal(typeof orc, "object");
  assert.equal(typeof orc.start, "function");
  assert.equal(typeof orc.stop, "function");
  assert.equal(typeof orc.setBlock, "function");
  assert.equal(typeof orc.getBlock, "function");
  assert.equal(typeof orc.removeBlock, "function");
  assert.equal(typeof orc.listBlocks, "function");
});

test("each createOrchestrator yields an independent block store", (t) => {
  const a = freshOrc(t);
  const b = freshOrc(t);
  a.orc.setBlock(block("only-a", 1, "A"));
  assert.ok(a.orc.getBlock("only-a"));
  assert.equal(b.orc.getBlock("only-a"), undefined);
  assert.deepEqual(b.orc.listBlocks(), []);
});

// ===========================================================================
// Behavior 1 — block store
// ===========================================================================

test("block store: setBlock then getBlock returns the same block", (t) => {
  const { orc } = freshOrc(t);
  const b = block("a", 10, "A");
  orc.setBlock(b);
  const got = orc.getBlock("a");
  assert.ok(got);
  assert.equal(got!.id, "a");
  assert.equal(got!.priority, 10);
  assert.equal(got!.render(), "A");
});

test("block store: listBlocks returns id+priority summaries", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 10, "A"));
  assert.deepEqual(orc.listBlocks(), [{ id: "a", priority: 10 }]);
});

test("block store: getBlock for an unknown id returns undefined", (t) => {
  const { orc } = freshOrc(t);
  assert.equal(orc.getBlock("missing"), undefined);
});

test("block store: removeBlock returns true then getBlock is undefined", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 10, "A"));
  assert.equal(orc.removeBlock("a"), true);
  assert.equal(orc.getBlock("a"), undefined);
  assert.deepEqual(orc.listBlocks(), []);
});

test("block store: removeBlock of a missing id returns false", (t) => {
  const { orc } = freshOrc(t);
  assert.equal(orc.removeBlock("missing"), false);
});

test("block store: removeBlock twice — second call returns false (idempotent)", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 1, "A"));
  assert.equal(orc.removeBlock("a"), true);
  assert.equal(orc.removeBlock("a"), false);
});

test("block store: setBlock with an existing id REPLACES the prior block", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 10, "first"));
  orc.setBlock(block("a", 99, "second"));
  const got = orc.getBlock("a");
  assert.equal(got!.priority, 99);
  assert.equal(got!.render(), "second");
  assert.deepEqual(orc.listBlocks(), [{ id: "a", priority: 99 }]);
});

test("block store: multiple distinct ids coexist and all appear in listBlocks", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 1, "A"));
  orc.setBlock(block("b", 2, "B"));
  orc.setBlock(block("c", 3, "C"));
  assert.deepEqual(orc.listBlocks().map((e) => e.id).sort(), ["a", "b", "c"]);
});

test("block store: removing one id leaves the others intact", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 1, "A"));
  orc.setBlock(block("b", 2, "B"));
  assert.equal(orc.removeBlock("a"), true);
  assert.ok(orc.getBlock("b"));
  assert.deepEqual(orc.listBlocks(), [{ id: "b", priority: 2 }]);
});

test("block store: zero / negative / fixed-tier priorities are stored verbatim", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("zero", 0, "Z"));
  orc.setBlock(block("neg", -5, "N"));
  orc.setBlock(block("fixed", 10000, "F"));
  assert.equal(orc.getBlock("zero")!.priority, 0);
  assert.equal(orc.getBlock("neg")!.priority, -5);
  assert.equal(orc.getBlock("fixed")!.priority, 10000);
});

test("block store: empty-string id is a usable, distinct key", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("", 1, "EMPTY"));
  assert.ok(orc.getBlock(""));
  assert.equal(orc.removeBlock(""), true);
  assert.equal(orc.getBlock(""), undefined);
});

// ===========================================================================
// Behavior 2 — a tick emits a TRIGGER (no body, no gather)
// ===========================================================================

test("frame: after start(), one CLOCK_TICK emits exactly one LLM_REQUEST trigger carrying {agentId}", async (t) => {
  const { orc, events } = freshOrc(t);
  const triggers: Array<{ at?: unknown; data?: { agentId?: unknown } }> = [];
  events.on(Events.LLM_REQUEST, (p) => triggers.push(p as never));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(triggers.length, 1, "exactly one LLM_REQUEST per tick");
  assert.equal(typeof triggers[0].at, "number", "Notify envelope carries a numeric at");
  assert.equal(triggers[0].data!.agentId, "a1", "the trigger stamps this Agent's id (the lock key)");
});

test("frame: the LLM_REQUEST trigger carries NO composed body (it is body-less)", async (t) => {
  const { orc, events } = freshOrc(t);
  let payload: { data?: Record<string, unknown> } | undefined;
  events.on(Events.LLM_REQUEST, (p) => {
    payload = p as never;
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.ok(payload, "trigger fired");
  assert.equal("context" in (payload!.data ?? {}), false, "no composed context on the trigger");
  assert.equal("messages" in (payload!.data ?? {}), false, "no messages on the trigger");
});

test("frame: a tick emits NO PROMPT_GATHER (compose happens on demand, not on tick)", async (t) => {
  const { orc, events } = freshOrc(t);
  let gather = 0;
  events.on(Events.PROMPT_GATHER, () => gather++);

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(gather, 0, "a tick alone must not gather/compose — it only triggers");
});

test("frame: a tick BEFORE start() produces no LLM_REQUEST (not subscribed yet)", async (t) => {
  const { events } = freshOrc(t);
  let count = 0;
  events.on(Events.LLM_REQUEST, () => count++);
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(count, 0);
});

// ===========================================================================
// Behavior 3 — prompt.compose: gather THEN compose, returns {context, messages}
// ===========================================================================

test("prompt.compose: invoking it emits exactly one PROMPT_GATHER and resolves {context,messages}", async (t) => {
  const h = freshOrc(t);
  let gather = 0;
  h.events.on(Events.PROMPT_GATHER, () => gather++);

  h.orc.start();
  const r = await composeNow(h);

  assert.equal(gather, 1, "exactly one PROMPT_GATHER per compose");
  assert.equal(typeof r.context.text, "string", "context.text is a string");
  assert.ok(Array.isArray(r.messages), "messages is an array");
});

test("prompt.compose: PROMPT_GATHER runs BEFORE compose — a block added in the gather handler appears", async (t) => {
  const h = freshOrc(t);
  h.events.on(Events.PROMPT_GATHER, () => {
    h.orc.setBlock({ id: "dyn", priority: 5, render: () => "DYN" });
  });

  h.orc.start();
  const r = await composeNow(h);

  assert.ok(r.context.text.includes("DYN"), "a block added during gather must be composed");
});

// ===========================================================================
// Behavior 4 — compose orders by priority DESC and wraps each block in <label>
// ===========================================================================

test("compose: blocks are ordered by priority DESC and each wrapped in its label", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("top", 100, "TOP"));
  h.orc.setBlock(block("bot", 1, "bot"));
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<top>\nTOP\n</top>\n\n<bot>\nbot\n</bot>");
});

test("compose: ordering is by priority value regardless of insertion order", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("mid", 50, "MID"));
  h.orc.setBlock(block("hi", 100, "HI"));
  h.orc.setBlock(block("lo", 1, "LO"));
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<hi>\nHI\n</hi>\n\n<mid>\nMID\n</mid>\n\n<lo>\nLO\n</lo>");
});

test("compose: a single block composes to exactly that block's text (no stray separators)", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("only", 7, "ONLY"));
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<only>\nONLY\n</only>");
});

test("compose: with no blocks the composed context text is the empty string", async (t) => {
  const h = freshOrc(t);
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "");
  assert.deepEqual(r.messages, []);
});

test("compose: a render() returning a Promise is awaited and its resolved text included", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock({ id: "async", priority: 10, render: () => Promise.resolve("async") });
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<async>\nasync\n</async>");
});

test("compose: mixes sync and async renders, preserving priority order", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("sync-top", 100, "SYNC"));
  h.orc.setBlock({
    id: "async-bot",
    priority: 1,
    render: () => new Promise<string>((r) => setTimeout(() => r("ASYNC"), 1)),
  });
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<sync-top>\nSYNC\n</sync-top>\n\n<async-bot>\nASYNC\n</async-bot>");
});

test("compose: a block is wrapped in its NOMINATED label, not its id", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock({ id: "persona", label: "identity", priority: 100, render: () => "I am X" });
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<identity>\nI am X\n</identity>");
});

test("compose: a block WITHOUT a label falls back to wrapping with its id", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("notes", 100, "NOTE"));
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<notes>\nNOTE\n</notes>");
});

test("compose: an empty-rendering block contributes NOTHING (no empty wrapper, no stray separators)", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("top", 100, "TOP"));
  h.orc.setBlock(block("blank", 50, ""));
  h.orc.setBlock(block("bot", 1, "BOT"));
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<top>\nTOP\n</top>\n\n<bot>\nBOT\n</bot>");
});

// ===========================================================================
// Behavior 5 — messages from message-target blocks
// ===========================================================================

test("messages: a single message-target block's Message[] becomes data.messages (field-for-field)", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("persona", 100, "I am X"));
  setMessageBlock(h.orc, "conv", 5000, [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "weather?", name: "web-chat" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "get_weather", arguments: { city: "SF" } }],
    },
    { role: "tool", content: "72F", toolCallId: "tc1", name: "get_weather" },
  ]);
  h.orc.start();
  const r = await composeNow(h);
  assert.deepEqual(r.messages, [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "weather?", name: "web-chat" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "get_weather", arguments: { city: "SF" } }],
    },
    { role: "tool", content: "72F", toolCallId: "tc1", name: "get_weather" },
  ]);
  assert.equal(r.context.text, "<persona>\nI am X\n</persona>");
});

test("messages: the order WITHIN a group is preserved (orchestrator never reorders a group)", async (t) => {
  const h = freshOrc(t);
  setMessageBlock(h.orc, "conv", 5000, [
    { role: "assistant", content: "third" },
    { role: "user", content: "first" },
    { role: "user", content: "second" },
  ]);
  h.orc.start();
  const r = await composeNow(h);
  assert.deepEqual(r.messages.map((m) => m.content), ["third", "first", "second"]);
});

test("messages: multiple message-blocks concatenate by priority DESC, each group contiguous", async (t) => {
  const h = freshOrc(t);
  setMessageBlock(h.orc, "a", 100, [
    { role: "user", content: "a1" },
    { role: "user", content: "a2" },
  ]);
  setMessageBlock(h.orc, "b", 300, [{ role: "user", content: "b1" }]);
  setMessageBlock(h.orc, "c", 200, [{ role: "user", content: "c1" }]);
  h.orc.start();
  const r = await composeNow(h);
  assert.deepEqual(r.messages.map((m) => m.content), ["b1", "c1", "a1", "a2"]);
});

test("messages: a message-block rendering [] contributes no messages", async (t) => {
  const h = freshOrc(t);
  setMessageBlock(h.orc, "empty", 200, []);
  setMessageBlock(h.orc, "real", 100, [{ role: "user", content: "real" }]);
  h.orc.start();
  const r = await composeNow(h);
  assert.deepEqual(r.messages.map((m) => m.content), ["real"]);
});

test("messages: NO message-target blocks => data.messages is [] (not undefined)", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("persona", 100, "I am X"));
  h.orc.start();
  const r = await composeNow(h);
  assert.ok(Array.isArray(r.messages));
  assert.deepEqual(r.messages, []);
});

test("messages: system + message blocks split cleanly (system->context.text, messages->data.messages)", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("persona", 100, "I am X"));
  setMessageBlock(h.orc, "conv", 5000, [{ role: "user", content: "hi", name: "web-chat" }]);
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<persona>\nI am X\n</persona>");
  assert.ok(!r.context.text.includes("hi"), "a message-block's content must NOT leak into context.text");
  assert.deepEqual(r.messages, [{ role: "user", content: "hi", name: "web-chat" }]);
});

test("messages: default target is 'system' — an untargeted block renders into context.text, not messages", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("persona", 100, "I am X"));
  h.orc.start();
  const r = await composeNow(h);
  assert.ok(r.context.text.includes("<persona>\nI am X\n</persona>"));
  assert.deepEqual(r.messages, []);
});

test("messages: a message-block whose render returns a NON-array is ignored (no messages)", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock({
    id: "bad",
    priority: 5000,
    target: "messages",
    render: () => "oops" as unknown as Message[],
  });
  h.orc.start();
  const r = await composeNow(h);
  assert.deepEqual(r.messages, []);
});

test("messages: a message-block whose render THROWS contributes no messages; others survive (degradation)", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock({
    id: "boom",
    priority: 9000,
    target: "messages",
    render: () => {
      throw new Error("x");
    },
  });
  setMessageBlock(h.orc, "ok", 100, [{ role: "user", content: "survived" }]);
  h.orc.start();
  const r = await composeNow(h);
  assert.deepEqual(r.messages.map((m) => m.content), ["survived"]);
});

test("compose: re-rendered each time — reflects block-store edits between composes", async (t) => {
  const h = freshOrc(t);
  let turns: Message[] = [{ role: "user", content: "t1" }];
  h.orc.setBlock({ id: "conv", priority: 5000, target: "messages", render: () => turns });
  h.orc.setBlock(block("a", 100, "A1"));
  h.orc.start();

  const r1 = await composeNow(h);
  assert.equal(r1.context.text, "<a>\nA1\n</a>");
  assert.deepEqual(r1.messages.map((m) => m.content), ["t1"]);

  // Mutate the store between composes.
  turns = [{ role: "user", content: "t2" }];
  h.orc.setBlock(block("a", 100, "A2"));
  assert.equal(h.orc.removeBlock("conv"), true);

  const r2 = await composeNow(h);
  assert.equal(r2.context.text, "<a>\nA2\n</a>", "re-composed with the replacement");
  assert.deepEqual(r2.messages, [], "the removed message-block no longer contributes");
});

// ===========================================================================
// Behavior 6 — per-block render ISOLATION
// ===========================================================================

test("isolation: a block whose render() REJECTS degrades to empty text; the good block survives", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("good", 100, "GOOD"));
  h.orc.setBlock({ id: "rejects", priority: 50, render: rejectingRender("render rejected") });
  h.orc.start();
  const r = await composeNow(h);
  assert.ok(r.context.text.includes("GOOD"));
  assert.ok(!r.context.text.includes("render rejected"));
});

test("isolation: a block whose render() THROWS synchronously degrades to empty; siblings survive", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("good", 100, "GOOD"));
  h.orc.setBlock({
    id: "throws",
    priority: 50,
    render: () => {
      throw new Error("sync render blew up");
    },
  });
  h.orc.start();
  const r = await composeNow(h);
  assert.ok(r.context.text.includes("GOOD"));
});

test("compose: a throwing PROMPT_GATHER listener does not abort compose", async (t) => {
  const h = freshOrc(t);
  h.orc.setBlock(block("base", 10, "BASE"));
  h.events.on(Events.PROMPT_GATHER, () => {
    throw new Error("gather listener exploded");
  });
  h.orc.start();
  const r = await composeNow(h);
  assert.equal(r.context.text, "<base>\nBASE\n</base>");
});

// ===========================================================================
// Behavior 7 — LLM_RETURN dispatches tool calls onto the action bus
// ===========================================================================

test("dispatch: LLM_RETURN with toolCalls invokes the matching action with its arguments", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let received: unknown = "unset";
  actions.register("tool.x", async (params) => {
    received = params;
    return "ok";
  });
  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "1",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "t", name: "tool.x", arguments: { q: 1 } }] },
  });
  await settle();
  assert.deepEqual(received, { q: 1 });
});

test("dispatch: multiple toolCalls each invoke their corresponding action", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  const calls: Array<{ name: string; params: unknown }> = [];
  actions.register("tool.a", async (params) => {
    calls.push({ name: "tool.a", params });
    return 1;
  });
  actions.register("tool.b", async (params) => {
    calls.push({ name: "tool.b", params });
    return 2;
  });
  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "1",
    at: 0,
    ok: true,
    data: {
      content: "",
      toolCalls: [
        { id: "t1", name: "tool.a", arguments: { a: true } },
        { id: "t2", name: "tool.b", arguments: { b: 9 } },
      ],
    },
  });
  await settle();
  const byName = Object.fromEntries(calls.map((c) => [c.name, c.params]));
  assert.deepEqual(byName["tool.a"], { a: true });
  assert.deepEqual(byName["tool.b"], { b: 9 });
  assert.equal(calls.length, 2);
});

test("dispatch: a tool call naming an UNregistered action does not throw the frame", async (t) => {
  const { orc, events } = freshOrc(t);
  orc.start();
  assert.doesNotThrow(() =>
    events.emit(Events.LLM_RETURN, {
      id: "1",
      at: 0,
      ok: true,
      data: { content: "", toolCalls: [{ id: "t", name: "tool.unregistered", arguments: {} }] },
    }),
  );
  await settle();
  assert.ok(true);
});

test("dispatch: LLM_RETURN with ok:false dispatches no tool calls", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let invoked = false;
  actions.register("tool.x", async () => {
    invoked = true;
    return "ok";
  });
  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "1",
    at: 0,
    ok: false,
    error: "model failed",
    data: { content: "", toolCalls: [{ id: "t", name: "tool.x", arguments: { q: 1 } }] },
  });
  await settle();
  assert.equal(invoked, false);
});

test("dispatch: LLM_RETURN ok:true but WITHOUT toolCalls dispatches nothing and does not throw", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let invoked = false;
  actions.register("tool.x", async () => {
    invoked = true;
    return "ok";
  });
  orc.start();
  assert.doesNotThrow(() =>
    events.emit(Events.LLM_RETURN, { id: "1", at: 0, ok: true, data: { content: "just text" } }),
  );
  await settle();
  assert.equal(invoked, false);
});

test("dispatch: LLM_RETURN ok:true with an EMPTY toolCalls array dispatches nothing", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let invoked = false;
  actions.register("tool.x", async () => {
    invoked = true;
    return "ok";
  });
  orc.start();
  events.emit(Events.LLM_RETURN, { id: "1", at: 0, ok: true, data: { content: "", toolCalls: [] } });
  await settle();
  assert.equal(invoked, false);
});

test("dispatch: a tick (no LLM_RETURN) never invokes a tool action on its own", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let invoked = false;
  actions.register("tool.x", async () => {
    invoked = true;
    return "ok";
  });
  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(invoked, false);
});

test("dispatch: a rejecting tool call does not prevent a sibling tool call from running", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let goodRan = false;
  actions.register("tool.bad", async () => {
    throw new Error("tool blew up");
  });
  actions.register("tool.good", async (params) => {
    goodRan = true;
    return params;
  });
  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "1",
    at: 0,
    ok: true,
    data: {
      content: "",
      toolCalls: [
        { id: "b", name: "tool.bad", arguments: { x: 1 } },
        { id: "g", name: "tool.good", arguments: { y: 2 } },
      ],
    },
  });
  await settle();
  assert.equal(goodRan, true);
});

// ===========================================================================
// Behavior 8 — lifecycle: stop() unsubscribes; start()/stop() idempotent
// ===========================================================================

test("lifecycle: after stop(), a CLOCK_TICK produces NO new LLM_REQUEST", async (t) => {
  const { orc, events } = freshOrc(t);
  let count = 0;
  events.on(Events.LLM_REQUEST, () => count++);
  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(count, 1);
  orc.stop();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });
  await settle();
  assert.equal(count, 1);
});

test("lifecycle: after stop(), an LLM_RETURN no longer dispatches tools", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let invoked = 0;
  actions.register("tool.x", async () => {
    invoked++;
    return "ok";
  });
  orc.start();
  orc.stop();
  events.emit(Events.LLM_RETURN, {
    id: "1",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "t", name: "tool.x", arguments: {} }] },
  });
  await settle();
  assert.equal(invoked, 0);
});

test("lifecycle: after stop(), the PROMPT_COMPOSE action is unregistered", (t) => {
  const { orc, actions } = freshOrc(t);
  orc.start();
  assert.equal(actions.has(Actions.PROMPT_COMPOSE), true, "registered while started");
  orc.stop();
  assert.equal(actions.has(Actions.PROMPT_COMPOSE), false, "unregistered on stop()");
});

test("lifecycle: start() is idempotent — a single tick still yields exactly one LLM_REQUEST", async (t) => {
  const { orc, events } = freshOrc(t);
  let count = 0;
  events.on(Events.LLM_REQUEST, () => count++);
  orc.start();
  orc.start();
  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(count, 1, "redundant start() must not double-subscribe");
});

test("lifecycle: stop() is idempotent and safe to call when never started", (t) => {
  const { orc } = freshOrc(t);
  assert.doesNotThrow(() => orc.stop());
  assert.doesNotThrow(() => orc.stop());
});

test("lifecycle: stop() then start() resumes frames (re-subscription works)", async (t) => {
  const { orc, events } = freshOrc(t);
  let count = 0;
  events.on(Events.LLM_REQUEST, () => count++);
  orc.start();
  orc.stop();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(count, 0);
  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });
  await settle();
  assert.equal(count, 1);
});

// ===========================================================================
// Behavior 9 — clock rhythm actions registered while started
// ===========================================================================

function recordingClock(): Clock & {
  setIntervalCalls: number[];
  setDefaultIntervalCalls: number[];
  fireNowCalls: number;
} {
  const rec = {
    setIntervalCalls: [] as number[],
    setDefaultIntervalCalls: [] as number[],
    fireNowCalls: 0,
    start() {},
    stop() {},
    setInterval(ms: number) {
      rec.setIntervalCalls.push(ms);
    },
    setDefaultInterval(ms: number) {
      rec.setDefaultIntervalCalls.push(ms);
    },
    fireNow() {
      rec.fireNowCalls++;
    },
    onFire(_handler: () => void) {},
  };
  return rec;
}

function orcWithRecordingClock(t: { after(fn: () => void): void }) {
  const sys = createEventSystem();
  const clock = recordingClock();
  const orc = createOrchestrator({ agentId: "a1", events: sys, clock });
  t.after(() => {
    try {
      orc.stop();
    } catch {
      /* teardown must never throw */
    }
  });
  return { orc, sys, events: sys.events, actions: sys.actions, clock };
}

test("clock actions: after start(), the three CLOCK_* actions are registered on the actionbus", (t) => {
  const { orc, actions } = orcWithRecordingClock(t);
  orc.start();
  assert.equal(actions.has(Actions.CLOCK_SET_INTERVAL), true);
  assert.equal(actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL), true);
  assert.equal(actions.has(Actions.CLOCK_FIRE_NOW), true);
});

test("clock actions: invoking clock.set_interval {ms:50} forwards to clock.setInterval(50)", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms: 50 });
  assert.deepEqual(clock.setIntervalCalls, [50]);
  assert.equal(clock.setDefaultIntervalCalls.length, 0);
  assert.equal(clock.fireNowCalls, 0);
});

test("clock actions: invoking clock.set_default_interval {ms:200} forwards to clock.setDefaultInterval(200)", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_SET_DEFAULT_INTERVAL, { ms: 200 });
  assert.deepEqual(clock.setDefaultIntervalCalls, [200]);
  assert.equal(clock.setIntervalCalls.length, 0);
});

test("clock actions: invoking clock.fire_now (no params) forwards to clock.fireNow()", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_FIRE_NOW);
  assert.equal(clock.fireNowCalls, 1);
});

test("clock actions: a positive boundary ms (1) is forwarded verbatim", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms: 1 });
  assert.deepEqual(clock.setIntervalCalls, [1]);
});

for (const [label, params] of [
  ["{} (missing ms)", {}],
  ["{ms:-1}", { ms: -1 }],
  ["{ms:0}", { ms: 0 }],
  ["undefined", undefined],
] as Array<[string, unknown]>) {
  test(`clock actions: set_interval with ${label} REJECTS and does not touch the clock`, async (t) => {
    const { orc, actions, clock } = orcWithRecordingClock(t);
    orc.start();
    await assert.rejects(() => actions.invoke(Actions.CLOCK_SET_INTERVAL, params));
    assert.equal(clock.setIntervalCalls.length, 0);
  });
}

test("clock actions: after stop(), the three CLOCK_* actions are NO LONGER registered", (t) => {
  const { orc, actions } = orcWithRecordingClock(t);
  orc.start();
  orc.stop();
  assert.equal(actions.has(Actions.CLOCK_SET_INTERVAL), false);
  assert.equal(actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL), false);
  assert.equal(actions.has(Actions.CLOCK_FIRE_NOW), false);
});

test("clock actions: a stop()/start() cycle RE-REGISTERS the actions and they still forward", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  orc.stop();
  assert.doesNotThrow(() => orc.start());
  assert.equal(actions.has(Actions.CLOCK_FIRE_NOW), true);
  await actions.invoke(Actions.CLOCK_FIRE_NOW);
  assert.equal(clock.fireNowCalls, 1);
});

// ===========================================================================
// Behavior 10 — LLM_RETURN robustness against undefined / null payloads
// ===========================================================================

test("dispatch: LLM_RETURN with an UNDEFINED payload dispatches nothing and does not throw", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let invoked = false;
  actions.register("tool.x", async () => {
    invoked = true;
    return "ok";
  });
  orc.start();
  assert.doesNotThrow(() => events.emit(Events.LLM_RETURN, undefined));
  await settle();
  assert.equal(invoked, false);
});

test("dispatch: LLM_RETURN with a NULL payload dispatches nothing and does not throw", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let invoked = false;
  actions.register("tool.x", async () => {
    invoked = true;
    return "ok";
  });
  orc.start();
  assert.doesNotThrow(() => events.emit(Events.LLM_RETURN, null));
  await settle();
  assert.equal(invoked, false);
});

test("dispatch: after a malformed return, the NEXT tick still emits LLM_REQUEST and a valid return still dispatches", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let count = 0;
  let goodCalls = 0;
  events.on(Events.LLM_REQUEST, () => count++);
  actions.register("tool.good", async () => {
    goodCalls++;
    return "ok";
  });
  orc.start();
  events.emit(Events.LLM_RETURN, undefined);
  events.emit(Events.LLM_RETURN, null);
  await settle();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  events.emit(Events.LLM_RETURN, {
    id: "2",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "g", name: "tool.good", arguments: {} }] },
  });
  await settle();
  assert.equal(count, 1, "a malformed return must not break the subsequent frame");
  assert.equal(goodCalls, 1, "dispatch continues to work after a malformed return");
});

// ===========================================================================
// Behavior 11 — tool.result emission as each dispatched call settles
// ===========================================================================

function captureToolResults(events: ReturnType<typeof freshOrc>["events"]): {
  all: Array<Reply<unknown> & { name: string }>;
  byId(id: string): (Reply<unknown> & { name: string }) | undefined;
} {
  const all: Array<Reply<unknown> & { name: string }> = [];
  events.on(Events.TOOL_RESULT, (payload) => {
    all.push(payload as Reply<unknown> & { name: string });
  });
  return { all, byId: (id) => all.find((r) => r.id === id) };
}

test("tool.result: a successful tool call emits one tool.result with id/name/ok:true and the resolved data", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  const results = captureToolResults(events);
  actions.register("tool.x", async () => ({ answer: 42 }));
  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "ret-1",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "call-x", name: "tool.x", arguments: { q: 1 } }] },
  });
  await settle();
  assert.equal(results.all.length, 1);
  const r = results.byId("call-x");
  assert.ok(r);
  assert.equal(r!.id, "call-x");
  assert.equal(r!.name, "tool.x");
  assert.equal(r!.ok, true);
  assert.deepEqual(r!.data, { answer: 42 });
});

test("tool.result: a rejecting call emits ok:false + error; its sibling success still emits its own ok result", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  const results = captureToolResults(events);
  actions.register("tool.bad", async () => {
    throw new Error("tool blew up");
  });
  actions.register("tool.good", async () => "GOOD-VALUE");
  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "ret-1",
    at: 0,
    ok: true,
    data: {
      content: "",
      toolCalls: [
        { id: "call-bad", name: "tool.bad", arguments: { x: 1 } },
        { id: "call-good", name: "tool.good", arguments: { y: 2 } },
      ],
    },
  });
  await settle();
  assert.equal(results.all.length, 2);
  const bad = results.byId("call-bad");
  assert.equal(bad!.ok, false);
  assert.ok((bad!.error ?? "").length > 0);
  const good = results.byId("call-good");
  assert.equal(good!.ok, true);
  assert.equal(good!.data, "GOOD-VALUE");
});

test("tool.result: an UNKNOWN action name emits ok:false (invoke rejects) rather than nothing", async (t) => {
  const { orc, events } = freshOrc(t);
  const results = captureToolResults(events);
  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "ret-1",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "call-missing", name: "tool.unregistered", arguments: {} }] },
  });
  await settle();
  assert.equal(results.all.length, 1);
  const r = results.byId("call-missing");
  assert.equal(r!.name, "tool.unregistered");
  assert.equal(r!.ok, false);
  assert.ok((r!.error ?? "").length > 0);
});

test("tool.result: after stop(), a late llm.return produces NO tool.result", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  const results = captureToolResults(events);
  let invoked = 0;
  actions.register("tool.x", async () => {
    invoked++;
    return "ok";
  });
  orc.start();
  orc.stop();
  events.emit(Events.LLM_RETURN, {
    id: "ret-late",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "call-x", name: "tool.x", arguments: {} }] },
  });
  await settle();
  assert.equal(invoked, 0);
  assert.equal(results.all.length, 0);
});
