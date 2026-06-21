import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import type { ContextBlock } from "../../contracts/context";
import type { ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the NEW `memory-note` plugin — Krakey's private
// long-term notebook. A tool + data-carrying plugin in the searxng/web family.
//
// Derived ONLY from the SPEC + contracts (impl not read — it does not exist yet):
//   default export = PluginFactory; manifest = { id:"memory-note",
//     version:"0.1.0", requires:["llm.register_tool"], configSchema: ConfigField[] }
//   config slice (all optional w/ defaults; read defensively):
//     guidance null; guidancePriority 6700; notesPriority 8500; maxNotes 100;
//     maxNoteChars 600; maxNotesTotalChars 6000.
//   setup registers:
//     - action memory-note.remember (also a ToolDef)
//     - action memory-note.forget   (also a ToolDef)
//     - SYSTEM block memory-note.guidance @ guidancePriority, label
//       "memory-note.guidance" — static (override or built-in) guidance string
//     - SYSTEM block memory-note.notes @ notesPriority, label "memory-note" —
//       renders the notebook as a STRING, or "" when empty.
//   NO tool.result listener, NO clock.fire_now. Persists to a private per-agent
//   notes.json under ctx.dataDir; reloaded across teardown + a fresh instance.
//   teardown removes both blocks, unregisters both actions, persists, idempotent.
// ---------------------------------------------------------------------------

const ID = "memory-note";
const GUIDANCE_BLOCK = "memory-note.guidance";
const NOTES_BLOCK = "memory-note.notes";
const REMEMBER = "memory-note.remember";
const FORGET = "memory-note.forget";

const DEFAULT_GUIDANCE_PRIORITY = 6700;
const DEFAULT_NOTES_PRIORITY = 8500;

// ---- tolerant dynamic import: a missing module fails each test cleanly ----
const mod: any = await import("../../public_plugin/memory-note/index.ts").then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "memory-note module not implemented yet (import failed)");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// ---- temp-dir lifecycle (one root for the file; per-test subdirs under it) --
let TMP = "";
test.before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-mn-"));
});
test.after(() => {
  if (TMP) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
function tmpDir(): string {
  return fs.mkdtempSync(path.join(TMP, "d-"));
}

// ---- fake PluginContext over a REAL event system --------------------------
// A real recording "llm.register_tool" action records each declared ToolDef.
// Blocks are backed by a Map. dataDir is a real temp dir so the plugin's
// notes.json persistence has somewhere to live.
function makeCtx(config: unknown, opts: { dataDir?: string } = {}) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  sys.actions.register("llm.register_tool", async (def: unknown) => {
    tools.push(def as ToolDef);
    return true;
  });
  const dataDir = opts.dataDir ?? tmpDir();
  const ctx: any = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir,
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => {
      store.set(b.id, b);
    },
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} },
    print() {},
  };
  return { ctx, store, sys, tools, dataDir };
}

async function setup(config: unknown, opts: { dataDir?: string } = {}) {
  const p = plugin();
  const h = makeCtx(config, opts);
  await p.setup(h.ctx);
  return { p, ...h };
}

function guidanceBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(GUIDANCE_BLOCK);
  assert.ok(b, "setup must register a block under id 'memory-note.guidance'");
  return b as ContextBlock;
}
function notesBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(NOTES_BLOCK);
  assert.ok(b, "setup must register a block under id 'memory-note.notes'");
  return b as ContextBlock;
}
const renderStr = async (b: ContextBlock): Promise<string> => (await b.render()) as string;

// Convenience: render the current notebook string.
const notesText = async (store: Map<string, ContextBlock>): Promise<string> =>
  renderStr(notesBlock(store));

// ===========================================================================
// 1. manifest / factory
// ===========================================================================

test("manifest/factory: default export is a function (PluginFactory)", () => {
  assert.equal(typeof mod?.default, "function", "memory-note default export must be a function");
});

test("manifest: id 'memory-note' and version '0.1.0'", () => {
  const p = plugin();
  assert.equal(p.manifest.id, ID);
  assert.equal(p.manifest.version, "0.1.0");
});

test("manifest: requires includes 'llm.register_tool'", () => {
  const p = plugin();
  assert.ok(Array.isArray(p.manifest.requires), "requires must be an array");
  assert.ok(
    p.manifest.requires.includes("llm.register_tool"),
    "requires must include llm.register_tool",
  );
});

test("manifest: configSchema is a non-empty array of fields each with key+type", () => {
  const p = plugin();
  const schema = p.manifest.configSchema;
  assert.ok(Array.isArray(schema), "configSchema must be an array");
  assert.ok(schema.length > 0, "configSchema must be non-empty");
  for (const field of schema) {
    assert.equal(typeof field, "object", "each config field is an object");
    assert.ok(field !== null, "each config field is non-null");
    assert.equal(typeof field.key, "string", "each config field has a string key");
    assert.ok((field.key as string).length > 0, "each config field key is non-empty");
    assert.equal(typeof field.type, "string", "each config field has a string type");
    assert.ok((field.type as string).length > 0, "each config field type is non-empty");
  }
});

