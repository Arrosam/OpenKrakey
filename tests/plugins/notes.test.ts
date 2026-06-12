/**
 * Edge tests for the `notes` public plugin — BLACK BOX, derived only from
 * contracts/plugin, contracts/llm (ToolDef), shared/actions and
 * overviews/nodes/notes.md. The implementation may NOT EXIST yet; it is loaded
 * with a guarded dynamic import so a missing module yields a clean assertion
 * failure ("plugin not implemented yet") rather than a file-level crash.
 *
 * Run only this file:
 *   node --import tsx --test tests/plugins/notes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEventSystem } from "../../packages/event-system/src";
import type { EventSystem } from "../../contracts/event-system";
import type { ToolDef, Communicator, CommunicatorLibrary } from "../../contracts/llm";
import type { Plugin, PluginContext } from "../../contracts/plugin";

// Guarded import: a missing module resolves to null so each test fails on an
// assertion, never on a thrown import error. (top-level await is fine in tests)
const mod: any = await import("../../public_plugin/notes/index.ts").then(
  (m) => m,
  () => null,
);

function loadPlugin(): Plugin {
  assert.equal(
    typeof mod?.default,
    "function",
    "plugin not implemented yet — the default export must be a PluginFactory (public_plugin/notes/index.ts)",
  );
  const p: Plugin = (mod.default as () => Plugin)(); // one fresh per-Agent instance
  return p;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  plugin: Plugin;
  sys: EventSystem;
  ctx: PluginContext;
  dataDir: string;
  notesDir: string; // dataDir/notes
  root: string; // the temp root holding dataDir (and the sentinel)
  sentinelPath: string;
  toolDefs: ToolDef[]; // every ToolDef captured by the llm.register_tool stub
  cleanup: () => void;
}

/**
 * Build a fully-wired PluginContext over a real EventSystem, register a stub
 * `llm.register_tool` action (capturing every ToolDef), then run plugin.setup.
 */
