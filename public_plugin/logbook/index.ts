/**
 * logbook — records the Agent's own activity (every well-known bus event) into a
 * bounded, persisted store, and exposes a `log.fetch` tool so the agent can query
 * its recent history. Results fold back into the next frame's messages, tagged
 * "logbook"; a system block teaches the tool.
 *
 * R6: ALL mutable state lives in the factory closure — no module-level state.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { ContextBlock } from "../../contracts/context";
import type { Message, ToolDef } from "../../contracts/llm";
import type { Unsub } from "../../contracts/event-system";
import { Events, Actions } from "../../shared/actions";
import { LOGBOOK_SCHEMA } from "./config-schema";
import { LogbookStore } from "./logbook-store";
import { buildRecord, query as runQuery, renderRecord } from "./logbook";
import type { LogFilter, LogRecord } from "./logbook";

const ID = "logbook";
const TOOL = "log.fetch";
const RESULTS_BLOCK = "logbook.results";
const GUIDANCE_BLOCK = "logbook.guidance";

/** Resolved, defensively-defaulted config. */
interface Cfg {
  ringSize: number;
  maxFileEntries: number;
  maxSummaryChars: number;
  captureTypes: string[];
  defaultFetchLimit: number;
  maxFetchLimit: number;
  resultsPriority: number;
  maxResultsTotalChars: number;
  guidance: string;
  guidancePriority: number;
}

/** One folded-back fetch outcome held in the results ring. */
interface FetchOutcome {
  at: number;
  ok: boolean;
  count: number;
  rendered: string;
  /** The provider error string when the fetch failed (ok === false). */
  error?: string;
}

const ALL_TYPES: string[] = Object.values(Events);

/** Pull a positive integer from an unknown config value, or fall back. */
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Resolve the plugin's config slice against schema defaults, defensively. */
function resolveConfig(raw: unknown): Cfg {
  const c = (raw ?? {}) as Record<string, unknown>;
  let captureTypes: string[];
  if (Array.isArray(c.captureTypes)) {
    captureTypes = c.captureTypes.filter((t): t is string => typeof t === "string");
    if (captureTypes.length === 0) captureTypes = ALL_TYPES.slice();
  } else {
    captureTypes = ALL_TYPES.slice();
  }
  return {
    ringSize: Math.max(1, Math.floor(num(c.ringSize, 500))),
    maxFileEntries: Math.max(1, Math.floor(num(c.maxFileEntries, 5000))),
    maxSummaryChars: Math.max(1, Math.floor(num(c.maxSummaryChars, 200))),
    captureTypes,
    defaultFetchLimit: Math.max(1, Math.floor(num(c.defaultFetchLimit, 50))),
    maxFetchLimit: Math.max(1, Math.floor(num(c.maxFetchLimit, 200))),
    resultsPriority: num(c.resultsPriority, 3200),
    maxResultsTotalChars: Math.max(1, Math.floor(num(c.maxResultsTotalChars, 4000))),
    guidance: str(c.guidance, "").trim(),
    guidancePriority: num(c.guidancePriority, 6400),
  };
}

const DEFAULT_GUIDANCE = [
  "You keep a logbook of your own recent activity. Use the `log.fetch` tool to look back at it.",
  "It records, frame by frame: clock ticks, LLM round-trips (with their ok flag and any error),",
  "tool results, inbound/outbound messages, plugin log lines, and context-overflow events.",
  "",
  "Call `log.fetch` to recall what just happened — e.g. to check whether your last reply went",
  "out, why an LLM call failed, or what a tool returned. Useful params:",
  "  • sinceMs — only records within the last N milliseconds (sinceMs:0 = since now)",
  "  • fromTimestamp / untilTimestamp — an absolute epoch-ms window",
  "  • type / types — narrow to a kind, e.g. \"llm.return\" or [\"input.message\",\"output.message\"]",
  "  • level — for log lines (\"info\" | \"warn\" | \"error\" | \"print\")",
  "  • ok — true/false, for llm.return and tool.result outcomes",
  "  • limit — how many of the most recent matches to return",
  "",
  "Results do NOT come back inline: they arrive on your NEXT frame as a message tagged",
  "\"logbook\". Fetch, then read the logbook block on the following turn.",
].join("\n");

/**
 * Build a LogFilter from raw tool params, validating defensively. THROWS a clear
 * Error on bad params (non-numeric sinceMs, unknown filter type, inverted window).
 */
