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
  /** Adapter id: "anthropic" | "openai" (compatible) | "cohere" | "jina" | … */
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
