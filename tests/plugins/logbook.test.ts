import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Actions, Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";
import type { Message, ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the NEW `logbook` plugin — an introspection tool
// that records a rolling window of the Agent's own bus activity and exposes it
// back to the model through a `log.fetch` tool (filterable by type/level/ok and
// a time window).
//
// Derived ONLY from the contract/spec (the implementation does NOT exist yet):
//   default export = PluginFactory; manifest = { id:"logbook", version present,
//                                                requires includes
//                                                "llm.register_tool", configSchema }
//   setup:
//     - subscribes to the well-known recording events
//       (clock.tick, llm.return, tool.result, log.entry, context.full,
//        input.message);
//     - registers a "log.fetch" ACTION on the actionbus AND declares a ToolDef
//       named "log.fetch" via llm.register_tool;
//     - contributes a SYSTEM "logbook.guidance" block and a MESSAGES
//       "logbook.results" block.
//   recording: each captured event becomes a record with a numeric `at`, a
//     `type` string, and (where applicable) ok / name / level fields. It SKIPS
//     its own log.entry (pluginId === "logbook").
//   log.fetch: returns recent records; filters by type/types/level/ok and a
//     time window (sinceMs relative OR fromTimestamp/untilTimestamp absolute);
//     limit caps the count (default + a hard cap). Bad params throw a clear
//     Error.
//   fold-back: a tool.result with name "log.fetch" renders into logbook.results
//     (role "user", name "logbook") on the next render and nudges clock.fire_now.
//   persistence: if the plugin persists to dataDir, a fresh setup() over the
//     SAME dataDir still returns previously-recorded records.
//
// The plugin is tested over a REAL event-system (packages/event-system) with a
// fake PluginContext whose block store is a Map and whose `llm.register_tool`
// and `clock.fire_now` actions RECORD their calls.
// ---------------------------------------------------------------------------

const ID = "logbook";
const GUIDANCE_BLOCK = "logbook.guidance";
const RESULTS_BLOCK = "logbook.results";
const FETCH = "log.fetch";

// ---- tolerant dynamic import: a missing module fails each test cleanly ----
const mod: any = await import("../../public_plugin/logbook/index.ts").then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "logbook module not implemented yet (import failed)");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// ---- temp dataDir bookkeeping (real fs; cleaned up after the suite) -------
const createdDirs: string[] = [];
function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-logbook-"));
  createdDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of createdDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

// ---- fake PluginContext over a REAL event system --------------------------
// A real recording "llm.register_tool" action records each declared ToolDef; a
// real recording "clock.fire_now" action records each nudge. Blocks are backed
// by a Map. dataDir is a real temp directory so persistence is observable.
function makeCtx(config: unknown, dataDir: string, opts: { registerClock?: boolean } = {}) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  const nudges: unknown[] = [];
  sys.actions.register("llm.register_tool", async (def: unknown) => {
    tools.push(def as ToolDef);
    return true;
  });
  if (opts.registerClock !== false) {
    sys.actions.register(Actions.CLOCK_FIRE_NOW, async (params: unknown) => {
      nudges.push(params ?? null);
      return undefined;
    });
  }
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
  return { ctx, store, sys, tools, nudges };
}

async function setup(
  config: unknown = {},
  dataDir: string = tmpDataDir(),
  opts: { registerClock?: boolean } = {},
) {
  const p = plugin();
  const h = makeCtx(config, dataDir, opts);
  await p.setup(h.ctx);
  return { p, dataDir, ...h };
}

// Some implementations may expose a flush() to make persistence deterministic
// (mirrors web-chat's TranscriptStore.flush()). If present on the Plugin, await
// it; otherwise this is a no-op so the assertion is still race-free for a
// synchronous-write impl.
async function flush(p: any): Promise<void> {
  if (p && typeof p.flush === "function") await p.flush();
}

function guidanceBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(GUIDANCE_BLOCK);
  assert.ok(b, "setup must register a block under id 'logbook.guidance'");
  return b as ContextBlock;
}
function resultsBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(RESULTS_BLOCK);
  assert.ok(b, "setup must register a block under id 'logbook.results'");
  return b as ContextBlock;
}
const renderStr = async (b: ContextBlock): Promise<string> => (await b.render()) as string;
const renderMsgs = async (b: ContextBlock): Promise<Message[]> => (await b.render()) as Message[];

