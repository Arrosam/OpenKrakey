/**
 * web-search — PURE HELPERS (no bus, no fetch, no I/O except reading the cfg object).
 *
 * All functions here are deterministic and side-effect free so they can be unit
 * tested in isolation. The bus-side wiring (actions, blocks, the fetch call) lives
 * in ./index.ts.
 */

export interface WebSearchConfig {
  instanceUrl: string | null; // if set -> ONLY endpoint (no fallback)
  localUrl: string; // default "http://localhost:8080"
  publicInstances: string[]; // default pool below
  usePublicFallback: boolean; // default true
  useDuckDuckGoFallback: boolean; // default true
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
  maxFailureNotices: number; // default 8 (0 disables the ledger path)
}

export interface NormalizedResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * One persistent-failure ledger entry: a distinct (tool + normalized error) pair
 * that has failed one or more consecutive times, surviving across frames until the
 * tool next succeeds. Pure-data (no bus); the bus wiring lives in ./index.ts.
 */
export interface FailureEntry {
  toolName: string;
  error: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

/** Immutable default public-instance pool. */
export const DEFAULT_PUBLIC_INSTANCES: readonly string[] = [];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Read and validate `ctx.config` (unknown) into a fully-defaulted WebSearchConfig.
 * A non-object `raw` is treated as `{}`; every field falls back to its default.
 */
export function readConfig(raw: unknown): WebSearchConfig {
  const o: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const instanceUrl = isNonEmptyString(o.instanceUrl) ? o.instanceUrl : null;
  const localUrl = isNonEmptyString(o.localUrl) ? o.localUrl : "http://localhost:8080";

  const publicInstances = Array.isArray(o.publicInstances)
    ? o.publicInstances.filter(isNonEmptyString)
    : [...DEFAULT_PUBLIC_INSTANCES];

  const usePublicFallback = o.usePublicFallback === false ? false : true;
  const useDuckDuckGoFallback = o.useDuckDuckGoFallback === false ? false : true;

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

  const maxFailureNotices =
    typeof o.maxFailureNotices === "number" && o.maxFailureNotices >= 0
      ? o.maxFailureNotices
      : 8;

  return {
    instanceUrl,
    localUrl,
    publicInstances,
    usePublicFallback,
    useDuckDuckGoFallback,
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
    maxFailureNotices,
  };
}

/**
 * The ordered list of base URLs to try. If `instanceUrl` is set it is the ONLY
 * endpoint (no fallback); otherwise local-first, then the public pool when
 * `usePublicFallback`. SearXNG endpoints only — the DuckDuckGo fallback is wired
 * separately in ./index.ts.
 */
export function resolveEndpoints(cfg: WebSearchConfig): string[] {
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
    throw new Error("web-search: response has no results array");
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

/** Strip HTML tags and decode the common entities, returning collapsed plain text. */
function stripTagsAndDecode(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, "");
  const decoded = noTags
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
  return decoded.replace(/\s+/g, " ").trim();
}

/**
 * Parse a DuckDuckGo Lite (https://lite.duckduckgo.com/lite/) HTML response into
 * NormalizedResult[]. Each `<a … class='result-link'>` carries the redirect href
 * whose `uddg` query-param is the (URI-encoded) real URL; the anchor's inner text
 * is the title; the FOLLOWING `<td class='result-snippet'>` inner text is the
 * snippet (empty string when absent). Results are paired in document order and
 * capped to `maxResults`; snippets are truncated to `maxSnippetChars`.
 */
export function parseDuckDuckGoLite(
  html: string,
  maxResults: number,
  maxSnippetChars: number,
): NormalizedResult[] {
  const results: NormalizedResult[] = [];
  // Match each result-link anchor and the snippet cell that follows it (if any),
  // before the next result-link anchor.
  const linkRe = /<a\b[^>]*\bclass='result-link'[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    const anchor = m[0];
    const innerHtml = m[1];

    const hrefMatch = /href=(?:"([^"]*)"|'([^']*)')/i.exec(anchor);
    const href = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? "") : "";
    let url = "";
    const uddgMatch = /[?&]uddg=([^&'"]*)/.exec(href);
    if (uddgMatch) {
      try {
        url = decodeURIComponent(uddgMatch[1]);
      } catch {
        url = "";
      }
    }

    const title = stripTagsAndDecode(innerHtml);

    // The snippet is the next result-snippet cell before the following result-link.
    const rest = html.slice(linkRe.lastIndex);
    const nextLinkIdx = rest.search(/<a\b[^>]*\bclass='result-link'/i);
    const window = nextLinkIdx === -1 ? rest : rest.slice(0, nextLinkIdx);
    const snippetMatch = /<td\b[^>]*\bclass='result-snippet'[^>]*>([\s\S]*?)<\/td>/i.exec(window);
    const snippet = snippetMatch
      ? truncateSnippet(stripTagsAndDecode(snippetMatch[1]), maxSnippetChars)
      : "";

    results.push({ title, url, snippet });
  }

  return results;
}

/**
 * Build the SYSTEM guidance string when the operator hasn't supplied a custom one.
 * Mentions the `web-search.search` tool, that results arrive on the NEXT frame as a
 * user message tagged "web-search", the endpoint strategy, the maxResults cap, the
 * DuckDuckGo fallback, and the honest caveat about public instances.
 */
export function buildDefaultGuidance(cfg: WebSearchConfig): string {
  const endpointStrategy =
    cfg.instanceUrl !== null
      ? `Queries go to the configured instance ${cfg.instanceUrl}.`
      : `Queries try your local instance first (${cfg.localUrl})${
          cfg.usePublicFallback
            ? `, then fall back to public instances (${cfg.publicInstances.join(", ")})`
            : ``
        }${
          cfg.useDuckDuckGoFallback
            ? `, and use a keyless DuckDuckGo web search when no SearXNG instance is set`
            : ``
        }.`;

  return [
    `You can search the web with the tool web-search.search (argument: query).`,
    `Results do NOT come back inline: titles, URLs, and snippets arrive on the NEXT frame as a user message tagged "web-search". Call the tool, then read its results next frame.`,
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

/** Max characters kept for a normalized failure error (keeps ledger keys bounded). */
const FAILURE_ERROR_MAX_CHARS = 300;

/**
 * Normalize a raw tool error into the string used both as the ledger key and the
 * rendered text: coerce to String, trim, fall back to "unknown" when empty, and
 * cap at ~300 chars so a giant error can't bloat the ledger.
 */
export function normalizeFailureError(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const nonEmpty = s.length === 0 ? "unknown" : s;
  return nonEmpty.length > FAILURE_ERROR_MAX_CHARS
    ? nonEmpty.slice(0, FAILURE_ERROR_MAX_CHARS)
    : nonEmpty;
}

/**
 * Upsert a failure into the ledger, keyed by (toolName + normalized error). If a
 * matching entry exists, bump its `count` and `lastAt`; otherwise append a fresh
 * entry with `count: 1`. The result is then bounded to `max` entries by dropping
 * the OLDEST (front, insertion order). `max <= 0` clears the ledger entirely
 * (the feature is disabled). Pure — returns a new array; never mutates `ledger`.
 */
export function upsertFailure(
  ledger: FailureEntry[],
  toolName: string,
  rawError: unknown,
  at: number,
  max: number,
): FailureEntry[] {
  if (max <= 0) return [];
  const error = normalizeFailureError(rawError);
  const idx = ledger.findIndex((e) => e.toolName === toolName && e.error === error);
  let next: FailureEntry[];
  if (idx >= 0) {
    const prev = ledger[idx];
    const updated: FailureEntry = {
      toolName,
      error,
      count: prev.count + 1,
      firstAt: prev.firstAt,
      lastAt: at,
    };
    next = ledger.slice();
    next[idx] = updated;
  } else {
    next = [...ledger, { toolName, error, count: 1, firstAt: at, lastAt: at }];
  }
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Remove ALL ledger entries for a tool (called when that tool next succeeds). Pure.
 */
export function clearFailures(ledger: FailureEntry[], toolName: string): FailureEntry[] {
  return ledger.filter((e) => e.toolName !== toolName);
}

/**
 * Render one persistent-failure notice for `entry`, or `null` when it should render
 * nothing extra (count < 2 — a single failure is already covered by the per-result
 * FAILED rendering). "failed <N>x in a row" and "retrying the same call unchanged
 * will NOT succeed" are matched verbatim by the edge tests.
 */
export function formatFailureNotice(entry: FailureEntry): string | null {
  if (entry.count < 2) return null;
  return (
    `[web-search persistent failure] ${entry.toolName} has failed ${entry.count}x in a row ` +
    `with the same error: ${entry.error}. This failure is persistent - retrying the same call ` +
    `unchanged will NOT succeed. Reflect on why it is failing and change your approach, or stop ` +
    `and report it; do not keep re-calling it.`
  );
}