// ===========================================================================
// 2. setup — context blocks
// ===========================================================================

test("guidance block: system-target at default priority 6700, label 'memory-note.guidance'", async () => {
  const { store } = await setup({});
  const b = guidanceBlock(store);
  assert.equal(b.id, GUIDANCE_BLOCK);
  assert.notEqual((b as any).target, "messages", "guidance must target the system prompt");
  assert.equal(b.priority, DEFAULT_GUIDANCE_PRIORITY);
  assert.equal((b as any).label, GUIDANCE_BLOCK);
  assert.equal(typeof (await renderStr(b)), "string", "system block renders a string");
});

test("guidance block: guidancePriority overrides the default", async () => {
  const { store } = await setup({ guidancePriority: 12345 });
  assert.equal(guidanceBlock(store).priority, 12345);
});

test("guidance text: default is a non-empty string", async () => {
  const { store } = await setup({});
  const text = await renderStr(guidanceBlock(store));
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0, "default guidance must be a non-empty string");
});

test("guidance text: cfg.guidance overrides verbatim", async () => {
  const { store } = await setup({ guidance: "CUSTOM MEMORY GUIDANCE" });
  assert.equal(await renderStr(guidanceBlock(store)), "CUSTOM MEMORY GUIDANCE");
});

test("notes block: system-target at default priority 8500, label 'memory-note'", async () => {
  const { store } = await setup({});
  const b = notesBlock(store);
  assert.equal(b.id, NOTES_BLOCK);
  assert.notEqual((b as any).target, "messages", "notes must target the system prompt");
  assert.equal(b.priority, DEFAULT_NOTES_PRIORITY);
  assert.equal((b as any).label, ID, "notes block label is 'memory-note'");
  assert.equal(typeof (await renderStr(b)), "string", "system block renders a string");
});

test("notes block: notesPriority overrides the default", async () => {
  const { store } = await setup({ notesPriority: 4321 });
  assert.equal(notesBlock(store).priority, 4321);
});

test("notes block: renders '' before any note is remembered (orchestrator would drop it)", async () => {
  const { store } = await setup({});
  assert.equal(await notesText(store), "", "empty notebook renders the empty string");
});

// ===========================================================================
// 3. setup — the two ToolDefs
// ===========================================================================

test("setup: registers both actions (remember + forget) on the actionbus", async () => {
  const { sys } = await setup({});
  const list = sys.actions.list();
  assert.ok(list.includes(REMEMBER), "actions.list() must include memory-note.remember");
  assert.ok(list.includes(FORGET), "actions.list() must include memory-note.forget");
});

test("setup: declares exactly two ToolDefs to llm.register_tool (remember + forget)", async () => {
  const { tools } = await setup({});
  assert.equal(tools.length, 2, "exactly two ToolDefs declared");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [FORGET, REMEMBER].sort());
});

test("ToolDefs: each has a non-empty description and a parameters object", async () => {
  const { tools } = await setup({});
  for (const t of tools) {
    assert.equal(typeof t.description, "string", `${t.name} description is a string`);
    assert.ok((t.description as string).length > 0, `${t.name} description is non-empty`);
    assert.equal(typeof t.parameters, "object", `${t.name} parameters is an object`);
    assert.ok(t.parameters !== null, `${t.name} parameters is non-null`);
  }
});

test("ToolDef remember: parameters require 'note'; declares kind enum (4 values) + importance", async () => {
  const { tools } = await setup({});
  const def = tools.find((t) => t.name === REMEMBER);
  assert.ok(def, "remember ToolDef declared");
  const params = def!.parameters as any;
  assert.ok(params.properties && typeof params.properties === "object", "has properties");
  assert.ok(params.properties.note, "declares a 'note' property");
  assert.ok(params.properties.kind, "declares a 'kind' property");
  assert.ok(params.properties.importance, "declares an 'importance' property");
  assert.ok(Array.isArray(params.required), "required is an array");
  assert.ok(params.required.includes("note"), "note is required");
  assert.ok(!params.required.includes("kind"), "kind is NOT required");
  assert.ok(!params.required.includes("importance"), "importance is NOT required");
  const kindEnum = params.properties.kind.enum;
  assert.ok(Array.isArray(kindEnum), "kind declares an enum array");
  assert.deepEqual(
    [...kindEnum].sort(),
    ["finding", "goal", "keep-in-mind", "thought"].sort(),
    "kind enum is exactly the four allowed values",
  );
});

test("ToolDef forget: parameters require 'id'", async () => {
  const { tools } = await setup({});
  const def = tools.find((t) => t.name === FORGET);
  assert.ok(def, "forget ToolDef declared");
  const params = def!.parameters as any;
  assert.ok(params.properties && typeof params.properties === "object", "has properties");
  assert.ok(params.properties.id, "declares an 'id' property");
  assert.ok(Array.isArray(params.required), "required is an array");
  assert.ok(params.required.includes("id"), "id is required");
});

