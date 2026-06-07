/**
 * Contract: agent  ·  connects: agent_instance (impl) ↔ boot, cli
 *
 * "Agent" = an independent instance (its own clock / event-system / orchestrator /
 * loader / plugins / data). `AgentDefinition` is its config file; `agent_instance`
 * is the node that wraps & runs one. (The runtime node is named `agent_instance`
 * to avoid clashing with the "Agent" concept.)
 */

/** An Agent's config (stored at agents/<id>/config.json). */
export interface AgentDefinition {
  id: string;
  /** Beat interval (ms). */
  intervalMs: number;
  /** Public plugin ids to load from public_plugin/ (shared). */
  plugins: string[];
  /** Plugin ids to load as INDEPENDENT copies (copied into the agent; private data). */
  privatePlugins?: string[];
  /** Per-plugin config, keyed by plugin id (also carries persona etc.). */
  config?: Record<string, unknown>;
}

/** External handle to one running Agent. */
export interface AgentHandle {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The per-Agent runtime unit (implemented by the agent_instance node). */
export interface Agent extends AgentHandle {}
