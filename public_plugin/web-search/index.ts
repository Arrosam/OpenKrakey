/**
 * web-search plugin — BUS SIDE.
 *
 * Default export is a PluginFactory the loader calls ONCE PER AGENT. All mutable
 * state (the `results` ring, `unsubs`) lives in the factory closure (R6); the only
 * module-level values are immutable consts. Imports are restricted (R2) to the
 * plugin/llm contracts, the shared/actions vocabulary, and the sibling ./search.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Message, ToolDef } from "../../contracts/llm";
import { Actions, Events } from "../../shared/actions";
import { WEB_SEARCH_SCHEMA } from "./config-schema";
import {
  buildDefaultGuidance,
  buildSearchUrl,
  clearFailures,
  formatFailureNotice,
  normalizeResults,
  parseDuckDuckGoLite,
  pushResult,
  readConfig,
  resolveEndpoints,
  upsertFailure,
  type FailureEntry,
  type NormalizedResult,
} from "./search";

/** Tool names this plugin owns — used to filter tool.result events. */
const OWN_TOOLS = new Set(["web-search.search"]);

const SEARCH_TOOL: ToolDef = {
  name: "web-search.search",
  description:
    'Search the web. Results (titles, URLs, snippets) arrive on the NEXT frame (not inline) as a user message tagged "web-search". Use it for current events, documentation lookups, or facts outside your training data.',
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      pageno: { type: "number", description: "Result page number (1-based). Default 1." },
    },
    required: ["query"],
  },
};

