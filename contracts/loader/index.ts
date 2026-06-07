/**
 * Contract: loader  ·  connects: loader (impl) ↔ agent_instance
 *
 * Per-Agent plugin lifecycle. `load` resolves this Agent's plugins (copy declared
 * independents into the agent; auto-load the private folder which overrides same-id
 * public; load declared public), sets each plugin's dataDir, builds its
 * PluginContext, and registers it by calling `setup` (wiring actions/listeners/
 * context blocks into the event-system + orchestrator block store). `teardown`
 * tears every loaded plugin down. The loader ONLY handles plugin startup/shutdown
 * — it does not run the beat.
 */
export interface Loader {
  /** Load + register all of this Agent's plugins. Idempotent-safe to call once. */
  load(): Promise<void>;
  /** Teardown all loaded plugins. */
  teardown(): Promise<void>;
}
