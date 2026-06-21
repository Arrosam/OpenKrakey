/**
 * schema.js — the SINGLE SOURCE OF TRUTH the config UI auto-fetches from.
 *
 * Every field below mirrors a real OpenKrakey setting (extracted verbatim from
 * the codebase: shared/config, packages/cli, and each plugin's config reader).
 * The UI in app.js renders controls *generically* from these descriptors — it
 * has no per-field knowledge. That is the whole point of the mock: point it at a
 * schema, get the right control for every value.
 *
 * control → rendered as
 *   "select"      single-select  → dropdown menu
 *   "multiselect" multi-choice   → selection-pick (chip grid, ◉/◯)
 *   "toggle"      boolean        → toggle switch
 *   "number"      free numeric   → <input type=number> (restricted)
 *   "text"        free string    → text field
 *   "url"         free URL       → text field (shows format + example)
 *   "secret"      free secret    → masked field (API key / token)
 *   "textarea"    free long text → multi-line field
 *   "taglist"     free list      → add/remove chips (e.g. command allowlist)
 */

// ─── Provider catalogue (verbatim from shared/config KNOWN_PROVIDERS) ─────────
const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic-compatible (Messages API)",
    summary: "Anthropic's /v1/messages wire format — Claude, or any compatible endpoint.",
    capabilities: ["chat", "ocr"],
    defaultCapabilities: ["chat"],
    inputs: ["text", "image", "document"],
    outputs: ["text"],
    baseURLHint: "API root WITHOUT /v1 — blank for the official endpoint",
    baseURLExample: "https://api.anthropic.com",
    modelExample: "claude-sonnet-4-6",
  },
  {
    id: "openai-completion",
    label: "OpenAI-compatible (chat completions)",
    summary: "The /chat/completions format — OpenAI, oneAPI, Ollama, vLLM…",
    capabilities: ["chat", "embed", "ocr"],
    defaultCapabilities: ["chat"],
    inputs: ["text", "image", "audio"],
    outputs: ["text"],
    baseURLHint: "API root INCLUDING /v1 — blank for official OpenAI",
    baseURLExample: "http://localhost:11434/v1",
    modelExample: "gpt-4o",
  },
  {
    id: "openai-responses",
    label: "OpenAI (Responses API)",
    summary: "OpenAI's /responses wire format.",
    capabilities: ["chat", "embed", "ocr"],
    defaultCapabilities: ["chat"],
    inputs: ["text", "image", "document"],
    outputs: ["text"],
    baseURLHint: "API root INCLUDING /v1 — blank for official OpenAI",
    baseURLExample: "https://api.openai.com/v1",
    modelExample: "gpt-4o",
  },
  {
    id: "cohere",
    label: "Cohere (rerank)",
    summary: "Cohere's /rerank format for scoring documents against a query.",
    capabilities: ["rerank"],
    defaultCapabilities: ["rerank"],
    inputs: ["text"],
    outputs: ["text"],
    baseURLHint: "blank for the official endpoint",
    baseURLExample: "https://api.cohere.com/v2",
    modelExample: "rerank-v3.5",
  },
  {
    id: "jina",
    label: "Jina (rerank)",
    summary: "Jina's /rerank format for scoring documents against a query.",
    capabilities: ["rerank"],
    defaultCapabilities: ["rerank"],
    inputs: ["text"],
    outputs: ["text"],
    baseURLHint: "blank for the official endpoint",
    baseURLExample: "https://api.jina.ai/v1",
    modelExample: "jina-reranker-v2-base-multilingual",
  },
];

const CAPABILITY_LABELS = {
  chat: "Chat / text generation",
  embed: "Text embeddings",
  rerank: "Document reranking",
  ocr: "OCR — text from images/PDFs",
};

const MODALITY_LABELS = {
  text: "Text",
  image: "Images",
  audio: "Audio",
  video: "Video",
  document: "Documents (PDF)",
};

