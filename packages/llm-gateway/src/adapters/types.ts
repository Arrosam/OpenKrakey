/**
 * Shared adapter config: the resolved, key-bearing per-call context the gateway
 * hands to a provider adapter. Stays inside the gateway — never returned to plugins.
 */
export interface AdapterCfg {
  apiKey: string;
  model: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  /** Nucleus-sampling cutoff (0–1) → `top_p`. */
  topP?: number;
  /** Stop sequences → `stop_sequences` (anthropic) / `stop` (openai chat). */
  stop?: string[];
  /** Reasoning effort → `reasoning_effort` (openai chat/responses only). */
  reasoningEffort?: string;
  /** Context-window size in tokens — METADATA only, never sent on the wire. */
  contextLength?: number;
}
