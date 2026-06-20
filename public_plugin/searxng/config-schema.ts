import type { ConfigSchema } from "../../contracts/plugin";

export const SEARXNG_SCHEMA: ConfigSchema = [
  { key: "instanceUrl", label: "Pinned instance URL", type: "url", default: null, placeholder: "(none — use fallback chain)", example: "https://searx.example.org", help: "If set, this is the ONLY endpoint — no local or public fallback. Recommended for privacy." },
  { key: "localUrl", label: "Local instance URL", type: "url", default: "http://localhost:8080", example: "http://localhost:8080", help: "Tried first when no pinned instance is set." },
  { key: "usePublicFallback", label: "Fall back to public instances", type: "boolean", default: true, help: "If the local instance fails, query a pool of public SearXNG instances (third-party). Disable for air-gap / privacy configs." },
  { key: "publicInstances", label: "Public instance pool", type: "list", default: [], placeholder: "https://searx.be …", showIf: { key: "usePublicFallback", equals: true }, help: "Empty = use the built-in default pool. Set one or more URLs to replace the pool." },
  { key: "safesearch", label: "Safe search", type: "enum", default: 0,
    options: [ { value: 0, label: "Off" }, { value: 1, label: "Moderate" }, { value: 2, label: "Strict" } ] },
  { key: "language", label: "Language", type: "string", default: "auto", placeholder: "auto", example: "auto · en · zh · de" },
  { key: "categories", label: "Categories", type: "string", default: "general", example: "general · news · science" },
  { key: "timeoutMs", label: "Request timeout", type: "number", default: 10000, min: 1, step: 500, unit: "ms" },
  { key: "maxResults", label: "Results returned", type: "number", default: 5, min: 0, step: 1 },
  { key: "maxSnippetChars", label: "Snippet length", type: "number", default: 400, min: 1, step: 50, help: "Character cap per result snippet." },
  { key: "maxResultChars", label: "Chars per result", type: "number", default: 1200, min: 1, step: 100, help: "Character cap per result entry injected into the prompt." },
  { key: "maxResultsTotalChars", label: "Total result chars", type: "number", default: 12000, min: 1, step: 100, help: "Total character budget across all searxng results in the prompt." },
  { key: "guidancePriority", label: "Guidance block priority", type: "number", default: 6000, min: 0, step: 100 },
  { key: "resultsPriority", label: "Results block priority", type: "number", default: 3500, min: 0, step: 100 },
];
