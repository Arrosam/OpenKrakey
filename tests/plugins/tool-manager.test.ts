import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import type { Plugin, PluginContext } from "../../contracts/plugin";
import type { ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `tool-manager` plugin — the per-Agent tool
// registry. It owns two actions:
//   - llm.register_tool { ToolDef } -> add/replace by name (validated)
//   - llm.list_tools             -> ToolDef[] snapshot of the registry
// and provides the "llm.register_tool" capability so the loader orders it ahead
// of every tool plugin. It holds no LLM/model behaviour.
// ---------------------------------------------------------------------------

const mod: any = await import("../../public_plugin/tool-manager/index.ts").then(
  (m) => m,
  () => null,
);

function plugin(): Plugin {
  assert.equal(
    typeof mod?.default,
    "function",
    "tool-manager not implemented — default export must be a PluginFactory",
  );
  return (mod.default as () => Plugin)();
}

function makeCtx() {
  const sys = createEventSystem();
  const ctx: PluginContext = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config: {},
    dataDir: "",
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: () => {},
    getBlock: () => undefined,
    removeBlock: () => false,
    listBlocks: () => [],
    log: { info() {}, warn() {}, error() {} },
    print() {},
  } as unknown as PluginContext;
  return { ctx, sys };
}

async function setup() {
  const p = plugin();
  const { ctx, sys } = makeCtx();
  await p.setup(ctx);
  return { p, sys, actions: sys.actions };
}

// ===========================================================================
// manifest / wiring
// ===========================================================================

test("manifest: id 'tool-manager', provides llm.register_tool", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "tool-manager");
  assert.ok(Array.isArray(p.manifest.provides), "provides must be an array");
  assert.ok(
    p.manifest.provides!.includes("llm.register_tool"),
    "must provide the llm.register_tool capability so the loader orders it before tool plugins",
  );
});

test("setup: registers llm.register_tool AND llm.list_tools on the actionbus", async () => {
  const { actions } = await setup();
  assert.equal(actions.has("llm.register_tool"), true);
  assert.equal(actions.has("llm.list_tools"), true);
});

// ===========================================================================
// llm.register_tool — positive + validation (ported from llm-core's old suite)
// ===========================================================================

test("register_tool: a valid ToolDef resolves true and appears in list_tools", async () => {
  const { actions } = await setup();
  const res = await actions.invoke("llm.register_tool", {
    name: "t1",
    description: "first tool",
    parameters: { type: "object" },
  });
  assert.equal(res, true);
  const tools = (await actions.invoke("llm.list_tools")) as ToolDef[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "t1");
  assert.equal(tools[0].description, "first tool");
});

test("register_tool: name-only ToolDef resolves true", async () => {
  const { actions } = await setup();
  assert.equal(await actions.invoke("llm.register_tool", { name: "bare" }), true);
});

test("register_tool: two distinct names both appear in list_tools", async () => {
  const { actions } = await setup();
  await actions.invoke("llm.register_tool", { name: "a" });
  await actions.invoke("llm.register_tool", { name: "b" });
  const names = ((await actions.invoke("llm.list_tools")) as ToolDef[]).map((d) => d.name).sort();
  assert.deepEqual(names, ["a", "b"]);
});

test("register_tool: re-registering the same name REPLACES (later def wins, one entry)", async () => {
  const { actions } = await setup();
  await actions.invoke("llm.register_tool", { name: "t1", description: "first" });
  await actions.invoke("llm.register_tool", { name: "t1", description: "second" });
  const tools = (await actions.invoke("llm.list_tools")) as ToolDef[];
  assert.equal(tools.filter((d) => d.name === "t1").length, 1);
  assert.equal(tools[0].description, "second");
});

for (const [label, params] of [
  ["null", null],
  ["non-object (string)", "t1"],
  ["missing name", { description: "no name" }],
  ["empty-string name", { name: "" }],
  ["non-string name (number)", { name: 123 }],
] as Array<[string, unknown]>) {
  test(`register_tool: rejects on ${label}`, async () => {
    const { actions } = await setup();
    await assert.rejects(actions.invoke("llm.register_tool", params));
  });
}

test("register_tool: a rejected registration does not add anything to the registry", async () => {
  const { actions } = await setup();
  await assert.rejects(actions.invoke("llm.register_tool", { name: "" }));
  assert.deepEqual(await actions.invoke("llm.list_tools"), []);
});

// ===========================================================================
// llm.list_tools — snapshot semantics
// ===========================================================================

test("list_tools: empty registry returns []", async () => {
  const { actions } = await setup();
  assert.deepEqual(await actions.invoke("llm.list_tools"), []);
});

test("list_tools: returns a fresh array — mutating the result never affects the registry", async () => {
  const { actions } = await setup();
  await actions.invoke("llm.register_tool", { name: "t1" });
  const first = (await actions.invoke("llm.list_tools")) as ToolDef[];
  first.push({ name: "injected" });
  const second = (await actions.invoke("llm.list_tools")) as ToolDef[];
  assert.deepEqual(second.map((d) => d.name), ["t1"], "external mutation must not leak into the registry");
});

// ===========================================================================
// teardown
// ===========================================================================

test("teardown: unregisters both actions and clears the registry (idempotent)", async () => {
  const { p, actions } = await setup();
  await actions.invoke("llm.register_tool", { name: "t1" });
  await p.teardown?.();
  assert.equal(actions.has("llm.register_tool"), false);
  assert.equal(actions.has("llm.list_tools"), false);
  // idempotent
  await p.teardown?.();
});
