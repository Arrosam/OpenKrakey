import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the NEW `history` plugin — a per-agent, persisted,
// compacting tool-use log.
//
// Derived ONLY from the SPEC + contracts (impl not read — it does not exist yet):
//   default export = PluginFactory; manifest = { id:"history", version:"0.1.0",
//     requires:["memory-note.remember"], configSchema: ConfigField[] }
//   config slice (all optional; defensive defaults; finite-number-only fallback,
//   counts floored to >=1):
//     maxEntries 50; keepRecent 20; logPriority 4500; maxEntryChars 300;
//     maxLogChars 4000; noteImportance 2; captureToolResults true.
//   setup:
//     - loads/persists history.json under ctx.dataDir
//     - if captureToolResults: subscribes to Events.TOOL_RESULT, one entry per
//       event { source:payload.name, kind:"tool_result", ok:payload.ok,
//       text:<compact summary of data when ok else error, truncated to
//       maxEntryChars>, at:payload.at ?? now }; the listener NEVER throws.
//     - registers action history.record { source(req), text(req,non-empty),
//       kind?, ok?, at? } -> throws on bad input; returns { id }.
//     - sets a SYSTEM block { id:"history.log", label:"history", target:"system",
//       priority:logPriority } whose render returns the compacted trail as a
//       string (header + per-entry lines `[ok] <source>: <text>` /
//       `[err] <source>: <text>`), bounded by maxLogChars, NEVER throws, "" when
//       empty.
//     - compaction + distillation: when recording pushes ABOVE maxEntries, the
//       oldest (length - keepRecent) entries are removed AND a checkpoint note is
//       written via ctx.actions.invoke("memory-note.remember", { note:<mentions
//       batch count>, kind:"finding", importance:noteImportance }) (never throws).
//     - ctx.print("history: tool-use log ready")
//   teardown: idempotent — unsubscribes tool.result, unregisters history.record,
//     removeBlock("history.log"), flushes persistence; second call no-op.
//
// The fake ctx runs over a REAL event system and registers a REAL recording
// memory-note.remember action so distillation can be asserted.
// ---------------------------------------------------------------------------

const ID = "history";
const LOG_BLOCK = "history.log";
const RECORD = "history.record";
const REMEMBER = "memory-note.remember";

const DEFAULT_LOG_PRIORITY = 4500;

// ---- tolerant dynamic import: a missing module fails each test cleanly ----
// Importing the not-yet-existing module is EXPECTED to fail until dev lands.
const mod: any = await import("../../public_plugin/history/index.ts").then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "history module not implemented yet (import failed)");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// ---- temp-dir lifecycle (one root for the file; per-test subdirs under it) --
let TMP = "";
test.before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-hist-"));
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
// A real recording "memory-note.remember" action records each set of params it
// receives so distillation can be asserted. Blocks are backed by a Map. dataDir
// is a real temp dir so history.json persistence has somewhere to live.
function makeCtx(config: unknown, opts: { dataDir?: string } = {}) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const remembered: any[] = [];
  sys.actions.register(REMEMBER, async (params: unknown) => {
    remembered.push(params);
    return { id: "mn-" + remembered.length };
  });
  const prints: string[] = [];
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
    print(text: string) {
      prints.push(text);
    },
  };
  return { ctx, store, sys, remembered, prints, dataDir };
}

async function setup(config: unknown, opts: { dataDir?: string } = {}) {
  const p = plugin();
  const h = makeCtx(config, opts);
  await p.setup(h.ctx);
  return { p, ...h };
}

function logBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(LOG_BLOCK);
  assert.ok(b, "setup must register a block under id 'history.log'");
  return b as ContextBlock;
}
const renderStr = async (b: ContextBlock): Promise<string> => (await b.render()) as string;

// Convenience: render the current log string.
const logText = async (store: Map<string, ContextBlock>): Promise<string> =>
  renderStr(logBlock(store));

// Emit a tool.result envelope (Reply<unknown> & { name }) on the bus, as the
// orchestrator does for each settled tool call.
let _resSeq = 0;
function emitToolResult(
  sys: ReturnType<typeof createEventSystem>,
  fields: { name?: string; ok: boolean; data?: unknown; error?: string; at?: number },
) {
  sys.events.emit(Events.TOOL_RESULT, {
    id: "tr-" + ++_resSeq,
    at: fields.at ?? Date.now(),
    ok: fields.ok,
    name: fields.name,
    data: fields.data,
    error: fields.error,
  });
}

