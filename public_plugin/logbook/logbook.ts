/**
 * logbook · record model — the LogRecord shape, per-type summarizers, and a pure
 * `query(records, filter)` function. No I/O, no bus access: just data shaping.
 *
 * Every record's `type` is the canonical event NAME from shared/actions Events.
 * `summary` is ALWAYS a compact one-line string (capped) — never the raw payload.
 */
import { Events } from "../../shared/actions";

/** One recorded activity row. */
export interface LogRecord {
  /** Monotonic sequence number, assigned by the store; survives restart. */
  seq: number;
  /** Event timestamp (payload.at ?? Date.now()). */
  at: number;
  /** Canonical event name (an Events value), e.g. "clock.tick", "llm.return". */
  type: string;
  /** Outcome flag — set for reply-shaped events (llm.return, tool.result). */
  ok?: boolean;
  /** Tool / event name where applicable (e.g. the tool name on tool.result). */
  name?: string;
  /** Log level — set for log.entry records ("info" | "warn" | "error" | "print"). */
  level?: string;
  /** Originating plugin id — set for log.entry records. */
  pluginId?: string;
  /** Correlation id — payload.id when it is a string. */
  corrId?: string;
  /** Compact, capped one-line description. NEVER the raw payload. */
  summary: string;
}

/** A query over recorded activity (all fields optional / additive). */
export interface LogFilter {
  /**
   * Relative window: include records whose `at` is within the last `sinceMs`
   * milliseconds (measured from `now`). `0` means "since now" → empty window.
   * When present it WINS over fromTimestamp/untilTimestamp.
   */
  sinceMs?: number;
  /** Absolute window start (inclusive), epoch ms. Ignored when sinceMs is set. */
  fromTimestamp?: number;
  /** Absolute window end (inclusive), epoch ms. Ignored when sinceMs is set. */
  untilTimestamp?: number;
  /** Single type to match (folded into the type set). */
  type?: string;
  /** Set of types to match; a record matches when its `type` is in the set. */
  types?: string[];
  /** Match only log.entry records with this level. */
  level?: string;
  /** Match only reply-shaped records (llm.return / tool.result) with this ok. */
  ok?: boolean;
  /** Most-recent cap; `0` yields an empty result. */
  limit?: number;
  /** Reference "now" for the sinceMs window (defaults to Date.now()). */
  now?: number;
}

const MS = 1;

/** Cap a one-line summary: collapse newlines, trim, and clip to `max` chars. */
function compact(text: string, max: number): string {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return oneLine.length > max ? oneLine.slice(0, Math.max(0, max - 1)) + "…" : oneLine;
}

/** Safely stringify an unknown value for a compact summary fragment. */
function brief(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build a compact, human one-line summary for an event payload, keyed by type.
 * `payload` is the raw event payload (a base envelope specialization); we read
 * only the few load-bearing fields per type and never echo the whole thing.
 */
export function summarize(type: string, payload: unknown, maxChars: number): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  let s: string;

  switch (type) {
    case Events.AGENT_START:
      s = `agent ${brief(data.agentId)} started`;
      break;
    case Events.CLOCK_TICK:
      s = `tick seq=${brief(data.seq)}`;
      break;
    case Events.PROMPT_GATHER:
      s = `gather seq=${brief(data.seq)}`;
      break;
    case Events.LLM_REQUEST:
      s = `round-trip requested for ${brief(data.agentId)}`;
      break;
    case Events.LLM_REQUEST_SENT: {
      const req = (data.request ?? {}) as Record<string, unknown>;
      const msgs = Array.isArray(req.messages) ? req.messages.length : 0;
      const tools = Array.isArray(req.tools) ? req.tools.length : 0;
      s = `sent ${brief(req.model) || "request"} (${msgs} msgs, ${tools} tools)`;
      break;
    }
    case Events.LLM_RETURN: {
      const ok = p.ok === true;
      if (!ok) {
        s = `error: ${brief(p.error) || "unknown"}`;
      } else {
        const resp = (p.data ?? {}) as Record<string, unknown>;
        const calls = Array.isArray(resp.toolCalls) ? resp.toolCalls.length : 0;
        const content = typeof resp.content === "string" ? resp.content : "";
        const head = content ? `"${content}"` : "(no text)";
        s = calls > 0 ? `ok ${calls} tool-call(s) ${head}` : `ok ${head}`;
      }
      break;
    }
    case Events.INPUT_MESSAGE:
      s = `in${data.from ? ` from ${brief(data.from)}` : ""}${
        data.channel ? ` [${brief(data.channel)}]` : ""
      }: ${brief(data.text)}`;
      break;
    case Events.OUTPUT_MESSAGE:
      s = `out${data.to ? ` to ${brief(data.to)}` : ""}${
        data.channel ? ` [${brief(data.channel)}]` : ""
      }: ${brief(data.text)}`;
      break;
    case Events.TOOL_RESULT: {
      const ok = p.ok === true;
      const nm = brief(p.name) || "tool";
      s = ok ? `${nm} ok: ${brief(p.data)}` : `${nm} error: ${brief(p.error) || "unknown"}`;
      break;
    }
    case Events.LOG:
      s = `[${brief(data.level)}] ${brief(data.pluginId)}: ${brief(data.text)}`;
      break;
    case Events.CONTEXT_FULL:
      s = `overflow round ${brief(data.round)}: ~${brief(data.estimatedTokens)}/${brief(
        data.limit,
      )} tokens (over by ${brief(data.overBy)})`;
      break;
    default:
      s = brief(data) || brief(payload);
      break;
  }
  return compact(s, maxChars);
}

