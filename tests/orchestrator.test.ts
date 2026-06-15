import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../packages/orchestrator/src";
import { createEventSystem } from "../packages/event-system/src";
import { Events, Actions } from "../shared/actions";
import type { Reply } from "../shared/actions";
import type { ContextBlock } from "../contracts/context";
import type { Clock } from "../contracts/clock";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
//
// These are BLACK-BOX edge tests against the `orchestrator` contract and its
// event-driven beat. We never assume implementation internals — we only drive
// and observe the public surface:
//   * the block store (setBlock/getBlock/removeBlock/listBlocks)
//   * start()/stop()
//   * the bus: emit CLOCK_TICK / LLM_RETURN, observe PROMPT_GATHER / LLM_REQUEST,
//     register/observe actions for tool dispatch.
//
// A REAL event-system is used so the bus actually carries the beat. The clock is
// a minimal stub: the orchestrator stores it but the beat is triggered by the
// CLOCK_TICK *event*, not by the clock object — so the stub never needs to fire.

/** Minimal no-op clock. The beat is driven via the CLOCK_TICK event, not this. */
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

/**
 * Fresh, fully isolated orchestrator + event-system per test. Registers a
 * teardown that always calls stop() (also exercising stop()-when-never-started
 * and double-stop idempotency, and preventing dangling subscriptions leaking
 * across tests since each gets its OWN event-system anyway).
 */
function freshOrc(t: { after(fn: () => void): void }) {
  const sys = createEventSystem();
  const clock = stubClock();
  const orc = createOrchestrator({ events: sys, clock });
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

/** Let the asynchronous beat (block render + compose) flush before asserting. */
function settle(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A render() that returns a genuinely-REJECTING promise — but the test keeps its
 * own reference and pre-attaches a no-op `.catch` so a buggy (non-isolating)
 * orchestrator that forgets to await/catch the block cannot turn this into a
 * process-level unhandledRejection that the runner would attribute to an arbitrary
 * test. The promise still rejects, so a correct compose() must catch it and degrade
 * the block to ""; the assertions on the composed text decide pass/fail. This keeps
 * the test BLACK-BOX (we hand the orchestrator a rejecting render) while failing on
 * a real assertion rather than a harness-level crash.
 */
function rejectingRender(message: string): () => Promise<string> {
  return () => {
    const p = Promise.reject<string>(new Error(message));
    p.catch(() => {
      /* swallow at the source so the test never leaks a free-floating rejection */
    });
    return p;
  };
}

/**
 * Capture every LLM_REQUEST payload's composed context text. Returns the live
 * array (newest pushed last). The orchestrator emits LLM_REQUEST with a
 * Request<{ context: ComposedContext }> payload: { id, at, data: { context } }.
 */
function captureContextTexts(events: ReturnType<typeof freshOrc>["events"]): string[] {
  const texts: string[] = [];
  events.on(Events.LLM_REQUEST, (payload) => {
    const p = payload as { data?: { context?: { text?: unknown } } };
    texts.push(String(p?.data?.context?.text));
  });
  return texts;
}

// ===========================================================================
// Factory / shape
// ===========================================================================

test("createOrchestrator returns an object exposing the full contract surface", (t) => {
  const { orc } = freshOrc(t);
  assert.ok(orc, "factory should return a value");
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
  assert.ok(a.orc.getBlock("only-a"), "a should have its own block");
  assert.equal(b.orc.getBlock("only-a"), undefined, "b must not observe a's block");
  assert.deepEqual(b.orc.listBlocks(), [], "b's store should be empty");
});

// ===========================================================================
// Behavior 1 — block store (setBlock / getBlock / removeBlock / listBlocks)
// ===========================================================================

// --- positive ---------------------------------------------------------------

test("block store: setBlock then getBlock returns the same block", (t) => {
  const { orc } = freshOrc(t);
  const b = block("a", 10, "A");
  orc.setBlock(b);
  const got = orc.getBlock("a");
  assert.ok(got, "getBlock should return the stored block");
  assert.equal(got!.id, "a");
  assert.equal(got!.priority, 10);
  assert.equal(typeof got!.render, "function");
  assert.equal(got!.render(), "A", "render should be preserved");
});

test("block store: listBlocks returns id+priority summaries", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 10, "A"));
  const list = orc.listBlocks();
  assert.equal(list.length, 1);
  assert.deepEqual(list, [{ id: "a", priority: 10 }]);
});

test("block store: getBlock for an unknown id returns undefined", (t) => {
  const { orc } = freshOrc(t);
  assert.equal(orc.getBlock("missing"), undefined);
});

// --- state transitions ------------------------------------------------------

test("block store: removeBlock returns true then getBlock is undefined", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 10, "A"));
  assert.equal(orc.removeBlock("a"), true, "removing an existing block returns true");
  assert.equal(orc.getBlock("a"), undefined, "removed block should be gone");
  assert.deepEqual(orc.listBlocks(), [], "list should be empty after removal");
});

