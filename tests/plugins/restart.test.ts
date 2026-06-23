import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import type { ContextBlock } from "../../contracts/context";
import type { ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// Edge tests for the `restart` plugin. The real path re-execs the process (it
// calls process.exit), which can't be exercised in-process — so these run with
// dryRun:true, which reports the plan WITHOUT restarting. That covers tool
// registration, guidance, and the reconstructed launch command.
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
