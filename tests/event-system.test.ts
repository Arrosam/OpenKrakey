import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../packages/event-system/src";
import type { EventSystem } from "../contracts/event-system";

// Each test constructs its own EventSystem so tests stay fully independent.
function fresh(): EventSystem {
  return createEventSystem();
}

// ---------------------------------------------------------------------------
// Factory / shape
// ---------------------------------------------------------------------------

test("createEventSystem returns an object exposing events and actions buses", () => {
  const sys = fresh();
  assert.ok(sys, "factory should return a value");
  assert.equal(typeof sys, "object");
  assert.ok(sys.events, "should expose events bus");
  assert.ok(sys.actions, "should expose actions bus");
  assert.equal(typeof sys.events.emit, "function");
  assert.equal(typeof sys.events.on, "function");
  assert.equal(typeof sys.actions.register, "function");
  assert.equal(typeof sys.actions.invoke, "function");
  assert.equal(typeof sys.actions.has, "function");
  assert.equal(typeof sys.actions.list, "function");
});

test("each createEventSystem call yields an independent, isolated instance", async () => {
  const a = fresh();
  const b = fresh();

  // A subscription/registration on `a` must not leak into `b`.
  let aSawEvent = false;
  a.events.on("ping", () => {
    aSawEvent = true;
  });
  a.actions.register("op", async () => "a-op");

  let bSawEvent = false;
  b.events.on("ping", () => {
    bSawEvent = true;
  });

  // Emit only on b: a's listener must not fire.
  b.events.emit("ping");
  assert.equal(aSawEvent, false, "instance a must not observe instance b's emit");
  assert.equal(bSawEvent, true, "instance b's own listener should fire");

  // Action registered only on a must be unknown to b.
  assert.equal(a.actions.has("op"), true);
  assert.equal(b.actions.has("op"), false);
  await assert.rejects(() => b.actions.invoke("op"));
});

// ===========================================================================
// EventBus
// ===========================================================================

// --- Behavior 1: emit with no listeners is a no-op and never throws ---------

test("EventBus.emit to an event with no listeners is a harmless no-op", () => {
  const { events } = fresh();
  assert.doesNotThrow(() => events.emit("never-subscribed"));
  assert.doesNotThrow(() => events.emit("never-subscribed", { some: "payload" }));
  assert.doesNotThrow(() => events.emit("never-subscribed", undefined));
});

test("EventBus.emit with no payload argument does not throw (payload optional)", () => {
  const { events } = fresh();
  let received: unknown = "unset";
  events.on("evt", (p) => {
    received = p;
  });
  assert.doesNotThrow(() => events.emit("evt"));
  // payload is optional in the contract; when omitted it should arrive as undefined.
  assert.equal(received, undefined);
});

test("EventBus.emit after the only listener was removed is a no-op", () => {
  const { events } = fresh();
  let calls = 0;
  const off = events.on("evt", () => {
    calls++;
  });
  off();
  assert.doesNotThrow(() => events.emit("evt", 1));
  assert.equal(calls, 0, "removed listener must not fire");
});

// --- Behavior 2: on + emit delivers the payload ----------------------------

test("EventBus.on then emit calls the handler with the exact payload", () => {
  const { events } = fresh();
  const calls: unknown[] = [];
  events.on("evt", (p) => {
    calls.push(p);
  });

  const payload = { id: 7, nested: { ok: true } };
  events.emit("evt", payload);

  assert.equal(calls.length, 1, "handler should be called exactly once per emit");
  assert.equal(calls[0], payload, "handler should receive the same payload reference");
});

test("EventBus delivers a range of payload shapes unchanged (equivalence classes)", () => {
  const cases: unknown[] = [
    undefined,
    null,
    0,
    -1,
    "",
    "hello",
    false,
    true,
    { a: 1 },
    [1, 2, 3],
    Symbol.iterator,
  ];

  for (const payload of cases) {
    const { events } = fresh();
    let received: unknown = "sentinel-never-set";
    let fired = false;
    events.on("evt", (p) => {
      fired = true;
      received = p;
    });
    events.emit("evt", payload);
    assert.equal(fired, true, `handler should fire for payload ${String(payload)}`);
    assert.equal(received, payload, `payload ${String(payload)} should pass through unchanged`);
  }
});

