import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../packages/orchestrator/src";
import { createEventSystem } from "../packages/event-system/src";
import { Events } from "../shared/actions";
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
// Behavior 4 — compose orders by priority DESC and joins with "\n"
// ===========================================================================

test("compose: blocks are ordered by priority DESC and joined with newlines", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("top", 100, "TOP"));
  orc.setBlock(block("bot", 1, "bot"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts.length, 1);
  assert.equal(texts[0], "TOP\nbot", "higher priority renders first, joined by \\n");
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

  assert.equal(texts[0], "HI\nMID\nLO", "compose must sort by priority DESC, not insertion order");
});

test("compose: a single block composes to exactly that block's text (no stray separators)", async (t) => {
  const { orc, events } = freshOrc(t);
  const texts = captureContextTexts(events);

  orc.setBlock(block("only", 7, "ONLY"));

  orc.start();
  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 1 } });
  await settle();

  assert.equal(texts[0], "ONLY", "single block: no leading/trailing newline");
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
  assert.equal(texts[0], "async", "the awaited async render result must be the composed text");
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
    "SYNC\nASYNC",
    "async block must be awaited and still placed per its priority",
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
  assert.equal(texts[0], "BASE");
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
  assert.equal(texts[0], "A1\nB", "first beat composes both blocks");

  // Mutate the store between beats: replace a, remove b.
  orc.setBlock(block("a", 100, "A2"));
  assert.equal(orc.removeBlock("b"), true);

  events.emit(Events.CLOCK_TICK, { at: 0, data: { seq: 2 } });
  await settle();
  assert.equal(texts[1], "A2", "second beat reflects the replacement and the removal");
});