// ─── Plugin catalogue (public_plugin/*) — what the agent can DO ───────────────
// `icon` names index the inline SVG set in app.js (no emoji/glyphs).
const PLUGINS = [
  { id: "llm-core",      icon: "cpu",      name: "LLM core",      tagline: "talks to the AI service — required for replies", required: true },
  { id: "persona",       icon: "person",   name: "Persona",       tagline: "the agent's identity / system prompt" },
  { id: "system-prompt", icon: "terminal", name: "System prompt", tagline: "operating model: monologue rule + tool use" },
  { id: "web-chat",      icon: "chat",     name: "Web chat",      tagline: "chat with the agent from your browser", dataCarrier: true },
  { id: "krakeycode",    icon: "code",     name: "Coding tools",  tagline: "read / write files, run shell, list dirs" },
  { id: "searxng",       icon: "search",   name: "Web search",    tagline: "search the web via a SearXNG instance" },
  { id: "browser",       icon: "globe",    name: "Browser",       tagline: "read-only Chrome control — navigate + screenshot" },
  { id: "inspector",     icon: "activity", name: "Inspector",     tagline: "live debug panel for every beat", dataCarrier: true },
  { id: "notes",         icon: "journal",  name: "Notes",         tagline: "scratch memory the agent can jot to" },
];

const f = (o) => o; // tiny identity helper, keeps field literals tidy