test("block store: removeBlock of a missing id returns false", (t) => {
  const { orc } = freshOrc(t);
  assert.equal(orc.removeBlock("missing"), false);
});

test("block store: removeBlock twice — second call returns false (idempotent removal)", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 1, "A"));
  assert.equal(orc.removeBlock("a"), true);
  assert.equal(orc.removeBlock("a"), false, "second removal of same id should be false");
});

test("block store: setBlock with an existing id REPLACES the prior block", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 10, "first"));
  orc.setBlock(block("a", 99, "second"));

  const got = orc.getBlock("a");
  assert.equal(got!.priority, 99, "priority should be the replacement's");
  assert.equal(got!.render(), "second", "render should be the replacement's");

  const list = orc.listBlocks();
  assert.equal(list.length, 1, "replacing must not create a duplicate entry");
  assert.deepEqual(list, [{ id: "a", priority: 99 }]);
});

test("block store: multiple distinct ids coexist and all appear in listBlocks", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 1, "A"));
  orc.setBlock(block("b", 2, "B"));
  orc.setBlock(block("c", 3, "C"));

  const ids = orc.listBlocks().map((e) => e.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(orc.getBlock("b")!.render(), "B");
});

test("block store: removing one id leaves the others intact", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("a", 1, "A"));
  orc.setBlock(block("b", 2, "B"));

  assert.equal(orc.removeBlock("a"), true);
  assert.equal(orc.getBlock("a"), undefined);
  assert.ok(orc.getBlock("b"), "unrelated block should survive");
  assert.deepEqual(orc.listBlocks(), [{ id: "b", priority: 2 }]);
});

// --- BVA — priority + id edge values ---------------------------------------

test("block store: zero / negative / fixed-tier (10000+) priorities are stored verbatim", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("zero", 0, "Z"));
  orc.setBlock(block("neg", -5, "N"));
  orc.setBlock(block("fixed", 10000, "F"));
  orc.setBlock(block("big", 999999, "B"));

  assert.equal(orc.getBlock("zero")!.priority, 0);
  assert.equal(orc.getBlock("neg")!.priority, -5);
  assert.equal(orc.getBlock("fixed")!.priority, 10000);
  assert.equal(orc.getBlock("big")!.priority, 999999);
});

test("block store: empty-string id is a usable, distinct key", (t) => {
  const { orc } = freshOrc(t);
  orc.setBlock(block("", 1, "EMPTY"));
  assert.ok(orc.getBlock(""), "empty-string id should be retrievable");
  assert.equal(orc.getBlock("")!.render(), "EMPTY");
  assert.deepEqual(orc.listBlocks(), [{ id: "", priority: 1 }]);
  assert.equal(orc.removeBlock(""), true);
  assert.equal(orc.getBlock(""), undefined);
});

// ===========================================================================
// Behavior 2 — start() + CLOCK_TICK emits exactly one PROMPT_GATHER + one LLM_REQUEST
// ===========================================================================

test("beat: after start(), one CLOCK_TICK emits exactly one PROMPT_GATHER and one LLM_REQUEST", async (t) => {
  const { orc, events } = freshOrc(t);
  let gatherCount = 0;
  let requestCount = 0;
  events.on(Events.PROMPT_GATHER, () => {
    gatherCount++;
  });
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(gatherCount, 1, "exactly one PROMPT_GATHER per tick");
  assert.equal(requestCount, 1, "exactly one LLM_REQUEST per tick");
});

test("beat: LLM_REQUEST payload carries a composed context with a string .text", async (t) => {
  const { orc, events } = freshOrc(t);
  let payload: unknown;
  events.on(Events.LLM_REQUEST, (p) => {
    payload = p;
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  const p = payload as { data?: { context?: { text?: unknown } } };
  assert.ok(p, "LLM_REQUEST should have fired");
  assert.ok(p.data, "payload should follow the Request envelope (has .data)");
  assert.ok(p.data!.context, "payload.data should contain a composed context");
  assert.equal(typeof p.data!.context!.text, "string", "context.text must be a string");
});

test("beat: a tick BEFORE start() produces no LLM_REQUEST (not subscribed yet)", async (t) => {
  const { events } = freshOrc(t);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  // No start() called.
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(requestCount, 0, "orchestrator should not react to ticks before start()");
});

// ===========================================================================
// Behavior 3 — PROMPT_GATHER fires BEFORE compose (gathered blocks land in context)
// ===========================================================================

test("beat: PROMPT_GATHER runs before compose — a block added in the gather handler appears in context", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  // A plugin-like listener that refreshes blocks when gather fires.
  events.on(Events.PROMPT_GATHER, () => {
    orc.setBlock({ id: "dyn", priority: 5, render: () => "DYN" });
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts.length, 1, "one beat should have composed once");
  assert.ok(
    texts[0].includes("DYN"),
    "context composed AFTER gather must include the block the gather handler added",
  );
});

// ===========================================================================
// Behavior 4 — compose orders by priority DESC and wraps each block in <label>…</label>
// ===========================================================================

test("compose: blocks are ordered by priority DESC and each wrapped in its label", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("top", 100, "TOP"));
  orc.setBlock(block("bot", 1, "bot"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts.length, 1);
  assert.equal(
    texts[0],
    "<top>\nTOP\n</top>\n\n<bot>\nbot\n</bot>",
    "higher priority first; each block wrapped in <label> (defaults to id), joined by a blank line",
  );
});

test("compose: ordering is by priority value regardless of insertion order", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  // Insert out of priority order on purpose.
  orc.setBlock(block("mid", 50, "MID"));
  orc.setBlock(block("hi", 100, "HI"));
  orc.setBlock(block("lo", 1, "LO"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(
    texts[0],
    "<hi>\nHI\n</hi>\n\n<mid>\nMID\n</mid>\n\n<lo>\nLO\n</lo>",
    "compose must sort by priority DESC, not insertion order",
  );
});

test("compose: a single block composes to exactly that block's text (no stray separators)", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("only", 7, "ONLY"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(
    texts[0],
    "<only>\nONLY\n</only>",
    "single block: just its <label> wrapper, no leading/trailing separators",
  );
});

// ===========================================================================
// Behavior 5 — empty buffer composes to { text: "" }
// ===========================================================================

test("compose: with no blocks the composed context text is the empty string", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts.length, 1, "the beat still emits a request even with an empty buffer");
  assert.equal(texts[0], "", "empty buffer must compose to an empty string");
});