test("EventBus only notifies listeners of the emitted event name, not others", () => {
  const { events } = fresh();
  let aCalls = 0;
  let bCalls = 0;
  events.on("a", () => {
    aCalls++;
  });
  events.on("b", () => {
    bCalls++;
  });

  events.emit("a", 1);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 0, "unrelated event listener must not fire");

  events.emit("b", 2);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);
});

test("EventBus treats event names as distinct (case-sensitive, empty-string is a valid name)", () => {
  const { events } = fresh();
  let lowerCalls = 0;
  let upperCalls = 0;
  let emptyCalls = 0;
  events.on("evt", () => {
    lowerCalls++;
  });
  events.on("EVT", () => {
    upperCalls++;
  });
  events.on("", () => {
    emptyCalls++;
  });

  events.emit("evt");
  assert.equal(lowerCalls, 1);
  assert.equal(upperCalls, 0, "different-cased event name should not match");
  assert.equal(emptyCalls, 0);

  events.emit("");
  assert.equal(emptyCalls, 1, "empty string should be a usable, distinct event name");
  assert.equal(lowerCalls, 1);
});

test("EventBus re-delivers on every emit (handler stays subscribed)", () => {
  const { events } = fresh();
  let calls = 0;
  events.on("evt", () => {
    calls++;
  });
  events.emit("evt");
  events.emit("evt");
  events.emit("evt");
  assert.equal(calls, 3, "handler should receive each subsequent emit");
});

// --- Behavior 3: multiple listeners on the same event all receive ----------

test("EventBus delivers a single emit to all listeners on that event", () => {
  const { events } = fresh();
  const order: number[] = [];
  events.on("evt", () => order.push(1));
  events.on("evt", () => order.push(2));
  events.on("evt", () => order.push(3));

  events.emit("evt", "x");
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    [1, 2, 3],
    "all three listeners should run for one emit",
  );
});

test("EventBus delivers the same payload to every listener", () => {
  const { events } = fresh();
  const seen: unknown[] = [];
  const payload = { shared: true };
  events.on("evt", (p) => seen.push(p));
  events.on("evt", (p) => seen.push(p));

  events.emit("evt", payload);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], payload);
  assert.equal(seen[1], payload);
});

test("EventBus allows the same handler function registered twice to be invoked twice", () => {
  const { events } = fresh();
  let calls = 0;
  const handler = () => {
    calls++;
  };
  events.on("evt", handler);
  events.on("evt", handler);
  events.emit("evt");
  assert.equal(calls, 2, "registering the same function twice yields two deliveries");
});

// --- Behavior 4: a throwing listener does not stop the others --------------

test("EventBus: a throwing listener does not prevent other listeners from running", () => {
  const { events } = fresh();
  let recorderRan = false;

  events.on("evt", () => {
    throw new Error("boom from listener");
  });
  events.on("evt", () => {
    recorderRan = true;
  });

  // emit itself should not surface the listener error to the caller.
  assert.doesNotThrow(() => events.emit("evt", 1));
  assert.equal(recorderRan, true, "the second (recording) listener must still run");
});

test("EventBus: recorder registered BEFORE a thrower still runs (order-independent isolation)", () => {
  const { events } = fresh();
  let recorderRan = false;

  events.on("evt", () => {
    recorderRan = true;
  });
  events.on("evt", () => {
    throw new Error("boom after recorder");
  });

  assert.doesNotThrow(() => events.emit("evt"));
  assert.equal(recorderRan, true);
});

test("EventBus: multiple throwing listeners still let every non-throwing one run", () => {
  const { events } = fresh();
  let aRan = false;
  let bRan = false;

  events.on("evt", () => {
    throw new Error("t1");
  });
  events.on("evt", () => {
    aRan = true;
  });
  events.on("evt", () => {
    throw new Error("t2");
  });
  events.on("evt", () => {
    bRan = true;
  });

  assert.doesNotThrow(() => events.emit("evt"));
  assert.equal(aRan, true);
  assert.equal(bRan, true);
});

test("EventBus: a throwing listener does not corrupt delivery on subsequent emits", () => {
  const { events } = fresh();
  let goodCalls = 0;
  events.on("evt", () => {
    throw new Error("always boom");
  });
  events.on("evt", () => {
    goodCalls++;
  });

  events.emit("evt");
  events.emit("evt");
  assert.equal(goodCalls, 2, "good listener should fire on both emits despite the thrower");
});