async function makeHarness(config: unknown = {}): Promise<Harness> {
  const plugin = loadPlugin();
  const sys = createEventSystem();

  // temp root: <root>/data is the dataDir; a sentinel lives ABOVE dataDir so a
  // traversal escape (../) would clobber it — we assert it stays untouched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-test-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const sentinelPath = path.join(root, "sentinel.txt");
  fs.writeFileSync(sentinelPath, "SENTINEL", "utf8");

  const notesDir = path.join(dataDir, "notes");

  // Map-backed block store stub.
  const blocks = new Map<string, any>();

  // Stub CommunicatorLibrary (notes does not call the LLM, but the contract
  // demands a real-shaped object).
  const communicator: Communicator = {
    name: "stub",
    provider: "stub",
    model: "stub-1",
    capabilities: ["chat"],
    input: ["text"],
    output: ["text"],
    async chat() {
      return { content: "" };
    },
  };
  const llm: CommunicatorLibrary = {
    get: (n) => (n === "stub" ? communicator : undefined),
    has: (n) => n === "stub",
    list: () => ["stub"],
    withCapability: (cap) => (cap === "chat" ? ["stub"] : []),
  };

  // The `llm.register_tool` action the notes plugin invokes for each tool.
  // Capture every ToolDef it is handed.
  const toolDefs: ToolDef[] = [];
  sys.actions.register("llm.register_tool", async (params: any) => {
    // The plugin passes a ToolDef-ish payload. Accept either the ToolDef
    // directly or { tool: ToolDef } to stay robust to small shape choices.
    const def: ToolDef = params && params.name ? params : params?.tool;
    assert.ok(def && typeof def.name === "string", "register_tool got no ToolDef name");
    toolDefs.push(def);
    return undefined;
  });

  const ctx: PluginContext = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir,
    llm,
    setBlock: (b) => void blocks.set(b.id, b),
    getBlock: (id) => blocks.get(id),
    removeBlock: (id) => blocks.delete(id),
    listBlocks: () =>
      [...blocks.values()].map((b: any) => ({ id: b.id, priority: b.priority })),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    print: () => {},
  };

  await plugin.setup(ctx);

  return {
    plugin,
    sys,
    ctx,
    dataDir,
    notesDir,
    root,
    sentinelPath,
    toolDefs,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// Snapshot every file path (relative to root) currently present below the temp
// root — used to prove a rejected write created nothing anywhere.
function snapshotFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

const ACTIONS = ["note.save", "note.read", "note.list"] as const;

// ===========================================================================
// 1. Shape — manifest
// ===========================================================================

test("manifest: id is 'notes' and requires includes 'llm.register_tool'", () => {
  const plugin = loadPlugin();
  assert.ok(plugin.manifest, "plugin must expose a manifest");
  assert.equal(plugin.manifest.id, "notes");
  assert.ok(Array.isArray(plugin.manifest.requires), "requires must be an array");
  assert.ok(
    plugin.manifest.requires!.includes("llm.register_tool"),
    "requires must include 'llm.register_tool'",
  );
});

// ===========================================================================
// 2. setup — registers the three actions + declares three ToolDefs
// ===========================================================================

test("setup: registers note.save / note.read / note.list on the action bus", async () => {
  const h = await makeHarness();
  try {
    for (const a of ACTIONS) {
      assert.equal(h.sys.actions.has(a), true, `action ${a} must be registered`);
    }
  } finally {
    h.cleanup();
  }
});

test("setup: creates dataDir/notes directory", async () => {
  const h = await makeHarness();
  try {
    assert.ok(fs.existsSync(h.notesDir), "dataDir/notes must exist after setup");
    assert.ok(fs.statSync(h.notesDir).isDirectory(), "dataDir/notes must be a directory");
  } finally {
    h.cleanup();
  }
});

test("setup: declares exactly three ToolDefs named for the three actions, each with a non-empty description", async () => {
  const h = await makeHarness();
  try {
    assert.equal(h.toolDefs.length, 3, "exactly three ToolDefs must be registered");
    const names = h.toolDefs.map((t) => t.name).sort();
    assert.deepEqual(names, [...ACTIONS].sort(), "ToolDef names must be the three action names");
    for (const t of h.toolDefs) {
      assert.equal(typeof t.description, "string", `${t.name} description must be a string`);
      assert.ok((t.description as string).trim().length > 0, `${t.name} description must be non-empty`);
    }
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// 3. Roundtrip — save / read / list (positive, happy path)
// ===========================================================================

test("roundtrip: note.save writes dataDir/notes/<name>.md and returns {saved:true,name}", async () => {
  const h = await makeHarness();
  try {
    const res: any = await h.sys.actions.invoke("note.save", { name: "alpha", text: "A" });
    assert.deepEqual(res, { saved: true, name: "alpha" });
    const file = path.join(h.notesDir, "alpha.md");
    assert.ok(fs.existsSync(file), "alpha.md must exist");
    assert.equal(fs.readFileSync(file, "utf8"), "A", "file content must be exactly the text");
  } finally {
    h.cleanup();
  }
});

test("roundtrip: note.read returns {name,text} for a saved note", async () => {
  const h = await makeHarness();
  try {
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "A" });
    const res: any = await h.sys.actions.invoke("note.read", { name: "alpha" });
    assert.deepEqual(res, { name: "alpha", text: "A" });
  } finally {
    h.cleanup();
  }
});

test("roundtrip: note.list returns sorted names including the saved notes", async () => {
  const h = await makeHarness();
  try {
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "A" });
    await h.sys.actions.invoke("note.save", { name: "beta", text: "B" });
    const res: any = await h.sys.actions.invoke("note.list");
    assert.ok(res && Array.isArray(res.names), "result must be { names: string[] }");
    assert.ok(res.names.includes("alpha"), "names must include alpha");
    assert.ok(res.names.includes("beta"), "names must include beta");
    const sorted = [...res.names].sort();
    assert.deepEqual(res.names, sorted, "names must be returned sorted");
  } finally {
    h.cleanup();
  }
});