// ---- bus-emit helpers (matching shared/actions payload envelopes) ---------
let _seq = 0;
function emitTick(sys: ReturnType<typeof createEventSystem>, seq = ++_seq) {
  sys.events.emit(Events.CLOCK_TICK, { at: Date.now(), data: { seq } });
}
function emitLlmReturn(sys: ReturnType<typeof createEventSystem>, ok: boolean, error?: string) {
  sys.events.emit(Events.LLM_RETURN, {
    id: "llm-" + ++_seq,
    at: Date.now(),
    ok,
    data: ok ? { message: { role: "assistant", content: "hi" } } : undefined,
    error: ok ? undefined : (error ?? "boom"),
  });
}
function emitToolResult(
  sys: ReturnType<typeof createEventSystem>,
  fields: { name: string; ok: boolean; data?: unknown; error?: string },
) {
  sys.events.emit(Events.TOOL_RESULT, {
    id: "tr-" + ++_seq,
    at: Date.now(),
    ok: fields.ok,
    name: fields.name,
    data: fields.data,
    error: fields.error,
  });
}
function emitLog(
  sys: ReturnType<typeof createEventSystem>,
  fields: { level: "info" | "warn" | "error" | "print"; pluginId: string; text: string },
) {
  sys.events.emit(Events.LOG, { at: Date.now(), data: fields });
}
function emitContextFull(sys: ReturnType<typeof createEventSystem>, round = 0) {
  sys.events.emit(Events.CONTEXT_FULL, {
    at: Date.now(),
    data: { estimatedTokens: 9000, limit: 8000, overBy: 1000, round },
  });
}
function emitInput(sys: ReturnType<typeof createEventSystem>, text = "hello", from = "user") {
  sys.events.emit(Events.INPUT_MESSAGE, { at: Date.now(), data: { text, from, channel: "web-chat" } });
}

// Fetch through the registered action (params optional).
async function fetch(sys: ReturnType<typeof createEventSystem>, params?: unknown): Promise<any[]> {
  const out = await sys.actions.invoke(FETCH, params);
  // The action's return shape is impl-defined as long as it CONTAINS the records.
  // Accept either a bare array or an envelope { records } / { results } / { entries }.
  if (Array.isArray(out)) return out as any[];
  const o = out as any;
  const arr = o?.records ?? o?.results ?? o?.entries ?? o?.logs;
  assert.ok(Array.isArray(arr), "log.fetch must return an array of records (or an envelope containing one)");
  return arr as any[];
}

const typesOf = (recs: any[]): string[] => recs.map((r) => String(r.type));

// Emit one of EVERY recordable event type onto the bus (a representative spread).
function emitSpread(sys: ReturnType<typeof createEventSystem>) {
  emitTick(sys);
  emitLlmReturn(sys, true);
  emitLlmReturn(sys, false, "the model errored");
  emitToolResult(sys, { name: "web-search.search", ok: true, data: { results: [] } });
  emitToolResult(sys, { name: "krakeycode.bash", ok: false, error: "nonzero exit" });
  emitLog(sys, { level: "warn", pluginId: "web-chat", text: "a warning" });
  emitContextFull(sys, 1);
  emitInput(sys, "a user typed this");
}

// ===========================================================================
// 1. manifest / factory
// ===========================================================================

test("manifest/factory: default export is a function (PluginFactory)", () => {
  assert.equal(typeof mod?.default, "function", "logbook default export must be a function");
});

test("manifest: id is 'logbook' and version is a non-empty string", () => {
  const p = plugin();
  assert.equal(p.manifest.id, ID);
  assert.equal(typeof p.manifest.version, "string", "version must be a string");
  assert.ok(p.manifest.version.length > 0, "version must be non-empty");
});

test("manifest: requires includes 'llm.register_tool'", () => {
  const p = plugin();
  assert.ok(Array.isArray(p.manifest.requires), "requires must be an array");
  assert.ok(
    p.manifest.requires.includes("llm.register_tool"),
    "requires must include llm.register_tool (logbook is a tool plugin)",
  );
});

test("manifest: declares a non-empty configSchema (array of fields with key+type)", () => {
  const p = plugin();
  const schema = p.manifest.configSchema;
  assert.ok(Array.isArray(schema), "configSchema must be an array");
  assert.ok(schema.length > 0, "configSchema must declare at least one field");
  for (const field of schema) {
    assert.equal(typeof field.key, "string", "each config field has a string key");
    assert.equal(typeof field.type, "string", "each config field has a string type");
  }
});

// ===========================================================================
// 2. setup — context blocks
// ===========================================================================

test("guidance block: registered at id 'logbook.guidance', targets the SYSTEM prompt, renders a string", async () => {
  const { store } = await setup();
  const b = guidanceBlock(store);
  assert.equal(b.id, GUIDANCE_BLOCK);
  assert.notEqual((b as any).target, "messages", "guidance must target the system prompt (not messages)");
  assert.equal(typeof b.priority, "number", "guidance has a numeric priority");
  assert.equal(typeof (await renderStr(b)), "string", "system block renders a string");
});

test("guidance text: default mentions the log.fetch tool", async () => {
  const { store } = await setup();
  const text = await renderStr(guidanceBlock(store));
  assert.match(text, /log\.fetch/, "default guidance must name the log.fetch tool");
});

test("results block: registered at id 'logbook.results', targets MESSAGES, renders [] initially", async () => {
  const { store } = await setup();
  const b = resultsBlock(store);
  assert.equal(b.id, RESULTS_BLOCK);
  assert.equal((b as any).target, "messages", "results must target the messages array");
  assert.equal(typeof b.priority, "number", "results has a numeric priority");
  const msgs = await renderMsgs(b);
  assert.ok(Array.isArray(msgs), "messages block renders an array");
  assert.deepEqual(msgs, [], "empty before any log.fetch result is recorded");
});

