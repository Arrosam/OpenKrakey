/**
 * inspector/query.ts — the PURE record-filter shared by the /query endpoint and
 * the dashboard's client-side live-tail mirror.
 *
 * `filterRecords` applies a small, LOCKED query grammar to an ordered (oldest →
 * newest) array of EventRecords and returns a NEW array (it never mutates the
 * input and never throws — a record with a missing/odd payload is simply tolerated).
 *
 * The grammar (all clauses AND together; empty arrays are inert):
 *   - TIME  — absolute window [fromTs, untilTs] (inclusive) when either bound is a
 *             finite number; else a relative `>= now - sinceMs` when sinceMs is a
 *             finite positive number; else no time filter.
 *   - TYPE  — `types` non-empty ⇒ keep records whose `kind` is in `types`.
 *   - LEVEL — `levels` non-empty ⇒ a `log` record is kept iff its payload.data.level
 *             is in `levels`; a NON-log record is kept ONLY when `types` is non-empty
 *             and includes its kind (so levels + empty types ⇒ logs-only).
 *   - LIMIT — keep the most-recent min(limit, HARD_MAX) (the tail); default = all;
 *             limit 0 ⇒ [].
 */
import type { EventRecord } from "./hub";

/** Absolute ceiling on how many records `filterRecords` will ever return. */
export const HARD_MAX = 5000;

/** The query shape parsed from /query search params (and built by the client). */
export interface RecordQuery {
  sinceMs?: number;
  fromTs?: number;
  untilTs?: number;
  types?: string[];
  levels?: string[];
  limit?: number;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && isFinite(v);
}

/** Read payload.data.level defensively (tolerate missing payload/data). */
function logLevel(rec: EventRecord): unknown {
  const p = rec.payload;
  if (p && typeof p === "object") {
    const d = (p as { data?: unknown }).data;
    if (d && typeof d === "object") return (d as { level?: unknown }).level;
  }
  return undefined;
}

/**
 * Filter `records` by `q`. PURE: returns a fresh array, never mutates `records`,
 * never throws. `now` is injectable so callers (and tests) control "now" for the
 * relative `sinceMs` window.
 */
export function filterRecords(
  records: EventRecord[],
  q: RecordQuery,
  now: number = Date.now(),
): EventRecord[] {
  const types = Array.isArray(q.types) ? q.types : [];
  const levels = Array.isArray(q.levels) ? q.levels : [];
  const hasTypes = types.length > 0;
  const hasLevels = levels.length > 0;

  // ---- resolve the time window once ----
  // Absolute window wins when EITHER bound is a finite number; otherwise a finite
  // positive sinceMs gives a relative lower bound; otherwise no time filter.
  let lo = -Infinity;
  let hi = Infinity;
  if (isFiniteNum(q.fromTs) || isFiniteNum(q.untilTs)) {
    if (isFiniteNum(q.fromTs)) lo = q.fromTs;
    if (isFiniteNum(q.untilTs)) hi = q.untilTs;
  } else if (isFiniteNum(q.sinceMs) && q.sinceMs > 0) {
    lo = now - q.sinceMs;
  }
  const hasTime = lo !== -Infinity || hi !== Infinity;

  // NO-OP (no content filter active): pass EVERY input record through UNCHANGED —
  // including null/undefined/garbage — without inspecting it. Only the limit tail
  // (below) may trim. This preserves length + element identity for an empty query.
  let out: EventRecord[];
  if (!hasTime && !hasTypes && !hasLevels) {
    out = records.slice();
  } else {
    // A filter IS active: iterate with DEFENSIVE access. A record that can't satisfy
    // the active filter is simply EXCLUDED (never throws on garbage).
    out = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      // A non-object record cannot satisfy any active filter → exclude (no throw).
      if (!rec || typeof rec !== "object") continue;

      // TIME (inclusive)
      const at = typeof rec.at === "number" ? rec.at : 0;
      if (at < lo || at > hi) continue;

      const isLog = rec.kind === "log";

      // TYPE + LEVEL — the two gates interact per the locked semantics:
      //  • levels NON-EMPTY: the level gate is the SOLE authority for LOG records
      //    (a log is kept iff its level ∈ levels, independent of `types`); a NON-log
      //    record is kept only if `types` is non-empty AND includes its kind (so
      //    levels + empty types ⇒ logs-only).
      //  • levels EMPTY: only the type gate applies (types non-empty ⇒ keep kind ∈
      //    types for ALL kinds incl. logs; types empty ⇒ inert).
      if (hasLevels) {
        if (isLog) {
          if (levels.indexOf(String(logLevel(rec))) === -1) continue;
        } else {
          if (!(hasTypes && types.indexOf(rec.kind) !== -1)) continue;
        }
      } else if (hasTypes) {
        if (types.indexOf(rec.kind) === -1) continue;
      }

      out.push(rec);
    }
  }

  // LIMIT — keep the most-recent min(limit, HARD_MAX) (the tail).
  if (q.limit === undefined) {
    // default: all (still hard-capped to HARD_MAX from the tail)
    if (out.length > HARD_MAX) return out.slice(out.length - HARD_MAX);
    return out;
  }
  const lim = Math.min(Math.max(0, Math.floor(q.limit)), HARD_MAX);
  if (lim === 0) return [];
  if (out.length > lim) return out.slice(out.length - lim);
  return out;
}