// ===========================================================================
// Behavior 6 — async render is awaited
// ===========================================================================

test("compose: a render() returning a Promise is awaited and its resolved text included", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock({
    id: "async",
    priority: 10,
    render: () => Promise.resolve("async"),
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts.length, 1);
  assert.equal(
    texts[0],
    "<async>\nasync\n</async>",
    "the awaited async render result must be wrapped and composed",
  );
});

test("compose: mixes sync and async renders, preserving priority order", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("sync-top", 100, "SYNC"));
  orc.setBlock({
    id: "async-bot",
    priority: 1,
    render: () => new Promise<string>((r) => setTimeout(() => r("ASYNC"), 1)),
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(
    texts[0],
    "<sync-top>\nSYNC\n</sync-top>\n\n<async-bot>\nASYNC\n</async-bot>",
    "async block must be awaited and still placed (wrapped) per its priority",
  );
});

// ===========================================================================
// Behavior 6b — block ENCAPSULATION: each block wrapped in <label>…</label>
// (label = block.label ?? block.id); empty/failed renders contribute nothing
// ===========================================================================

test("compose: a block is wrapped in its NOMINATED label, not its id", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock({ id: "persona", label: "identity", priority: 100, render: () => "I am X" });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(
    texts[0],
    "<identity>\nI am X\n</identity>",
    "the nominated label takes precedence over the block id in the wrapper",
  );
});

test("compose: a block WITHOUT a label falls back to wrapping with its id", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("notes", 100, "NOTE"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts[0], "<notes>\nNOTE\n</notes>", "no label => the wrapper uses the block id");
});

test("compose: an empty-rendering block contributes NOTHING (no empty wrapper, no stray separators)", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("top", 100, "TOP"));
  orc.setBlock(block("blank", 50, ""));
  orc.setBlock(block("bot", 1, "BOT"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(
    texts[0],
    "<top>\nTOP\n</top>\n\n<bot>\nBOT\n</bot>",
    "an empty-rendering block is omitted entirely — no <blank></blank>, no extra blank line",
  );
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
    data: {
      content: "",
      toolCalls: [{ id: "t", name: "tool.x", arguments: { q: 1 } }],
    },
  });
  await settle();

  assert.deepEqual(received, { q: 1 }, "the tool action should be invoked with the parsed arguments");
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
  assert.equal(calls.length, 2, "each tool call dispatches exactly once");
});

test("dispatch: a tool call naming an UNregistered action does not throw the beat", async (t) => {
  const { orc, events } = freshOrc(t);
  orc.start();
  // No action registered at all — dispatch must swallow the resulting rejection.
  assert.doesNotThrow(() =>
    events.emit(Events.LLM_RETURN, {
      id: "1",
      at: 0,
      ok: true,
      data: {
        content: "",
        toolCalls: [{ id: "t", name: "tool.unregistered", arguments: {} }],
      },
    }),
  );
  await settle();
  // Reaching here without an unhandled rejection crashing the runner is the assertion.
  assert.ok(true);
});

// ===========================================================================
// Behavior 8 — LLM_RETURN with ok:false, or no toolCalls, dispatches nothing
// ===========================================================================

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
    data: {
      content: "",
      toolCalls: [{ id: "t", name: "tool.x", arguments: { q: 1 } }],
    },
  });
  await settle();

  assert.equal(invoked, false, "a failed (ok:false) return must not dispatch tools");
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
    events.emit(Events.LLM_RETURN, {
      id: "1",
      at: 0,
      ok: true,
      data: { content: "just text, no tools" },
    }),
  );
  await settle();

  assert.equal(invoked, false, "no toolCalls => nothing dispatched");
});