// ─── Per-plugin config schemas (auto-fetched, rendered generically) ──────────
// Each entry is the exact config slice each plugin reads from ctx.config.
const PLUGIN_SCHEMAS = {
  persona: [
    f({ key: "text", label: "Persona text", control: "textarea", default: "You are Krakey, an autonomous agent. Be concise and helpful.",
        help: "The identity system block. Rendered at the very top of the prompt (stable prefix → prompt-cache hits)." }),
    f({ key: "priority", label: "Block priority", control: "number", default: 10000, min: 0, step: 100,
        help: "Higher = closer to the top of the composed context." }),
  ],
  "system-prompt": [
    f({ key: "text", label: "Operating-model text", control: "textarea",
        default: "You run on a recurring beat: each beat you think, and may act. The plain text you produce each beat is your PRIVATE MONOLOGUE and is shown to NO ONE. To affect anything outside your own head you MUST call one of your tools.",
        help: "Channel-agnostic. Teaches the monologue rule + basic tool use. Never names a specific channel." }),
    f({ key: "priority", label: "Block priority", control: "number", default: 9000, min: 0, step: 100 }),
  ],
  "llm-core": [
    f({ key: "communicator", label: "AI service", control: "select", optionsFrom: "services", default: "",
        help: "Which configured AI service this agent talks to. Blank = first chat-capable service." }),
    f({ key: "temperature", label: "Temperature", control: "number", default: undefined, min: 0, max: 2, step: 0.1,
        placeholder: "provider default", help: "Sampling temperature. Leave blank to use the provider default." }),
    f({ key: "maxTokens", label: "Max output tokens", control: "number", default: undefined, min: 1, step: 1,
        placeholder: "provider default", help: "Upper bound on the reply length." }),
  ],
  "web-chat": [
    f({ key: "port", label: "Port", control: "number", default: 7718, min: 1, max: 65535, step: 1,
        help: "The browser chat server binds here." }),
    f({ key: "host", label: "Bind host", control: "text", default: "127.0.0.1", placeholder: "127.0.0.1",
        example: "127.0.0.1 (loopback) · 0.0.0.0 (all interfaces)",
        help: "Loopback by default — not LAN-reachable. Any string the OS accepts." }),
    f({ key: "token", label: "Session token", control: "secret", default: "",
        help: "Pin a token (≥16 url-safe chars) or leave blank for a fresh random one each run." }),
    f({ key: "guidance", label: "Channel guidance", control: "textarea", default: "",
        placeholder: "(uses built-in guidance)", help: "Overrides the web-chat.guidance system block text." }),
    f({ key: "guidancePriority", label: "Guidance priority", control: "number", default: 8000, min: 0, step: 100 }),
    f({ key: "conversationMaxTurns", label: "Conversation window — turns", control: "number", default: 60, min: 1, step: 1,
        help: "How many recent turns are fed back to the LLM." }),
    f({ key: "conversationMaxChars", label: "Conversation window — chars", control: "number", default: 24000, min: 1, step: 100 }),
  ],
  inspector: [
    f({ key: "port", label: "Port", control: "number", default: 7788, min: 1, max: 65535, step: 1 }),
    f({ key: "host", label: "Bind host", control: "text", default: "127.0.0.1", placeholder: "127.0.0.1" }),
    f({ key: "token", label: "Session token", control: "secret", default: "",
        help: "≥16 url-safe chars, or blank for a fresh random token each run." }),
    f({ key: "bufferSize", label: "Event buffer size", control: "number", default: 1000, min: 1, step: 1,
        help: "Ring-buffer length for captured beats." }),
    f({ key: "maxRecordBytes", label: "Max record bytes", control: "number", default: 65536, min: 1, step: 1024 }),
  ],
  krakeycode: [
    f({ key: "mode", label: "Security mode", control: "select", default: "local",
        options: [
          { value: "local", label: "Local — absolute paths / working dir" },
          { value: "sandbox", label: "Sandbox — confined to a root + allowlist" },
        ],
        help: "Sandbox confines file ops to the root below and filters shell commands." }),
    f({ key: "root", label: "Sandbox root", control: "text", default: "", placeholder: "(plugin data dir)",
        example: "./workspace", showIf: { key: "mode", equals: "sandbox" },
        help: "File ops cannot escape this directory in sandbox mode." }),
    f({ key: "allowWrite", label: "Allow file writes", control: "toggle", default: true,
        help: "write_file / edit_file tools. Turn off for read-only." }),
    f({ key: "allowCommands", label: "Allow shell commands", control: "toggle", default: true,
        help: "The bash tool." }),
    f({ key: "commandAllowlist", label: "Command allowlist", control: "taglist", default: [],
        placeholder: "git, ls, cat…", showIf: { key: "mode", equals: "sandbox" },
        help: "Sandbox only. Empty = allow everything. Otherwise the command name must appear here." }),
    f({ key: "commandTimeoutMs", label: "Command timeout", control: "number", default: 60000, min: 1, step: 1000, unit: "ms" }),
    f({ key: "maxReadBytes", label: "Max read bytes", control: "number", default: 1000000, min: 1, step: 1000 }),
    f({ key: "maxOutputBytes", label: "Max shell output bytes", control: "number", default: 200000, min: 1, step: 1000 }),
    f({ key: "maxResults", label: "Results kept", control: "number", default: 10, min: 0, step: 1 }),
    f({ key: "maxResultChars", label: "Chars per result", control: "number", default: 4000, min: 1, step: 100 }),
    f({ key: "maxResultsTotalChars", label: "Total result chars", control: "number", default: 16000, min: 1, step: 100 }),
    f({ key: "guidancePriority", label: "Guidance priority", control: "number", default: 7000, min: 0, step: 100 }),
    f({ key: "resultsPriority", label: "Results priority", control: "number", default: 4000, min: 0, step: 100 }),
  ],
  searxng: [
    f({ key: "instanceUrl", label: "Pinned instance URL", control: "url", default: "",
        example: "https://searx.example.org", placeholder: "(none — use fallback chain)",
        help: "If set, this is the ONLY endpoint (no fallback). Best for privacy." }),
    f({ key: "localUrl", label: "Local instance URL", control: "url", default: "http://localhost:8080",
        example: "http://localhost:8080", help: "Tried first when no pinned instance is set." }),
    f({ key: "usePublicFallback", label: "Fall back to public instances", control: "toggle", default: true,
        help: "If the local instance is down, query a pool of public SearXNG instances (third-party)." }),
    f({ key: "publicInstances", label: "Public instance pool", control: "taglist", default: [],
        placeholder: "https://searx.be …", showIf: { key: "usePublicFallback", equals: true },
        help: "Empty = use the built-in default pool." }),
    f({ key: "safesearch", label: "Safe search", control: "select", default: 0,
        options: [
          { value: 0, label: "Off" },
          { value: 1, label: "Moderate" },
          { value: 2, label: "Strict" },
        ] }),
    f({ key: "language", label: "Language", control: "text", default: "auto", placeholder: "auto", example: "auto · en · zh · de" }),
    f({ key: "categories", label: "Categories", control: "text", default: "general", example: "general · news · science" }),
    f({ key: "timeoutMs", label: "Request timeout", control: "number", default: 10000, min: 1, step: 500, unit: "ms" }),
    f({ key: "maxResults", label: "Results returned", control: "number", default: 5, min: 0, step: 1 }),
    f({ key: "maxSnippetChars", label: "Snippet length", control: "number", default: 400, min: 1, step: 50 }),
    f({ key: "maxResultChars", label: "Chars per result", control: "number", default: 1200, min: 1, step: 100 }),
    f({ key: "maxResultsTotalChars", label: "Total result chars", control: "number", default: 12000, min: 1, step: 100 }),
    f({ key: "guidancePriority", label: "Guidance priority", control: "number", default: 6000, min: 0, step: 100 }),
    f({ key: "resultsPriority", label: "Results priority", control: "number", default: 3500, min: 0, step: 100 }),
  ],
  browser: [
    f({ key: "headless", label: "Headless", control: "toggle", default: true,
        help: "Run Chrome without a visible window." }),
    f({ key: "chromePath", label: "Chrome path", control: "text", default: "", placeholder: "(auto-detect)",
        example: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        help: "Leave blank to auto-detect the installed Chrome." }),
    f({ key: "remoteDebugPort", label: "Remote debug port", control: "number", default: 0, min: 0, max: 65535, step: 1,
        help: "0 = pick a free port automatically." }),
    f({ key: "navigationTimeoutMs", label: "Navigation timeout", control: "number", default: 30000, min: 1, step: 1000, unit: "ms" }),
    f({ key: "commandTimeoutMs", label: "Command timeout", control: "number", default: 10000, min: 1, step: 500, unit: "ms" }),
    f({ key: "maxTextChars", label: "Max page text chars", control: "number", default: 50000, min: 1, step: 1000 }),
    f({ key: "screenshotDir", label: "Screenshot dir", control: "text", default: "", placeholder: "(plugin data dir)/screenshots" }),
    f({ key: "guidancePriority", label: "Guidance priority", control: "number", default: 5500, min: 0, step: 100 }),
    f({ key: "resultsPriority", label: "Results priority", control: "number", default: 3000, min: 0, step: 100 }),
    f({ key: "maxResults", label: "Results kept", control: "number", default: 10, min: 0, step: 1 }),
    f({ key: "maxResultChars", label: "Chars per result", control: "number", default: 4000, min: 1, step: 100 }),
    f({ key: "maxResultsTotalChars", label: "Total result chars", control: "number", default: 16000, min: 1, step: 100 }),
  ],
  notes: [],
};