// Count the per-entry log lines `[ok] ...` / `[err] ...` in a rendered log.
const ENTRY_LINE_RE = /^\[(?:ok|err)\]\s/gm;
function countEntryLines(text: string): number {
  return (text.match(ENTRY_LINE_RE) ?? []).length;
}

// ===========================================================================
// 1. manifest / factory
// ===========================================================================

test("manifest/factory: default export is a function (PluginFactory)", () => {
  assert.equal(typeof mod?.default, "function", "history default export must be a function");
});

test("manifest: id 'history' and version '0.1.0'", () => {
  const p = plugin();
  assert.equal(p.manifest.id, ID);
  assert.equal(p.manifest.version, "0.1.0");
});

test("manifest: requires includes 'memory-note.remember'", () => {
  const p = plugin();
  assert.ok(Array.isArray(p.manifest.requires), "requires must be an array");
  assert.ok(
    p.manifest.requires.includes(REMEMBER),
    "requires must include memory-note.remember",
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
// 2. setup — the single context block
// ===========================================================================

test("log block: exactly ONE system-target block 'history.log' at default priority 4500", async () => {
  const { store } = await setup({});
  // exactly one block was set
  assert.equal(store.size, 1, "setup registers exactly one context block");
  const b = logBlock(store);
  assert.equal(b.id, LOG_BLOCK);
  assert.notEqual((b as any).target, "messages", "the log targets the system prompt");
  assert.equal(b.priority, DEFAULT_LOG_PRIORITY);
  assert.equal(typeof (await renderStr(b)), "string", "system block renders a string");
});

test("log block: label is 'history'", async () => {
  const { store } = await setup({});
  assert.equal((logBlock(store) as any).label, "history", "log block label is 'history'");
});

test("log block: logPriority overrides the default", async () => {
  const { store } = await setup({ logPriority: 9123 });
  assert.equal(logBlock(store).priority, 9123);
});

test("log block: renders '' before any entry is recorded", async () => {
  const { store } = await setup({});
  assert.equal(await logText(store), "", "an empty log renders the empty string");
});

// ===========================================================================
// 3. setup — the history.record action + the print line
// ===========================================================================

test("setup: registers the history.record action on the actionbus", async () => {
  const { sys } = await setup({});
  assert.ok(sys.actions.has(RECORD), "actions.has must report history.record");
  assert.ok(sys.actions.list().includes(RECORD), "actions.list() must include history.record");
});

test("setup: prints the ready line 'history: tool-use log ready'", async () => {
  const { prints } = await setup({});
  assert.ok(
    prints.some((p) => p === "history: tool-use log ready"),
    "setup must print the ready line verbatim",
  );
});

// ===========================================================================
// 4. auto-capture — Events.TOOL_RESULT -> log entries
// ===========================================================================

test("auto-capture (ok): an ok tool.result appears with an [ok] marker + the source", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, {
    name: "krakeycode.read_file",
    ok: true,
    data: { content: "hello", path: "/x" },
    at: 1000,
  });
  const text = await logText(store);
  assert.match(text, /krakeycode\.read_file/, "the source/tool name appears");
  assert.match(text, /\[ok\]/, "an ok result carries an [ok] marker");
  assert.equal(countEntryLines(text), 1, "exactly one entry was recorded");
});

test("auto-capture (err): a failing tool.result appears with an [err] marker + the error", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: "krakeycode.read_file", ok: false, error: "boom", at: 2000 });
  const text = await logText(store);
  assert.match(text, /krakeycode\.read_file/, "the source/tool name appears");
  assert.match(text, /\[err\]/, "a failing result carries an [err] marker");
  assert.match(text, /boom/, "the error text appears in the entry");
});

test("auto-capture: multiple tool.results accumulate in order", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: "tool.a", ok: true, data: { v: 1 }, at: 10 });
  emitToolResult(sys, { name: "tool.b", ok: false, error: "nope", at: 20 });
  const text = await logText(store);
  assert.equal(countEntryLines(text), 2, "both results were captured");
  assert.ok(text.indexOf("tool.a") < text.indexOf("tool.b"), "entries appear in arrival order");
});