function buildFilter(params: unknown, cfg: Cfg): LogFilter {
  const p = (params ?? {}) as Record<string, unknown>;
  const filter: LogFilter = {};

  const reqNum = (key: string, v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`log.fetch: "${key}" must be a finite number`);
    }
    return v;
  };

  if (p.sinceMs !== undefined) {
    const ms = reqNum("sinceMs", p.sinceMs);
    if (ms < 0) throw new Error('log.fetch: "sinceMs" must be >= 0');
    filter.sinceMs = ms;
  } else {
    if (p.fromTimestamp !== undefined) filter.fromTimestamp = reqNum("fromTimestamp", p.fromTimestamp);
    if (p.untilTimestamp !== undefined) filter.untilTimestamp = reqNum("untilTimestamp", p.untilTimestamp);
    if (
      filter.fromTimestamp !== undefined &&
      filter.untilTimestamp !== undefined &&
      filter.fromTimestamp > filter.untilTimestamp
    ) {
      throw new Error('log.fetch: "fromTimestamp" must be <= "untilTimestamp"');
    }
  }

  if (p.type !== undefined) {
    if (typeof p.type !== "string") throw new Error('log.fetch: "type" must be a string');
    if (!ALL_TYPES.includes(p.type)) {
      throw new Error(`log.fetch: unknown type "${p.type}" — known: ${ALL_TYPES.join(", ")}`);
    }
    filter.type = p.type;
  }

  if (p.types !== undefined) {
    if (!Array.isArray(p.types)) throw new Error('log.fetch: "types" must be an array of strings');
    const types: string[] = [];
    for (const t of p.types) {
      if (typeof t !== "string") throw new Error('log.fetch: "types" entries must be strings');
      if (!ALL_TYPES.includes(t)) {
        throw new Error(`log.fetch: unknown type "${t}" — known: ${ALL_TYPES.join(", ")}`);
      }
      types.push(t);
    }
    filter.types = types;
  }

  if (p.level !== undefined) {
    if (typeof p.level !== "string") throw new Error('log.fetch: "level" must be a string');
    filter.level = p.level;
  }

  if (p.ok !== undefined) {
    if (typeof p.ok !== "boolean") throw new Error('log.fetch: "ok" must be a boolean');
    filter.ok = p.ok;
  }

  if (p.limit !== undefined) {
    const lim = reqNum("limit", p.limit);
    if (lim < 0) throw new Error('log.fetch: "limit" must be >= 0');
    filter.limit = Math.floor(lim);
  }

  // Clamp the effective limit to maxFetchLimit; default when unspecified.
  // limit:0 stays 0 (empty result).
  if (filter.limit === undefined) {
    filter.limit = cfg.defaultFetchLimit;
  }
  if (filter.limit > cfg.maxFetchLimit) {
    filter.limit = cfg.maxFetchLimit;
  }

  return filter;
}

const toolDef: ToolDef = {
  name: TOOL,
  description:
    "Fetch your own recent activity from the logbook: clock ticks, LLM round-trips " +
    "(with ok + any error), tool results, inbound/outbound messages, plugin log lines, " +
    "and context-overflow events. Filter by time window (sinceMs relative, or " +
    "fromTimestamp/untilTimestamp absolute epoch-ms), type/types, level, ok, and limit. " +
    'Results are NOT returned inline — they appear on your NEXT frame as a message tagged "logbook".',
  parameters: {
    type: "object",
    properties: {
      sinceMs: { type: "number", description: "Only records within the last N ms (0 = since now). Wins over from/until." },
      fromTimestamp: { type: "number", description: "Absolute window start, epoch ms (inclusive)." },
      untilTimestamp: { type: "number", description: "Absolute window end, epoch ms (inclusive)." },
      type: { type: "string", description: "A single event type to match, e.g. \"llm.return\"." },
      types: { type: "array", items: { type: "string" }, description: "A set of event types; a record matches when its type is in the set." },
      level: { type: "string", description: "For log.entry records: \"info\" | \"warn\" | \"error\" | \"print\"." },
      ok: { type: "boolean", description: "For llm.return / tool.result: filter by outcome." },
      limit: { type: "number", description: "How many of the most recent matches to return (0 = none)." },
    },
    required: [],
  },
};