// ===========================================================================
// 4. remember — happy path
// ===========================================================================

test("remember (happy): returns {id:string, kind, importance, evicted:null} and renders into notebook", async () => {
  const { store, sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, {
    note: "Ship the launcher by Friday",
    kind: "goal",
    importance: 4,
  });
  assert.equal(typeof res.id, "string", "returns a string id");
  assert.ok(res.id.length > 0, "id is non-empty");
  assert.equal(res.kind, "goal");
  assert.equal(res.importance, 4);
  assert.equal(res.evicted, null, "nothing evicted on a fresh notebook");

  const text = await notesText(store);
  assert.match(text, /Ship the launcher by Friday/, "note text appears in the notebook");
  assert.ok(text.includes(res.id), "the assigned id appears in the notebook");
});

test("remember (happy): default kind is 'thought' and default importance is 3 when omitted", async () => {
  const { store, sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "a stray idea" });
  assert.equal(res.kind, "thought", "default kind is thought");
  assert.equal(res.importance, 3, "default importance is 3");
  const text = await notesText(store);
  assert.match(text, /a stray idea/, "the note is rendered");
  // The default-kind heading must be present (thoughts).
  assert.match(text, /Thoughts/, "the Thoughts heading appears for a default-kind note");
});

test("remember (happy): id prefix matches kind (g/k/t/f) and is unique per remember", async () => {
  const { sys } = await setup({});
  const g: any = await sys.actions.invoke(REMEMBER, { note: "goal note", kind: "goal" });
  const k: any = await sys.actions.invoke(REMEMBER, { note: "kim note", kind: "keep-in-mind" });
  const t: any = await sys.actions.invoke(REMEMBER, { note: "thought note", kind: "thought" });
  const f: any = await sys.actions.invoke(REMEMBER, { note: "finding note", kind: "finding" });
  assert.match(g.id, /^g\d+$/, "goal id starts with 'g'");
  assert.match(k.id, /^k\d+$/, "keep-in-mind id starts with 'k'");
  assert.match(t.id, /^t\d+$/, "thought id starts with 't'");
  assert.match(f.id, /^f\d+$/, "finding id starts with 'f'");
  const ids = [g.id, k.id, t.id, f.id];
  assert.equal(new Set(ids).size, ids.length, "all ids are unique");
});

test("remember (happy): importance marker and the four headings render per kind", async () => {
  const { store, sys } = await setup({});
  await sys.actions.invoke(REMEMBER, { note: "GOAL-X", kind: "goal", importance: 5 });
  await sys.actions.invoke(REMEMBER, { note: "KIM-X", kind: "keep-in-mind", importance: 2 });
  await sys.actions.invoke(REMEMBER, { note: "THT-X", kind: "thought", importance: 1 });
  await sys.actions.invoke(REMEMBER, { note: "FND-X", kind: "finding", importance: 3 });
  const text = await notesText(store);
  assert.match(text, /Goals/, "Goals heading present");
  assert.match(text, /Keep in mind/, "Keep in mind heading present");
  assert.match(text, /Thoughts/, "Thoughts heading present");
  assert.match(text, /Findings/, "Findings heading present");
  // importance marker uses ★ with the count, e.g. ★5.
  assert.match(text, /★\s*5/, "importance marker shows the level (★5)");
});

test("remember (happy): a heading appears only for a kind that has notes", async () => {
  const { store, sys } = await setup({});
  await sys.actions.invoke(REMEMBER, { note: "only a finding", kind: "finding" });
  const text = await notesText(store);
  assert.match(text, /Findings/, "Findings heading present");
  assert.ok(!/Goals/.test(text), "Goals heading absent (no goals)");
  assert.ok(!/Keep in mind/.test(text), "Keep in mind heading absent (none)");
  assert.ok(!/Thoughts/.test(text), "Thoughts heading absent (none)");
});

test("remember (happy): within a kind, notes are ordered by importance DESC", async () => {
  const { store, sys } = await setup({});
  await sys.actions.invoke(REMEMBER, { note: "low-imp", kind: "thought", importance: 1 });
  await sys.actions.invoke(REMEMBER, { note: "high-imp", kind: "thought", importance: 5 });
  await sys.actions.invoke(REMEMBER, { note: "mid-imp", kind: "thought", importance: 3 });
  const text = await notesText(store);
  const iHigh = text.indexOf("high-imp");
  const iMid = text.indexOf("mid-imp");
  const iLow = text.indexOf("low-imp");
  assert.ok(iHigh >= 0 && iMid >= 0 && iLow >= 0, "all three notes rendered");
  assert.ok(iHigh < iMid, "importance 5 sorts before importance 3");
  assert.ok(iMid < iLow, "importance 3 sorts before importance 1");
});

// ===========================================================================
// 5. remember — validation (negative / error guessing)
// ===========================================================================

