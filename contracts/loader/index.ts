/**
 * Contract: loader  ·  connects: loader (impl) ↔ agent_instance
 *
 * Per-Agent plugin lifecycle. `load` resolves this Agent's plugins (copy declared
 * independents into the agent — code only, never the source's accumulated data/;
 * auto-load the private folder which overrides same-id public; load declared
 * public), sets each plugin's dataDir, builds its PluginContext, and registers it
 * by calling `setup` (wiring actions/listeners/context blocks into the
 * event-system + orchestrator block store). `teardown` tears every loaded plugin
 * down. The loader ONLY handles plugin startup/shutdown — it does not run the beat.
 *
 * Per-Agent instantiation (R6): plugins share CODE, never live state — the
 * loader imports each plugin through a per-agent module URL (`?agent=<id>`),
 * so every Agent gets its OWN module instance of a public plugin; module-scoped
 * plugin state is therefore per-Agent. Only `dataDir` is shared for public
 * plugins (the explicit shared-knowledge semantics); an independent copy gets
 * both its own instance and its own data.
 *
 * Determinism & validation: plugin ids must be simple names (no path separators,
 * no `.`/`..`) — anything else is rejected before any filesystem copy or import.
 * Plugins load in a deterministic order (private folder sorted by name, then the
 * declared public list). A `requires` entry containing a dot is an ACTION name
 * checked against the actionbus at that plugin's setup time; any other entry must
 * match the plugin id or a `manifest.provides` capability of a plugin in THIS
 * load set (independent of load order).
 *
 * Failure: load() is all-or-nothing — if any plugin fails to import/validate/
 * setup, the plugins already set up are torn down (reverse order, isolated
 * errors) before the error is rethrown.
 */
export interface Loader {
  /** Load + register all of this Agent's plugins. Call exactly once; a repeat call is not safe. */
  load(): Promise<void>;
  /** Teardown all loaded plugins. */
  teardown(): Promise<void>;
}