const factory: PluginFactory = (): Plugin => {
  // ---- closure state ----
  let store: LogbookStore | undefined;
  let cfg: Cfg;
  let ctxRef: PluginContext | undefined;
  const unsubs: Unsub[] = [];
  let results: FetchOutcome[] = [];
  let torn = false;

  const manifest = {
    id: ID,
    version: "0.1.0",
    requires: ["llm.register_tool"],
    configSchema: LOGBOOK_SCHEMA,
  };

  async function setup(ctx: PluginContext): Promise<void> {
    ctxRef = ctx;
    cfg = resolveConfig(ctx.config);
    store = await LogbookStore.load(ctx.dataDir, {
      ringSize: cfg.ringSize,
      maxFileEntries: cfg.maxFileEntries,
    });

    const capture = new Set(cfg.captureTypes);

    // ---- subscribe to EVERY well-known event (best-effort, never throw) ----
    for (const type of ALL_TYPES) {
      if (!capture.has(type)) continue;
      const unsub = ctx.events.on(type, (payload) => {
        try {
          const rec = buildRecord(type, payload, cfg.maxSummaryChars);
          // Never record our OWN log.entry lines (avoid a feedback loop).
          if (type === Events.LOG && rec.pluginId === ID) return;
          store?.append(rec);
        } catch {
          /* best-effort — a bad payload must never break the bus */
        }
      });
      unsubs.push(unsub);
    }

    // ---- the log.fetch action ----
    const unregFetch = ctx.actions.register(TOOL, async (params) => {
      // No params (undefined/null) = no-filter (return recent records); a DEFINED
      // non-object primitive (string/number/boolean) is invalid.
      if (params != null && typeof params !== "object") {
        throw new Error("log.fetch: params must be an object");
      }
      const filter = buildFilter(params, cfg); // throws on bad params
      const records = store ? store.query(filter) : [];
      return { query: filter, count: records.length, records };
    });
    unsubs.push(unregFetch);

    // ---- declare the tool to the LLM (via the tool-manager action) ----
    try {
      await ctx.actions.invoke("llm.register_tool", toolDef);
    } catch (err) {
      ctx.log.warn(`could not register ${TOOL} tool: ${(err as Error)?.message ?? err}`);
    }

    // ---- fold tool results back into the next frame ----
    const unsubResult = ctx.events.on(Events.TOOL_RESULT, (payload) => {
      try {
        const p = (payload ?? {}) as { name?: string; ok?: boolean; at?: number; data?: unknown; error?: string };
        if (p.name !== TOOL) return;
        const out = (p.data ?? {}) as { count?: number; records?: LogRecord[] };
        const recs = Array.isArray(out.records) ? out.records : [];
        const rendered = recs.map(renderRecord).join("\n");
        results.push({
          at: typeof p.at === "number" ? p.at : Date.now(),
          ok: p.ok === true,
          count: typeof out.count === "number" ? out.count : recs.length,
          rendered,
          error: typeof p.error === "string" ? p.error : undefined,
        });
        trimResults();
        // Nudge a fresh frame so the agent reads its results promptly.
        if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) {
          ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
        }
      } catch {
        /* best-effort */
      }
    });
    unsubs.push(unsubResult);

    // ---- shed results under context pressure; reset on a fresh round-trip ----
    // CONTEXT_FULL: drop the oldest folded-back result so the next re-compose is
    // smaller. LLM_RETURN: the agent has now consumed whatever was folded in this
    // frame, so clear the ring (one-shot delivery) — this also resets the shed
    // pressure, mirroring other tool plugins.
    const unsubFull = ctx.events.on(Events.CONTEXT_FULL, () => {
      if (results.length > 0) results.shift();
    });
    unsubs.push(unsubFull);
    const unsubReturn = ctx.events.on(Events.LLM_RETURN, () => {
      if (results.length > 0) results = [];
    });
    unsubs.push(unsubReturn);

    // ---- fold-back results block (messages) ----
    const resultsBlock: ContextBlock = {
      id: RESULTS_BLOCK,
      target: "messages",
      priority: cfg.resultsPriority,
      render: (): Message[] => renderResults(),
    };
    ctx.setBlock(resultsBlock);

    // ---- guidance block (system) ----
    const guidanceText = cfg.guidance || DEFAULT_GUIDANCE;
    const guidanceBlock: ContextBlock = {
      id: GUIDANCE_BLOCK,
      target: "system",
      label: GUIDANCE_BLOCK,
      priority: cfg.guidancePriority,
      render: (): string => guidanceText,
    };
    ctx.setBlock(guidanceBlock);

    ctx.print(`logbook ready — recording ${capture.size} activity types; log.fetch registered.`);
  }

  /** Render the held fetch outcomes newest-first, under the total-char budget. */
  function renderResults(): Message[] {
    if (results.length === 0) return [];
    const out: Message[] = [];
    let used = 0;
    // newest-first
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      const iso = new Date(r.at).toISOString();
      const header = `[logbook | ${TOOL} | ${r.ok ? "ok" : "error"} | ${r.count} records | ${iso}]`;
      // A failed fold surfaces the provider error so the agent can read what went wrong.
      const body = r.ok ? r.rendered : `Error: ${r.error ?? "unknown"}`;
      const content = body ? `${header}\n${body}` : header;
      if (used + content.length > cfg.maxResultsTotalChars && out.length > 0) break;
      out.push({ role: "user", name: ID, content });
      used += content.length;
    }
    return out;
  }

  /** Keep the results ring bounded so it cannot grow without limit. */
  function trimResults(): void {
    const MAX = 32;
    if (results.length > MAX) results = results.slice(results.length - MAX);
  }

  async function teardown(): Promise<void> {
    if (torn) return;
    torn = true;
    for (const u of unsubs.splice(0)) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    try {
      ctxRef?.removeBlock(GUIDANCE_BLOCK);
      ctxRef?.removeBlock(RESULTS_BLOCK);
    } catch {
      /* ignore */
    }
    results = [];
    store?.compactSync();
  }

  return { manifest, setup, teardown };
};

export default factory;