/**
 * Build a LogRecord from an event. Pulls the shared envelope fields (at, id) and
 * the per-type extras (ok / name / level / pluginId) the spec calls out, then
 * delegates the one-line summary to `summarize`. `seq` is filled by the store.
 */
export function buildRecord(
  type: string,
  payload: unknown,
  maxSummaryChars: number,
): Omit<LogRecord, "seq"> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;

  const at = typeof p.at === "number" ? p.at : Date.now();
  const corrId = typeof p.id === "string" ? p.id : undefined;

  const rec: Omit<LogRecord, "seq"> = {
    at,
    type,
    summary: summarize(type, payload, maxSummaryChars),
  };
  if (corrId !== undefined) rec.corrId = corrId;

  // ok — reply-shaped events.
  if (type === Events.LLM_RETURN || type === Events.TOOL_RESULT) {
    if (typeof p.ok === "boolean") rec.ok = p.ok;
  }
  // name — carried on tool.result (and surfaced for input/output channel).
  if (type === Events.TOOL_RESULT && typeof p.name === "string") {
    rec.name = p.name;
  }
  // log.entry — level + pluginId are TOP-LEVEL record fields.
  if (type === Events.LOG) {
    if (typeof data.level === "string") rec.level = data.level;
    if (typeof data.pluginId === "string") rec.pluginId = data.pluginId;
  }
  return rec;
}

/**
 * Pure query over a chronological record array. Records are assumed ascending by
 * seq/at (the store keeps them so). Returns the most-recent `limit` matches in
 * CHRONOLOGICAL order.
 */
export function query(records: readonly LogRecord[], filter: LogFilter = {}): LogRecord[] {
  const now = typeof filter.now === "number" ? filter.now : Date.now();

  // Resolve the time window. sinceMs (relative) wins over from/until.
  let from = -Infinity;
  let until = Infinity;
  if (typeof filter.sinceMs === "number") {
    from = now - filter.sinceMs * MS;
    until = now;
  } else {
    if (typeof filter.fromTimestamp === "number") from = filter.fromTimestamp;
    if (typeof filter.untilTimestamp === "number") until = filter.untilTimestamp;
  }

  // Resolve the type set (single type folded in).
  const typeSet = new Set<string>();
  if (typeof filter.type === "string") typeSet.add(filter.type);
  if (Array.isArray(filter.types)) {
    for (const t of filter.types) if (typeof t === "string") typeSet.add(t);
  }
  const hasTypeFilter = typeSet.size > 0;

  const matched: LogRecord[] = [];
  for (const r of records) {
    if (r.at < from || r.at > until) continue;
    if (hasTypeFilter && !typeSet.has(r.type)) continue;
    if (filter.level !== undefined && r.level !== filter.level) continue;
    if (filter.ok !== undefined && r.ok !== filter.ok) continue;
    matched.push(r);
  }

  // limit:0 → empty; undefined → all matches; else most-recent N.
  if (filter.limit === 0) return [];
  if (typeof filter.limit === "number" && filter.limit > 0 && matched.length > filter.limit) {
    return matched.slice(matched.length - filter.limit);
  }
  return matched;
}

/** Render one record as a compact, human, single line for the fold-back block. */
export function renderRecord(r: LogRecord): string {
  const iso = new Date(r.at).toISOString();
  const tags: string[] = [r.type];
  if (r.name) tags.push(r.name);
  if (r.level) tags.push(r.level);
  if (typeof r.ok === "boolean") tags.push(r.ok ? "ok" : "fail");
  return `#${r.seq} ${iso} [${tags.join(" | ")}] ${r.summary}`;
}
