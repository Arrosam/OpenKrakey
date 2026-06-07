/**
 * Shared: config — config/setting TYPES + canonical PATH constants.
 *
 * The actual file I/O lives in the nodes that own it (boot reads agent configs;
 * cli writes them) — this module fixes the shapes + locations so both agree on
 * the format.
 */
import type { AgentDefinition } from "../../contracts/agent";

export type { AgentDefinition };

/** The Default Plugin Setting that the cli's `/new` copies into a fresh agent. */
export interface DefaultAgentSetting {
  intervalMs: number;
  plugins: string[];
  privatePlugins?: string[];
  config?: Record<string, unknown>;
}

/** Resolved runtime paths (relative to the repo root). */
export interface OpenKrakeyConfig {
  /** Shared plugin code dir. */
  publicPluginDir: string;
  /** Per-Agent personal folders live under here (agents/<id>/). */
  agentsDir: string;
  /** The Default Plugin Setting file. */
  defaultPath: string;
}

/** Canonical default paths. */
export const PATHS: OpenKrakeyConfig = {
  publicPluginDir: "public_plugin",
  agentsDir: "agents",
  defaultPath: "config/agent.default.json",
};

/** A personal-folder layout helper for one Agent id. */
export const agentPaths = (agentsDir: string, id: string) => ({
  dir: `${agentsDir}/${id}`,
  config: `${agentsDir}/${id}/config.json`,
  pluginsDir: `${agentsDir}/${id}/plugins`,
});