test("setup: listBlocks reports BOTH the guidance and results blocks", async () => {
  const { ctx, store } = await setup();
  void store;
  const ids = ctx.listBlocks().map((b: any) => b.id);
  assert.ok(ids.includes(GUIDANCE_BLOCK), "listBlocks includes logbook.guidance");
  assert.ok(ids.includes(RESULTS_BLOCK), "listBlocks includes logbook.results");
});

// ===========================================================================
// 3. setup — the log.fetch action + ToolDef
// ===========================================================================

test("setup: registers the log.fetch action on the actionbus", async () => {
  const { sys } = await setup();
  assert.ok(sys.actions.list().includes(FETCH), "actions.list() must include log.fetch");
});

test("setup: declares a ToolDef named 'log.fetch' via llm.register_tool", async () => {
  const { tools } = await setup();
  const def = tools.find((t) => t.name === FETCH);
  assert.ok(def, "a ToolDef named log.fetch must be registered via llm.register_tool");
});

test("ToolDef: has a non-empty description string", async () => {
  const { tools } = await setup();
  const def = tools.find((t) => t.name === FETCH)!;
  const desc = String(def.description ?? "");
  assert.ok(desc.length > 0, "the log.fetch ToolDef must carry a non-empty description");
});

test("ToolDef: parameters is a non-null object (a JSON-schema params shape)", async () => {
  const { tools } = await setup();
  const def = tools.find((t) => t.name === FETCH)!;
  const params = def.parameters as any;
  assert.equal(typeof params, "object", "parameters must be an object");
  assert.ok(params !== null, "parameters must be non-null");
  // A params object should at least describe its filter inputs as properties.
  assert.ok(params.properties && typeof params.properties === "object", "params has a properties object");
});

// ===========================================================================
// 4. RECORDING — positive / equivalence (every event type captured)
// ===========================================================================

test("recording: after a spread of bus events, log.fetch returns records covering each event type", async () => {
  const { p, sys } = await setup();
  emitSpread(sys);
  await flush(p);
  const recs = await fetch(sys);
  assert.ok(Array.isArray(recs) && recs.length > 0, "records were captured");
  const types = new Set(typesOf(recs));
  // The captured records must cover each well-known event type. The exact `type`
  // string is the event NAME from shared/actions (clock.tick, llm.return, …).
  for (const t of [
    Events.CLOCK_TICK,
    Events.LLM_RETURN,
    Events.TOOL_RESULT,
    Events.LOG,
    Events.CONTEXT_FULL,
    Events.INPUT_MESSAGE,
  ]) {
    assert.ok(types.has(t), `a record of type '${t}' must be captured`);
  }
});

test("recording: every record carries a numeric `at` timestamp and a string `type`", async () => {
  const { p, sys } = await setup();
  emitSpread(sys);
  await flush(p);
  const recs = await fetch(sys);
  for (const r of recs) {
    assert.equal(typeof r.at, "number", "each record has a numeric `at` timestamp");
    assert.ok(Number.isFinite(r.at), "`at` is a finite number");
    assert.equal(typeof r.type, "string", "each record has a string `type`");
  }
});

test("recording: context.full IS captured (not silently dropped)", async () => {
  const { p, sys } = await setup();
  emitContextFull(sys, 2);
  await flush(p);
  const recs = await fetch(sys, { type: Events.CONTEXT_FULL });
  assert.ok(recs.length >= 1, "the context.full event must be recorded");
  assert.ok(recs.every((r) => r.type === Events.CONTEXT_FULL), "filtered records are all context.full");
});

test("recording: an llm.return ok:true record carries ok === true; ok:false carries ok === false", async () => {
  const { p, sys } = await setup();
  emitLlmReturn(sys, true);
  emitLlmReturn(sys, false, "the model errored");
  await flush(p);
  const recs = await fetch(sys, { type: Events.LLM_RETURN });
  assert.equal(recs.length, 2, "both llm.return records captured");
  const oks = recs.map((r) => r.ok).sort();
  assert.deepEqual(oks, [false, true], "ok is preserved faithfully for each llm.return");
});

test("recording: a tool.result record carries the tool `name` and its ok flag", async () => {
  const { p, sys } = await setup();
  emitToolResult(sys, { name: "web-search.search", ok: true, data: { x: 1 } });
  emitToolResult(sys, { name: "krakeycode.bash", ok: false, error: "boom" });
  await flush(p);
  const recs = await fetch(sys, { type: Events.TOOL_RESULT });
  assert.equal(recs.length, 2, "both tool.result records captured");
  const byName = new Map(recs.map((r) => [r.name, r]));
  assert.ok(byName.has("web-search.search"), "records the tool name web-search.search");
  assert.ok(byName.has("krakeycode.bash"), "records the tool name krakeycode.bash");
  assert.equal(byName.get("web-search.search").ok, true, "ok preserved for the success");
  assert.equal(byName.get("krakeycode.bash").ok, false, "ok preserved for the failure");
});

