import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import type { ContextBlock } from "../../contracts/context";
import type { ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// Edge tests for the `restart` plugin. The plugin no longer owns process
// lifecycle: instead of process.exit it invokes the core `core.restart` action,
// which IS exercisable in-process by stubbing that action on the bus. dryRun still
// reports the plan WITHOUT restarting. Covered: tool registration, guidance, the
// reconstructed launch command (dryRun), the live core.restart delegation, and the
// no-seam degrade path.
// ---------------------------------------------------------------------------

const RESTART = "restart.now";
const GUIDANCE = "restart.guidance";

const mod: any = await import("../../public_plugin/restart/index.ts").then((m) => m, () => null);
function plugin(): any {
  assert.ok(mod, "restart module failed to import");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

function makeCtx(config: unknown) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  sys.actions.register("llm.register_tool", async (def: unknown) => { tools.push(def as ToolDef); return true; });
  const ctx: any = {
    agentId: "a", events: sys.events, actions: sys.actions, config, dataDir: "/tmp/x",
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => store.set(b.id, b),
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} }, print() {},
  };
  return { ctx, store, sys, tools };
}
async function setup(config: unknown) {
  const p = plugin();
  const h = makeCtx(config);
  await p.setup(h.ctx);
  return { p, ...h };
}

test("manifest: id 'restart' v0.1.0", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "restart");
  assert.equal(p.manifest.version, "0.1.0");
});

test("setup: registers restart.now, declares one ToolDef, sets a system guidance block", async () => {
  const { sys, tools, store } = await setup({ dryRun: true });
  assert.ok(sys.actions.list().includes(RESTART), "restart.now registered");
  assert.deepEqual(tools.map((t) => t.name), [RESTART]);
  const b = store.get(GUIDANCE);
  assert.ok(b, "guidance block present");
  assert.notEqual((b as any).target, "messages", "guidance targets the system prompt");
});

test("restart.now (dryRun): returns the plan WITHOUT restarting, with a node launch command", async () => {
  const { sys } = await setup({ dryRun: true });
  const res: any = await sys.actions.invoke(RESTART, { reason: "loading a new plugin" });
  assert.equal(res.restarting, false, "must NOT restart in dry run");
  assert.equal(res.dryRun, true);
  assert.ok(Array.isArray(res.command) && res.command.length >= 1, "reports a launch command");
  assert.equal(res.command[0], process.execPath, "command starts with the node executable");
});

test("teardown: removes the guidance block and unregisters the tool", async () => {
  const { p, sys, store } = await setup({ dryRun: true });
  await p.teardown();
  assert.equal(store.get(GUIDANCE), undefined, "guidance removed");
  assert.ok(!sys.actions.list().includes(RESTART), "restart.now unregistered");
});

test("restart.now (live): invokes core.restart with the configured delayMs (and never process.exit)", async () => {
  const { sys } = await setup({ delayMs: 2222 });
  const calls: unknown[] = [];
  sys.actions.register("core.restart", async (p: unknown) => { calls.push(p); return { restarting: true }; });
  const res: any = await sys.actions.invoke(RESTART, {});
  // This test process is still alive afterwards ⇒ the plugin did NOT call process.exit.
  assert.equal(res.restarting, true, "reports it is restarting");
  assert.equal(res.delayMs, 2222);
  assert.deepEqual(calls, [{ delayMs: 2222 }], "core.restart invoked once with the configured delayMs");
});

test("restart.now (live) with NO core.restart seam: degrades to a no-op + error (no throw, no exit)", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(RESTART, {});
  assert.equal(res.restarting, false, "must not claim to restart without the core seam");
  assert.ok(typeof res.error === "string" && res.error.length > 0, "reports why it could not restart");
});
