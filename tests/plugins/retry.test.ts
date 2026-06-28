import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import { Actions, Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";

// ---------------------------------------------------------------------------
// Edge tests for the NEW `retry` plugin.
//
// Contract (black-box — listener-only, drives the per-Agent clock over the bus):
//   - Manifest: id === "retry"; has a configSchema; NO `requires` entries (it
//     depends on no plugin/action at load — it guards clock.set_interval with has).
//   - setup() registers an Events.LLM_RETURN listener; registers NO tools and NO
//     context blocks (listBlocks empty after setup).
//   - On Events.LLM_RETURN with a Reply { ok:false }: invoke clock.set_interval
//     ({ ms: <retryIntervalMs> }, default 15000) once, to accelerate the next frame.
//   - On Events.LLM_RETURN { ok:true }: clock.set_interval is NOT invoked, and the
//     consecutive-failure streak resets to the BASE retryIntervalMs.
//   - config backoff:true → consecutive failures use retryIntervalMs * 2^(n-1),
//     capped at maxRetryIntervalMs.
//   - config maxConsecutiveRetries > 0 → after that many consecutive failures, no
//     further set_interval is invoked.
//   - actions.has guard: if no clock.set_interval action is registered, a failed
//     llm.return does NOT throw.
//   - The listener NEVER throws on malformed payloads.
//   - teardown() unsubscribes (no further set_interval after teardown) and is
//     idempotent (calling twice does not throw).
//
// The implementation does NOT exist yet — the dynamic import below fails on a
// clean assertion rather than a module-resolution crash.
// ---------------------------------------------------------------------------

const mod: any = await import("../../public_plugin/retry/index.ts").then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "retry module failed to import");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// Fake PluginContext over a real event-system. Records every clock.set_interval
// payload so tests can assert exactly what the plugin drove. By default the clock
// action IS registered; pass { withClock: false } to exercise the has() guard.
function makeCtx(config: unknown, opts: { withClock?: boolean } = {}) {
  const withClock = opts.withClock !== false;
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: unknown[] = [];
  const setIntervalCalls: number[] = [];
  const msOf = (p: unknown): number => (p as { ms?: number })?.ms as number;
  // Record any tool registration so we can assert the plugin declares none.
  sys.actions.register("llm.register_tool", async (def: unknown) => {
    tools.push(def);
    return true;
  });
  if (withClock) {
    sys.actions.register(Actions.CLOCK_SET_INTERVAL, async (p: unknown) => {
      setIntervalCalls.push(msOf(p));
    });
  }
  const ctx: any = {
    agentId: "a",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir: "/tmp/x",
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => store.set(b.id, b),
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} },
    print() {},
  };
  return { ctx, store, sys, tools, setIntervalCalls };
}

async function setup(config: unknown = {}, opts: { withClock?: boolean } = {}) {
  const p = plugin();
  const h = makeCtx(config, opts);
  await p.setup(h.ctx);
  return { p, ...h };
}

// Emit one llm.return Reply<LLMResponse> on the bus with the given ok flag.
let corr = 0;
function emitReturn(sys: ReturnType<typeof createEventSystem>, ok: boolean, extra: Record<string, unknown> = {}) {
  corr += 1;
  sys.events.emit(Events.LLM_RETURN, {
    id: `c${corr}`,
    at: Date.now(),
    ok,
    ...(ok ? { data: { content: "hi", toolCalls: [] } } : { error: "Engine Busy" }),
    ...extra,
  });
}

// The bus emit + the plugin's invoke() are async; let microtasks/timers settle.
const settle = () => new Promise((r) => setTimeout(r, 15));

// ===========================================================================
// MANIFEST / SETUP — positive + structural
// ===========================================================================

test("manifest: id 'retry', has a configSchema, and NO requires entries", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "retry");
  assert.equal(typeof p.manifest.version, "string");
  assert.ok(Array.isArray(p.manifest.configSchema), "configSchema present (array)");
  assert.ok(p.manifest.configSchema.length > 0, "configSchema is non-empty");
  // It depends on no plugin/action at load — must not declare requires.
  assert.ok(
    p.manifest.requires === undefined || p.manifest.requires.length === 0,
    "no requires entries (guards clock.set_interval with has())",
  );
});

test("setup: registers an llm.return listener; declares NO tools and NO context blocks", async () => {
  const { sys, tools, store, ctx } = await setup({});
  assert.equal(tools.length, 0, "no llm.register_tool calls");
  assert.equal(store.size, 0, "no context blocks set");
  assert.deepEqual(ctx.listBlocks(), [], "listBlocks empty after setup");
  // A failed return must reach a handler — proven indirectly by the positive
  // tests below; here we assert no synchronous throw on a benign emit.
  assert.doesNotThrow(() => sys.events.emit(Events.LLM_RETURN, { id: "x", at: 1, ok: true }));
});