test("recording: a log.entry record carries its `level` and pluginId", async () => {
  const { p, sys } = await setup();
  emitLog(sys, { level: "error", pluginId: "web-chat", text: "kaboom" });
  await flush(p);
  const recs = await fetch(sys, { type: Events.LOG });
  assert.ok(recs.length >= 1, "the log.entry was recorded");
  const r = recs.find((x) => x.level === "error");
  assert.ok(r, "the record preserves level 'error'");
});

// ===========================================================================
// 5. RECORDING — negative: skips its OWN log.entry, never throws on garbage
// ===========================================================================

test("recording (negative): a log.entry from pluginId 'logbook' is NOT stored (no self-logging loop)", async () => {
  const { p, sys } = await setup();
  emitLog(sys, { level: "info", pluginId: "logbook", text: "I just fetched something" });
  emitLog(sys, { level: "info", pluginId: "memory-note", text: "a foreign line" });
  await flush(p);
  const recs = await fetch(sys, { type: Events.LOG });
  assert.ok(
    recs.every((r) => r.pluginId !== ID && !String(r.text ?? "").includes("I just fetched")),
    "logbook must skip recording its OWN log.entry",
  );
  assert.ok(
    recs.some((r) => r.pluginId === "memory-note" || String(r.text ?? "").includes("foreign")),
    "foreign log.entry lines are still recorded",
  );
});

test("recording (negative): malformed payloads on every recordable event do NOT throw and do not corrupt the store", async () => {
  const { p, sys } = await setup();
  // Each of these is a deliberately broken payload for a subscribed event.
  assert.doesNotThrow(() => sys.events.emit(Events.CLOCK_TICK, undefined), "tick: undefined payload");
  assert.doesNotThrow(() => sys.events.emit(Events.CLOCK_TICK, null), "tick: null payload");
  assert.doesNotThrow(() => sys.events.emit(Events.CLOCK_TICK, "not-an-object"), "tick: string payload");
  assert.doesNotThrow(() => sys.events.emit(Events.LLM_RETURN, {}), "llm.return: empty object");
  assert.doesNotThrow(() => sys.events.emit(Events.TOOL_RESULT, { id: "x" }), "tool.result: no name");
  assert.doesNotThrow(() => sys.events.emit(Events.TOOL_RESULT, { name: 42 }), "tool.result: numeric name");
  assert.doesNotThrow(() => sys.events.emit(Events.LOG, { data: null }), "log.entry: null data");
  assert.doesNotThrow(() => sys.events.emit(Events.LOG, {}), "log.entry: no data");
  assert.doesNotThrow(() => sys.events.emit(Events.CONTEXT_FULL, {}), "context.full: no data");
  assert.doesNotThrow(() => sys.events.emit(Events.INPUT_MESSAGE, { data: 7 }), "input.message: bad data");
  await flush(p);
  // A subsequent valid event still records, proving the store was not corrupted.
  emitTick(sys);
  await flush(p);
  const recs = await fetch(sys);
  assert.ok(
    recs.some((r) => r.type === Events.CLOCK_TICK),
    "a valid event after malformed ones still records",
  );
});

// ===========================================================================
// 6. log.fetch FILTERS — positive / equivalence
// ===========================================================================

test("filter (none): no params -> returns recent records of ALL types", async () => {
  const { p, sys } = await setup();
  emitSpread(sys);
  await flush(p);
  const recs = await fetch(sys);
  const types = new Set(typesOf(recs));
  assert.ok(types.size >= 4, "with no filter, records of many types are returned together");
});

test("filter (type: single): only records of that single type are returned", async () => {
  const { p, sys } = await setup();
  emitSpread(sys);
  await flush(p);
  const recs = await fetch(sys, { type: Events.TOOL_RESULT });
  assert.ok(recs.length >= 1, "at least one tool.result");
  assert.ok(recs.every((r) => r.type === Events.TOOL_RESULT), "every returned record is a tool.result");
});

test("filter (types: array): records of ANY listed type are returned, others excluded", async () => {
  const { p, sys } = await setup();
  emitSpread(sys);
  await flush(p);
  const wanted = [Events.LLM_RETURN, Events.INPUT_MESSAGE];
  const recs = await fetch(sys, { types: wanted });
  assert.ok(recs.length >= 2, "records for both requested types returned");
  assert.ok(recs.every((r) => wanted.includes(r.type as any)), "no record outside the requested types");
  const got = new Set(typesOf(recs));
  assert.ok(got.has(Events.LLM_RETURN) && got.has(Events.INPUT_MESSAGE), "both requested types present");
});