for (const bad of [
  { label: "missing note", params: { kind: "thought" } },
  { label: "empty-string note", params: { note: "" } },
  { label: "whitespace-only note", params: { note: "   \t\n " } },
  { label: "non-string note (number)", params: { note: 42 } },
  { label: "null note", params: { note: null } },
]) {
  test(`remember validation: ${bad.label} rejects`, async () => {
    const { sys } = await setup({});
    await assert.rejects(
      sys.actions.invoke(REMEMBER, bad.params),
      `${bad.label} must reject`,
    );
  });
}

test("remember validation: invalid kind rejects", async () => {
  const { sys } = await setup({});
  await assert.rejects(
    sys.actions.invoke(REMEMBER, { note: "ok note", kind: "todo" }),
    "a kind outside the four-value set must reject",
  );
});

test("remember validation: an invalid kind does not enter the notebook", async () => {
  const { store, sys } = await setup({});
  await assert.rejects(sys.actions.invoke(REMEMBER, { note: "DO-NOT-STORE", kind: "bogus" }));
  const text = await notesText(store);
  assert.ok(!text.includes("DO-NOT-STORE"), "a rejected note must not be persisted into the notebook");
});

// ===========================================================================
// 6. remember — importance coercion / clamping (BVA)
// ===========================================================================

test("remember importance: below 1 is clamped to 1", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "n", importance: 0 });
  assert.equal(res.importance, 1, "importance 0 clamps up to 1");
});

test("remember importance: negative is clamped to 1", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "n", importance: -10 });
  assert.equal(res.importance, 1, "negative importance clamps up to 1");
});

test("remember importance: above 5 is clamped to 5", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "n", importance: 9 });
  assert.equal(res.importance, 5, "importance 9 clamps down to 5");
});

test("remember importance: boundary values 1 and 5 are preserved", async () => {
  const { sys } = await setup({});
  const lo: any = await sys.actions.invoke(REMEMBER, { note: "lo", importance: 1 });
  const hi: any = await sys.actions.invoke(REMEMBER, { note: "hi", importance: 5 });
  assert.equal(lo.importance, 1);
  assert.equal(hi.importance, 5);
});

test("remember importance: a float is coerced to an integer in [1,5]", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "n", importance: 3.9 });
  assert.equal(Number.isInteger(res.importance), true, "importance is coerced to an integer");
  assert.ok(res.importance >= 1 && res.importance <= 5, "coerced importance stays within [1,5]");
});

test("remember importance: a non-number defaults to 3", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "n", importance: "high" as any });
  assert.equal(res.importance, 3, "non-number importance falls back to the default 3");
});

test("remember importance: NaN defaults to 3", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "n", importance: Number.NaN });
  assert.equal(res.importance, 3, "NaN importance falls back to the default 3");
});

// ===========================================================================
// 7. remember — text trimming / truncation (BVA)
// ===========================================================================

test("remember truncation: a note longer than maxNoteChars is stored truncated with an ellipsis", async () => {
  const cap = 20;
  const long = "x".repeat(200);
  const { store, sys } = await setup({ maxNoteChars: cap });
  await sys.actions.invoke(REMEMBER, { note: long, kind: "thought" });
  const text = await notesText(store);
  // The stored note's visible run of x's must be no longer than the cap.
  const run = text.match(/x+/)?.[0] ?? "";
  assert.ok(run.length <= cap, `stored run (${run.length}) must be <= maxNoteChars (${cap})`);
  assert.ok(run.length < long.length, "stored note is shorter than the source");
  assert.match(text, /…/, "a truncated note carries an ellipsis");
});

test("remember truncation: a note at/under maxNoteChars is stored without an ellipsis", async () => {
  const { store, sys } = await setup({ maxNoteChars: 50 });
  await sys.actions.invoke(REMEMBER, { note: "short and sweet", kind: "thought" });
  const text = await notesText(store);
  assert.match(text, /short and sweet/, "the full short note is rendered");
  assert.ok(!text.includes("…"), "a short note is not truncated (no ellipsis)");
});

test("remember trimming: leading/trailing whitespace is trimmed before storing", async () => {
  const { store, sys } = await setup({});
  await sys.actions.invoke(REMEMBER, { note: "   padded note   ", kind: "thought" });
  const text = await notesText(store);
  assert.match(text, /padded note/, "the trimmed note is rendered");
});

// ===========================================================================
// 8. forget — state transitions
// ===========================================================================

test("forget: removes a remembered note — returns {removed:true,id}; note gone from render", async () => {
  const { store, sys } = await setup({});
  const r: any = await sys.actions.invoke(REMEMBER, { note: "ephemeral", kind: "thought" });
  assert.match(await notesText(store), /ephemeral/, "note present before forget");
  const res: any = await sys.actions.invoke(FORGET, { id: r.id });
  assert.equal(res.removed, true, "an existing note is removed");
  assert.equal(res.id, r.id, "echoes the id");
  assert.ok(!(await notesText(store)).includes("ephemeral"), "note gone from the notebook");
});