test("auto-capture: a long data summary is truncated to maxEntryChars", async () => {
  const cap = 20;
  const big = "z".repeat(500);
  const { store, sys } = await setup({ maxEntryChars: cap });
  emitToolResult(sys, { name: "tool.big", ok: true, data: { blob: big }, at: 1 });
  const text = await logText(store);
  // The longest contiguous run of z's in the rendered entry must be <= the cap.
  const run = text.match(/z+/)?.[0] ?? "";
  assert.ok(run.length <= cap, `captured run (${run.length}) must be <= maxEntryChars (${cap})`);
  assert.ok(run.length < big.length, "the captured summary is shorter than the source");
});

test("auto-capture (malformed): a null payload is ignored — no throw, nothing added", async () => {
  const { store, sys } = await setup({});
  assert.doesNotThrow(() => {
    sys.events.emit(Events.TOOL_RESULT, null);
  }, "a null tool.result payload must not throw out of the listener");
  assert.equal(await logText(store), "", "a malformed payload adds no entry");
});

test("auto-capture (malformed): a payload missing 'name' is ignored — no throw, nothing added", async () => {
  const { store, sys } = await setup({});
  assert.doesNotThrow(() => {
    sys.events.emit(Events.TOOL_RESULT, { id: "x", at: 1, ok: true, data: { a: 1 } });
  }, "a tool.result without a name must not throw");
  assert.equal(await logText(store), "", "a nameless payload adds no entry");
});

test("auto-capture: a tool.result with no 'at' still records (defaults to now), no throw", async () => {
  const { store, sys } = await setup({});
  assert.doesNotThrow(() => {
    sys.events.emit(Events.TOOL_RESULT, { id: "x", ok: true, name: "tool.c", data: { a: 1 } });
  }, "a missing 'at' must not throw");
  const text = await logText(store);
  assert.match(text, /tool\.c/, "the entry is still recorded when 'at' is absent");
});

// ===========================================================================
// 5. captureToolResults:false — tool.result is NOT captured
// ===========================================================================

test("captureToolResults:false -> an emitted tool.result is NOT recorded", async () => {
  const { store, sys } = await setup({ captureToolResults: false });
  emitToolResult(sys, { name: "tool.ignored", ok: true, data: { a: 1 }, at: 1 });
  assert.equal(await logText(store), "", "with capture disabled the log stays empty");
});

test("captureToolResults:false -> history.record still works (manual logging path)", async () => {
  const { store, sys } = await setup({ captureToolResults: false });
  const res: any = await sys.actions.invoke(RECORD, { source: "manual", text: "still logs" });
  assert.equal(typeof res.id, "number", "history.record returns a numeric id even with capture off");
  assert.match(await logText(store), /still logs/, "the manually recorded entry renders");
});

// ===========================================================================
// 6. history.record — happy path
// ===========================================================================

test("record (happy): valid params -> returns { id:number } and renders the entry", async () => {
  const { store, sys } = await setup({});
  const res: any = await sys.actions.invoke(RECORD, {
    source: "agent",
    text: "did a thing",
    kind: "note",
    ok: true,
  });
  assert.equal(typeof res.id, "number", "returns a numeric id");
  const text = await logText(store);
  assert.match(text, /did a thing/, "the recorded text renders");
  assert.match(text, /agent/, "the source renders");
});

test("record (happy): omitting ok/kind still records and renders", async () => {
  const { store, sys } = await setup({});
  const res: any = await sys.actions.invoke(RECORD, { source: "src", text: "minimal entry" });
  assert.equal(typeof res.id, "number", "returns a numeric id");
  assert.match(await logText(store), /minimal entry/, "a minimal entry renders");
});

test("record (happy): ok:false renders with an [err] marker", async () => {
  const { store, sys } = await setup({});
  await sys.actions.invoke(RECORD, { source: "src", text: "it failed", ok: false });
  assert.match(await logText(store), /\[err\]/, "ok:false records as an error entry");
});

test("record (happy): ok:true renders with an [ok] marker", async () => {
  const { store, sys } = await setup({});
  await sys.actions.invoke(RECORD, { source: "src", text: "it worked", ok: true });
  assert.match(await logText(store), /\[ok\]/, "ok:true records as an ok entry");
});

test("record (happy): successive records yield distinct ids", async () => {
  const { sys } = await setup({});
  const a: any = await sys.actions.invoke(RECORD, { source: "s", text: "one" });
  const b: any = await sys.actions.invoke(RECORD, { source: "s", text: "two" });
  assert.notEqual(a.id, b.id, "each record gets a distinct id");
});

