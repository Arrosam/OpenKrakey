/**
 * Black-box edge tests for the `toolbox` plugin.
 *
 * Derived ONLY from:
 *   - overviews/nodes/toolbox.md (the spec)
 *   - contracts/plugin (Plugin / PluginManifest / PluginContext)
 *   - contracts/llm (ToolDef, CommunicatorLibrary)
 *   - shared/actions (Actions.CLOCK_SET_INTERVAL / CLOCK_SET_DEFAULT_INTERVAL)
 *
 * The plugin implementation does NOT exist yet (public_plugin/toolbox/index.ts).
 * It is loaded with a GUARDED dynamic import so a missing module yields a clean
 * ASSERTION failure ("plugin not implemented yet") in every test rather than a
 * file-level crash. No implementation files under packages/ or public_plugin/
 * are read by these tests.
 *
 * Harness: a REAL event-system bus (createEventSystem) + a Map-backed block store
 * stub + a hand-built CommunicatorLibrary stub + a stub `llm.register_tool` action
 * registered BEFORE setup that captures every ToolDef the plugin registers.
 *
 * Spec pins:
 *   1. manifest.id === "toolbox"; requires includes "llm.register_tool".
 *   2. After setup: actions.has("time.now"); invoking it returns { iso, epochMs }
 *      where iso parses to a date and epochMs is finite and they agree.
 *   3. Exactly three ToolDefs captured: "time.now" plus two whose names STRICTLY
 *      EQUAL Actions.CLOCK_SET_INTERVAL / CLOCK_SET_DEFAULT_INTERVAL; the clock
 *      defs have a params schema mentioning "ms" and non-empty descriptions.
 *   4. toolbox does NOT register the clock.* actions itself (the orchestrator owns
 *      them) — actions.has(Actions.CLOCK_SET_INTERVAL) stays false after setup.
 *   5. teardown unregisters time.now.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEventSystem } from "../../packages/event-system/src";
import { Actions } from "../../shared/actions";
import type { CommunicatorLibrary } from "../../contracts/llm";
import type { ContextBlock } from "../../contracts/context";

// ---------------------------------------------------------------------------
// Guarded import of the (possibly-missing) plugin under test.
// A missing module -> mod === null -> each test fails on a clean assertion.
// ---------------------------------------------------------------------------
const mod: any = await import("../../public_plugin/toolbox/index.ts").then(
  (m) => m,
  () => null,
);

/** Resolve the plugin object (default export, or the module itself as fallback). */
function loadPlugin(): any {
  assert.ok(mod, "plugin not implemented yet (public_plugin/toolbox/index.ts missing or failed to import)");
  const plugin = mod.default ?? mod.plugin ?? mod;
  assert.ok(plugin, "plugin module present but no default export");
  assert.equal(typeof plugin.setup, "function", "plugin.setup must be a function");
  assert.ok(plugin.manifest, "plugin.manifest must be present");
  return plugin;
}

// ---------------------------------------------------------------------------
// Block-store stub (Map-backed) implementing the PluginContext block ops.
// ---------------------------------------------------------------------------
function blockStore() {
  const blocks = new Map<string, ContextBlock>();
  return {
    blocks,
    setBlock(b: ContextBlock) {
      blocks.set(b.id, b);
    },
    getBlock(id: string) {
      return blocks.get(id);
    },
    removeBlock(id: string) {
      return blocks.delete(id);
    },
    listBlocks() {
      return [...blocks.values()].map((b) => ({ id: b.id, priority: b.priority }));
    },
  };
}

// ---------------------------------------------------------------------------
// Stub CommunicatorLibrary — toolbox needs no LLM call, but PluginContext.llm
// must be a valid library. A single fake chat communicator is provided so the
// surface is realistic.
// ---------------------------------------------------------------------------
function stubLibrary(): CommunicatorLibrary {
  const comm: any = {
    name: "fake",
    provider: "fake",
    model: "fake-1",
    capabilities: ["chat"] as const,
    input: ["text"] as const,
    output: ["text"] as const,
    chat: async () => ({ content: "" }),
  };
  return {
    get: (name: string) => (name === "fake" ? comm : undefined),
    has: (name: string) => name === "fake",
    list: () => ["fake"],
    withCapability: (cap: string) => (cap === "chat" ? ["fake"] : []),
  } as CommunicatorLibrary;
}

// ---------------------------------------------------------------------------
// Harness: real bus + captured ToolDefs + a temp dataDir. Registers the stub
// `llm.register_tool` action BEFORE setup (mirrors the manifest requirement that
// the action be present at the plugin's setup time).
//
// Returns the live handles plus a teardown() to clean the temp dir.
// ---------------------------------------------------------------------------
type Harness = {
  sys: ReturnType<typeof createEventSystem>;
  ctx: any;
  toolDefs: any[];
  store: ReturnType<typeof blockStore>;
  dataDir: string;
  cleanup: () => void;
};