test("dispatch: LLM_RETURN ok:true with an EMPTY toolCalls array dispatches nothing", async (t) => {
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
    ok: true,
    data: { content: "", toolCalls: [] },
  });
  await settle();

  assert.equal(invoked, false, "empty toolCalls array => no dispatch");
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

  assert.equal(invoked, false, "the beat emits an LLM_REQUEST but dispatches no tools by itself");
});

// ===========================================================================
// Behavior 9 — a rejected tool call does not break the beat or sibling calls
// ===========================================================================

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
  assert.doesNotThrow(() =>
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
    }),
  );
  await settle();

  assert.equal(goodRan, true, "the good tool must still run despite a sibling rejection");
});

test("dispatch: a rejecting tool call does not break a SUBSEQUENT beat/return", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let goodCalls = 0;
  actions.register("tool.bad", async () => {
    throw new Error("boom");
  });
  actions.register("tool.good", async () => {
    goodCalls++;
    return "ok";
  });

  orc.start();

  events.emit(Events.LLM_RETURN, {
    id: "1",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "b", name: "tool.bad", arguments: {} }] },
  });
  await settle();

  events.emit(Events.LLM_RETURN, {
    id: "2",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "g", name: "tool.good", arguments: {} }] },
  });
  await settle();

  assert.equal(goodCalls, 1, "the orchestrator keeps dispatching after an earlier rejection");
});

test("beat: a throwing PROMPT_GATHER listener does not abort compose/LLM_REQUEST", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("base", 10, "BASE"));
  events.on(Events.PROMPT_GATHER, () => {
    throw new Error("gather listener exploded");
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts.length, 1, "compose + LLM_REQUEST should still happen");
  assert.equal(texts[0], "<base>\nBASE\n</base>");
});

// ===========================================================================
// Behavior 10 — stop() unsubscribes; start()/stop() idempotent
// ===========================================================================

test("lifecycle: after stop(), a CLOCK_TICK produces NO new LLM_REQUEST", async (t) => {
  const { orc, events } = freshOrc(t);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(requestCount, 1, "one request before stop");

  orc.stop();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });
  await settle();
  assert.equal(requestCount, 1, "no further requests after stop()");
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

  assert.equal(invoked, 0, "stop() should also detach the LLM_RETURN dispatcher");
});

test("lifecycle: start() is idempotent — a single tick still yields exactly one LLM_REQUEST", async (t) => {
  const { orc, events } = freshOrc(t);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.start();
  orc.start();
  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(
    requestCount,
    1,
    "redundant start() calls must not double-subscribe (still one request per tick)",
  );
});

test("lifecycle: stop() is idempotent and safe to call when never started", (t) => {
  const { orc } = freshOrc(t);
  assert.doesNotThrow(() => orc.stop(), "stop() before start() must not throw");
  assert.doesNotThrow(() => orc.stop(), "double stop() must not throw");
});

test("lifecycle: stop() then start() resumes beats (re-subscription works)", async (t) => {
  const { orc, events } = freshOrc(t);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.start();
  orc.stop();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(requestCount, 0, "stopped: no request");

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });
  await settle();
  assert.equal(requestCount, 1, "restarted: beats resume and emit again");
});

// ===========================================================================
// Cross-cutting — block-store mutations between beats are reflected
// ===========================================================================

test("compose reflects block-store edits made between beats (removal + replacement)", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("a", 100, "A1"));
  orc.setBlock(block("b", 1, "B"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();
  assert.equal(texts[0], "<a>\nA1\n</a>\n\n<b>\nB\n</b>", "first beat composes both blocks");

  // Mutate the store between beats: replace a, remove b.
  orc.setBlock(block("a", 100, "A2"));
  assert.equal(orc.removeBlock("b"), true);

  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });
  await settle();
  assert.equal(texts[1], "<a>\nA2\n</a>", "second beat reflects the replacement and the removal");
});

// ===========================================================================
// Behavior 11 — per-block render ISOLATION (a failing block degrades to "",
// never drops siblings or the beat)
// ===========================================================================
//
// compose() renders each block in isolation: a block whose render() throws
// synchronously OR returns a rejecting promise contributes empty text for that
// beat, but the good block's text still makes it into the composed context and
// the LLM_REQUEST still fires exactly once.