test("note.list on an empty store returns an empty names array", async () => {
  const h = await makeHarness();
  try {
    const res: any = await h.sys.actions.invoke("note.list");
    assert.ok(res && Array.isArray(res.names), "result must be { names: string[] }");
    assert.equal(res.names.length, 0, "no notes => empty names");
  } finally {
    h.cleanup();
  }
});

test("note.list does not include the .md extension in names", async () => {
  const h = await makeHarness();
  try {
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "A" });
    const res: any = await h.sys.actions.invoke("note.list");
    assert.ok(res.names.includes("alpha"), "name must be the bare note name");
    assert.ok(!res.names.some((n: string) => n.endsWith(".md")), "names must not carry .md");
  } finally {
    h.cleanup();
  }
});

// BVA — name/text content boundaries that should be ACCEPTED
test("BVA: single-char name and empty text save and read back", async () => {
  const h = await makeHarness();
  try {
    const res: any = await h.sys.actions.invoke("note.save", { name: "a", text: "" });
    assert.deepEqual(res, { saved: true, name: "a" });
    const read: any = await h.sys.actions.invoke("note.read", { name: "a" });
    assert.deepEqual(read, { name: "a", text: "" });
    assert.equal(fs.readFileSync(path.join(h.notesDir, "a.md"), "utf8"), "");
  } finally {
    h.cleanup();
  }
});

test("BVA: dots/underscores/hyphens/digits in name are allowed", async () => {
  const h = await makeHarness();
  try {
    const name = "A1.b_c-2";
    const res: any = await h.sys.actions.invoke("note.save", { name, text: "ok" });
    assert.deepEqual(res, { saved: true, name });
    assert.ok(fs.existsSync(path.join(h.notesDir, `${name}.md`)), "file for valid name must exist");
  } finally {
    h.cleanup();
  }
});