// ===========================================================================
// POSITIVE / EQUIVALENCE — a failure accelerates the next frame
// ===========================================================================

test("positive: ok:false → invokes clock.set_interval once with the default 15000", async () => {
  const { sys, setIntervalCalls } = await setup({});
  emitReturn(sys, false);
  await settle();
  assert.deepEqual(setIntervalCalls, [15000], "one set_interval at the 15000 default");
});

test("positive: custom retryIntervalMs is used instead of the default", async () => {
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 2000 });
  emitReturn(sys, false);
  await settle();
  assert.deepEqual(setIntervalCalls, [2000], "set_interval at the configured 2000");
});

test("positive: a second independent failure fires set_interval again (one per failure)", async () => {
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 3000 });
  emitReturn(sys, false);
  await settle();
  emitReturn(sys, false);
  await settle();
  assert.equal(setIntervalCalls.length, 2, "two failures → two set_interval invocations");
});

test("positive: ok:true does NOT invoke clock.set_interval", async () => {
  const { sys, setIntervalCalls } = await setup({});
  emitReturn(sys, true);
  await settle();
  assert.deepEqual(setIntervalCalls, [], "success is a no-op for the clock");
});

// ===========================================================================
// BOUNDARY VALUE ANALYSIS — backoff curve, the cap, and retry-count limits
// ===========================================================================

test("BVA: first failure (n=1) with backoff uses the BASE interval (2^0 = base)", async () => {
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 1000, backoff: true });
  emitReturn(sys, false);
  await settle();
  assert.deepEqual(setIntervalCalls, [1000], "n=1 → base*2^0 = base");
});

test("BVA: backoff doubles per consecutive failure (base * 2^(n-1))", async () => {
  const { sys, setIntervalCalls } = await setup({
    retryIntervalMs: 1000,
    backoff: true,
    maxRetryIntervalMs: 1_000_000, // high enough not to cap this sequence
  });
  for (let i = 0; i < 4; i++) {
    emitReturn(sys, false);
    await settle();
  }
  assert.deepEqual(setIntervalCalls, [1000, 2000, 4000, 8000], "1000·2^(n-1) for n=1..4");
});

test("BVA: backoff is capped at maxRetryIntervalMs (does not exceed the cap)", async () => {
  const { sys, setIntervalCalls } = await setup({
    retryIntervalMs: 1000,
    backoff: true,
    maxRetryIntervalMs: 4000,
  });
  for (let i = 0; i < 5; i++) {
    emitReturn(sys, false);
    await settle();
  }
  // 1000, 2000, 4000, then clamped at 4000, 4000 — never above the cap.
  assert.equal(Math.max(...setIntervalCalls), 4000, "no value exceeds maxRetryIntervalMs");
  assert.deepEqual(setIntervalCalls, [1000, 2000, 4000, 4000, 4000], "clamped once it reaches the cap");
});

test("BVA: backoff off → every failure uses the flat base interval", async () => {
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 5000, backoff: false });
  for (let i = 0; i < 3; i++) {
    emitReturn(sys, false);
    await settle();
  }
  assert.deepEqual(setIntervalCalls, [5000, 5000, 5000], "no doubling when backoff is off");
});

test("BVA: maxConsecutiveRetries === 0 → unlimited retries (the limit is disabled)", async () => {
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 1000, maxConsecutiveRetries: 0 });
  for (let i = 0; i < 6; i++) {
    emitReturn(sys, false);
    await settle();
  }
  assert.equal(setIntervalCalls.length, 6, "0 means no cap on the number of retries");
});

test("BVA: maxConsecutiveRetries === 1 → only the first consecutive failure fires", async () => {
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 1000, maxConsecutiveRetries: 1 });
  emitReturn(sys, false); // 1st — fires
  await settle();
  emitReturn(sys, false); // 2nd — over the limit, silent
  await settle();
  emitReturn(sys, false); // 3rd — still silent
  await settle();
  assert.equal(setIntervalCalls.length, 1, "stops after the 1st consecutive failure");
});

test("BVA: maxConsecutiveRetries === N → exactly N consecutive failures fire, then stop", async () => {
  const N = 3;
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 1000, maxConsecutiveRetries: N });
  for (let i = 0; i < N + 2; i++) {
    emitReturn(sys, false);
    await settle();
  }
  assert.equal(setIntervalCalls.length, N, `only ${N} of the ${N + 2} failures fire`);
});

// ===========================================================================
// STATE TRANSITIONS — the consecutive-failure streak (fail → fail → success → fail)
// ===========================================================================

