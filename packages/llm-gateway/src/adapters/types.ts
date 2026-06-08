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
}
