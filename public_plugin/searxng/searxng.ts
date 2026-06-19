/**
 * searxng — PURE HELPERS (no bus, no fetch, no I/O except reading the cfg object).
 *
 * All functions here are deterministic and side-effect free so they can be unit
 * tested in isolation. The bus-side wiring (actions, blocks, the fetch call) lives
 * in ./index.ts.
 */

export interface SearxngConfig {
  instanceUrl: string | null; // if set -> ONLY endpoint (no fallback)
  localUrl: string; // default "http://localhost:8080"
  publicInstances: string[]; // default pool below
  usePublicFallback: boolean; // default true
  language: string; // default "auto"
  categories: string; // default "general"
  safesearch: number; // 0|1|2, default 0
  timeoutMs: number; // default 10000
  maxResults: number; // default 5
  maxSnippetChars: number; // default 400
  maxResultChars: number; // default 1200
  maxResultsTotalChars: number; // default 12000
  guidance: string | null; // default null
  guidancePriority: number; // default 6000
  resultsPriority: number; // default 3500
}

export interface NormalizedResult {
  title: string;
  url: string;
  snippet: string;
}

/** Immutable default public-instance pool. */
export const DEFAULT_PUBLIC_INSTANCES: readonly string[] = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://paulgo.io",
  "https://searx.tiekoetter.com",
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Read and validate `ctx.config` (unknown) into a fully-defaulted SearxngConfig.
 * A non-object `raw` is treated as `{}`; every field falls back to its default.
 */
export function readConfig(raw: unknown): SearxngConfig {
  const o: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const instanceUrl = isNonEmptyString(o.instanceUrl) ? o.instanceUrl : null;
  const localUrl = isNonEmptyString(o.localUrl) ? o.localUrl : "http://localhost:8080";

  const publicInstances = Array.isArray(o.publicInstances)
    ? o.publicInstances.filter(isNonEmptyString)
    : [...DEFAULT_PUBLIC_INSTANCES];

  const usePublicFallback = o.usePublicFallback === false ? false : true;

  const language = isNonEmptyString(o.language) ? o.language : "auto";
  const categories = isNonEmptyString(o.categories) ? o.categories : "general";

  const safesearch =
    o.safesearch === 0 || o.safesearch === 1 || o.safesearch === 2 ? o.safesearch : 0;

  const timeoutMs = typeof o.timeoutMs === "number" && o.timeoutMs > 0 ? o.timeoutMs : 10000;
  const maxResults =
    typeof o.maxResults === "number" && o.maxResults >= 0 ? o.maxResults : 5;
  const maxSnippetChars =
    typeof o.maxSnippetChars === "number" && o.maxSnippetChars > 0 ? o.maxSnippetChars : 400;
  const maxResultChars =
    typeof o.maxResultChars === "number" && o.maxResultChars > 0 ? o.maxResultChars : 1200;
  const maxResultsTotalChars =
    typeof o.maxResultsTotalChars === "number" && o.maxResultsTotalChars > 0
      ? o.maxResultsTotalChars
      : 12000;

  const guidance = typeof o.guidance === "string" ? o.guidance : null;
  const guidancePriority = typeof o.guidancePriority === "number" ? o.guidancePriority : 6000;
  const resultsPriority = typeof o.resultsPriority === "number" ? o.resultsPriority : 3500;

  return {
    instanceUrl,
    localUrl,
    publicInstances,
    usePublicFallback,
    language,
    categories,
    safesearch,
    timeoutMs,
    maxResults,
    maxSnippetChars,
    maxResultChars,
    maxResultsTotalChars,
    guidance,
    guidancePriority,
    resultsPriority,
  };
}

/**
 * The ordered list of base URLs to try. If `instanceUrl` is set it is the ONLY
 * endpoint (no fallback); otherwise local-first, then the public pool when
 * `usePublicFallback`.
 */
export function resolveEndpoints(cfg: SearxngConfig): string[] {
  if (cfg.instanceUrl !== null) return [cfg.instanceUrl];
  return [cfg.localUrl, ...(cfg.usePublicFallback ? cfg.publicInstances : [])];
}

/**
 * Build the `/search` JSON API URL for a base instance. URLSearchParams handles
 * encoding; `pageno` is only added when it is a number >= 1.
 */
export function buildSearchUrl(
  base: string,
  p: {
    query: string;
    language: string;
    categories: string;
    safesearch: number;
    pageno?: number;
  },
): string {
  const url = new URL("/search", base);
  url.searchParams.set("q", p.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", p.language);
  url.searchParams.set("categories", p.categories);
  url.searchParams.set("safesearch", String(p.safesearch));
  if (typeof p.pageno === "number" && p.pageno >= 1) {
    url.searchParams.set("pageno", String(p.pageno));
  }
  return url.toString();
}

/** Truncate to `max` chars, appending an ellipsis when cut. */
export function truncateSnippet(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

/**
 * Normalize a SearXNG JSON response into NormalizedResult[]. Throws if the
 * response has no `results` array. Each item maps to { title, url, snippet }.
 */
export function normalizeResults(
  json: unknown,
  maxResults: number,
  maxSnippetChars: number,
): NormalizedResult[] {
  if (json === null || typeof json !== "object" || !Array.isArray((json as { results?: unknown }).results)) {
    throw new Error("searxng: response has no results array");
  }
  const items = (json as { results: unknown[] }).results.slice(0, maxResults);
  return items.map((raw): NormalizedResult => {
    const item = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const url = typeof item.url === "string" ? item.url : "";
    const snippet = truncateSnippet(String(item.content ?? ""), maxSnippetChars);
    return { title, url, snippet };
  });
}

/**
 * Build the SYSTEM guidance string when the operator hasn't supplied a custom one.
 * Mentions the `searxng.search` tool, that results arrive on the NEXT beat as a
 * user message tagged "searxng", the endpoint strategy, the maxResults cap, and the
 * honest caveat about public instances.
 */
export function buildDefaultGuidance(cfg: SearxngConfig): string {
  const endpointStrategy =
    cfg.instanceUrl !== null
      ? `Queries go to the configured instance ${cfg.instanceUrl}.`
      : `Queries try your local instance first (${cfg.localUrl})${
          cfg.usePublicFallback
            ? `, then fall back to public instances (${cfg.publicInstances.join(", ")})`
            : ``
        }.`;

  return [
    `You can search the web with the tool searxng.search (argument: query).`,
    `Results do NOT come back inline: titles, URLs, and snippets arrive on the NEXT beat as a user message tagged "searxng". Call the tool, then read its results next beat.`,
    endpointStrategy,
    `At most ${cfg.maxResults} results are returned per query.`,
    `Note: public SearXNG instances may rate-limit or disable the JSON API, so a search can fail. For reliable web search, run a local SearXNG or set instanceUrl in this plugin's config.`,
  ].join("\n");
}

/**
 * Append `entry` to the `ring`, keeping at most `max` entries (newest kept). Pure.
 */
export function pushResult<T>(ring: T[], entry: T, max: number): T[] {
  const next = [...ring, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