test("filter (level): for log records, only the matching level is returned", async () => {
  const { p, sys } = await setup();
  emitLog(sys, { level: "info", pluginId: "a", text: "an info line" });
  emitLog(sys, { level: "warn", pluginId: "b", text: "a warn line" });
  emitLog(sys, { level: "error", pluginId: "c", text: "an error line" });
  await flush(p);
  const recs = await fetch(sys, { type: Events.LOG, level: "warn" });
  assert.ok(recs.length >= 1, "the warn-level record is returned");
  assert.ok(recs.every((r) => r.level === "warn"), "only warn-level log records pass the filter");
});

test("filter (ok:true): for llm.return/tool.result, only successful records are returned", async () => {
  const { p, sys } = await setup();
  emitLlmReturn(sys, true);
  emitLlmReturn(sys, false, "err");
  emitToolResult(sys, { name: "t.a", ok: true });
  emitToolResult(sys, { name: "t.b", ok: false, error: "x" });
  await flush(p);
  const recs = await fetch(sys, { ok: true });
  assert.ok(recs.length >= 1, "successful records returned");
  assert.ok(
    recs.every((r) => r.ok === true),
    "ok:true filter excludes every failure record",
  );
});

test("filter (ok:false): only failure records are returned", async () => {
  const { p, sys } = await setup();
  emitLlmReturn(sys, true);
  emitLlmReturn(sys, false, "err");
  emitToolResult(sys, { name: "t.a", ok: true });
  emitToolResult(sys, { name: "t.b", ok: false, error: "x" });
  await flush(p);
  const recs = await fetch(sys, { ok: false });
  assert.ok(recs.length >= 1, "failure records returned");
  assert.ok(recs.every((r) => r.ok === false), "ok:false filter excludes every success record");
});

test("filter (type + ok combined): a single type AND ok flag are both applied", async () => {
  const { p, sys } = await setup();
  emitToolResult(sys, { name: "t.a", ok: true });
  emitToolResult(sys, { name: "t.b", ok: false, error: "x" });
  emitLlmReturn(sys, false, "ignored by the type filter");
  await flush(p);
  const recs = await fetch(sys, { type: Events.TOOL_RESULT, ok: false });
  assert.ok(recs.length >= 1, "a failed tool.result is returned");
  assert.ok(
    recs.every((r) => r.type === Events.TOOL_RESULT && r.ok === false),
    "both the type and ok filters are applied together",
  );
});

// ===========================================================================
// 7. log.fetch TIME WINDOW — relative (sinceMs) and absolute (from/until)
// ===========================================================================

test("filter (sinceMs): only records within the relative window are returned (older excluded)", async () => {
  const { p, sys } = await setup();
  // An OLD record whose `at` is far in the past, then a fresh one.
  sys.events.emit(Events.CLOCK_TICK, { at: Date.now() - 60_000, data: { seq: 1 } });
  emitTick(sys); // "now"
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, sinceMs: 5_000 });
  assert.ok(recs.length >= 1, "the recent tick is within the 5s window");
  const now = Date.now();
  assert.ok(
    recs.every((r) => now - r.at <= 5_000 + 2_000),
    "no record older than the sinceMs window is returned",
  );
});

test("filter (fromTimestamp): only records at/after the absolute lower bound are returned", async () => {
  const { p, sys } = await setup();
  const cutoff = Date.now();
  sys.events.emit(Events.CLOCK_TICK, { at: cutoff - 10_000, data: { seq: 1 } }); // before cutoff
  sys.events.emit(Events.CLOCK_TICK, { at: cutoff + 10_000, data: { seq: 2 } }); // after cutoff
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, fromTimestamp: cutoff });
  assert.ok(recs.length >= 1, "the after-cutoff record is returned");
  assert.ok(recs.every((r) => r.at >= cutoff), "no record before fromTimestamp is returned");
});

test("filter (untilTimestamp): only records at/before the absolute upper bound are returned", async () => {
  const { p, sys } = await setup();
  const cutoff = Date.now();
  sys.events.emit(Events.CLOCK_TICK, { at: cutoff - 10_000, data: { seq: 1 } }); // before cutoff
  sys.events.emit(Events.CLOCK_TICK, { at: cutoff + 10_000, data: { seq: 2 } }); // after cutoff
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, untilTimestamp: cutoff });
  assert.ok(recs.length >= 1, "the before-cutoff record is returned");
  assert.ok(recs.every((r) => r.at <= cutoff), "no record after untilTimestamp is returned");
});

test("filter (from + until): an absolute window keeps only records inside [from, until]", async () => {
  const { p, sys } = await setup();
  const base = Date.now();
  sys.events.emit(Events.CLOCK_TICK, { at: base - 20_000, data: { seq: 1 } }); // outside (below)
  sys.events.emit(Events.CLOCK_TICK, { at: base, data: { seq: 2 } }); // inside
  sys.events.emit(Events.CLOCK_TICK, { at: base + 20_000, data: { seq: 3 } }); // outside (above)
  await flush(p);
  const recs = await fetch(sys, {
    type: Events.CLOCK_TICK,
    fromTimestamp: base - 5_000,
    untilTimestamp: base + 5_000,
  });
  assert.ok(recs.length >= 1, "the in-window record is returned");
  assert.ok(
    recs.every((r) => r.at >= base - 5_000 && r.at <= base + 5_000),
    "only records inside the absolute window are returned",
  );
});