test("isolation: a block whose render() REJECTS degrades to empty text; the good block + LLM_REQUEST survive", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.setBlock(block("good", 100, "GOOD"));
  orc.setBlock({
    id: "rejects",
    priority: 50,
    render: rejectingRender("render rejected"),
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(requestCount, 1, "the beat is NOT dropped — LLM_REQUEST still fires exactly once");
  assert.equal(texts.length, 1, "exactly one context composed");
  assert.ok(
    texts[0].includes("GOOD"),
    "the good block's text must survive a sibling render rejection",
  );
  assert.ok(
    !texts[0].includes("render rejected"),
    "the failed block must not leak its error text into the context",
  );
});

test("isolation: a block whose render() THROWS synchronously degrades to empty; siblings + beat survive", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.setBlock(block("good", 100, "GOOD"));
  orc.setBlock({
    id: "throws",
    priority: 50,
    render: () => {
      throw new Error("sync render blew up");
    },
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(requestCount, 1, "a synchronously-throwing block must not drop the beat");
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes("GOOD"), "the good block must still compose");
});

test("isolation: a rejecting AND a synchronously-throwing block alongside a good one — only the good text composes", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("good", 100, "GOOD"));
  orc.setBlock({
    id: "rejects",
    priority: 80,
    render: rejectingRender("reject"),
  });
  orc.setBlock({
    id: "throws",
    priority: 60,
    render: () => {
      throw new Error("throw");
    },
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts.length, 1, "the beat composes once despite two failing blocks");
  // Both failed blocks degrade to empty string; the good block remains. Whether the
  // empty contributions inject blank lines is implementation detail, but GOOD must
  // be present and the error texts must NOT be.
  assert.ok(texts[0].includes("GOOD"), "the single good block's text must be present");
  assert.ok(!texts[0].includes("reject"), "rejected block error must not leak");
  assert.ok(!texts[0].includes("throw"), "thrown block error must not leak");
});

// ===========================================================================
// Behavior 12 — queued-beat cancellation on stop(); in-flight collapse to ONE
// follow-up
// ===========================================================================
//
// A beat is in-flight while its (slow) render is pending. Ticks that arrive
// during an in-flight beat collapse to at most ONE queued follow-up beat. stop()
// cancels the queued follow-up so no further PROMPT_GATHER/LLM_REQUEST fires.

/** A block whose render resolves only after `ms`, letting a beat stay in-flight. */
function slowBlock(id: string, priority: number, text: string, ms = 30): ContextBlock {
  return {
    id,
    priority,
    render: () => new Promise<string>((r) => setTimeout(() => r(text), ms)),
  };
}

test("cancellation: stop() during an in-flight beat cancels the QUEUED follow-up beat (no further PROMPT_GATHER/LLM_REQUEST)", async (t) => {
  const { orc, events } = freshOrc(t);
  let gatherCount = 0;
  let requestCount = 0;
  events.on(Events.PROMPT_GATHER, () => {
    gatherCount++;
  });
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.setBlock(slowBlock("slow", 10, "SLOW", 40));

  orc.start();
  // Two back-to-back ticks: the 1st starts an in-flight beat (slow render pending),
  // the 2nd queues behind it.
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });

  // Stop BEFORE the in-flight render settles, so the queued follow-up is cancelled.
  orc.stop();

  // Let everything settle well past the slow render's resolution.
  await settle(120);

  // The first (in-flight) beat may or may not have already gathered before stop(),
  // but the QUEUED second beat must never run: at most one of each fired, and no
  // SECOND LLM_REQUEST appears after stop().
  assert.ok(requestCount <= 1, "the queued follow-up beat must be cancelled by stop()");
  assert.ok(gatherCount <= 1, "no extra PROMPT_GATHER from the cancelled queued beat");
});

test("cancellation: no NEW beat work is emitted strictly AFTER stop() when a beat was queued", async (t) => {
  const { orc, events } = freshOrc(t);
  orc.setBlock(slowBlock("slow", 10, "SLOW", 40));

  let stopped = false;
  let requestsAfterStop = 0;
  let gathersAfterStop = 0;
  events.on(Events.LLM_REQUEST, () => {
    if (stopped) requestsAfterStop++;
  });
  events.on(Events.PROMPT_GATHER, () => {
    if (stopped) gathersAfterStop++;
  });

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });

  stopped = true;
  orc.stop();

  await settle(120);

  assert.equal(requestsAfterStop, 0, "no LLM_REQUEST may fire after stop()");
  assert.equal(gathersAfterStop, 0, "no PROMPT_GATHER may fire after stop()");
});

test("queueing: 3 back-to-back ticks during ONE in-flight beat collapse to exactly TWO LLM_REQUESTs (one in-flight + one coalesced follow-up)", async (t) => {
  const { orc, events } = freshOrc(t);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.setBlock(slowBlock("slow", 10, "SLOW", 30));

  orc.start();
  // Three ticks arrive while the first beat's slow render is still pending.
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 3 } });

  // Settle long enough for the in-flight beat AND its single coalesced follow-up
  // (each ~30ms) to fully complete.
  await settle(150);

  assert.equal(
    requestCount,
    2,
    "ticks during an in-flight beat coalesce to exactly one follow-up (1 in-flight + 1 queued = 2 total)",
  );
});