test("forget: an unknown id returns {removed:false,id} and does not throw", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(FORGET, { id: "nope-999" });
  assert.equal(res.removed, false, "forgetting an unknown id reports removed:false");
  assert.equal(res.id, "nope-999", "echoes the id");
});

test("forget: forgetting the same id twice — first true, second false (idempotent removal)", async () => {
  const { sys } = await setup({});
  const r: any = await sys.actions.invoke(REMEMBER, { note: "twice", kind: "thought" });
  const first: any = await sys.actions.invoke(FORGET, { id: r.id });
  const second: any = await sys.actions.invoke(FORGET, { id: r.id });
  assert.equal(first.removed, true, "first forget removes it");
  assert.equal(second.removed, false, "second forget finds nothing to remove");
});

test("forget: removing one note leaves the others intact", async () => {
  const { store, sys } = await setup({});
  const a: any = await sys.actions.invoke(REMEMBER, { note: "keep-me", kind: "thought" });
  const b: any = await sys.actions.invoke(REMEMBER, { note: "drop-me", kind: "thought" });
  void a;
  await sys.actions.invoke(FORGET, { id: b.id });
  const text = await notesText(store);
  assert.match(text, /keep-me/, "the untouched note remains");
  assert.ok(!text.includes("drop-me"), "the forgotten note is gone");
});

// ===========================================================================
// 9. eviction — capacity enforcement (state transitions + BVA)
// ===========================================================================

test("eviction: maxNotes=2 + three notes of differing importance -> least-important dropped", async () => {
  const { store, sys } = await setup({ maxNotes: 2 });
  const lo: any = await sys.actions.invoke(REMEMBER, { note: "LO", kind: "thought", importance: 1 });
  const hi: any = await sys.actions.invoke(REMEMBER, { note: "HI", kind: "thought", importance: 5 });
  const mid: any = await sys.actions.invoke(REMEMBER, { note: "MID", kind: "thought", importance: 3 });
  // The third insert pushes count to 3 > 2 -> the least-important (LO, imp 1) is evicted.
  assert.ok(mid.evicted, "the third remember reports an eviction");
  assert.equal(mid.evicted.id, lo.id, "the least-important note (LO) is the one evicted");
  assert.equal(mid.evicted.importance, 1, "evicted note's importance is reported");

  const text = await notesText(store);
  assert.ok(!text.includes("LO"), "the least-important note is gone");
  assert.match(text, /HI/, "the most-important note remains");
  assert.match(text, /MID/, "the second-most-important note remains");
  void hi;
});

test("eviction: a tie on importance evicts the OLDEST note", async () => {
  const { store, sys } = await setup({ maxNotes: 2 });
  const first: any = await sys.actions.invoke(REMEMBER, { note: "FIRST", kind: "thought", importance: 3 });
  const second: any = await sys.actions.invoke(REMEMBER, { note: "SECOND", kind: "thought", importance: 3 });
  const third: any = await sys.actions.invoke(REMEMBER, { note: "THIRD", kind: "thought", importance: 3 });
  // All importance 3 -> tie broken by age: the oldest (FIRST) is evicted.
  assert.ok(third.evicted, "the third remember reports an eviction");
  assert.equal(third.evicted.id, first.id, "the oldest tied note (FIRST) is evicted");
  const text = await notesText(store);
  assert.ok(!text.includes("FIRST"), "the oldest tied note is gone");
  assert.match(text, /SECOND/, "the newer tied note remains");
  assert.match(text, /THIRD/, "the newest note remains");
  void second;
});

test("eviction: the just-inserted note is itself eligible (insert a lone low note into a full high book)", async () => {
  const { store, sys } = await setup({ maxNotes: 1 });
  const high: any = await sys.actions.invoke(REMEMBER, { note: "HIGH", kind: "thought", importance: 5 });
  const low: any = await sys.actions.invoke(REMEMBER, { note: "LOW", kind: "thought", importance: 1 });
  // count 2 > 1 -> the least-important is LOW (the just-inserted one), so it is evicted.
  assert.ok(low.evicted, "the second remember reports an eviction");
  assert.equal(low.evicted.id, low.id, "the just-inserted low note is evicted (it is least-important)");
  const text = await notesText(store);
  assert.match(text, /HIGH/, "the pre-existing high note survives");
  assert.ok(!text.includes("LOW"), "the just-inserted low note did not survive");
  void high;
});

test("eviction: at exactly maxNotes there is no eviction (boundary, evicted:null)", async () => {
  const { store, sys } = await setup({ maxNotes: 2 });
  const a: any = await sys.actions.invoke(REMEMBER, { note: "A", kind: "thought", importance: 2 });
  const b: any = await sys.actions.invoke(REMEMBER, { note: "B", kind: "thought", importance: 2 });
  assert.equal(a.evicted, null, "first insert evicts nothing");
  assert.equal(b.evicted, null, "second insert (at capacity) evicts nothing");
  const text = await notesText(store);
  assert.match(text, /A/, "first note present");
  assert.match(text, /B/, "second note present");
});