// ─── Agent / Default base fields (the shared four) ───────────────────────────
const AGENT_FIELDS = [
  f({ key: "intervalMs", label: "Heartbeat interval", control: "number", default: 30000, min: 1, step: 1000, unit: "ms",
      help: "How often the agent wakes to think unprompted. 30000 = every 30 s." }),
  f({ key: "plugins", label: "Plugins to load", control: "multiselect", optionsFrom: "plugins", default: [],
      help: "Everything this agent can do. Each is a public_plugin/." }),
  f({ key: "privatePlugins", label: "Private data copies", control: "multiselect", optionsFrom: "plugins", default: [],
      help: "These plugins get their own isolated data under this agent instead of sharing the public copy." }),
];

// ─── Communicator (AI service) fields — provider-reactive ────────────────────
function communicatorFields(providerId) {
  const p = PROVIDERS.find((x) => x.id === providerId) || PROVIDERS[0];
  return [
    f({ key: "provider", label: "Provider type", control: "select", default: p.id,
        options: PROVIDERS.map((x) => ({ value: x.id, label: x.label, summary: x.summary })),
        help: "The wire format your endpoint speaks. Drives every option below." }),
    f({ key: "model", label: "Model id", control: "text", default: "", example: `e.g. ${p.modelExample}`,
        placeholder: p.modelExample, help: "Exactly as your provider names it." }),
    f({ key: "baseURL", label: "Endpoint URL", control: "url", default: "",
        example: `e.g. ${p.baseURLExample}`, placeholder: p.baseURLExample, help: p.baseURLHint }),
    f({ key: "apiKey", label: "API key", control: "secret", default: "",
        help: "Stored locally in config/llm.json (gitignored). Use ${ENV_VAR} to reference an environment variable." }),
    f({ key: "capabilities", label: "Used for", control: "multiselect", default: p.defaultCapabilities,
        options: p.capabilities.map((c) => ({ value: c, label: CAPABILITY_LABELS[c] })),
        help: "What this connection will serve. Constrained to what the provider type supports." }),
    f({ key: "input", label: "Input types", control: "multiselect", default: ["text"],
        options: p.inputs.map((m) => ({ value: m, label: MODALITY_LABELS[m] })),
        help: "Content the model accepts." }),
    f({ key: "output", label: "Output types", control: "multiselect", default: ["text"],
        options: p.outputs.map((m) => ({ value: m, label: MODALITY_LABELS[m] })),
        help: "Content the model produces." }),
    f({ key: "temperature", label: "Temperature", control: "number", default: undefined, min: 0, max: 2, step: 0.1,
        placeholder: "provider default" }),
    f({ key: "maxTokens", label: "Max tokens (context window)", control: "number", default: undefined, min: 1, step: 1,
        placeholder: "provider default", help: "Number-only. The cap on tokens per request." }),
  ];
}

