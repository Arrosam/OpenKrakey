/**
 * EDGE tests for the inspector ENHANCEMENT — persistence + query filter.
 *
 * These cover the two NEW, pure/unit-testable cores of the enhancement. Neither
 * module exists yet, so every block dynamically `import()`s the module under a
 * tiny loader that fails on a CLEAN assertion (with a pointer to the missing
 * file) rather than a raw module-resolution stack trace. The existing
 * `tests/plugins/inspector.test.ts` remains the regression gate for the live
 * hub/HTTP/SSE surface and is NOT touched.
 *
 * MODULE 1 — public_plugin/inspector/query.ts
 *   export function filterRecords(records: EventRecord[], q: Query, now?: number): EventRecord[]
 *   EventRecord = { seq:number, at:number, kind:string, agentId:string, corrId?:string, payload:any }
 *   Query      = { sinceMs?, fromTs?, untilTs?, types?:string[], levels?:string[], limit? }
 *   LOCKED semantics:
 *     TIME  — fromTs|untilTs finite ⇒ absolute window [fromTs ?? -Inf, untilTs ?? +Inf]
 *             inclusive; else sinceMs finite & > 0 ⇒ keep at >= now - sinceMs; else no time filter.
 *     TYPE  — types non-empty ⇒ keep only kind ∈ types.
 *     LEVEL — levels non-empty ⇒ a kind==="log" record kept iff payload.data.level ∈ levels;
 *             a NON-log record kept ONLY if types is non-empty AND includes that kind.
 *             (levels + empty types ⇒ logs-only.)
 *     LIMIT — after filtering keep the most-recent min(limit, HARD_MAX) (tail). Default = all.
 *     NO params ⇒ all records unchanged. Never throws on malformed records.
 *
 * MODULE 2 — public_plugin/inspector/store.ts
 *   class EventStore:
 *     static async load(dataDir, agentId, cfg): Promise<EventStore>
 *     window(): EventRecord[]      // restored, oldest→newest, bounded
 *     maxSeq(): number
 *     append(rec): void
 *     compactSync(): void
 *     flush(): Promise<void>
 *   cfg = { maxPersistedEntries, retentionMs, persist }
 *   Real fs.mkdtempSync tmp dirs; await flush() before reload; cleanup in test.after.
 *   Per-agentId files under dataDir/<agentId>/.
 *
 * Driven via tsx (node:test + node:assert/strict) — NOT typechecked by tsc.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(".");
const QUERY_URL = pathToFileURL(
  path.resolve(REPO, "public_plugin", "inspector", "query.ts"),
).href;
const STORE_URL = pathToFileURL(
  path.resolve(REPO, "public_plugin", "inspector", "store.ts"),
).href;

// --------------------------------------------------------------------------
// EventRecord shape (from the contract): { seq, at, kind, agentId, corrId?, payload }
// --------------------------------------------------------------------------
interface EventRecord {
  seq: number;
  at: number;
  kind: string;
  agentId: string;
  corrId?: string;
  payload: any;
}

interface Query {
  sinceMs?: number;
  fromTs?: number;
  untilTs?: number;
  types?: string[];
  levels?: string[];
  limit?: number;
}

// --------------------------------------------------------------------------
// Module loaders. A missing/broken module => one clean assertion that names the
// file, rather than an opaque ERR_MODULE_NOT_FOUND escaping the test.
// --------------------------------------------------------------------------
type FilterFn = (records: EventRecord[], q: Query, now?: number) => EventRecord[];

interface QueryMod {
  filterRecords: FilterFn;
  HARD_MAX?: number;
}

interface StoreCfg {
  maxPersistedEntries: number;
  retentionMs: number;
  persist: boolean;
}

interface EventStore {
  window(): EventRecord[];
  maxSeq(): number;
  append(rec: EventRecord): void;
  compactSync(): void;
  flush(): Promise<void>;
}

interface StoreMod {
  EventStore: {
    load(dataDir: string, agentId: string, cfg: StoreCfg): Promise<EventStore>;
  };
}

async function loadQuery(): Promise<QueryMod> {
  const mod = (await import(QUERY_URL).then(
    (m) => m,
    () => null,
  )) as Partial<QueryMod> | null;
  assert.ok(
    mod && typeof mod.filterRecords === "function",
    "inspector query core not implemented yet: public_plugin/inspector/query.ts must export `filterRecords(records, q, now?)`",
  );
  return mod as QueryMod;
}

async function loadStore(): Promise<StoreMod> {
  const mod = (await import(STORE_URL).then(
    (m) => m,
    () => null,
  )) as Partial<StoreMod> | null;
  assert.ok(
    mod && mod.EventStore && typeof mod.EventStore.load === "function",
    "inspector store core not implemented yet: public_plugin/inspector/store.ts must export `class EventStore` with `static async load(dataDir, agentId, cfg)`",
  );
  return mod as StoreMod;
}

// --------------------------------------------------------------------------
// Record fixtures. `rec()` builds a well-formed EventRecord; `logRec()` a log
// record whose payload.data.level drives the LEVEL filter.
// --------------------------------------------------------------------------
let SEQ = 0;
function rec(over: Partial<EventRecord> = {}): EventRecord {
  const seq = over.seq ?? ++SEQ;
  return {
    seq,
    at: over.at ?? 1000 + seq,
    kind: over.kind ?? "input",
    agentId: over.agentId ?? "alice",
    payload: over.payload ?? { data: { text: "x" } },
    ...(over.corrId !== undefined ? { corrId: over.corrId } : {}),
  };
}
function logRec(level: string, over: Partial<EventRecord> = {}): EventRecord {
  return rec({ kind: "log", payload: { data: { level, text: "L" } }, ...over });
}
const kinds = (rs: EventRecord[]): string[] => rs.map((r) => r.kind);
const seqs = (rs: EventRecord[]): number[] => rs.map((r) => r.seq);

// ###########################################################################
// MODULE 1 — filterRecords(records, q, now?)
// ###########################################################################

// ===========================================================================
// 1A — positive / equivalence: no params, type, level, time, limit each in turn
// ===========================================================================

test("filterRecords: no params returns ALL records unchanged (same items, same order)", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec({ kind: "input" }), rec({ kind: "tick" }), logRec("warn")];
  const out = filterRecords(recs, {});
  assert.deepEqual(out, recs, "an empty query is a pass-through");
});

test("filterRecords: types filter keeps ONLY records whose kind is in the set", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    rec({ kind: "input" }),
    rec({ kind: "output" }),
    rec({ kind: "tick" }),
    rec({ kind: "tool.result" }),
  ];
  const out = filterRecords(recs, { types: ["input", "tool.result"] });
  assert.deepEqual(
    kinds(out).sort(),
    ["input", "tool.result"],
    "only kinds in `types` survive",
  );
});

test("filterRecords: levels filter keeps logs whose payload.data.level is in the set (logs-only when types empty)", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    logRec("info"),
    logRec("warn"),
    logRec("error"),
    rec({ kind: "input" }),
    rec({ kind: "tick" }),
  ];
  const out = filterRecords(recs, { levels: ["warn", "error"] });
  assert.deepEqual(
    kinds(out),
    ["log", "log"],
    "levels + empty types ⇒ logs-only; non-log records are dropped",
  );
  const levels = out.map((r) => r.payload.data.level).sort();
  assert.deepEqual(levels, ["error", "warn"], "only logs at the requested levels survive");
});

test("filterRecords: absolute window [fromTs, untilTs] inclusive on both ends", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    rec({ at: 100 }),
    rec({ at: 200 }),
    rec({ at: 300 }),
    rec({ at: 400 }),
  ];
  const out = filterRecords(recs, { fromTs: 200, untilTs: 300 });
  assert.deepEqual(
    out.map((r) => r.at).sort((a, b) => a - b),
    [200, 300],
    "both boundary timestamps are INCLUSIVE",
  );
});

test("filterRecords: sinceMs keeps records with at >= now - sinceMs (explicit now)", async () => {
  const { filterRecords } = await loadQuery();
  const now = 10_000;
  const recs = [
    rec({ at: 8_000 }), // 2000ms old — kept
    rec({ at: 9_500 }), // 500ms old  — kept
    rec({ at: 5_000 }), // 5000ms old — dropped
  ];
  const out = filterRecords(recs, { sinceMs: 3_000 }, now);
  assert.deepEqual(
    out.map((r) => r.at).sort((a, b) => a - b),
    [8_000, 9_500],
    "only records within now - sinceMs survive",
  );
});

test("filterRecords: limit keeps the most-recent N (tail), preserving order", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    rec({ seq: 1 }),
    rec({ seq: 2 }),
    rec({ seq: 3 }),
    rec({ seq: 4 }),
    rec({ seq: 5 }),
  ];
  const out = filterRecords(recs, { limit: 2 });
  assert.deepEqual(seqs(out), [4, 5], "limit returns the TAIL (most recent), in order");
});

// ===========================================================================
// 1B — boundary value analysis
// ===========================================================================

test("filterRecords BVA: limit=0 returns an empty result", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec(), rec(), rec()];
  const out = filterRecords(recs, { limit: 0 });
  assert.deepEqual(out, [], "limit=0 keeps nothing (tail of length 0)");
});

test("filterRecords BVA: limit=1 returns only the single most-recent record", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec({ seq: 7 }), rec({ seq: 8 }), rec({ seq: 9 })];
  const out = filterRecords(recs, { limit: 1 });
  assert.deepEqual(seqs(out), [9], "limit=1 ⇒ the last record only");
});

test("filterRecords BVA: limit >= length returns everything (no truncation)", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec({ seq: 1 }), rec({ seq: 2 }), rec({ seq: 3 })];
  assert.deepEqual(seqs(filterRecords(recs, { limit: 3 })), [1, 2, 3], "limit == length keeps all");
  assert.deepEqual(seqs(filterRecords(recs, { limit: 99 })), [1, 2, 3], "limit > length keeps all");
});

test("filterRecords BVA: an absurd limit is capped at HARD_MAX (never returns more than the cap)", async () => {
  const { filterRecords } = await loadQuery();
  // Build well over any plausible HARD_MAX so the cap is observable independent
  // of its exact value. If the module exports HARD_MAX, pin the count to it.
  const mod = await loadQuery();
  const cap = typeof mod.HARD_MAX === "number" ? mod.HARD_MAX : 50_000;
  const big = cap + 25;
  const recs: EventRecord[] = [];
  for (let i = 0; i < big; i++) recs.push(rec({ seq: i + 1 }));
  const out = filterRecords(recs, { limit: Number.MAX_SAFE_INTEGER });
  assert.ok(
    out.length <= cap,
    "limit is clamped to HARD_MAX (got " + out.length + ", cap " + cap + ")",
  );
  // The retained slice is still the TAIL (highest seqs), per the limit semantics.
  assert.equal(out[out.length - 1].seq, big, "the newest record is always retained under the cap");
});

test("filterRecords BVA: sinceMs=0 is NOT a positive number ⇒ no time filter (keeps all)", async () => {
  const { filterRecords } = await loadQuery();
  const now = 10_000;
  const recs = [rec({ at: 1 }), rec({ at: 9_999 }), rec({ at: 10_000 })];
  const out = filterRecords(recs, { sinceMs: 0 }, now);
  assert.deepEqual(out, recs, "sinceMs=0 disables the relative-time filter (no positive window)");
});

test("filterRecords BVA: sinceMs boundary — at exactly now - sinceMs is INCLUSIVE", async () => {
  const { filterRecords } = await loadQuery();
  const now = 10_000;
  const recs = [
    rec({ at: 7_000 }), // exactly now - sinceMs (3000) — boundary, kept
    rec({ at: 6_999 }), // just below — dropped
    rec({ at: 7_001 }), // just above — kept
  ];
  const out = filterRecords(recs, { sinceMs: 3_000 }, now);
  assert.deepEqual(
    out.map((r) => r.at).sort((a, b) => a - b),
    [7_000, 7_001],
    "the lower bound (now - sinceMs) is inclusive; one tick below is excluded",
  );
});

test("filterRecords BVA: fromTs only ⇒ open-ended window [fromTs, +Inf]; untilTs only ⇒ [-Inf, untilTs]", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec({ at: 100 }), rec({ at: 200 }), rec({ at: 300 })];
  assert.deepEqual(
    filterRecords(recs, { fromTs: 200 }).map((r) => r.at),
    [200, 300],
    "fromTs alone keeps at >= fromTs (inclusive)",
  );
  assert.deepEqual(
    filterRecords(recs, { untilTs: 200 }).map((r) => r.at),
    [100, 200],
    "untilTs alone keeps at <= untilTs (inclusive)",
  );
});

test("filterRecords BVA: empty input returns empty for any query", async () => {
  const { filterRecords } = await loadQuery();
  assert.deepEqual(filterRecords([], {}), [], "no records, no query");
  assert.deepEqual(filterRecords([], { types: ["input"], limit: 5, sinceMs: 1 }, 9), [], "no records, rich query");
});

test("filterRecords BVA: empty types array imposes NO type filter (treated as 'no types')", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec({ kind: "input" }), rec({ kind: "tick" })];
  assert.deepEqual(
    kinds(filterRecords(recs, { types: [] })),
    ["input", "tick"],
    "an EMPTY types array is 'no type filter', not 'match nothing'",
  );
});

test("filterRecords BVA: empty levels array imposes NO level filter (treated as 'no levels')", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [logRec("info"), rec({ kind: "input" })];
  assert.deepEqual(
    kinds(filterRecords(recs, { levels: [] })),
    ["log", "input"],
    "an EMPTY levels array does not force logs-only",
  );
});

// ===========================================================================
// 1C — combined-semantics / interaction (the load-bearing LEVEL+TYPE rule)
// ===========================================================================

test("filterRecords combo: levels + non-empty types keeps non-log kinds in types AND logs at those levels", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    logRec("warn"), // log @ warn — kept (level matches)
    logRec("info"), // log @ info — dropped (level not in set)
    rec({ kind: "tick" }), // non-log, in types — kept (because types includes it)
    rec({ kind: "input" }), // non-log, NOT in types — dropped
  ];
  const out = filterRecords(recs, { levels: ["warn"], types: ["tick"] });
  assert.deepEqual(
    kinds(out).sort(),
    ["log", "tick"],
    "a non-log record is kept ONLY when types is non-empty AND includes its kind; logs gated by level",
  );
  assert.equal(
    out.find((r) => r.kind === "log")?.payload.data.level,
    "warn",
    "the surviving log is the warn one",
  );
});

test("filterRecords combo: levels alone drops every non-log record (logs-only)", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    rec({ kind: "input" }),
    rec({ kind: "output" }),
    rec({ kind: "tool.result" }),
    logRec("error"),
  ];
  const out = filterRecords(recs, { levels: ["error"] });
  assert.deepEqual(kinds(out), ["log"], "levels with empty types ⇒ non-logs excluded wholesale");
});

test("filterRecords combo: types includes 'log' but no levels ⇒ all logs kept regardless of level", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [logRec("info"), logRec("warn"), rec({ kind: "input" })];
  const out = filterRecords(recs, { types: ["log"] });
  assert.deepEqual(
    out.map((r) => (r.kind === "log" ? r.payload.data.level : r.kind)).sort(),
    ["info", "warn"],
    "with no levels filter, every log kind passes; input excluded by the type filter",
  );
});

test("filterRecords combo: time + type + limit compose (window, then type, then tail)", async () => {
  const { filterRecords } = await loadQuery();
  const now = 10_000;
  const recs = [
    rec({ seq: 1, kind: "input", at: 9_000 }),
    rec({ seq: 2, kind: "tick", at: 9_100 }),
    rec({ seq: 3, kind: "input", at: 9_200 }),
    rec({ seq: 4, kind: "input", at: 9_300 }),
    rec({ seq: 5, kind: "input", at: 4_000 }), // outside sinceMs window
  ];
  // sinceMs window keeps seq 1..4; type=input keeps 1,3,4; limit=2 ⇒ tail [3,4].
  const out = filterRecords(recs, { sinceMs: 3_000, types: ["input"], limit: 2 }, now);
  assert.deepEqual(seqs(out), [3, 4], "filters compose: time → type → tail limit");
});

test("filterRecords combo: absolute window WINS over sinceMs when fromTs/untilTs are finite", async () => {
  const { filterRecords } = await loadQuery();
  const now = 10_000;
  const recs = [rec({ at: 100 }), rec({ at: 5_000 }), rec({ at: 9_900 })];
  // If sinceMs were applied it would drop at:100; but fromTs/untilTs override it.
  const out = filterRecords(recs, { sinceMs: 1_000, fromTs: 50, untilTs: 200 }, now);
  assert.deepEqual(
    out.map((r) => r.at),
    [100],
    "an absolute window takes precedence over the relative sinceMs filter",
  );
});

// ===========================================================================
// 1D — negative / error-guessing (must NEVER throw on malformed input)
// ===========================================================================

test("filterRecords negative: a log record missing payload.data does not throw and is excluded by a level filter", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    { seq: 1, at: 1, kind: "log", agentId: "a", payload: null } as any,
    { seq: 2, at: 2, kind: "log", agentId: "a", payload: {} } as any,
    { seq: 3, at: 3, kind: "log", agentId: "a", payload: { data: null } } as any,
    logRec("warn", { seq: 4 }),
  ];
  let out: EventRecord[] = [];
  assert.doesNotThrow(() => {
    out = filterRecords(recs, { levels: ["warn"] });
  }, "missing payload.data must be tolerated");
  assert.deepEqual(seqs(out), [4], "only the well-formed warn log matches; malformed logs are excluded, not crashes");
});

test("filterRecords negative: malformed/garbage records pass through cleanly when no filter applies", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    {} as any,
    { kind: "input" } as any,
    null as any,
    undefined as any,
    rec({ kind: "tick" }),
  ];
  let out: EventRecord[] = [];
  assert.doesNotThrow(() => {
    out = filterRecords(recs, {});
  }, "an empty query must never inspect record internals in a throwing way");
  assert.equal(out.length, recs.length, "no-op query returns the same number of items");
});

test("filterRecords negative: a record with a non-numeric `at` is handled without throwing under a time filter", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [
    { seq: 1, at: "oops" as any, kind: "input", agentId: "a", payload: {} } as any,
    rec({ seq: 2, at: 9_000 }),
  ];
  let out: EventRecord[] = [];
  assert.doesNotThrow(() => {
    out = filterRecords(recs, { sinceMs: 3_000 }, 10_000);
  }, "a non-numeric timestamp must not throw");
  // The well-formed in-window record must still be returned.
  assert.ok(out.some((r) => r.seq === 2), "the valid in-window record survives the malformed sibling");
});

test("filterRecords negative: types referencing kinds not present yields an empty result (no throw)", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec({ kind: "input" }), rec({ kind: "tick" })];
  assert.deepEqual(filterRecords(recs, { types: ["nonexistent.kind"] }), [], "unknown type ⇒ empty, not error");
});

test("filterRecords negative: does not mutate the input array or its records", async () => {
  const { filterRecords } = await loadQuery();
  const recs = [rec({ seq: 1, kind: "input" }), rec({ seq: 2, kind: "tick" }), rec({ seq: 3, kind: "input" })];
  const snapshot = JSON.stringify(recs);
  filterRecords(recs, { types: ["input"], limit: 1, sinceMs: 5, levels: ["info"] }, 9999);
  assert.equal(JSON.stringify(recs), snapshot, "filterRecords is pure — the input is untouched");
});

// ###########################################################################
// MODULE 2 — EventStore (per-agentId persisted ring)
// ###########################################################################

const tmpDirs: string[] = [];
function tmpDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-inspector-store-"));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

const DEFAULT_CFG: StoreCfg = { maxPersistedEntries: 1000, retentionMs: 0, persist: true };
function cfg(over: Partial<StoreCfg> = {}): StoreCfg {
  return { ...DEFAULT_CFG, ...over };
}

// A record with a controllable absolute `at` so retention tests are deterministic.
let SSEQ = 0;
function srec(over: Partial<EventRecord> = {}): EventRecord {
  const seq = over.seq ?? ++SSEQ;
  return {
    seq,
    at: over.at ?? Date.now(),
    kind: over.kind ?? "input",
    agentId: over.agentId ?? "a",
    payload: over.payload ?? { data: { text: "r" + seq } },
    ...(over.corrId !== undefined ? { corrId: over.corrId } : {}),
  };
}

// ===========================================================================
// 2A — round-trip persistence (positive + state transition)
// ===========================================================================

test("EventStore: append + flush + load round-trips the records via window() (oldest→newest)", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg());
  const a = srec({ seq: 11, kind: "input", payload: { data: { text: "first" } } });
  const b = srec({ seq: 12, kind: "tick", payload: { data: { seq: 1 } } });
  const cR = srec({ seq: 13, kind: "log", payload: { data: { level: "info", text: "third" } } });
  s1.append(a);
  s1.append(b);
  s1.append(cR);
  await s1.flush();

  const s2 = await EventStore.load(dir, "alice", cfg());
  const win = s2.window();
  assert.deepEqual(
    win.map((r) => r.seq),
    [11, 12, 13],
    "restored window is oldest→newest in append order",
  );
  assert.deepEqual(win.map((r) => r.kind), ["input", "tick", "log"], "kinds preserved across reload");
  assert.match(JSON.stringify(win[0].payload), /first/, "the payload survives the round-trip");
});

test("EventStore: maxSeq() returns the highest persisted seq after reload", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg());
  s1.append(srec({ seq: 5 }));
  s1.append(srec({ seq: 42 }));
  s1.append(srec({ seq: 7 })); // out-of-order seq; maxSeq is still 42
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg());
  assert.equal(s2.maxSeq(), 42, "maxSeq is the maximum persisted seq, not the last-appended");
});

test("EventStore state transition: append → flush → reload → append again continues to accrue", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg());
  s1.append(srec({ seq: 1 }));
  s1.append(srec({ seq: 2 }));
  await s1.flush();

  const s2 = await EventStore.load(dir, "alice", cfg());
  assert.deepEqual(s2.window().map((r) => r.seq), [1, 2], "first run restored");
  s2.append(srec({ seq: 3 }));
  s2.append(srec({ seq: 4 }));
  await s2.flush();

  const s3 = await EventStore.load(dir, "alice", cfg());
  assert.deepEqual(
    s3.window().map((r) => r.seq),
    [1, 2, 3, 4],
    "a second session appends to the persisted history, not over it",
  );
  assert.equal(s3.maxSeq(), 4, "maxSeq reflects the cumulative history");
});

test("EventStore: an empty store (no appends) reloads to an empty window and maxSeq 0", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg());
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg());
  assert.deepEqual(s2.window(), [], "a never-appended store restores an empty window");
  assert.equal(s2.maxSeq(), 0, "maxSeq of an empty store is 0");
});

// ===========================================================================
// 2B — per-agentId isolation
// ===========================================================================

test("EventStore isolation: two agentIds under the SAME dataDir keep SEPARATE histories", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const sa = await EventStore.load(dir, "a", cfg());
  const sb = await EventStore.load(dir, "b", cfg());
  sa.append(srec({ seq: 101, agentId: "a", payload: { data: { text: "AAA" } } }));
  sb.append(srec({ seq: 202, agentId: "b", payload: { data: { text: "BBB" } } }));
  await sa.flush();
  await sb.flush();

  const ra = await EventStore.load(dir, "a", cfg());
  const rb = await EventStore.load(dir, "b", cfg());
  assert.deepEqual(ra.window().map((r) => r.seq), [101], "agent a sees only a's record");
  assert.deepEqual(rb.window().map((r) => r.seq), [202], "agent b sees only b's record");
  assert.ok(
    !JSON.stringify(ra.window()).includes("BBB"),
    "a's window must NOT contain b's payload",
  );
});

test("EventStore isolation: per-agent files live under dataDir/<agentId>/", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const sa = await EventStore.load(dir, "alice", cfg());
  sa.append(srec({ seq: 1 }));
  await sa.flush();
  const aliceDir = path.join(dir, "alice");
  assert.ok(
    fs.existsSync(aliceDir) && fs.statSync(aliceDir).isDirectory(),
    "the agent's persisted file lives under dataDir/<agentId>/ (expected " + aliceDir + ")",
  );
  // The directory must hold at least one file (the persisted log).
  const entries = fs.readdirSync(aliceDir);
  assert.ok(entries.length >= 1, "the agent subdir contains the persisted log file(s): " + JSON.stringify(entries));
});

// ===========================================================================
// 2C — bounding (maxPersistedEntries) — BVA
// ===========================================================================

test("EventStore bound: appending MORE than maxPersistedEntries keeps only the last N on reload", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const N = 5;
  const s1 = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: N }));
  for (let i = 1; i <= 12; i++) s1.append(srec({ seq: i }));
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: N }));
  const win = s2.window();
  assert.equal(win.length, N, "the persisted window is capped at maxPersistedEntries");
  assert.deepEqual(
    win.map((r) => r.seq),
    [8, 9, 10, 11, 12],
    "only the LAST maxPersistedEntries survive (drop-oldest), in order",
  );
});

test("EventStore bound BVA: exactly maxPersistedEntries keeps them all; one more drops the oldest", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const N = 4;
  const s1 = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: N }));
  for (let i = 1; i <= N; i++) s1.append(srec({ seq: i }));
  await s1.flush();
  const atCap = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: N }));
  assert.deepEqual(atCap.window().map((r) => r.seq), [1, 2, 3, 4], "exactly N persists all N");

  atCap.append(srec({ seq: 5 }));
  await atCap.flush();
  const overCap = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: N }));
  assert.deepEqual(
    overCap.window().map((r) => r.seq),
    [2, 3, 4, 5],
    "N+1 evicts exactly the oldest (FIFO) leaving the last N",
  );
});

test("EventStore bound: window() is bounded even when the on-disk file holds more than the cap", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  // First write a large history with a generous cap...
  const big = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: 1000 }));
  for (let i = 1; i <= 20; i++) big.append(srec({ seq: i }));
  await big.flush();
  // ...then reload with a TIGHT cap; window() must respect the load-time cap.
  const tight = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: 3 }));
  const win = tight.window();
  assert.ok(win.length <= 3, "window() is bounded by the load-time cap (got " + win.length + ")");
  assert.deepEqual(win.map((r) => r.seq), [18, 19, 20], "the tail (newest) is what is retained");
});

// ===========================================================================
// 2D — retentionMs (time-based pruning) — BVA
// ===========================================================================

test("EventStore retention: on load, records older than now - retentionMs are dropped", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const now = Date.now();
  const s1 = await EventStore.load(dir, "alice", cfg({ retentionMs: 60_000 }));
  s1.append(srec({ seq: 1, at: now - 120_000 })); // 2 min old — pruned
  s1.append(srec({ seq: 2, at: now - 30_000 })); //  30s old — kept
  s1.append(srec({ seq: 3, at: now - 1_000 })); //   1s old — kept
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg({ retentionMs: 60_000 }));
  assert.deepEqual(
    s2.window().map((r) => r.seq),
    [2, 3],
    "records older than the retention window are dropped on load",
  );
});

test("EventStore retention BVA: retentionMs=0 DISABLES pruning (all records survive regardless of age)", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const now = Date.now();
  const s1 = await EventStore.load(dir, "alice", cfg({ retentionMs: 0 }));
  s1.append(srec({ seq: 1, at: now - 10 * 365 * 24 * 3_600_000 })); // ~10 years old
  s1.append(srec({ seq: 2, at: now }));
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg({ retentionMs: 0 }));
  assert.deepEqual(s2.window().map((r) => r.seq), [1, 2], "retentionMs=0 keeps everything (pruning off)");
});

test("EventStore retention: a record within the retention window is kept; one outside is pruned", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const now = Date.now();
  // Wall-clock retention (cutoff = now - retentionMs) is read a few ms after these
  // timestamps are chosen, so an EXACT-tick boundary is unobservable; use clear
  // margins (5s either side of the 10s window) to test the invariant deterministically.
  const s1 = await EventStore.load(dir, "alice", cfg({ retentionMs: 10_000 }));
  s1.append(srec({ seq: 1, at: now - 5_000 })); // well inside the 10s window ⇒ kept
  s1.append(srec({ seq: 2, at: now - 15_000 })); // well outside the window ⇒ pruned
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg({ retentionMs: 10_000 }));
  assert.deepEqual(
    s2.window().map((r) => r.seq),
    [1],
    "wall-clock retention keeps records newer than now - retentionMs and prunes older ones",
  );
});

// ===========================================================================
// 2E — persist:false (in-memory only)
// ===========================================================================

test("EventStore persist:false: append does not persist — a reload sees an empty window", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg({ persist: false }));
  s1.append(srec({ seq: 1 }));
  s1.append(srec({ seq: 2 }));
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg({ persist: false }));
  assert.deepEqual(s2.window(), [], "with persist:false nothing reaches disk; a fresh load is empty");
  assert.equal(s2.maxSeq(), 0, "maxSeq is 0 when nothing was persisted");
});

test("EventStore persist:false: does not create the agent subdir / file on disk", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "ghost", cfg({ persist: false }));
  s1.append(srec({ seq: 1 }));
  await s1.flush();
  const ghostDir = path.join(dir, "ghost");
  const noFile =
    !fs.existsSync(ghostDir) ||
    (fs.statSync(ghostDir).isDirectory() && fs.readdirSync(ghostDir).length === 0);
  assert.ok(noFile, "persist:false must not write any persisted log file for the agent");
});

// ===========================================================================
// 2F — compactSync()
// ===========================================================================

test("EventStore compactSync: after compaction a reload reflects exactly the current bounded window", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const N = 4;
  const s1 = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: N }));
  for (let i = 1; i <= 10; i++) s1.append(srec({ seq: i })); // overflow the cap
  s1.compactSync(); // teardown-style flush+compaction (synchronous)
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg({ maxPersistedEntries: N }));
  assert.deepEqual(
    s2.window().map((r) => r.seq),
    [7, 8, 9, 10],
    "compactSync writes the authoritative current window (last N), not the full append log",
  );
});

test("EventStore compactSync: is safe on an empty store (no throw, empty on reload)", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg());
  assert.doesNotThrow(() => s1.compactSync(), "compactSync on an empty store must not throw");
  await s1.flush();
  const s2 = await EventStore.load(dir, "alice", cfg());
  assert.deepEqual(s2.window(), [], "empty store stays empty after compaction");
});

// ===========================================================================
// 2G — robustness / error-guessing (load must never throw)
// ===========================================================================

test("EventStore robustness: loading a fresh (never-written) dataDir returns an empty store, no throw", async () => {
  const { EventStore } = await loadStore();
  const dir = path.join(tmpDataDir(), "does", "not", "exist", "yet");
  let s: EventStore | null = null;
  await assert.doesNotReject(async () => {
    s = await EventStore.load(dir, "alice", cfg());
  }, "load on a missing dir must not reject");
  assert.deepEqual(s!.window(), [], "a missing data dir yields an empty window");
});

test("EventStore robustness: a corrupt JSONL line is skipped — load returns the parseable records", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  // Seed a real persisted file via the store so the on-disk path/format is whatever
  // the implementation chose, THEN inject a garbage line into that same file.
  const s1 = await EventStore.load(dir, "alice", cfg());
  s1.append(srec({ seq: 1, payload: { data: { text: "good-1" } } }));
  s1.append(srec({ seq: 2, payload: { data: { text: "good-2" } } }));
  await s1.flush();
  const aliceDir = path.join(dir, "alice");
  const files = fs.readdirSync(aliceDir).map((f) => path.join(aliceDir, f));
  assert.ok(files.length >= 1, "the store wrote at least one persisted file to corrupt");
  // Append a corrupt (non-JSON) line plus a blank line to the first file.
  fs.appendFileSync(files[0], "this is { not json\n\n", "utf8");

  let s2: EventStore | null = null;
  await assert.doesNotReject(async () => {
    s2 = await EventStore.load(dir, "alice", cfg());
  }, "a corrupt line must not make load() reject");
  const win = s2!.window();
  assert.ok(
    win.some((r) => /good-1/.test(JSON.stringify(r.payload))) &&
      win.some((r) => /good-2/.test(JSON.stringify(r.payload))),
    "the parseable records are recovered despite the corrupt line: " + JSON.stringify(win),
  );
});

test("EventStore robustness: load tolerates a totally empty / whitespace-only persisted file", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg());
  s1.append(srec({ seq: 1 }));
  await s1.flush();
  const aliceDir = path.join(dir, "alice");
  const file = path.join(aliceDir, fs.readdirSync(aliceDir)[0]);
  fs.writeFileSync(file, "\n   \n\t\n", "utf8"); // clobber with whitespace only
  let s2: EventStore | null = null;
  await assert.doesNotReject(async () => {
    s2 = await EventStore.load(dir, "alice", cfg());
  }, "a whitespace-only file must not reject");
  assert.deepEqual(s2!.window(), [], "a content-free file restores an empty window");
});

test("EventStore robustness: an unusual agentId does not crash load/append/flush", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  // An agentId with characters that are awkward in a path. The store must either
  // sanitize it or otherwise handle it WITHOUT throwing and keep it isolated.
  const weird = "weird id .. /\\:*?";
  let s: EventStore | null = null;
  await assert.doesNotReject(async () => {
    s = await EventStore.load(dir, weird, cfg());
    s!.append(srec({ seq: 1, agentId: weird, payload: { data: { text: "ok" } } }));
    await s!.flush();
  }, "a path-hostile agentId must not crash the store");
  // It must NOT have escaped the dataDir (no traversal): the parent dir is intact
  // and a sibling 'clean' agent under the same dataDir stays isolated/empty.
  const clean = await EventStore.load(dir, "clean", cfg());
  assert.deepEqual(clean.window(), [], "the weird-id store did not bleed into a sibling agent");
});

test("EventStore robustness: appending a malformed record never throws and does not corrupt later reads", async () => {
  const { EventStore } = await loadStore();
  const dir = tmpDataDir();
  const s1 = await EventStore.load(dir, "alice", cfg());
  assert.doesNotThrow(() => {
    s1.append({} as any);
    s1.append({ seq: 2, kind: "input", payload: { data: { text: "valid" } } } as any);
  }, "append must swallow / tolerate a malformed record");
  await s1.flush();
  let s2: EventStore | null = null;
  await assert.doesNotReject(async () => {
    s2 = await EventStore.load(dir, "alice", cfg());
  }, "a store that saw a malformed append still reloads cleanly");
  assert.ok(
    s2!.window().some((r) => /valid/.test(JSON.stringify(r.payload))),
    "the subsequent valid record is still persisted and recovered",
  );
});