test("record (happy): a long text is truncated to maxEntryChars on render", async () => {
  const cap = 15;
  const long = "q".repeat(300);
  const { store, sys } = await setup({ maxEntryChars: cap });
  await sys.actions.invoke(RECORD, { source: "s", text: long });
  const text = await logText(store);
  const run = text.match(/q+/)?.[0] ?? "";
  assert.ok(run.length <= cap, `stored run (${run.length}) must be <= maxEntryChars (${cap})`);
  assert.ok(run.length < long.length, "the stored entry is shorter than the source");
});

// ===========================================================================
// 7. history.record — validation (negative / error guessing)
// ===========================================================================

for (const bad of [
  { label: "missing source", params: { text: "t" } },
  { label: "empty-string source", params: { source: "", text: "t" } },
  { label: "non-string source (number)", params: { source: 42, text: "t" } },
  { label: "null source", params: { source: null, text: "t" } },
  { label: "missing text", params: { source: "s" } },
  { label: "empty-string text", params: { source: "s", text: "" } },
  { label: "whitespace-only text", params: { source: "s", text: "   \t\n " } },
  { label: "non-string text (number)", params: { source: "s", text: 7 } },
  { label: "null text", params: { source: "s", text: null } },
]) {
  test(`record validation: ${bad.label} rejects`, async () => {
    const { sys } = await setup({});
    await assert.rejects(
      sys.actions.invoke(RECORD, bad.params),
      `${bad.label} must reject`,
    );
  });
}

test("record validation: a rejected record does not enter the log", async () => {
  const { store, sys } = await setup({});
  await assert.rejects(sys.actions.invoke(RECORD, { source: "s", text: "" }));
  assert.equal(await logText(store), "", "a rejected record must not be persisted into the log");
});

test("record validation: a null params object rejects (no source/text at all)", async () => {
  const { sys } = await setup({});
  await assert.rejects(sys.actions.invoke(RECORD, null), "null params must reject");
});

// ===========================================================================
// 8. compaction + distillation (state transitions + BVA)
//
// SPEC: when recording pushes the queue ABOVE maxEntries, the oldest
// (length - keepRecent) entries are removed AND a checkpoint note is written to
// memory-note { note:<mentions batch count>, kind:"finding", importance:noteImportance }.
// ===========================================================================

test("compaction: maxEntries=4 keepRecent=2 + 5 records -> queue compacted to 2 retained (oldest dropped)", async () => {
  const { store, sys } = await setup({ maxEntries: 4, keepRecent: 2 });
  for (let i = 1; i <= 5; i++) {
    await sys.actions.invoke(RECORD, { source: "s", text: `ENTRY-${i}` });
  }
  const text = await logText(store);
  assert.equal(countEntryLines(text), 2, "after compaction exactly keepRecent (2) entries remain");
  // The two NEWEST (ENTRY-4, ENTRY-5) survive; the older three are dropped.
  assert.match(text, /ENTRY-4/, "the second-newest entry survives compaction");
  assert.match(text, /ENTRY-5/, "the newest entry survives compaction");
  assert.ok(!text.includes("ENTRY-1"), "the oldest entry was dropped");
  assert.ok(!text.includes("ENTRY-2"), "an old entry was dropped");
  assert.ok(!text.includes("ENTRY-3"), "an old entry was dropped");
});

test("compaction: distillation invokes memory-note.remember with a finding note at the configured importance", async () => {
  const { sys, remembered } = await setup({ maxEntries: 4, keepRecent: 2, noteImportance: 4 });
  for (let i = 1; i <= 5; i++) {
    await sys.actions.invoke(RECORD, { source: "s", text: `E-${i}` });
  }
  assert.ok(remembered.length >= 1, "memory-note.remember was invoked at least once on compaction");
  const call = remembered[remembered.length - 1];
  assert.equal(typeof call.note, "string", "the checkpoint note is a string");
  assert.ok(call.note.length > 0, "the checkpoint note is non-empty");
  // The note must reference the dropped batch count (length - keepRecent = 5 - 2 = 3).
  assert.match(String(call.note), /3/, "the note references the dropped-batch count (3)");
  assert.equal(call.kind, "finding", "the checkpoint note is kind 'finding'");
  assert.equal(call.importance, 4, "the checkpoint note uses the configured noteImportance");
});