// ===========================================================================
// 10. persistence — round-trip across teardown + a fresh instance
// ===========================================================================

test("persistence: notes remembered in one instance reload in a fresh instance over the same dataDir", async () => {
  const dataDir = tmpDir();
  // First instance: remember a couple of notes, then teardown (persists).
  const a = await setup({}, { dataDir });
  await a.sys.actions.invoke(REMEMBER, { note: "persist-me-goal", kind: "goal", importance: 4 });
  await a.sys.actions.invoke(REMEMBER, { note: "persist-me-finding", kind: "finding", importance: 2 });
  await a.p.teardown();

  // Second instance over the SAME dataDir: the notes must reload.
  const b = await setup({}, { dataDir });
  const text = await notesText(b.store);
  assert.match(text, /persist-me-goal/, "the goal note reloaded");
  assert.match(text, /persist-me-finding/, "the finding note reloaded");
});

test("persistence: missing notes.json -> empty notebook, no throw", async () => {
  const dataDir = tmpDir(); // fresh, no notes.json
  const { store } = await setup({}, { dataDir });
  assert.equal(await notesText(store), "", "a fresh dataDir yields an empty notebook");
});

test("persistence: a corrupt notes.json -> empty notebook, no throw on setup", async () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "notes.json"), "{ this is not valid json ]", "utf8");
  let store: Map<string, ContextBlock>;
  await assert.doesNotReject(async () => {
    const h = await setup({}, { dataDir });
    store = h.store;
  }, "a corrupt notes.json must not throw out of setup");
  assert.equal(await notesText(store!), "", "a corrupt store degrades to an empty notebook");
});

test("persistence: a forgotten note does not reappear after teardown + reload", async () => {
  const dataDir = tmpDir();
  const a = await setup({}, { dataDir });
  const r: any = await a.sys.actions.invoke(REMEMBER, { note: "transient", kind: "thought" });
  await a.sys.actions.invoke(REMEMBER, { note: "durable", kind: "thought" });
  await a.sys.actions.invoke(FORGET, { id: r.id });
  await a.p.teardown();

  const b = await setup({}, { dataDir });
  const text = await notesText(b.store);
  assert.ok(!text.includes("transient"), "the forgotten note stays forgotten across reload");
  assert.match(text, /durable/, "the remaining note persists");
});

// ===========================================================================
// 11. render budget — never throws, honors maxNotesTotalChars
// ===========================================================================

test("render budget: notes render never throws and stays a string under a tiny total budget", async () => {
  const { store, sys } = await setup({ maxNotesTotalChars: 80, maxNoteChars: 600, maxNotes: 50 });
  for (let i = 0; i < 10; i++) {
    await sys.actions.invoke(REMEMBER, { note: "y".repeat(100), kind: "thought", importance: 3 });
  }
  let text = "";
  await assert.doesNotReject(async () => {
    text = await notesText(store);
  }, "render must never throw, even when over the total budget");
  assert.equal(typeof text, "string", "render still returns a string");
});

// ===========================================================================
// 12. teardown
// ===========================================================================

test("teardown: removes both context blocks", async () => {
  const { p, store } = await setup({});
  assert.ok(store.get(GUIDANCE_BLOCK), "guidance present before teardown");
  assert.ok(store.get(NOTES_BLOCK), "notes present before teardown");
  await p.teardown();
  assert.equal(store.get(GUIDANCE_BLOCK), undefined, "guidance removed");
  assert.equal(store.get(NOTES_BLOCK), undefined, "notes removed");
});

test("teardown: unregisters both actions (remember + forget)", async () => {
  const { p, sys } = await setup({});
  assert.ok(sys.actions.has(REMEMBER), "remember registered before teardown");
  assert.ok(sys.actions.has(FORGET), "forget registered before teardown");
  await p.teardown();
  assert.equal(sys.actions.has(REMEMBER), false, "remember unregistered after teardown");
  assert.equal(sys.actions.has(FORGET), false, "forget unregistered after teardown");
});

test("teardown: is idempotent (double teardown does not throw)", async () => {
  const { p } = await setup({});
  await p.teardown();
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "second teardown must not throw");
});

// ===========================================================================
// 13. REGRESSION — corrected behavior for bugs found in code review.
//
// Each test below encodes the FIXED contract: it must FAIL against the current
// (buggy) implementation and PASS once the fix lands. Nothing here contradicts
// the existing passing cases above — they extend the same spec.
//
// Defaults restated from the file header (used as the fall-back targets):
//   maxNotes 100; maxNoteChars 600; maxNotesTotalChars 6000.
//
// The only observable note surface (as in every test above) is the rendered
// notebook string; there is no separate note-store object on the fake ctx. So
// "how many notes are retained" is read by counting rendered note lines, where a
// real note line carries the `[<id> ★<n>] ...` shape.
// ===========================================================================