// ─── Seed state (real values pulled from the repo's config + agents) ─────────
const SEED = {
  services: {
    oneAPI: {
      provider: "openai-completion",
      model: "astron-low",
      baseURL: "http://38.175.194.56:38844/v1",
      apiKey: "sk-2fDWNPNK••••••••••••••••••••••D3A3",
      capabilities: ["chat", "ocr"],
      input: ["text", "image"],
      output: ["text"],
    },
  },
  default: { name: "AI service" }, // chosen default communicator
  defaultSetting: {
    intervalMs: 30000,
    plugins: ["llm-core", "persona", "system-prompt", "web-chat", "krakeycode"],
    privatePlugins: ["web-chat"],
    config: {
      persona: { text: "You are Krakey, an autonomous agent. Be concise and helpful." },
      "web-chat": { port: 7718 },
    },
  },
  agents: {
    krakey: {
      id: "krakey",
      intervalMs: 30000,
      plugins: ["llm-core", "persona", "system-prompt", "web-chat", "inspector", "krakeycode"],
      privatePlugins: ["web-chat"],
      config: {
        persona: { text: "You are Krakey, an autonomous agent. Be concise and helpful." },
        "llm-core": { communicator: "oneAPI" },
        "web-chat": { port: 8979 },
        inspector: { port: 7788 },
      },
    },
    krakey2: {
      id: "krakey2",
      intervalMs: 30000,
      plugins: ["llm-core", "persona", "system-prompt", "web-chat", "inspector", "krakeycode"],
      privatePlugins: ["web-chat"],
      config: {
        persona: { text: "You are Krakey, an autonomous agent. Be concise and helpful." },
        "llm-core": { communicator: "oneAPI" },
        "web-chat": { port: 7718 },
        inspector: { port: 7788 },
      },
    },
  },
};

window.OK = { PROVIDERS, CAPABILITY_LABELS, MODALITY_LABELS, PLUGINS, PLUGIN_SCHEMAS, AGENT_FIELDS, communicatorFields, SEED };