test("queueing: 2 back-to-back ticks during ONE in-flight beat yield exactly TWO LLM_REQUESTs", async (t) => {
  const { orc, events } = freshOrc(t);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.setBlock(slowBlock("slow", 10, "SLOW", 30));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });

  await settle(150);

  assert.equal(requestCount, 2, "one in-flight beat + one queued follow-up = exactly two requests");
});

// ===========================================================================
// Behavior 13 — clock rhythm actions registered while started
// ===========================================================================
//
// While started, the orchestrator registers the well-known CLOCK_* actions on
// the actionbus. Invoking them forwards to the injected clock; invalid params
// reject WITHOUT touching the clock; stop() unregisters them; stop()/start()
// re-registers without throwing.

/**
 * A clock that RECORDS every rhythm call so tests can assert forwarding. Shape
 * matches the Clock contract; the orchestrator stores it and the beat is driven
 * by CLOCK_TICK events, so these handlers need only record.
 */
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

/** Orchestrator wired to a recording clock (own event-system), with teardown. */
function orcWithRecordingClock(t: { after(fn: () => void): void }) {
  const sys = createEventSystem();
  const clock = recordingClock();
  const orc = createOrchestrator({ events: sys, clock });
  t.after(() => {
    try {
      orc.stop();
    } catch {
      /* teardown must never throw */
    }
  });
  return { orc, sys, events: sys.events, actions: sys.actions, clock };
}

// --- positive: registration + forwarding --------------------------------------

test("clock actions: after start(), the three CLOCK_* actions are registered on the actionbus", (t) => {
  const { orc, actions } = orcWithRecordingClock(t);
  orc.start();
  assert.equal(actions.has(Actions.CLOCK_SET_INTERVAL), true, "clock.set_interval should be registered");
  assert.equal(
    actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL),
    true,
    "clock.set_default_interval should be registered",
  );
  assert.equal(actions.has(Actions.CLOCK_FIRE_NOW), true, "clock.fire_now should be registered");
  const listed = actions.list();
  assert.ok(listed.includes(Actions.CLOCK_SET_INTERVAL));
  assert.ok(listed.includes(Actions.CLOCK_SET_DEFAULT_INTERVAL));
  assert.ok(listed.includes(Actions.CLOCK_FIRE_NOW));
});

test("clock actions: invoking clock.set_interval {ms:50} forwards to clock.setInterval(50)", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms: 50 });
  assert.deepEqual(clock.setIntervalCalls, [50], "the injected clock's setInterval must receive 50");
  assert.equal(clock.setDefaultIntervalCalls.length, 0, "set_interval must not touch setDefaultInterval");
  assert.equal(clock.fireNowCalls, 0, "set_interval must not fire");
});

test("clock actions: invoking clock.set_default_interval {ms:200} forwards to clock.setDefaultInterval(200)", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_SET_DEFAULT_INTERVAL, { ms: 200 });
  assert.deepEqual(
    clock.setDefaultIntervalCalls,
    [200],
    "the injected clock's setDefaultInterval must receive 200",
  );
  assert.equal(clock.setIntervalCalls.length, 0, "set_default_interval must not touch setInterval");
  assert.equal(clock.fireNowCalls, 0, "set_default_interval must not fire");
});

test("clock actions: invoking clock.fire_now (no params) forwards to clock.fireNow()", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_FIRE_NOW);
  assert.equal(clock.fireNowCalls, 1, "fire_now must call the clock's fireNow exactly once");
  assert.equal(clock.setIntervalCalls.length, 0);
  assert.equal(clock.setDefaultIntervalCalls.length, 0);
});

test("clock actions: a positive boundary ms (1) is forwarded verbatim", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms: 1 });
  await actions.invoke(Actions.CLOCK_SET_DEFAULT_INTERVAL, { ms: 1 });
  assert.deepEqual(clock.setIntervalCalls, [1]);
  assert.deepEqual(clock.setDefaultIntervalCalls, [1]);
});

// --- negative: invalid params reject WITHOUT touching the clock ----------------

test("clock actions: set_interval with {} REJECTS and does not touch the clock", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await assert.rejects(
    () => actions.invoke(Actions.CLOCK_SET_INTERVAL, {}),
    "missing ms must reject",
  );
  assert.equal(clock.setIntervalCalls.length, 0, "rejected call must not reach the clock");
});

test("clock actions: set_interval with {ms:-1} REJECTS and does not touch the clock", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await assert.rejects(
    () => actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms: -1 }),
    "non-positive ms must reject",
  );
  assert.equal(clock.setIntervalCalls.length, 0, "rejected call must not reach the clock");
});

test("clock actions: set_interval with {ms:0} REJECTS (must be positive) and does not touch the clock", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await assert.rejects(
    () => actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms: 0 }),
    "zero ms must reject (interval must be positive)",
  );
  assert.equal(clock.setIntervalCalls.length, 0, "rejected call must not reach the clock");
});

test("clock actions: set_interval with undefined params REJECTS and does not touch the clock", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await assert.rejects(
    () => actions.invoke(Actions.CLOCK_SET_INTERVAL, undefined),
    "undefined params must reject",
  );
  assert.equal(clock.setIntervalCalls.length, 0, "rejected call must not reach the clock");
});