/** A real rendered note line matches `[<id> ★<n>] ...`; ids look like g1/t12/f3. */
const NOTE_LINE_RE = /\[[a-z]?\d+\s+★\s*\d+\]/g;

/** Count the actual note lines in a rendered notebook string. */
function countNoteLines(text: string): number {
  return (text.match(NOTE_LINE_RE) ?? []).length;
}

// ---------------------------------------------------------------------------
// 13.1 Config "unset" sentinels (null / "" / false / []) fall back to the
//      DEFAULT for a numeric key — they must behave EXACTLY like absence, NOT
//      coerce to 0/1. (Bug: a falsy config value collapsed the limit.)
// ---------------------------------------------------------------------------

test("regression cfg-sentinel: maxNotes=null falls back to the default cap (100), not 1", async () => {
  // With a buggy `cfg.maxNotes || 0`-style read, null collapses to a cap of ~1
  // and two of three notes get evicted. The default cap of 100 keeps all three.
  const { store, sys } = await setup({ maxNotes: null });
  await sys.actions.invoke(REMEMBER, { note: "SENT-A", kind: "thought", importance: 1 });
  await sys.actions.invoke(REMEMBER, { note: "SENT-B", kind: "thought", importance: 3 });
  await sys.actions.invoke(REMEMBER, { note: "SENT-C", kind: "thought", importance: 5 });
  const text = await notesText(store);
  assert.match(text, /SENT-A/, "maxNotes=null must not evict: the least-important note survives");
  assert.match(text, /SENT-B/, "maxNotes=null must not evict: the mid note survives");
  assert.match(text, /SENT-C/, "maxNotes=null must not evict: the most-important note survives");
  assert.equal(countNoteLines(text), 3, "maxNotes=null behaves like the default cap (100): all 3 retained");
});

test("regression cfg-sentinel: maxNotes=\"\" (empty string) falls back to the default cap (100)", async () => {
  const { store, sys } = await setup({ maxNotes: "" });
  await sys.actions.invoke(REMEMBER, { note: "SENT-D", kind: "thought", importance: 1 });
  await sys.actions.invoke(REMEMBER, { note: "SENT-E", kind: "thought", importance: 3 });
  await sys.actions.invoke(REMEMBER, { note: "SENT-F", kind: "thought", importance: 5 });
  const text = await notesText(store);
  assert.match(text, /SENT-D/, "maxNotes='' must not evict: the least-important note survives");
  assert.match(text, /SENT-E/, "maxNotes='' must not evict: the mid note survives");
  assert.match(text, /SENT-F/, "maxNotes='' must not evict: the most-important note survives");
  assert.equal(countNoteLines(text), 3, "maxNotes='' behaves like the default cap (100): all 3 retained");
});

test("regression cfg-sentinel: maxNoteChars=null stores a 50-char note INTACT (not truncated to just '…')", async () => {
  // 50 chars is well under the default 600. A buggy `cfg.maxNoteChars || 0` read
  // would truncate to 0 chars, leaving only the ellipsis. The default keeps it whole.
  const content = "z".repeat(50);
  const { store, sys } = await setup({ maxNoteChars: null });
  await sys.actions.invoke(REMEMBER, { note: content, kind: "thought" });
  const text = await notesText(store);
  assert.match(text, new RegExp(content), "the full 50-char note is rendered under the default char cap");
  assert.ok(!text.includes("…"), "a 50-char note under the default cap carries no ellipsis (not truncated)");
});

test("regression cfg-sentinel: maxNotesTotalChars=null renders notes under the default budget (6000)", async () => {
  // A buggy falsy read collapses the total budget to ~0 and renders zero notes.
  // The default budget of 6000 easily fits a few short notes.
  const { store, sys } = await setup({ maxNotesTotalChars: null });
  await sys.actions.invoke(REMEMBER, { note: "BUDGET-A", kind: "thought", importance: 3 });
  await sys.actions.invoke(REMEMBER, { note: "BUDGET-B", kind: "finding", importance: 2 });
  const text = await notesText(store);
  // At least one real note line (the [<id> ★<n>] ... shape) must render.
  assert.match(
    text,
    /\[[a-z]?\d+\s+★\s*\d+\]/,
    "with the default total budget, at least one note line must render",
  );
});

// ---------------------------------------------------------------------------
// 13.2 The per-note char limit is floored to its schema minimum (1), never 0
//      or negative. maxNoteChars=0 must resolve to 1, so a note keeps at least
//      its first character (e.g. "abcdefghij" -> "a…"), never just "…".
// ---------------------------------------------------------------------------

test("regression char-floor: maxNoteChars=0 floors to 1 — a 10-char note keeps a non-empty prefix", async () => {
  const { store, sys } = await setup({ maxNoteChars: 0 });
  await sys.actions.invoke(REMEMBER, { note: "abcdefghij", kind: "thought" });
  const text = await notesText(store);
  assert.match(text, /…/, "a truncated note carries an ellipsis");
  // The stored body must NOT be the empty string followed by an ellipsis.
  assert.ok(!text.includes("] …"), "the note must keep at least one character, not collapse to just '…'");
  // After the floor-to-1 fix, the surviving prefix is the first char: "a…".
  assert.match(text, /a…/, "maxNoteChars floored to 1 keeps the first character ('a…')");
});