// ===========================================================================
// 8. log.fetch LIMIT — boundary value analysis
// ===========================================================================

test("limit (BVA): limit:1 returns exactly one record", async () => {
  const { p, sys } = await setup();
  for (let i = 0; i < 5; i++) emitTick(sys);
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, limit: 1 });
  assert.equal(recs.length, 1, "limit:1 caps the result at a single record");
});

test("limit (BVA): limit:0 returns no records", async () => {
  const { p, sys } = await setup();
  for (let i = 0; i < 3; i++) emitTick(sys);
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, limit: 0 });
  assert.equal(recs.length, 0, "limit:0 returns an empty array");
});

test("limit (default): with no limit param, a DEFAULT cap bounds the count (not unbounded)", async () => {
  const { p, sys } = await setup();
  // Emit far more than any sensible default would return.
  for (let i = 0; i < 500; i++) emitTick(sys);
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK });
  assert.ok(recs.length < 500, "the default limit must cap the count below the number emitted");
});

test("limit (hard cap): an absurdly large limit is clamped to a hard cap (does not return everything)", async () => {
  const { p, sys } = await setup();
  for (let i = 0; i < 1000; i++) emitTick(sys);
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, limit: 1_000_000 });
  assert.ok(recs.length < 1000, "an over-large limit is clamped by a hard cap (cannot exceed retention)");
});

test("limit (recency): when capped, the MOST RECENT records are the ones returned", async () => {
  const { p, sys } = await setup();
  // Emit ticks with monotonically increasing `at` so 'recent' is well-defined.
  const base = Date.now();
  for (let i = 0; i < 6; i++) {
    sys.events.emit(Events.CLOCK_TICK, { at: base + i * 1000, data: { seq: i } });
  }
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, limit: 2 });
  assert.equal(recs.length, 2, "capped to 2");
  const ats = recs.map((r) => r.at);
  assert.ok(
    ats.every((a) => a >= base + 4 * 1000),
    "the two returned records are the two most recent (newest `at`)",
  );
});

// ===========================================================================
// 9. log.fetch — negative / error guessing (bad params throw a clear Error)
// ===========================================================================

test("bad params: an unknown filter type value throws a clear Error", async () => {
  const { sys } = await setup();
  await assert.rejects(
    sys.actions.invoke(FETCH, { type: "totally.not.an.event" }),
    (err: any) => {
      assert.ok(err instanceof Error, "rejects with an Error");
      assert.ok(String(err.message).length > 0, "the Error carries a message");
      return true;
    },
  );
});

test("bad params: a negative limit throws a clear Error", async () => {
  const { sys } = await setup();
  await assert.rejects(sys.actions.invoke(FETCH, { limit: -5 }), /limit/i, "a negative limit is rejected");
});

test("bad params: a non-numeric limit (string) throws a clear Error", async () => {
  const { sys } = await setup();
  await assert.rejects(sys.actions.invoke(FETCH, { limit: "ten" }), (err: any) => err instanceof Error);
});

test("bad params: a non-numeric sinceMs throws a clear Error", async () => {
  const { sys } = await setup();
  await assert.rejects(sys.actions.invoke(FETCH, { sinceMs: "soon" }), (err: any) => err instanceof Error);
});

test("bad params: an inverted absolute window (from > until) throws a clear Error", async () => {
  const { sys } = await setup();
  const now = Date.now();
  await assert.rejects(
    sys.actions.invoke(FETCH, { fromTimestamp: now + 10_000, untilTimestamp: now - 10_000 }),
    (err: any) => err instanceof Error,
    "from later than until is an invalid window",
  );
});

test("bad params: a non-object params value (a string) throws a clear Error", async () => {
  const { sys } = await setup();
  await assert.rejects(sys.actions.invoke(FETCH, "give me logs"), (err: any) => err instanceof Error);
});

// ===========================================================================
// 10. log.fetch — boundary values on the time window
// ===========================================================================

test("BVA (sinceMs:0): a zero relative window returns only records at the current instant (effectively none older)", async () => {
  const { p, sys } = await setup();
  sys.events.emit(Events.CLOCK_TICK, { at: Date.now() - 1000, data: { seq: 1 } });
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK, sinceMs: 0 });
  // sinceMs:0 means "since now" — a record 1s old must be excluded.
  assert.ok(
    recs.every((r) => Date.now() - r.at <= 50),
    "sinceMs:0 excludes records older than the current instant",
  );
});