test("state: success between failures resets the streak (over the retry limit)", async () => {
  // limit=2: two fails fire, the 3rd would be silenced — unless a success resets.
  const { sys, setIntervalCalls } = await setup({ retryIntervalMs: 1000, maxConsecutiveRetries: 2 });
  emitReturn(sys, false); // streak 1 — fires
  await settle();
  emitReturn(sys, false); // streak 2 — fires
  await settle();
  emitReturn(sys, true); // success — streak resets to 0
  await settle();
  emitReturn(sys, false); // streak 1 again — fires (would be silenced without the reset)
  await settle();
  assert.equal(setIntervalCalls.length, 3, "the post-success failure fires again after the reset");
});

test("state: success resets the BACKOFF curve back to the base interval (fail→fail→success→fail)", async () => {
  const { sys, setIntervalCalls } = await setup({
    retryIntervalMs: 1000,
    backoff: true,
    maxRetryIntervalMs: 1_000_000,
  });
  emitReturn(sys, false); // 1000 (2^0)
  await settle();
  emitReturn(sys, false); // 2000 (2^1) — streak is now backed off
  await settle();
  emitReturn(sys, true); // success — resets the streak
  await settle();
  emitReturn(sys, false); // back to BASE 1000, not the backed-off 4000
  await settle();
  assert.deepEqual(setIntervalCalls, [1000, 2000, 1000], "post-success failure returns to base, not the backed-off value");
});

test("state: a fresh agent instance has its own independent streak (closure state, R6)", async () => {
  // First instance backs off to 2000; a second instance must start at base.
  const { sys: sysA, setIntervalCalls: callsA } = await setup({ retryIntervalMs: 1000, backoff: true, maxRetryIntervalMs: 1_000_000 });
  emitReturn(sysA, false);
  await settle();
  emitReturn(sysA, false);
  await settle();
  assert.deepEqual(callsA, [1000, 2000], "instance A backs off");

  const { sys: sysB, setIntervalCalls: callsB } = await setup({ retryIntervalMs: 1000, backoff: true, maxRetryIntervalMs: 1_000_000 });
  emitReturn(sysB, false);
  await settle();
  assert.deepEqual(callsB, [1000], "instance B starts fresh at the base — no shared module state");
});

// ===========================================================================
// NEGATIVE / ERROR GUESSING — guard, malformed payloads, teardown
// ===========================================================================

test("negative: NO clock.set_interval registered → a failed return does NOT throw (has() guard)", async () => {
  const { sys } = await setup({}, { withClock: false });
  // The plugin must guard with actions.has(); an unguarded invoke would reject and
  // (in a listener) surface as an unhandled rejection. Emitting must stay clean.
  await assert.doesNotReject(async () => {
    emitReturn(sys, false);
    await settle();
  });
});

test("negative: listener never throws on malformed payloads (null / undefined / missing ok / non-boolean ok)", async () => {
  const { sys, setIntervalCalls } = await setup({});
  const bad: unknown[] = [
    null,
    undefined,
    {},
    { id: "x", at: 1 }, // missing ok
    { ok: "false" }, // non-boolean ok (string)
    { ok: 0 }, // non-boolean ok (number)
    { ok: null },
    42,
    "not-an-object",
    [],
  ];
  for (const payload of bad) {
    assert.doesNotThrow(() => sys.events.emit(Events.LLM_RETURN, payload), `emit must not throw for ${JSON.stringify(payload)}`);
  }
  await settle();
  // A non-boolean / missing ok is NOT a strict ok:false, so it must not be treated
  // as a retryable failure (only a real Reply{ok:false} accelerates).
  assert.deepEqual(setIntervalCalls, [], "malformed payloads never trigger set_interval");
});

test("negative: ok:true with no data does not throw and stays a no-op", async () => {
  const { sys, setIntervalCalls } = await setup({});
  assert.doesNotThrow(() => sys.events.emit(Events.LLM_RETURN, { id: "x", at: 1, ok: true }));
  await settle();
  assert.deepEqual(setIntervalCalls, [], "bare success is still a no-op");
});

test("teardown: after teardown a further failed return causes NO set_interval", async () => {
  const { p, sys, setIntervalCalls } = await setup({ retryIntervalMs: 1000 });
  emitReturn(sys, false);
  await settle();
  assert.equal(setIntervalCalls.length, 1, "fired once before teardown");
  await p.teardown();
  emitReturn(sys, false);
  await settle();
  assert.equal(setIntervalCalls.length, 1, "no further set_interval after teardown (listener unsubscribed)");
});

test("teardown: is idempotent — calling it twice does not throw", async () => {
  const { p } = await setup({});
  await p.teardown();
  await assert.doesNotReject(async () => p.teardown(), "second teardown must not throw/reject");
});

test("teardown before any event: does not throw", async () => {
  const { p } = await setup({});
  await assert.doesNotReject(async () => p.teardown());
});