test("compaction: distillation also fires on auto-captured tool.results", async () => {
  const { sys, store, remembered } = await setup({ maxEntries: 3, keepRecent: 1 });
  for (let i = 1; i <= 4; i++) {
    emitToolResult(sys, { name: `tool.${i}`, ok: true, data: { i }, at: i });
  }
  // Allow any fire-and-forget distillation to settle.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(countEntryLines(await logText(store)), 1, "compacted down to keepRecent (1)");
  assert.ok(remembered.length >= 1, "a checkpoint note was written for the auto-capture compaction");
  assert.equal(remembered[remembered.length - 1].kind, "finding", "checkpoint is a finding");
});

test("compaction (boundary): at exactly maxEntries there is no compaction and no distillation", async () => {
  const { store, sys, remembered } = await setup({ maxEntries: 4, keepRecent: 2 });
  for (let i = 1; i <= 4; i++) {
    await sys.actions.invoke(RECORD, { source: "s", text: `K-${i}` });
  }
  assert.equal(countEntryLines(await logText(store)), 4, "at capacity all 4 entries remain");
  assert.equal(remembered.length, 0, "no checkpoint note while at/under capacity");
});

test("compaction: distillation never throwing — a rejecting memory-note.remember does not break record", async () => {
  // A fresh ctx whose memory-note.remember REJECTS; the plugin must wrap the call.
  const p = plugin();
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  sys.actions.register(REMEMBER, async () => {
    throw new Error("memory-note exploded");
  });
  const ctx: any = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config: { maxEntries: 2, keepRecent: 1 },
    dataDir: tmpDir(),
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => store.set(b.id, b),
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} },
    print() {},
  };
  await p.setup(ctx);
  // Recording past capacity triggers a distillation whose remember() rejects.
  await assert.doesNotReject(async () => {
    await sys.actions.invoke(RECORD, { source: "s", text: "first" });
    await sys.actions.invoke(RECORD, { source: "s", text: "second" });
    await sys.actions.invoke(RECORD, { source: "s", text: "third" });
  }, "a rejecting memory-note.remember must not surface out of history.record");
  // Compaction still happened despite the failed note.
  assert.equal(countEntryLines(await renderStr(store.get(LOG_BLOCK)!)), 1, "compaction still trimmed to keepRecent");
});

// ===========================================================================
// 9. config defensiveness — counts floored to >=1, finite-number-only fallback
// ===========================================================================

test("config floor: keepRecent below 1 floors to >=1 (a compaction still leaves at least one entry)", async () => {
  const { store, sys } = await setup({ maxEntries: 2, keepRecent: 0 });
  for (let i = 1; i <= 3; i++) {
    await sys.actions.invoke(RECORD, { source: "s", text: `F-${i}` });
  }
  const n = countEntryLines(await logText(store));
  assert.ok(n >= 1, `keepRecent floored to >=1 keeps at least one entry (kept ${n})`);
});

test("config fallback: non-finite maxEntries (null) falls back to the default cap (50), not a collapse to 1", async () => {
  // With a buggy falsy read, null would collapse the cap; the default of 50 keeps all 5.
  const { store, sys } = await setup({ maxEntries: null });
  for (let i = 1; i <= 5; i++) {
    await sys.actions.invoke(RECORD, { source: "s", text: `D-${i}` });
  }
  assert.equal(countEntryLines(await logText(store)), 5, "maxEntries=null behaves like the default cap (50)");
});

test("config fallback: non-finite maxEntryChars (NaN) falls back to the default (300), not 0", async () => {
  const content = "w".repeat(80); // well under the default 300
  const { store, sys } = await setup({ maxEntryChars: Number.NaN });
  await sys.actions.invoke(RECORD, { source: "s", text: content });
  const text = await logText(store);
  assert.match(text, new RegExp(content), "the full 80-char text renders under the default char cap");
});

// ===========================================================================
// 10. render budget — never throws, bounded by maxLogChars
// ===========================================================================

test("render budget: under a tiny maxLogChars the render still returns a string and never throws", async () => {
  const { store, sys } = await setup({ maxLogChars: 40, maxEntryChars: 300, maxEntries: 50 });
  for (let i = 0; i < 10; i++) {
    await sys.actions.invoke(RECORD, { source: "s", text: "y".repeat(50) });
  }
  let text = "";
  await assert.doesNotReject(async () => {
    text = await logText(store);
  }, "render must never throw even when over the total budget");
  assert.equal(typeof text, "string", "render still returns a string");
});