// ---------------------------------------------------------------------------
// 13.3 importance given as a NON-number — including the falsy "", false, [] —
//      defaults to 3 (NOT 1). Consistent with the existing "high"/NaN -> 3 cases.
// ---------------------------------------------------------------------------

test("regression importance: empty-string importance defaults to 3 (not 1)", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "x", importance: "" as any });
  assert.equal(res.importance, 3, "importance '' is a non-number — defaults to 3");
});

test("regression importance: false importance defaults to 3 (not 1)", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "x", importance: false as any });
  assert.equal(res.importance, 3, "importance false is a non-number — defaults to 3");
});

test("regression importance: empty-array importance defaults to 3 (not 1)", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(REMEMBER, { note: "x", importance: [] as any });
  assert.equal(res.importance, 3, "importance [] is a non-number — defaults to 3");
});

// ---------------------------------------------------------------------------
// 13.4 load() enforces capacity on the persisted notebook — capacity is applied
//      WHEN THE STORE LOADS, not only on the next remember. Seed 5 valid notes
//      via a first instance (which persists a valid notes.json), then reload
//      under maxNotes=3: at most 3 survive, and they are the most-important.
// ---------------------------------------------------------------------------

test("regression load-cap: a notebook of 5 reloaded under maxNotes=3 is trimmed to 3 on load (least-important dropped)", async () => {
  const dataDir = tmpDir();

  // First instance: write 5 valid note records to notes.json (via teardown's persist).
  const seed = await setup({}, { dataDir });
  const i1: any = await seed.sys.actions.invoke(REMEMBER, { note: "CAP-1", kind: "thought", importance: 1 });
  const i2: any = await seed.sys.actions.invoke(REMEMBER, { note: "CAP-2", kind: "thought", importance: 2 });
  const i3: any = await seed.sys.actions.invoke(REMEMBER, { note: "CAP-3", kind: "thought", importance: 3 });
  const i4: any = await seed.sys.actions.invoke(REMEMBER, { note: "CAP-4", kind: "thought", importance: 4 });
  const i5: any = await seed.sys.actions.invoke(REMEMBER, { note: "CAP-5", kind: "thought", importance: 5 });
  const seedText = await notesText(seed.store);
  assert.equal(countNoteLines(seedText), 5, "five notes seeded before reload");
  // notes.json on disk must actually carry the 5 records (proves a valid seed file).
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "notes.json"), "utf8"));
  void [i1, i2, i3, i4, i5, onDisk];
  await seed.p.teardown();

  // Second instance over the SAME dataDir, capped at 3: load must enforce capacity
  // immediately — BEFORE any remember is invoked. The notebook is read straight
  // after setup (no remember), so a render of only 3 lines proves load-time capping.
  const reloaded = await setup({ maxNotes: 3 }, { dataDir });
  const text = await notesText(reloaded.store);
  assert.ok(countNoteLines(text) <= 3, "capacity is enforced on load: at most 3 notes survive");
  assert.equal(countNoteLines(text), 3, "exactly the 3 capacity slots are filled on load");
  // The 2 least-important (importance 1 and 2) are dropped; the 3 most-important survive.
  assert.ok(!text.includes("CAP-1"), "the least-important note (importance 1) is dropped on load");
  assert.ok(!text.includes("CAP-2"), "the second-least-important note (importance 2) is dropped on load");
  assert.match(text, /CAP-3/, "an importance-3 note survives");
  assert.match(text, /CAP-4/, "an importance-4 note survives");
  assert.match(text, /CAP-5/, "an importance-5 note survives");
});

// ---------------------------------------------------------------------------
// 13.5 render always shows at least one note — an absurdly small total budget
//      must still surface one real note line, never collapse to header + "(…
//      N more notes hidden)" with ZERO notes shown.
// ---------------------------------------------------------------------------

test("regression render-min: maxNotesTotalChars=1 still renders at least one real note line", async () => {
  const { store, sys } = await setup({ maxNotesTotalChars: 1 });
  await sys.actions.invoke(REMEMBER, { note: "MIN-A", kind: "thought", importance: 5 });
  await sys.actions.invoke(REMEMBER, { note: "MIN-B", kind: "thought", importance: 3 });
  await sys.actions.invoke(REMEMBER, { note: "MIN-C", kind: "thought", importance: 1 });
  const text = await notesText(store);
  // A real note line carries the [<id> ★<n>] ... shape; the header/"hidden" summary does not.
  assert.match(
    text,
    /\[[a-z]?\d+\s+★\s*\d+\]/,
    "even at a 1-char total budget, at least one actual note line must render (not just header + hidden count)",
  );
});