function makeHarness(opts?: { config?: unknown; agentId?: string; omitRegisterTool?: boolean }): Harness {
  const sys = createEventSystem();
  const store = blockStore();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-toolbox-"));
  const toolDefs: any[] = [];

  // The capability the manifest REQUIRES: capture each ToolDef, return nothing.
  if (!opts?.omitRegisterTool) {
    sys.actions.register("llm.register_tool", async (params: unknown) => {
      toolDefs.push(params);
      return undefined;
    });
  }

  const ctx = {
    agentId: opts?.agentId ?? "agent-test",
    events: sys.events,
    actions: sys.actions,
    config: opts?.config,
    dataDir,
    llm: stubLibrary(),
    setBlock: store.setBlock,
    getBlock: store.getBlock,
    removeBlock: store.removeBlock,
    listBlocks: store.listBlocks,
    log: () => {},
  };

  return {
    sys,
    ctx,
    toolDefs,
    store,
    dataDir,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

/** Run a body with a fresh harness; always clean up the temp dir. */
async function withHarness(
  body: (h: Harness, plugin: any) => Promise<void> | void,
  opts?: Parameters<typeof makeHarness>[0],
): Promise<void> {
  const plugin = loadPlugin();
  const h = makeHarness(opts);
  try {
    await body(h, plugin);
  } finally {
    h.cleanup();
  }
}

// ===========================================================================
// 1. MANIFEST SHAPE (positive + negative)
// ===========================================================================

test("manifest: id is exactly 'toolbox'", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.manifest.id, "toolbox");
});

test("manifest: version is a non-empty string", () => {
  const plugin = loadPlugin();
  assert.equal(typeof plugin.manifest.version, "string");
  assert.ok(plugin.manifest.version.length > 0, "version must be non-empty");
});

test("manifest: requires includes 'llm.register_tool'", () => {
  const plugin = loadPlugin();
  assert.ok(Array.isArray(plugin.manifest.requires), "requires must be an array");
  assert.ok(
    plugin.manifest.requires.includes("llm.register_tool"),
    "requires must list the 'llm.register_tool' action",
  );
});

test("manifest: does NOT require the clock actions (those are the orchestrator's, used as tool names only)", () => {
  const plugin = loadPlugin();
  const req: string[] = plugin.manifest.requires ?? [];
  // The clock setters are TOOL NAMES the LLM calls, not actions toolbox depends on at setup.
  assert.ok(!req.includes(Actions.CLOCK_SET_INTERVAL), "must not require clock.set_interval");
  assert.ok(!req.includes(Actions.CLOCK_SET_DEFAULT_INTERVAL), "must not require clock.set_default_interval");
});

// ===========================================================================
// 2. time.now ACTION — registration + return shape (positive + BVA)
// ===========================================================================

test("setup: registers the 'time.now' action on the bus", async () => {
  await withHarness(async (h, plugin) => {
    assert.equal(h.sys.actions.has("time.now"), false, "time.now must not exist before setup");
    await plugin.setup(h.ctx);
    assert.equal(h.sys.actions.has("time.now"), true, "time.now must be registered after setup");
  });
});

test("time.now: returns { iso, epochMs } with correct primitive types", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const res: any = await h.sys.actions.invoke("time.now");
    assert.ok(res && typeof res === "object", "result must be an object");
    assert.equal(typeof res.iso, "string", "iso must be a string");
    assert.equal(typeof res.epochMs, "number", "epochMs must be a number");
  });
});

test("time.now: epochMs is finite and iso parses to a real date", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const res: any = await h.sys.actions.invoke("time.now");
    assert.ok(Number.isFinite(res.epochMs), "epochMs must be finite");
    const parsed = Date.parse(res.iso);
    assert.ok(!Number.isNaN(parsed), "iso must be parseable by Date.parse");
  });
});

test("time.now: iso and epochMs AGREE (within a small tolerance)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const res: any = await h.sys.actions.invoke("time.now");
    const parsed = Date.parse(res.iso);
    assert.ok(
      Math.abs(parsed - res.epochMs) <= 1000,
      `iso (${res.iso} -> ${parsed}) and epochMs (${res.epochMs}) must agree within 1s`,
    );
  });
});