// --- Behavior 5: Unsub removes the listener; stale-safe (idempotent) --------

test("EventBus: the Unsub returned by on removes that listener", () => {
  const { events } = fresh();
  let calls = 0;
  const off = events.on("evt", () => {
    calls++;
  });
  assert.equal(typeof off, "function", "on should return an unsubscribe function");

  events.emit("evt");
  assert.equal(calls, 1);

  off();
  events.emit("evt");
  assert.equal(calls, 1, "after unsub the listener should no longer fire");
});

test("EventBus: calling Unsub more than once is harmless (stale-safe)", () => {
  const { events } = fresh();
  let calls = 0;
  const off = events.on("evt", () => {
    calls++;
  });
  off();
  assert.doesNotThrow(() => off(), "second unsub call should not throw");
  assert.doesNotThrow(() => off(), "third unsub call should not throw");
  events.emit("evt");
  assert.equal(calls, 0);
});

test("EventBus: unsubbing one listener leaves the others intact", () => {
  const { events } = fresh();
  let aCalls = 0;
  let bCalls = 0;
  const offA = events.on("evt", () => {
    aCalls++;
  });
  events.on("evt", () => {
    bCalls++;
  });

  offA();
  events.emit("evt");
  assert.equal(aCalls, 0, "unsubscribed listener must not fire");
  assert.equal(bCalls, 1, "remaining listener must still fire");
});

test("EventBus: unsubbing one of two identical handlers removes only one registration", () => {
  const { events } = fresh();
  let calls = 0;
  const handler = () => {
    calls++;
  };
  const off1 = events.on("evt", handler);
  events.on("evt", handler);

  off1();
  events.emit("evt");
  assert.equal(calls, 1, "exactly one of the two identical registrations should remain");
});

// --- Behavior 6: unsubscribing during/after emit does not corrupt others ----

test("EventBus: a listener that unsubscribes itself during emit does not break others", () => {
  const { events } = fresh();
  const order: string[] = [];

  let offSelf: (() => void) | undefined;
  offSelf = events.on("evt", () => {
    order.push("self");
    offSelf?.(); // remove self mid-dispatch
  });
  events.on("evt", () => {
    order.push("other");
  });

  assert.doesNotThrow(() => events.emit("evt"));
  assert.ok(order.includes("other"), "other listener should still be delivered to in same emit");

  // Next emit: self is gone, other remains.
  order.length = 0;
  events.emit("evt");
  assert.deepEqual(order, ["other"], "self-removed listener must not fire on the next emit");
});

test("EventBus: a listener unsubscribing a LATER listener during emit is safe", () => {
  const { events } = fresh();
  const fired: string[] = [];

  let offSecond: (() => void) | undefined;
  events.on("evt", () => {
    fired.push("first");
    offSecond?.(); // cancel the not-yet-invoked second listener
  });
  offSecond = events.on("evt", () => {
    fired.push("second");
  });
  events.on("evt", () => {
    fired.push("third");
  });

  assert.doesNotThrow(() => events.emit("evt"));
  // first and third must always run; emit must not crash regardless of whether
  // the cancelled "second" is skipped this round.
  assert.ok(fired.includes("first"), "first listener should run");
  assert.ok(fired.includes("third"), "third listener should run even after a mid-emit unsub");

  // On the next emit, the cancelled listener is definitively gone.
  fired.length = 0;
  events.emit("evt");
  assert.equal(fired.includes("second"), false, "cancelled listener must be gone next emit");
  assert.ok(fired.includes("first"));
  assert.ok(fired.includes("third"));
});

test("EventBus: adding a new listener during emit does not crash delivery", () => {
  const { events } = fresh();
  let lateCalls = 0;
  let firstCalls = 0;

  events.on("evt", () => {
    firstCalls++;
    if (firstCalls === 1) {
      events.on("evt", () => {
        lateCalls++;
      });
    }
  });

  assert.doesNotThrow(() => events.emit("evt"));
  // The late listener is guaranteed to receive subsequent emits.
  events.emit("evt");
  assert.ok(lateCalls >= 1, "listener added during emit should receive a later emit");
});

// ===========================================================================
// ActionBus
// ===========================================================================

// --- Behavior 7: register + invoke resolves to handler return, passes params -