test("BVA: large multi-line text roundtrips byte-for-byte", async () => {
  const h = await makeHarness();
  try {
    const text = "line1\nline2\n\n" + "x".repeat(5000) + "\ntail";
    await h.sys.actions.invoke("note.save", { name: "big", text });
    const read: any = await h.sys.actions.invoke("note.read", { name: "big" });
    assert.equal(read.text, text, "large text must roundtrip exactly");
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// 4. Validation — bad names reject AND write nothing outside dataDir/notes
// ===========================================================================

const BAD_NAMES: Array<[string, string]> = [
  ["..", "parent traversal token"],
  [".", "current-dir token"],
  ["a/b", "forward-slash path separator"],
  ["a\\b", "backslash path separator"],
  ["", "empty string"],
  ["../escape", "leading traversal"],
  ["sub/../x", "embedded traversal"],
  ["a b", "space (outside charset)"],
  ["a:b", "colon (outside charset)"],
];

for (const [bad, why] of BAD_NAMES) {
  test(`validation: note.save rejects name ${JSON.stringify(bad)} (${why}) and writes nothing`, async () => {
    const h = await makeHarness();
    try {
      const before = snapshotFiles(h.root);
      await assert.rejects(
        () => h.sys.actions.invoke("note.save", { name: bad, text: "PAYLOAD" }),
        `note.save must reject invalid name ${JSON.stringify(bad)}`,
      );
      // Sentinel above dataDir untouched.
      assert.equal(
        fs.readFileSync(h.sentinelPath, "utf8"),
        "SENTINEL",
        "sentinel above dataDir must be untouched",
      );
      // No new file appeared anywhere under the temp root.
      const after = snapshotFiles(h.root);
      assert.deepEqual(after, before, "a rejected save must not create any file");
    } finally {
      h.cleanup();
    }
  });
}

for (const [bad, why] of BAD_NAMES) {
  test(`validation: note.read rejects invalid name ${JSON.stringify(bad)} (${why})`, async () => {
    const h = await makeHarness();
    try {
      await assert.rejects(
        () => h.sys.actions.invoke("note.read", { name: bad }),
        `note.read must reject invalid name ${JSON.stringify(bad)}`,
      );
    } finally {
      h.cleanup();
    }
  });
}

test("validation: note.read of a missing note rejects with a clear (non-empty) error", async () => {
  const h = await makeHarness();
  try {
    await assert.rejects(
      () => h.sys.actions.invoke("note.read", { name: "ghost" }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg && msg.trim().length > 0, "missing-note error must carry a message");
        return true;
      },
    );
  } finally {
    h.cleanup();
  }
});

test("validation: a rejected traversal save does not create a stray .md anywhere outside notesDir", async () => {
  const h = await makeHarness();
  try {
    // even with a .md-looking traversal, nothing escapes
    await assert.rejects(() =>
      h.sys.actions.invoke("note.save", { name: "../escaped", text: "X" }),
    );
    const escaped = path.join(h.root, "escaped.md");
    assert.ok(!fs.existsSync(escaped), "no file may be written above notesDir");
    assert.ok(!fs.existsSync(path.join(h.dataDir, "escaped.md")), "no file at dataDir root either");
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// 5. State transitions — overwrite keeps the latest text
// ===========================================================================

test("state: saving the same name twice keeps the latest text (read + file both)", async () => {
  const h = await makeHarness();
  try {
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "first" });
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "second" });
    const read: any = await h.sys.actions.invoke("note.read", { name: "alpha" });
    assert.equal(read.text, "second", "read must reflect the latest write");
    assert.equal(
      fs.readFileSync(path.join(h.notesDir, "alpha.md"), "utf8"),
      "second",
      "file must hold the latest write",
    );
  } finally {
    h.cleanup();
  }
});

test("state: overwriting does not duplicate the name in note.list", async () => {
  const h = await makeHarness();
  try {
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "1" });
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "2" });
    const res: any = await h.sys.actions.invoke("note.list");
    const count = res.names.filter((n: string) => n === "alpha").length;
    assert.equal(count, 1, "an overwritten note appears once in the list");
  } finally {
    h.cleanup();
  }
});

test("state: a note saved is independently readable after another note is saved", async () => {
  const h = await makeHarness();
  try {
    await h.sys.actions.invoke("note.save", { name: "alpha", text: "A" });
    await h.sys.actions.invoke("note.save", { name: "beta", text: "B" });
    const a: any = await h.sys.actions.invoke("note.read", { name: "alpha" });
    const b: any = await h.sys.actions.invoke("note.read", { name: "beta" });
    assert.equal(a.text, "A", "alpha is undisturbed by saving beta");
    assert.equal(b.text, "B", "beta has its own content");
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// 6. teardown — unregisters all three actions
// ===========================================================================

test("teardown: unregisters note.save / note.read / note.list", async () => {
  const h = await makeHarness();
  try {
    assert.equal(typeof h.plugin.teardown, "function", "plugin must expose teardown");
    for (const a of ACTIONS) assert.equal(h.sys.actions.has(a), true, `${a} present pre-teardown`);

    await h.plugin.teardown!();

    for (const a of ACTIONS) {
      assert.equal(h.sys.actions.has(a), false, `${a} must be unregistered after teardown`);
    }
  } finally {
    h.cleanup();
  }
});

test("teardown: after teardown the actions can no longer be invoked", async () => {
  const h = await makeHarness();
  try {
    await h.plugin.teardown!();
    await assert.rejects(
      () => h.sys.actions.invoke("note.list"),
      "invoking a torn-down action must reject",
    );
  } finally {
    h.cleanup();
  }
});