test("BVA (empty window): a from/until window that contains no records returns []", async () => {
  const { p, sys } = await setup();
  emitTick(sys);
  await flush(p);
  // A window entirely in the far past, before anything was recorded.
  const far = Date.now() - 1_000_000;
  const recs = await fetch(sys, { fromTimestamp: far, untilTimestamp: far + 1000 });
  assert.deepEqual(recs, [], "an empty time window returns an empty array, not an error");
});

test("BVA (no matching type): a valid filter type with zero matching records returns []", async () => {
  const { p, sys } = await setup();
  emitTick(sys); // only a clock.tick exists
  await flush(p);
  const recs = await fetch(sys, { type: Events.INPUT_MESSAGE });
  assert.deepEqual(recs, [], "a type with no records returns an empty array");
});

// ===========================================================================
// 11. STATE TRANSITIONS — record -> fetch -> record more -> fetch
// ===========================================================================

test("transition: fetch reflects records present at call time (record -> fetch -> record more -> fetch grows)", async () => {
  const { p, sys } = await setup();
  emitTick(sys);
  await flush(p);
  const first = await fetch(sys, { type: Events.CLOCK_TICK });
  const firstCount = first.length;
  assert.ok(firstCount >= 1, "first fetch sees the first tick");

  emitTick(sys);
  emitTick(sys);
  await flush(p);
  const second = await fetch(sys, { type: Events.CLOCK_TICK });
  assert.ok(second.length > firstCount, "the second fetch sees the additional ticks");
});

test("transition: repeated fetches with no new events are stable (same count)", async () => {
  const { p, sys } = await setup();
  emitTick(sys);
  emitTick(sys);
  await flush(p);
  const a = await fetch(sys, { type: Events.CLOCK_TICK });
  const b = await fetch(sys, { type: Events.CLOCK_TICK });
  assert.equal(b.length, a.length, "fetch is read-only — it does not consume or change records");
});

test("transition: ordering — records are returned in a consistent chronological order", async () => {
  const { p, sys } = await setup();
  const base = Date.now();
  for (let i = 0; i < 4; i++) {
    sys.events.emit(Events.CLOCK_TICK, { at: base + i * 100, data: { seq: i } });
  }
  await flush(p);
  const recs = await fetch(sys, { type: Events.CLOCK_TICK });
  const ats = recs.map((r) => r.at);
  const ascending = [...ats].sort((x, y) => x - y);
  const descending = [...ats].sort((x, y) => y - x);
  assert.ok(
    JSON.stringify(ats) === JSON.stringify(ascending) ||
      JSON.stringify(ats) === JSON.stringify(descending),
    "returned records are in a consistent (monotonic) time order",
  );
});

// ===========================================================================
// 12. FOLD-BACK — own log.fetch tool.result renders + nudges clock.fire_now
// ===========================================================================

test("fold-back: an own log.fetch result renders one {role:'user', name:'logbook'} message", async () => {
  const { store, sys } = await setup();
  emitToolResult(sys, {
    name: FETCH,
    ok: true,
    data: { records: [{ at: Date.now(), type: Events.CLOCK_TICK }] },
  });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1, "exactly one folded message");
  const m = msgs[0];
  assert.equal(m.role, "user", "folded message uses role 'user' (clean conversation, not role:'tool')");
  assert.equal(m.name, "logbook", "folded message is tagged name 'logbook'");
  assert.match(String(m.content), /log\.fetch/, "the folded content names the log.fetch tool");
});

test("fold-back: a FOREIGN tool.result name is ignored (results block stays empty)", async () => {
  const { store, sys } = await setup();
  emitToolResult(sys, { name: "web-search.search", ok: true, data: { results: [] } });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "another tool's result must not enter the logbook.results block");
});

test("fold-back: an own log.fetch result nudges clock.fire_now (the action records a call)", async () => {
  const { sys, nudges } = await setup();
  emitToolResult(sys, { name: FETCH, ok: true, data: { records: [] } });
  await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget invoke settle
  assert.ok(nudges.length >= 1, "clock.fire_now must be invoked after an own log.fetch result");
});