test("time.now: reports ~current wall time (close to Date.now at call site)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const before = Date.now();
    const res: any = await h.sys.actions.invoke("time.now");
    const after = Date.now();
    // Allow generous slack for scheduling, but it must be the real clock, not 0/fixed.
    assert.ok(
      res.epochMs >= before - 2000 && res.epochMs <= after + 2000,
      `epochMs ${res.epochMs} must be near [${before}, ${after}]`,
    );
  });
});

test("time.now: ignores params — invoking with arbitrary params still yields the same shape (BVA: extra/garbage input)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    for (const p of [undefined, null, {}, { anything: 1 }, "ignored", 42, []]) {
      const res: any = await h.sys.actions.invoke("time.now", p as any);
      assert.equal(typeof res.iso, "string", `iso shape with params=${JSON.stringify(p)}`);
      assert.equal(typeof res.epochMs, "number", `epochMs shape with params=${JSON.stringify(p)}`);
    }
  });
});

test("time.now: advances across successive calls (monotonic, not a frozen constant)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const a: any = await h.sys.actions.invoke("time.now");
    // tiny async gap
    await new Promise((r) => setTimeout(r, 5));
    const b: any = await h.sys.actions.invoke("time.now");
    assert.ok(b.epochMs >= a.epochMs, "epochMs must be non-decreasing across calls");
  });
});

// ===========================================================================
// 3. REGISTERED TOOLDEFS — exactly three, correct names & schemas (positive + negative)
// ===========================================================================

test("register_tool: invoked exactly THREE times during setup", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    assert.equal(h.toolDefs.length, 3, "exactly three ToolDefs must be registered");
  });
});

test("register_tool: each captured arg is a ToolDef with a string name", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    for (const td of h.toolDefs) {
      assert.ok(td && typeof td === "object", "each ToolDef must be an object");
      assert.equal(typeof td.name, "string", "ToolDef.name must be a string");
      assert.ok(td.name.length > 0, "ToolDef.name must be non-empty");
    }
  });
});

test("register_tool: the three tool names are exactly time.now + the two clock action constants", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const names = h.toolDefs.map((t) => t.name).sort();
    const expected = ["time.now", Actions.CLOCK_SET_INTERVAL, Actions.CLOCK_SET_DEFAULT_INTERVAL].sort();
    assert.deepEqual(names, expected, "registered tool names must match the spec set exactly");
  });
});

test("register_tool: clock tool names STRICTLY EQUAL the shared/actions constants (no near-miss strings)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const byName = new Map(h.toolDefs.map((t) => [t.name, t]));
    assert.ok(byName.has(Actions.CLOCK_SET_INTERVAL), `a tool named exactly "${Actions.CLOCK_SET_INTERVAL}" must be registered`);
    assert.ok(byName.has(Actions.CLOCK_SET_DEFAULT_INTERVAL), `a tool named exactly "${Actions.CLOCK_SET_DEFAULT_INTERVAL}" must be registered`);
    // The literal values the LLM must call, pinned here so a typo in either side fails.
    assert.equal(Actions.CLOCK_SET_INTERVAL, "clock.set_interval");
    assert.equal(Actions.CLOCK_SET_DEFAULT_INTERVAL, "clock.set_default_interval");
  });
});

test("register_tool: no duplicate tool names", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const names = h.toolDefs.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "tool names must be unique");
  });
});

test("register_tool: the time.now ToolDef has a non-empty description", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const td = h.toolDefs.find((t) => t.name === "time.now");
    assert.ok(td, "time.now ToolDef must exist");
    assert.equal(typeof td.description, "string", "time.now description must be a string");
    assert.ok(td.description.trim().length > 0, "time.now description must be non-empty");
  });
});

test("register_tool: each clock ToolDef has a non-empty description", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    for (const name of [Actions.CLOCK_SET_INTERVAL, Actions.CLOCK_SET_DEFAULT_INTERVAL]) {
      const td = h.toolDefs.find((t) => t.name === name);
      assert.ok(td, `${name} ToolDef must exist`);
      assert.equal(typeof td.description, "string", `${name} description must be a string`);
      assert.ok(td.description.trim().length > 0, `${name} description must be non-empty`);
    }
  });
});

test("register_tool: each clock ToolDef declares a parameters schema mentioning 'ms'", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    for (const name of [Actions.CLOCK_SET_INTERVAL, Actions.CLOCK_SET_DEFAULT_INTERVAL]) {
      const td = h.toolDefs.find((t) => t.name === name);
      assert.ok(td, `${name} ToolDef must exist`);
      assert.ok(td.parameters != null, `${name} must declare a parameters schema`);
      // The schema must reference the "ms" parameter somewhere in its structure.
      const blob = JSON.stringify(td.parameters);
      assert.ok(blob.includes("ms"), `${name} parameters schema must mention "ms" (got ${blob})`);
    }
  });
});

