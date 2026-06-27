/**
 * Contract: loader  ·  connects: loader (impl) ↔ agent_instance
 *
 * Per-Agent plugin lifecycle. `load` resolves this Agent's plugins (auto-load the
 * private folder agents/<id>/plugins/ — custom code there overrides same-id
 * public; resolve declared independents and declared publics from public_plugin/),
 * sets each plugin's dataDir, builds its PluginContext, and registers it by
 * calling `setup` (wiring actions/listeners/context blocks into the event-system
 * + orchestrator block store). `teardown` tears every loaded plugin down. The
 * loader ONLY handles plugin startup/shutdown — it does not run the frame.
 *
 * Declared independents (`privatePlugins`) are NEVER code-copied: the code stays
 * in public_plugin/ (so its relative imports keep resolving — copying broke them)
 * and the PluginFactory already gives each Agent its own instance; "independent"
 * means the dataDir is the agent-private agents/<id>/plugins/<pid>/data instead
 * of the shared public_plugin/<pid>/data. A missing public source still rejects.
 *
 * Per-Agent instantiation (R6): plugins share CODE, never live state — a
 * plugin module default-exports a FACTORY (see contracts/plugin), and the
 * loader calls it once per Agent, so every Agent gets its OWN Plugin instance
 * even though ESM caches the module itself. Only `dataDir` is shared for
 * public plugins (the explicit shared-knowledge semantics); an independent
 * copy gets both its own instance and its own data.
 *
 * Determinism & validation: plugin ids must be simple names (no path separators,
 * no `.`/`..`) — anything else is rejected before any filesystem access or import.
 * The load set is gathered in a deterministic order: the declared `plugins` list in
 * order, then any `privatePlugins` not in that list, then any custom private-folder
 * plugins declared nowhere (sorted by name). A `requires` entry containing a dot is
 * an ACTION name that must be registered on the actionbus by an earlier plugin's
 * setup; any other entry must match the plugin id or a `manifest.provides` capability
 * of a plugin in THIS load set (independent of load order).
 *
 * Setup ORDER satisfies `requires`: a plugin is set up only once all its
 * requirements are met, so a dependent that is DECLARED before its action provider
 * is deferred until the provider has set up (the declared order is otherwise
 * preserved — independent plugins keep their listed order). This means a config
 * need not hand-order action dependencies correctly. If no remaining plugin can
 * have its requirements met (a dependency cycle, or a provider that was never
 * declared), load() fails with a DependencyError — the same loud failure a missing
 * dependency has always produced.
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