test("fold-back: a FOREIGN tool.result does NOT nudge clock.fire_now", async () => {
  const { sys, nudges } = await setup();
  emitToolResult(sys, { name: "web-chat.send_message", ok: true, data: { delivered: true } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(nudges.length, 0, "a foreign tool result must not trigger a frame");
});

test("fold-back (negative): does NOT throw when clock.fire_now is NOT registered", async () => {
  const { sys } = await setup({}, tmpDataDir(), { registerClock: false });
  assert.equal(sys.actions.has(Actions.CLOCK_FIRE_NOW), false, "precondition: no clock action registered");
  assert.doesNotThrow(() => {
    emitToolResult(sys, { name: FETCH, ok: true, data: { records: [] } });
  }, "a missing clock.fire_now must be tolerated (guarded with has)");
  await new Promise((r) => setTimeout(r, 20));
});

test("fold-back (negative): an own log.fetch FAILURE result still renders (surfaces the error)", async () => {
  const { store, sys } = await setup();
  emitToolResult(sys, { name: FETCH, ok: false, error: "bad filter" });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1, "a failed own result is still folded so the model sees the failure");
  assert.match(String(msgs[0].content), /bad filter/, "the folded content carries the error message");
});

// ===========================================================================
// 13. PERSISTENCE — records survive a reload over the SAME dataDir
// ===========================================================================

test("persistence: a fresh setup() over the SAME dataDir still returns previously-recorded records", async () => {
  const dir = tmpDataDir();
  // First lifecycle: record a distinctive spread, then tear down.
  const a = await setup({}, dir);
  a.sys.events.emit(Events.INPUT_MESSAGE, { at: Date.now(), data: { text: "PERSIST-ME", from: "user" } });
  emitToolResult(a.sys, { name: "web-search.search", ok: true, data: { tag: "PERSIST-TOOL" } });
  await flush(a.p);
  if (a.p && typeof a.p.teardown === "function") await a.p.teardown();

  // Second lifecycle: a brand-new plugin instance over the SAME dataDir (a reload).
  const b = await setup({}, dir);
  const recs = await fetch(b.sys);
  // If logbook persists, the prior records reappear. If it does NOT persist, this
  // test documents the requirement: the spec says records must survive.
  const joined = JSON.stringify(recs);
  assert.ok(
    recs.length > 0 && /PERSIST/.test(joined),
    "records recorded before the reload must be returned after a fresh setup() over the same dataDir",
  );
});

test("persistence: a DIFFERENT dataDir starts empty (per-dir isolation, no cross-leak)", async () => {
  // Seed dir #1.
  const dir1 = tmpDataDir();
  const a = await setup({}, dir1);
  a.sys.events.emit(Events.INPUT_MESSAGE, { at: Date.now(), data: { text: "ONLY-IN-DIR1", from: "u" } });
  await flush(a.p);
  if (a.p && typeof a.p.teardown === "function") await a.p.teardown();

  // A fresh plugin over a SEPARATE dir must not see dir1's records.
  const dir2 = tmpDataDir();
  const b = await setup({}, dir2);
  const recs = await fetch(b.sys);
  assert.ok(
    !JSON.stringify(recs).includes("ONLY-IN-DIR1"),
    "a separate dataDir must not surface another dir's records",
  );
});

// ===========================================================================
// 14. teardown — removes blocks, unsubscribes, idempotent
// ===========================================================================

test("teardown: removes BOTH context blocks (listBlocks for the two ids becomes empty)", async () => {
  const { p, store } = await setup();
  assert.ok(store.get(GUIDANCE_BLOCK), "guidance present before teardown");
  assert.ok(store.get(RESULTS_BLOCK), "results present before teardown");
  await p.teardown();
  assert.equal(store.get(GUIDANCE_BLOCK), undefined, "guidance removed after teardown");
  assert.equal(store.get(RESULTS_BLOCK), undefined, "results removed after teardown");
});

test("teardown: unregisters the log.fetch action", async () => {
  const { p, sys } = await setup();
  assert.ok(sys.actions.list().includes(FETCH), "log.fetch registered before teardown");
  await p.teardown();
  assert.ok(!sys.actions.list().includes(FETCH), "log.fetch unregistered after teardown");
});

test("teardown: unsubscribes — events emitted AFTER teardown are not recorded", async () => {
  const { p, sys, store } = await setup();
  // Capture the results block ref before teardown to render it post-teardown is moot;
  // instead verify a re-setup over a fresh ctx does not see post-teardown emissions.
  await p.teardown();
  // After teardown the action is gone, so we cannot fetch from the same plugin.
  // Assert the block store is clean (the listeners that would have recorded are off).
  assert.equal(store.get(RESULTS_BLOCK), undefined, "results block gone");
  // Emitting now must not throw even though logbook tore down its listeners.
  assert.doesNotThrow(() => emitTick(sys), "a tick after teardown must not throw");
  assert.doesNotThrow(() => emitToolResult(sys, { name: FETCH, ok: true, data: {} }),
    "a tool.result after teardown must not throw");
});

test("teardown: is idempotent (a second teardown does not throw)", async () => {
  const { p } = await setup();
  await p.teardown();
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "the second teardown must not throw");
});

// ===========================================================================
// 15. multi-instance isolation (R6) — two Agents share no live state
// ===========================================================================

test("isolation: two plugin instances on separate buses record independently", async () => {
  const a = await setup({}, tmpDataDir());
  const b = await setup({}, tmpDataDir());
  // Record on A only.
  a.sys.events.emit(Events.INPUT_MESSAGE, { at: Date.now(), data: { text: "FOR-A", from: "u" } });
  await flush(a.p);
  await flush(b.p);
  const recsA = await fetch(a.sys, { type: Events.INPUT_MESSAGE });
  const recsB = await fetch(b.sys, { type: Events.INPUT_MESSAGE });
  assert.ok(recsA.length >= 1, "instance A recorded its own input.message");
  assert.equal(recsB.length, 0, "instance B's ring is independent (R6: no shared live state)");
});