test("ActionBus.register then invoke resolves to the handler's return value", async () => {
  const { actions } = fresh();
  actions.register("greet", async () => "hello");
  const result = await actions.invoke("greet");
  assert.equal(result, "hello");
});

test("ActionBus.invoke passes params through to the handler unchanged", async () => {
  const { actions } = fresh();
  let received: unknown = "unset";
  actions.register("echo", async (params) => {
    received = params;
    return params;
  });

  const params = { x: 1, y: [2, 3] };
  const result = await actions.invoke("echo", params);
  assert.equal(received, params, "handler should receive the same params reference");
  assert.equal(result, params, "invoke should resolve with the handler's returned value");
});

test("ActionBus.invoke with no params argument passes undefined (params optional)", async () => {
  const { actions } = fresh();
  let received: unknown = "unset";
  actions.register("noparam", async (params) => {
    received = params;
    return "ok";
  });
  const result = await actions.invoke("noparam");
  assert.equal(received, undefined, "omitted params should arrive as undefined");
  assert.equal(result, "ok");
});

test("ActionBus.invoke returns a Promise (thenable), even for a sync-looking handler", () => {
  const { actions } = fresh();
  actions.register("op", async () => 42);
  const ret = actions.invoke("op");
  assert.ok(typeof (ret as Promise<unknown>).then === "function", "invoke must return a Promise");
  return ret; // let the test runner await it
});

test("ActionBus.invoke resolves a range of return value shapes (equivalence classes)", async () => {
  const cases: unknown[] = [undefined, null, 0, "", false, { ok: true }, [1, 2]];
  for (const value of cases) {
    const { actions } = fresh();
    actions.register("op", async () => value);
    const result = await actions.invoke("op");
    assert.equal(result, value, `invoke should resolve to ${String(value)}`);
  }
});

test("ActionBus.invoke rejects when the handler rejects, surfacing the error", async () => {
  const { actions } = fresh();
  const err = new Error("handler failed");
  actions.register("fail", async () => {
    throw err;
  });
  await assert.rejects(() => actions.invoke("fail"), (e) => e === err);
});

test("ActionBus routes invoke to the correct handler when several are registered", async () => {
  const { actions } = fresh();
  actions.register("a", async () => "A");
  actions.register("b", async () => "B");
  actions.register("c", async () => "C");

  assert.equal(await actions.invoke("b"), "B");
  assert.equal(await actions.invoke("a"), "A");
  assert.equal(await actions.invoke("c"), "C");
});

test("ActionBus invoke can be called repeatedly on the same action", async () => {
  const { actions } = fresh();
  let count = 0;
  actions.register("tick", async () => ++count);
  assert.equal(await actions.invoke("tick"), 1);
  assert.equal(await actions.invoke("tick"), 2);
  assert.equal(await actions.invoke("tick"), 3);
});

// --- Behavior 8: invoke on an unregistered action rejects ------------------

test("ActionBus.invoke on an unregistered action returns a rejected promise", async () => {
  const { actions } = fresh();
  await assert.rejects(() => actions.invoke("nope"));
});

test("ActionBus.invoke on an unregistered action rejects even with params supplied", async () => {
  const { actions } = fresh();
  await assert.rejects(() => actions.invoke("nope", { some: "params" }));
});

test("ActionBus.invoke of the empty-string action (never registered) rejects", async () => {
  const { actions } = fresh();
  await assert.rejects(() => actions.invoke(""));
});

test("ActionBus.invoke rejects (does not throw synchronously) for unknown actions", () => {
  const { actions } = fresh();
  // Calling invoke must not throw synchronously; the failure is via rejection.
  let ret: Promise<unknown>;
  assert.doesNotThrow(() => {
    ret = actions.invoke("unknown");
  });
  return assert.rejects(() => ret);
});

// --- Behavior 9: duplicate register throws synchronously -------------------

test("ActionBus.register of an already-registered action throws synchronously", () => {
  const { actions } = fresh();
  actions.register("a", async () => 1);
  assert.throws(() => actions.register("a", async () => 2));
});

test("ActionBus: a failed duplicate register does not replace the original handler", async () => {
  const { actions } = fresh();
  actions.register("a", async () => "original");
  try {
    actions.register("a", async () => "replacement");
  } catch {
    // expected
  }
  const result = await actions.invoke("a");
  assert.equal(result, "original", "original handler must remain after rejected duplicate");
});