/** One recorded tool outcome, fed by the tool.result listener, rendered as a message. */
interface ResultEntry {
  at: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const createWebSearch: PluginFactory = (): Plugin => {
  let results: ResultEntry[] = [];
  let failures: FailureEntry[] = [];
  let unsubs: Array<() => void> = [];
  let pressureRound = 0;

  return {
    manifest: { id: "web-search", version: "0.1.0", requires: ["llm.register_tool"], configSchema: WEB_SEARCH_SCHEMA },

    async setup(ctx: PluginContext): Promise<void> {
      const cfg = readConfig(ctx.config);

      // 1. The web-search.search action — validates, then a serial endpoint waterfall.
      const offSearch = ctx.actions.register("web-search.search", async (params: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        if (typeof p.query !== "string" || p.query.trim().length === 0) {
          throw new Error("web-search.search: 'query' must be a non-empty string");
        }
        const query = p.query.trim();
        const pageno =
          typeof p.pageno === "number" && p.pageno >= 1 ? Math.floor(p.pageno) : 1;

        const tried: string[] = [];
        let lastError = "";

        for (const base of resolveEndpoints(cfg)) {
          tried.push(base);
          const url = buildSearchUrl(base, {
            query,
            language: cfg.language,
            categories: cfg.categories,
            safesearch: cfg.safesearch,
            pageno,
          });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
          try {
            const res = await globalThis.fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) {
              lastError = `HTTP ${res.status} from ${base}`;
              continue;
            }
            let json: unknown;
            try {
              json = await res.json();
            } catch {
              lastError = `non-JSON from ${base}`;
              continue;
            }
            let normalized: NormalizedResult[];
            try {
              normalized = normalizeResults(json, cfg.maxResults, cfg.maxSnippetChars);
            } catch (e) {
              lastError = String(e);
              continue;
            }
            if (normalized.length === 0) {
              lastError = `empty results from ${base}`;
              continue;
            }
            return { endpoint: base, query, results: normalized };
          } catch (err) {
            clearTimeout(timer);
            lastError = String(err);
          }
        }

        // DuckDuckGo Lite keyless fallback — only when no SearXNG instance is pinned.
        if (cfg.useDuckDuckGoFallback && cfg.instanceUrl === null) {
          tried.push("duckduckgo-lite");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
          try {
            const res = await globalThis.fetch(
              "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query),
              {
                headers: {
                  "user-agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                  accept: "text/html",
                },
                signal: controller.signal,
              },
            );
            clearTimeout(timer);
            if (res.ok) {
              const html = await res.text();
              const results = parseDuckDuckGoLite(html, cfg.maxResults, cfg.maxSnippetChars);
              if (results.length > 0) {
                return { endpoint: "duckduckgo", query, results };
              }
              lastError = "empty results from duckduckgo-lite";
            } else {
              lastError = `HTTP ${res.status} from duckduckgo-lite`;
            }
          } catch (err) {
            clearTimeout(timer);
            lastError = String(err);
          }
        }

        throw new Error(
          `web-search.search: all endpoints failed (tried: ${tried.join(", ")}); last error: ${lastError}`,
        );
      });

      // 2. Register the tool (best-effort — a missing llm.register_tool isn't fatal).
      try {
        await ctx.actions.invoke("llm.register_tool", SEARCH_TOOL);
      } catch (err) {
        ctx.log.warn(`web-search: failed to register tool: ${String(err)}`);
      }

      // 3. Guidance block (system).
      const guidanceText = cfg.guidance !== null ? cfg.guidance : buildDefaultGuidance(cfg);
      ctx.setBlock({
        id: "web-search.guidance",
        label: "web-search.guidance",
        target: "system",
        priority: cfg.guidancePriority,
        render: () => guidanceText,
      });

      // 4. Results block (messages) — renders recorded outcomes newest-first,
      //    bounded by a total char budget. Pure and never throws.
      ctx.setBlock({
        id: "web-search.results",
        target: "messages",
        priority: cfg.resultsPriority,
        render: (): Message[] => {
          // Persistent-failure notices (count >= 2) prepend the results block so a
          // tool that keeps failing is surfaced ahead of this frame's raw outcomes.
          // Each notice respects the per-entry char budget (maxResultChars).
          const failureMessages: Message[] = [];
          for (const f of failures) {
            const text = formatFailureNotice(f);
            if (text === null) continue;
            const content =
              text.length > cfg.maxResultChars
                ? text.slice(0, cfg.maxResultChars) +
                  `\n…(${text.length - cfg.maxResultChars} chars truncated)`
                : text;
            failureMessages.push({ role: "user", name: "web-search", content } as Message);
          }

          if (results.length === 0) return failureMessages;

          const queryOf = (r: ResultEntry): string => {
            const d = r.data as { query?: unknown } | null | undefined;
            return d !== null && typeof d === "object" && typeof d.query === "string"
              ? d.query
              : "";
          };
          const headerOf = (r: ResultEntry): string =>
            `[web-search result | web-search.search | ${r.ok ? "ok" : "error"} | query: ${queryOf(r)} | ${new Date(r.at).toISOString()}]`;

          const bodyOf = (r: ResultEntry): string => {
            let body: string;
            if (r.ok) {
              const data = r.data as { results?: unknown } | null | undefined;
              if (data !== null && typeof data === "object" && Array.isArray(data.results)) {
                body = (data.results as NormalizedResult[])
                  .map((res, i) => `${i + 1}. ${res.title}\n   ${res.url}\n   ${res.snippet}`)
                  .join("\n\n");
              } else {
                body = JSON.stringify(r.data);
              }
            } else {
              body =
                "Error: " +
                (r.error ?? "unknown") +
                "\n[web-search FAILED — no backend returned results. Tell the user the search failed; if it keeps failing, they should set a working SearXNG instanceUrl in the web-search config. Do not silently retry the same query.]";
            }
            if (body.length > cfg.maxResultChars) {
              const truncated = body.length - cfg.maxResultChars;
              body = body.slice(0, cfg.maxResultChars) + `\n…(${truncated} chars truncated)`;
            }
            return body;
          };

          // Newest-first inclusion under the total budget; the newest entry is
          // always rendered full, older ones until the budget is exhausted.
          const full = new Array<boolean>(results.length).fill(false);
          let total = 0;
          for (let i = results.length - 1; i >= 0; i--) {
            const h = headerOf(results[i]);
            const b = bodyOf(results[i]);
            const len = h.length + 1 + b.length;
            if (i === results.length - 1 || total + len <= cfg.maxResultsTotalChars) {
              full[i] = true;
              total += len;
            } else {
              break;
            }
          }

          return failureMessages.concat(
            results.map(
              (r, i) =>
                ({
                  role: "user",
                  name: "web-search",
                  content: full[i] ? headerOf(r) + "\n" + bodyOf(r) : headerOf(r),
                }) as Message,
            ),
          );
        },
      });

      // 5. tool.result listener — records own-tool outcomes; nudges a frame. Never throws.
      const offResult = ctx.events.on(Events.TOOL_RESULT, (payload: unknown) => {
        if (payload === null || typeof payload !== "object") return;
        const q = payload as {
          name?: unknown;
          at?: unknown;
          ok?: unknown;
          data?: unknown;
          error?: unknown;
        };
        if (typeof q.name !== "string" || !OWN_TOOLS.has(q.name)) return;
        const at = typeof q.at === "number" ? q.at : Date.now();
        const ok = !!q.ok;
        results = pushResult(
          results,
          {
            at,
            ok,
            data: q.data,
            error: typeof q.error === "string" ? q.error : undefined,
          },
          cfg.maxResults,
        );
        // Persistent-failure ledger (F2). Skipped entirely when disabled (maxFailureNotices <= 0).
        // On failure: upsert by (tool + normalized error). On success: clear all entries for the tool.
        if (cfg.maxFailureNotices > 0) {
          failures = ok
            ? clearFailures(failures, q.name)
            : upsertFailure(failures, q.name, q.error, at, cfg.maxFailureNotices);
        }
        if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) {
          ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
        }
      });

      // 6. context.full reaction — synchronous, INCREMENTAL pressure shedding:
      //    drop the `round` OLDEST entries (front = oldest) from the CURRENT buffer
      //    so the immediately-following re-compose is smaller. round 0 → no-op.
      const offContextFull = ctx.events.on(Events.CONTEXT_FULL, (payload) => {
        const raw = (payload as any)?.data?.round;
        const round =
          typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
        pressureRound = round;
        if (round > 0) {
          const toDrop = Math.min(round, results.length);
          if (toDrop > 0) results = results.slice(toDrop);
          // Shed the ledger under the SAME oldest-first pressure logic (clamped).
          const failuresToDrop = Math.min(round, failures.length);
          if (failuresToDrop > 0) failures = failures.slice(failuresToDrop);
        }
      });

      // Results are one-shot: cleared once the model has read them (llm.return),
      // which fires before this frame's tool.result events — so fresh results
      // pushed by this frame survive to the next frame. Also resets the pressure
      // counter for the fresh round-trip.
      const offReturn = ctx.events.on(Events.LLM_RETURN, () => {
        results = [];
        pressureRound = 0;
      });

      unsubs = [
        offSearch,
        offResult,
        offContextFull,
        offReturn,
        () => ctx.removeBlock("web-search.guidance"),
        () => ctx.removeBlock("web-search.results"),
      ];

      ctx.print("web-search: web-search tool ready");
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
      results = [];
      failures = [];
      pressureRound = 0;
    },
  };
};

export default createWebSearch;