test("clock actions: set_default_interval with {} and {ms:-1} REJECT and do not touch the clock", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  await assert.rejects(() => actions.invoke(Actions.CLOCK_SET_DEFAULT_INTERVAL, {}));
  await assert.rejects(() => actions.invoke(Actions.CLOCK_SET_DEFAULT_INTERVAL, { ms: -1 }));
  assert.equal(clock.setDefaultIntervalCalls.length, 0, "no invalid call may reach the clock");
});

// --- state transitions: stop() unregisters; stop()/start() re-registers --------

test("clock actions: after stop(), the three CLOCK_* actions are NO LONGER registered", (t) => {
  const { orc, actions } = orcWithRecordingClock(t);
  orc.start();
  assert.equal(actions.has(Actions.CLOCK_SET_INTERVAL), true, "registered while started");

  orc.stop();
  assert.equal(actions.has(Actions.CLOCK_SET_INTERVAL), false, "set_interval unregistered on stop()");
  assert.equal(
    actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL),
    false,
    "set_default_interval unregistered on stop()",
  );
  assert.equal(actions.has(Actions.CLOCK_FIRE_NOW), false, "fire_now unregistered on stop()");
});

test("clock actions: a stop()/start() cycle RE-REGISTERS the three actions without throwing", (t) => {
  const { orc, actions } = orcWithRecordingClock(t);
  orc.start();
  orc.stop();
  assert.equal(actions.has(Actions.CLOCK_FIRE_NOW), false, "unregistered after stop");

  assert.doesNotThrow(() => orc.start(), "re-start must not throw (e.g. on duplicate-register)");
  assert.equal(actions.has(Actions.CLOCK_SET_INTERVAL), true, "re-registered after restart");
  assert.equal(actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL), true);
  assert.equal(actions.has(Actions.CLOCK_FIRE_NOW), true);
});

test("clock actions: after a stop()/start() cycle the re-registered fire_now still forwards to the clock", async (t) => {
  const { orc, actions, clock } = orcWithRecordingClock(t);
  orc.start();
  orc.stop();
  orc.start();
  await actions.invoke(Actions.CLOCK_FIRE_NOW);
  assert.equal(clock.fireNowCalls, 1, "the re-registered action must still reach the clock");
});

// ===========================================================================
// Behavior 14 — LLM_RETURN robustness against undefined / null payloads
// ===========================================================================
//
// An LLM_RETURN carrying undefined or null dispatches nothing, does not throw,
// and does not break a subsequent valid beat/return.

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
  assert.equal(invoked, false, "an undefined return must dispatch nothing");
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
  assert.equal(invoked, false, "a null return must dispatch nothing");
});

test("dispatch: after an undefined/null LLM_RETURN, the NEXT valid beat still emits LLM_REQUEST", async (t) => {
  const { orc, events } = freshOrc(t);
  let requestCount = 0;
  events.on(Events.LLM_REQUEST, () => {
    requestCount++;
  });

  orc.start();
  events.emit(Events.LLM_RETURN, undefined);
  events.emit(Events.LLM_RETURN, null);
  await settle();

  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(requestCount, 1, "a malformed return must not break the subsequent beat");
});

test("dispatch: after an undefined LLM_RETURN, a SUBSEQUENT valid LLM_RETURN still dispatches its tool", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  let goodCalls = 0;
  actions.register("tool.good", async () => {
    goodCalls++;
    return "ok";
  });

  orc.start();
  events.emit(Events.LLM_RETURN, undefined);
  await settle();

  events.emit(Events.LLM_RETURN, {
    id: "2",
    at: 0,
    ok: true,
    data: { content: "", toolCalls: [{ id: "g", name: "tool.good", arguments: {} }] },
  });
  await settle();

  assert.equal(goodCalls, 1, "dispatch continues to work after a malformed return");
});

// ===========================================================================
// Behavior 15 — tool.result emission as each dispatched tool call settles
// ===========================================================================
//
// Contract (orchestrator header + shared/actions EventPayloads["tool.result"]):
// "As EACH dispatched call settles, a `tool.result` event is emitted (Reply:
//  id = the ToolCall id, name = the action name; ok+data on success,
//  ok:false+error on rejection)". Payload type = Reply<unknown> & { name }.
//
// We drive via start() then emit LLM_RETURN with a Reply whose data.toolCalls
// name actions registered on the bus, and observe Events.TOOL_RESULT.

/**
 * Collect every TOOL_RESULT payload the orchestrator emits. Returns the live
 * array (newest pushed last) plus a by-id lookup helper, since settle order
 * across concurrent dispatches is not guaranteed — assertions must key on id.
 */