test("ActionBus: empty-string action name can be registered, and duplicate of it throws", () => {
  const { actions } = fresh();
  assert.doesNotThrow(() => actions.register("", async () => "empty"));
  assert.equal(actions.has(""), true);
  assert.throws(() => actions.register("", async () => "again"));
});

// --- Behavior 10: has reflects registration; list returns names ------------

test("ActionBus.has is false before registration and true after", () => {
  const { actions } = fresh();
  assert.equal(actions.has("a"), false);
  actions.register("a", async () => 1);
  assert.equal(actions.has("a"), true);
  assert.equal(actions.has("b"), false, "unrelated name should still be false");
});

test("ActionBus.list returns the registered action names", () => {
  const { actions } = fresh();
  assert.deepEqual(actions.list(), [], "list should start empty");

  actions.register("a", async () => 1);
  actions.register("b", async () => 2);
  actions.register("c", async () => 3);

  const names = actions.list();
  assert.equal(names.length, 3);
  assert.deepEqual([...names].sort(), ["a", "b", "c"]);
});

test("ActionBus.list does not contain duplicates and reflects only registered names", () => {
  const { actions } = fresh();
  actions.register("only", async () => 1);
  const names = actions.list();
  assert.deepEqual(names, ["only"]);
});

test("ActionBus.list reflects an empty bus as an empty array", () => {
  const { actions } = fresh();
  const names = actions.list();
  assert.ok(Array.isArray(names));
  assert.equal(names.length, 0);
});

// --- Behavior 11: Unsub from register removes the action; stale-safe --------

test("ActionBus: the Unsub from register removes the action", async () => {
  const { actions } = fresh();
  const off = actions.register("a", async () => "v");
  assert.equal(typeof off, "function", "register should return an unsubscribe function");
  assert.equal(actions.has("a"), true);
  assert.equal(await actions.invoke("a"), "v");

  off();
  assert.equal(actions.has("a"), false, "has should be false after unregister");
  assert.equal(actions.list().includes("a"), false, "list should drop the unregistered action");
  await assert.rejects(() => actions.invoke("a"), "invoke should reject after unregister");
});

test("ActionBus: register Unsub is stale-safe (callable more than once)", async () => {
  const { actions } = fresh();
  const off = actions.register("a", async () => "v");
  off();
  assert.doesNotThrow(() => off(), "second unregister call should not throw");
  assert.doesNotThrow(() => off(), "third unregister call should not throw");
  assert.equal(actions.has("a"), false);
});

test("ActionBus: after unregister, the same action name can be registered again", async () => {
  const { actions } = fresh();
  const off = actions.register("a", async () => "first");
  off();
  // Re-registration must not throw now that the name is free.
  assert.doesNotThrow(() => actions.register("a", async () => "second"));
  assert.equal(actions.has("a"), true);
  assert.equal(await actions.invoke("a"), "second");
});

test("ActionBus: a stale Unsub does not remove a re-registered action of the same name", async () => {
  const { actions } = fresh();
  const off1 = actions.register("a", async () => "first");
  off1();
  actions.register("a", async () => "second");

  // Calling the OLD unsub again must not clobber the new registration.
  assert.doesNotThrow(() => off1());
  assert.equal(actions.has("a"), true, "re-registered action should survive a stale unsub");
  assert.equal(await actions.invoke("a"), "second");
});

test("ActionBus: unregistering one action leaves the others intact", async () => {
  const { actions } = fresh();
  const offA = actions.register("a", async () => "A");
  actions.register("b", async () => "B");

  offA();
  assert.equal(actions.has("a"), false);
  assert.equal(actions.has("b"), true);
  assert.equal(await actions.invoke("b"), "B");
  await assert.rejects(() => actions.invoke("a"));
});

// ===========================================================================
// Cross-bus independence
// ===========================================================================

test("events and actions buses are independent namespaces", async () => {
  const { events, actions } = fresh();
  let eventFired = false;
  events.on("shared-name", () => {
    eventFired = true;
  });
  actions.register("shared-name", async () => "action-result");

  // Emitting the event must not invoke the action and vice versa.
  events.emit("shared-name");
  assert.equal(eventFired, true);
  assert.equal(await actions.invoke("shared-name"), "action-result");

  // The action registration must not have created an event listener side effect,
  // and the event must not appear in the action list beyond what we registered.
  assert.deepEqual(actions.list(), ["shared-name"]);
});