test("render budget: the rendered log respects maxLogChars (roughly bounded)", async () => {
  const cap = 200;
  const { store, sys } = await setup({ maxLogChars: cap, maxEntryChars: 300, maxEntries: 50 });
  for (let i = 0; i < 20; i++) {
    await sys.actions.invoke(RECORD, { source: "src", text: `line number ${i} with some padding text` });
  }
  const text = await logText(store);
  // Allow a small slack for a header/ellipsis line; the body must not balloon past the budget.
  assert.ok(text.length <= cap * 2, `rendered log (${text.length}) stays roughly within maxLogChars (${cap})`);
});

// ===========================================================================
// 11. persistence — round-trip across teardown + a fresh instance
// ===========================================================================

test("persistence: entries recorded in one instance reload in a fresh instance over the same dataDir", async () => {
  const dataDir = tmpDir();
  const a = await setup({}, { dataDir });
  await a.sys.actions.invoke(RECORD, { source: "first", text: "persist-A" });
  await a.sys.actions.invoke(RECORD, { source: "second", text: "persist-B" });
  await a.p.teardown();

  const b = await setup({}, { dataDir });
  const text = await logText(b.store);
  assert.match(text, /persist-A/, "the first entry reloaded");
  assert.match(text, /persist-B/, "the second entry reloaded");
});

test("persistence: missing history.json -> empty log, no throw", async () => {
  const dataDir = tmpDir(); // fresh, no history.json
  const { store } = await setup({}, { dataDir });
  assert.equal(await logText(store), "", "a fresh dataDir yields an empty log");
});

test("persistence: a corrupt history.json -> empty log, no throw on setup", async () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "history.json"), "{ this is not valid json ]", "utf8");
  let store: Map<string, ContextBlock> | undefined;
  await assert.doesNotReject(async () => {
    const h = await setup({}, { dataDir });
    store = h.store;
  }, "a corrupt history.json must not throw out of setup");
  assert.equal(await logText(store!), "", "a corrupt store degrades to an empty log");
});

// ===========================================================================
// 12. teardown
// ===========================================================================

test("teardown: removes the history.log context block", async () => {
  const { p, store } = await setup({});
  assert.ok(store.get(LOG_BLOCK), "log block present before teardown");
  await p.teardown();
  assert.equal(store.get(LOG_BLOCK), undefined, "log block removed after teardown");
});

test("teardown: unregisters the history.record action (assert via actions.has)", async () => {
  const { p, sys } = await setup({});
  assert.ok(sys.actions.has(RECORD), "history.record registered before teardown");
  await p.teardown();
  assert.equal(sys.actions.has(RECORD), false, "history.record unregistered after teardown");
});

test("teardown: unsubscribes the tool.result listener (a later tool.result does not change state)", async () => {
  const { p, store, sys } = await setup({});
  await p.teardown();
  // A fresh setup over the SAME store would re-add the block; here we read the
  // torn-down state directly. The block is gone, so capture cannot append to a
  // rendered log. The listener must also no longer fire — emitting must not throw.
  assert.doesNotThrow(() => {
    emitToolResult(sys, { name: "tool.late", ok: true, data: { a: 1 }, at: 1 });
  }, "emitting tool.result after teardown must not throw");
  assert.equal(store.get(LOG_BLOCK), undefined, "no log block exists after teardown");
});

test("teardown: a tool.result emitted after teardown leaves a reloaded instance unaffected", async () => {
  const dataDir = tmpDir();
  const a = await setup({}, { dataDir });
  await a.sys.actions.invoke(RECORD, { source: "s", text: "kept" });
  await a.p.teardown();
  // Emit on the (now torn-down) bus — the unsubscribed listener must ignore it.
  emitToolResult(a.sys, { name: "tool.after", ok: true, data: { a: 1 }, at: 1 });

  // Reload over the same dataDir: only the pre-teardown entry must be present.
  const b = await setup({}, { dataDir });
  const text = await logText(b.store);
  assert.match(text, /kept/, "the pre-teardown entry persists");
  assert.ok(!text.includes("tool.after"), "a post-teardown tool.result was not captured");
});

test("teardown: is idempotent (a second teardown does not throw)", async () => {
  const { p } = await setup({});
  await p.teardown();
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "second teardown must not throw");
});