test("register_tool: the time.now ToolDef declares NO meaningful params (per spec '(no params)')", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const td = h.toolDefs.find((t) => t.name === "time.now");
    assert.ok(td, "time.now ToolDef must exist");
    // Either parameters is absent, or it declares an empty/parameterless schema.
    if (td.parameters != null) {
      const props = (td.parameters as any).properties;
      if (props != null) {
        assert.equal(
          Object.keys(props).length,
          0,
          "time.now must not declare input properties (spec: no params)",
        );
      }
    }
  });
});

// ===========================================================================
// 4. SEPARATION OF CONCERNS — toolbox does NOT own the clock.* actions
// ===========================================================================

test("setup: does NOT register clock.set_interval as an action (orchestrator owns it)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    assert.equal(
      h.sys.actions.has(Actions.CLOCK_SET_INTERVAL),
      false,
      "toolbox must not register the clock.set_interval action",
    );
  });
});

test("setup: does NOT register clock.set_default_interval as an action (orchestrator owns it)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    assert.equal(
      h.sys.actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL),
      false,
      "toolbox must not register the clock.set_default_interval action",
    );
  });
});

test("setup: the ONLY new action toolbox registers is time.now", async () => {
  await withHarness(async (h, plugin) => {
    const before = new Set(h.sys.actions.list());
    await plugin.setup(h.ctx);
    const added = h.sys.actions.list().filter((a) => !before.has(a));
    assert.deepEqual(added.sort(), ["time.now"], "the only action added by setup must be time.now");
  });
});

// ===========================================================================
// 5. TEARDOWN — unregisters time.now (state transition)
// ===========================================================================

test("teardown: exists and is a function", () => {
  const plugin = loadPlugin();
  assert.equal(typeof plugin.teardown, "function", "teardown must be defined");
});

test("teardown: unregisters the time.now action (registered -> torn down)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    assert.equal(h.sys.actions.has("time.now"), true, "precondition: time.now registered after setup");
    await plugin.teardown?.();
    assert.equal(h.sys.actions.has("time.now"), false, "time.now must be unregistered after teardown");
  });
});

test("teardown: after teardown, invoking time.now rejects / fails (action gone)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    await plugin.teardown?.();
    await assert.rejects(
      () => h.sys.actions.invoke("time.now"),
      "invoking a torn-down action must reject",
    );
  });
});

test("state transition: setup -> teardown -> setup re-registers time.now cleanly (idempotent re-arm)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    await plugin.teardown?.();
    assert.equal(h.sys.actions.has("time.now"), false, "torn down");
    // Re-running setup on the same bus must work without a duplicate-registration crash.
    await plugin.setup(h.ctx);
    assert.equal(h.sys.actions.has("time.now"), true, "time.now must be registered again after re-setup");
    const res: any = await h.sys.actions.invoke("time.now");
    assert.equal(typeof res.epochMs, "number", "re-registered time.now still returns the shape");
  });
});

test("teardown: does not strand the captured clock ToolDefs (still exactly 3 registered during the prior setup)", async () => {
  await withHarness(async (h, plugin) => {
    await plugin.setup(h.ctx);
    const count = h.toolDefs.length;
    await plugin.teardown?.();
    // teardown concerns actions, not previously-captured tool registrations.
    assert.equal(h.toolDefs.length, count, "teardown must not re-invoke register_tool");
    assert.equal(count, 3, "setup must have registered exactly three tools");
  });
});

// ===========================================================================
// 6. CONFIG ROBUSTNESS (BVA on PluginContext.config — spec ignores config)
// ===========================================================================

test("setup: tolerates an undefined config slice", async () => {
  await withHarness(
    async (h, plugin) => {
      await plugin.setup(h.ctx);
      assert.equal(h.sys.actions.has("time.now"), true);
      assert.equal(h.toolDefs.length, 3);
    },
    { config: undefined },
  );
});

test("setup: tolerates an empty-object config slice", async () => {
  await withHarness(
    async (h, plugin) => {
      await plugin.setup(h.ctx);
      assert.equal(h.sys.actions.has("time.now"), true);
      assert.equal(h.toolDefs.length, 3);
    },
    { config: {} },
  );
});

test("setup: tolerates an arbitrary/garbage config slice", async () => {
  await withHarness(
    async (h, plugin) => {
      await plugin.setup(h.ctx);
      assert.equal(h.sys.actions.has("time.now"), true);
      assert.equal(h.toolDefs.length, 3);
    },
    { config: { nonsense: [1, 2, 3], nested: { x: true } } },
  );
});
