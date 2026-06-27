import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import { Actions, Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";
import type { ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// Edge tests for the `interval_toggle` plugin — self-pacing tools that drive the
// per-Agent clock over the action bus:
//   interval.set  { intervalMs }          -> set_default_interval + set_interval
//   interval.hold { intervalMs, beats }   -> hold for N clock.tick beats, then
//                                            revert to the base via set_default.
// ---------------------------------------------------------------------------

const SET = "interval.set";
const HOLD = "interval.hold";
const GUIDANCE = "interval.guidance";

const mod: any = await import("../../public_plugin/interval_toggle/index.ts").then((m) => m, () => null);
function plugin(): any {
  assert.ok(mod, "interval_toggle module failed to import");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// Fake PluginContext over a real event-system. Records the clock action payloads
// so tests can assert what the plugin drove, plus the declared ToolDefs.
function makeCtx(config: unknown) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  const setIntervalCalls: number[] = [];
  const setDefaultCalls: number[] = [];
  const msOf = (p: unknown): number => (p as { ms?: number })?.ms as number;
  sys.actions.register("llm.register_tool", async (def: unknown) => { tools.push(def as ToolDef); return true; });
  sys.actions.register(Actions.CLOCK_SET_INTERVAL, async (p: unknown) => { setIntervalCalls.push(msOf(p)); });
  sys.actions.register(Actions.CLOCK_SET_DEFAULT_INTERVAL, async (p: unknown) => { setDefaultCalls.push(msOf(p)); });
  const ctx: any = {
    agentId: "a", events: sys.events, actions: sys.actions, config, dataDir: "/tmp/x",
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => store.set(b.id, b),
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} }, print() {},
  };
  return { ctx, store, sys, tools, setIntervalCalls, setDefaultCalls };
}
async function setup(config: unknown = {}) {
  const p = plugin();
  const h = makeCtx(config);
  await p.setup(h.ctx);
  return { p, ...h };
}
const tick = (sys: ReturnType<typeof createEventSystem>) =>
  sys.events.emit(Events.CLOCK_TICK, { at: 1, data: { seq: 1 } });
const settle = () => new Promise((r) => setTimeout(r, 15));

test("manifest: id 'interval_toggle' v0.1.0", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "interval_toggle");
  assert.equal(p.manifest.version, "0.1.0");
});

test("setup: registers interval.set + interval.hold, declares two ToolDefs, sets a system guidance block", async () => {
  const { sys, tools, store } = await setup({});
  const list = sys.actions.list();
  assert.ok(list.includes(SET) && list.includes(HOLD), "both action tools registered");
  assert.deepEqual(tools.map((t) => t.name).sort(), [HOLD, SET]);
  const b = store.get(GUIDANCE);
  assert.ok(b, "guidance block present");
  assert.notEqual((b as any).target, "messages", "guidance targets the system prompt");
});

test("interval.set: drives set_default_interval + set_interval with { ms }", async () => {
  const { sys, setIntervalCalls, setDefaultCalls } = await setup({});
  const res: any = await sys.actions.invoke(SET, { intervalMs: 10000 });
  assert.equal(res.ok, true);
  assert.equal(res.intervalMs, 10000);
  assert.deepEqual(setDefaultCalls, [10000], "set_default_interval called with 10000");
  assert.deepEqual(setIntervalCalls, [10000], "set_interval called with 10000");
});

test("interval.set: rejects a non-positive / missing interval", async () => {
  const { sys } = await setup({});
  await assert.rejects(sys.actions.invoke(SET, { intervalMs: 0 }));
  await assert.rejects(sys.actions.invoke(SET, {}));
});

test("interval.hold: applies the held interval now and reverts to base after `beats` ticks", async () => {
  const { sys, setDefaultCalls } = await setup({});
  await sys.actions.invoke(SET, { intervalMs: 15000 }); // base = 15000
  await sys.actions.invoke(HOLD, { intervalMs: 28800000, beats: 2 });
  // applied immediately
  assert.equal(setDefaultCalls[setDefaultCalls.length - 1], 28800000, "hold sets the rhythm to 8h now");
  tick(sys); await settle();
  assert.equal(setDefaultCalls[setDefaultCalls.length - 1], 28800000, "still held after 1st beat");
  tick(sys); await settle();
  assert.equal(setDefaultCalls[setDefaultCalls.length - 1], 15000, "reverted to base (15000) after 2nd beat");
  const len = setDefaultCalls.length;
  tick(sys); await settle();
  assert.equal(setDefaultCalls.length, len, "no further reverts once the hold elapsed");
});

test("interval.hold: beats defaults to 1 (reverts after a single beat)", async () => {
  const { sys, setDefaultCalls } = await setup({ baseIntervalMs: 60000 });
  await sys.actions.invoke(HOLD, { intervalMs: 5000 });
  assert.equal(setDefaultCalls[setDefaultCalls.length - 1], 5000, "held at 5000 now");
  tick(sys); await settle();
  assert.equal(setDefaultCalls[setDefaultCalls.length - 1], 60000, "reverts to config base 60000 after 1 beat");
});

test("teardown: removes the guidance block and unregisters both tools", async () => {
  const { p, sys, store } = await setup({});
  await p.teardown();
  assert.equal(store.get(GUIDANCE), undefined, "guidance removed");
  const list = sys.actions.list();
  assert.ok(!list.includes(SET) && !list.includes(HOLD), "tools unregistered");
});
