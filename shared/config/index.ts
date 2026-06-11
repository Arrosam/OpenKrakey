/**
 * Shared: config — config/setting TYPES + canonical PATH constants.
 *
 * The actual file I/O lives in the nodes that own it (boot reads agent configs +
 * the LLM config; cli writes them) — this module fixes the shapes + locations so
 * everyone agrees on the format.
 */
import type { AgentDefinition } from "../../contracts/agent";
import type { Capability, Modality } from "../../contracts/llm";

export type { AgentDefinition };

/** The Default Plugin Setting that the cli's `/new` copies into a fresh agent. */
export interface DefaultAgentSetting {
  intervalMs: number;
  plugins: string[];
  privatePlugins?: string[];
  config?: Record<string, unknown>;
}

/**
 * One configured communicator (a provider connection). Lives in config/llm.json.
 * The gateway builds a key-less Communicator from each of these.
 */
export interface CommunicatorDef {
  /** Adapter id: "anthropic" | "openai-completion" | "openai-responses" | "cohere" | "jina" | … */
  provider: string;
  model: string;
  /** API key — a literal, or a "${ENV_VAR}" reference the gateway resolves. */
  apiKey?: string;
  /** Base URL override (for openai-compatible / rerank / proxy endpoints). */
  baseURL?: string;
  /** Operations this model is configured for (default ["chat"]). */
  capabilities?: Capability[];
  /** Input modalities the model accepts (default ["text"]). */
  input?: Modality[];
  /** Output modalities the model produces (default ["text"]). */
  output?: Modality[];
  /** Optional per-communicator request defaults. */
  temperature?: number;
  maxTokens?: number;
}

/**
 * config/llm.json — the global LLM communicator catalogue. GITIGNORED: it holds
 * API keys. Read by boot, turned into a key-less CommunicatorLibrary by the gateway.
 */
export interface LLMConfig {
  communicators: Record<string, CommunicatorDef>;
  /** Optional default communicator name. */
  default?: string;
}

/** Resolved runtime paths (relative to the repo root). */
export interface OpenKrakeyConfig {
  /** Shared plugin code dir. */
  publicPluginDir: string;
  /** Per-Agent personal folders live under here (agents/<id>/). */
  agentsDir: string;
  /** The Default Plugin Setting file. */
  defaultPath: string;
  /** The global LLM communicator catalogue (gitignored — holds keys). */
  llmPath: string;
}

/** Canonical default paths. */
export const PATHS: OpenKrakeyConfig = {
  publicPluginDir: "public_plugin",
  agentsDir: "agents",
  defaultPath: "config/agent.default.json",
  llmPath: "config/llm.json",
};

/** A personal-folder layout helper for one Agent id. */
export const agentPaths = (agentsDir: string, id: string) => ({
  dir: `${agentsDir}/${id}`,
  config: `${agentsDir}/${id}/config.json`,
  pluginsDir: `${agentsDir}/${id}/plugins`,
});

// ---------------------------------------------------------------------------
// Provider catalogue — UI-facing knowledge about the gateway's adapters.
// The cli renders selects/hints from this table so a config can never name a
// provider type or capability the gateway would reject; tests cross-check it
// against the gateway both ways.
// ---------------------------------------------------------------------------

/** UI-facing description of one gateway adapter (a valid CommunicatorDef.provider). */
export interface ProviderInfo {
  /** The adapter id stored in CommunicatorDef.provider. */
  id: string;
  /** Natural-language name shown in UIs. */
  label: string;
  /** One-line description of what this provider type is for. */
  summary: string;
  /** Capabilities this adapter can serve (the only ones selectable in UIs). */
  capabilities: Capability[];
  /** Pre-selected capabilities for a freshly created communicator. */
  defaultCapabilities: Capability[];
  /** Input modalities models on this provider may accept (selectable in UIs). */
  inputs: Modality[];
  /** Output modalities models on this provider may produce (selectable in UIs). */
  outputs: Modality[];
  /** Natural-language guidance for the baseURL format (and what blank means). */
  baseURLHint: string;
  /** A concrete example baseURL. */
  baseURLExample: string;
}

/** Every provider type the gateway accepts, with UI guidance. */
export const KNOWN_PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    summary: "The official Anthropic Messages API.",
    capabilities: ["chat", "ocr"],
    defaultCapabilities: ["chat"],
    inputs: ["text", "image", "document"],
    outputs: ["text"],
    baseURLHint: "API root WITHOUT /v1 — leave blank for the official endpoint",
    baseURLExample: "https://api.anthropic.com",
  },
  {
    id: "openai-completion",
    label: "OpenAI-compatible (chat completions)",
    summary: "OpenAI itself, or any compatible endpoint: oneAPI, Ollama, vLLM, LM Studio…",
    capabilities: ["chat", "embed", "ocr"],
    defaultCapabilities: ["chat"],
    inputs: ["text", "image", "audio"],
    outputs: ["text"],
    baseURLHint: "API root INCLUDING /v1 — leave blank for official OpenAI",
    baseURLExample: "http://localhost:11434/v1",
  },
  {
    id: "openai-responses",
    label: "OpenAI (Responses API)",
    summary: "OpenAI's newer Responses API.",
    capabilities: ["chat", "embed", "ocr"],
    defaultCapabilities: ["chat"],
    inputs: ["text", "image", "document"],
    outputs: ["text"],
    baseURLHint: "API root INCLUDING /v1 — leave blank for official OpenAI",
    baseURLExample: "https://api.openai.com/v1",
  },
  {
    id: "cohere",
    label: "Cohere (reranking)",
    summary: "Cohere's /rerank endpoint for scoring documents against a query.",
    capabilities: ["rerank"],
    defaultCapabilities: ["rerank"],
    inputs: ["text"],
    outputs: ["text"],
    baseURLHint: "leave blank for the official endpoint",
    baseURLExample: "https://api.cohere.com/v2",
  },
  {
    id: "jina",
    label: "Jina (reranking)",
    summary: "Jina's /rerank endpoint for scoring documents against a query.",
    capabilities: ["rerank"],
    defaultCapabilities: ["rerank"],
    inputs: ["text"],
    outputs: ["text"],
    baseURLHint: "leave blank for the official endpoint",
    baseURLExample: "https://api.jina.ai/v1",
  },
];

/** Natural-language labels for capabilities (UI display). */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: "Chat / text generation",
  embed: "Text embeddings",
  rerank: "Document reranking",
  ocr: "OCR — extract text from images/PDFs",
};

/** Natural-language labels for content modalities (UI display). */
export const MODALITY_LABELS: Record<Modality, string> = {
  text: "Text",
  image: "Images",
  audio: "Audio",
  video: "Video",
  document: "Documents (PDF)",
};