function captureToolResults(events: ReturnType<typeof freshOrc>["events"]): {
  all: Array<Reply<unknown> & { name: string }>;
  byId(id: string): (Reply<unknown> & { name: string }) | undefined;
} {
  const all: Array<Reply<unknown> & { name: string }> = [];
  events.on(Events.TOOL_RESULT, (payload) => {
    all.push(payload as Reply<unknown> & { name: string });
  });
  return {
    all,
    byId: (id) => all.find((r) => r.id === id),
  };
}

test("tool.result: a successful tool call emits exactly one tool.result with id/name/ok:true and the resolved data", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  const results = captureToolResults(events);
  actions.register("tool.x", async () => ({ answer: 42 }));

  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "ret-1",
    at: 0,
    ok: true,
    data: {
      content: "",
      toolCalls: [{ id: "call-x", name: "tool.x", arguments: { q: 1 } }],
    },
  });
  await settle();

  assert.equal(results.all.length, 1, "exactly one tool.result for one settled call");
  const r = results.byId("call-x");
  assert.ok(r, "tool.result id must equal the ToolCall id");
  assert.equal(r!.id, "call-x", "id === the ToolCall id (not the llm.return id)");
  assert.equal(r!.name, "tool.x", "name === the dispatched action name");
  assert.equal(r!.ok, true, "a resolved handler yields ok:true");
  assert.deepEqual(r!.data, { answer: 42 }, "data === the handler's resolved value");
  assert.equal(r!.error, undefined, "a successful result carries no error");
});

test("tool.result: a rejecting tool call emits ok:false + non-empty string error, and its sibling success still emits its own ok result (isolation)", async (t) => {
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

  assert.equal(results.all.length, 2, "both settled calls emit a tool.result");

  const bad = results.byId("call-bad");
  assert.ok(bad, "the rejecting call still emits a tool.result");
  assert.equal(bad!.name, "tool.bad");
  assert.equal(bad!.ok, false, "a rejection yields ok:false");
  assert.equal(typeof bad!.error, "string", "rejection error must be a string");
  assert.ok(bad!.error!.length > 0, "rejection error must be non-empty");

  const good = results.byId("call-good");
  assert.ok(good, "the sibling success still emits its own tool.result (isolation)");
  assert.equal(good!.name, "tool.good");
  assert.equal(good!.ok, true, "the sibling success is ok:true despite the rejection");
  assert.equal(good!.data, "GOOD-VALUE", "the sibling's resolved value is carried through");
});

test("tool.result: two tool calls in one llm.return produce two tool.results whose ids match pairwise (regardless of settle order)", async (t) => {
  const { orc, actions, events } = freshOrc(t);
  const results = captureToolResults(events);
  // Make the first-listed call settle LAST so we cannot rely on emission order.
  actions.register("tool.slow", async () => {
    await new Promise((r) => setTimeout(r, 25));
    return "slow-done";
  });
  actions.register("tool.fast", async () => "fast-done");

  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "ret-1",
    at: 0,
    ok: true,
    data: {
      content: "",
      toolCalls: [
        { id: "call-slow", name: "tool.slow", arguments: {} },
        { id: "call-fast", name: "tool.fast", arguments: {} },
      ],
    },
  });
  await settle(60);

  assert.equal(results.all.length, 2, "exactly two tool.result events for two calls");
  // Assert by id lookup, never by sequence (settle order may differ from list order).
  const slow = results.byId("call-slow");
  const fast = results.byId("call-fast");
  assert.ok(slow, "slow call's id must appear");
  assert.ok(fast, "fast call's id must appear");
  assert.equal(slow!.name, "tool.slow");
  assert.equal(slow!.ok, true);
  assert.equal(slow!.data, "slow-done");
  assert.equal(fast!.name, "tool.fast");
  assert.equal(fast!.ok, true);
  assert.equal(fast!.data, "fast-done");
});

test("tool.result: an UNKNOWN action name emits ok:false (invoke rejects with 'Unknown action') rather than nothing", async (t) => {
  const { orc, events } = freshOrc(t);
  const results = captureToolResults(events);

  orc.start();
  events.emit(Events.LLM_RETURN, {
    id: "ret-1",
    at: 0,
    ok: true,
    data: {
      content: "",
      toolCalls: [{ id: "call-missing", name: "tool.unregistered", arguments: {} }],
    },
  });
  await settle();

  assert.equal(results.all.length, 1, "an unknown action must still produce a tool.result, not silence");
  const r = results.byId("call-missing");
  assert.ok(r, "tool.result carries the original ToolCall id");
  assert.equal(r!.name, "tool.unregistered", "name === the (unknown) action name");
  assert.equal(r!.ok, false, "an unknown action rejects => ok:false");
  assert.equal(typeof r!.error, "string", "the rejection error must be a string");
  assert.ok(r!.error!.length > 0, "the rejection error must be non-empty");
});

test("tool.result: after stop(), a late llm.return produces NO tool.result (the llm.return subscription is gone)", async (t) => {
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

  assert.equal(invoked, 0, "a stopped orchestrator no longer dispatches the tool");
  assert.equal(results.all.length, 0, "and therefore emits no tool.result for the late return");
});
