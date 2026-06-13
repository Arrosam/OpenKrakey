/**
 * Contract: plugin  ·  connects: loader (loads + builds PluginContext), orchestrator (block store)
 *
 * The only extensibility surface. A plugin contributes any combination of context
 * blocks, actions, and event listeners — all via the per-Agent EventSystem it is
 * handed at `setup`. It NEVER imports another plugin or core internals.
 *
 * Context blocks are addressed BY ID and are NOT owner-locked: any plugin may
 * add / modify / remove / read ANY block by id (e.g. plugin A edits plugin B's
 * block). The block store lives in the orchestrator; these ops delegate to it.
 */
import type { EventBus, ActionBus, Unsub } from "../event-system";
import type { ContextBlock } from "../context";
import type { CommunicatorLibrary } from "../llm";

export interface PluginManifest {
  id: string;
  version: string;
  /**
   * What this plugin needs, verified by the loader: an entry containing a dot is
   * an ACTION name (must be registered on the actionbus by that plugin's setup
   * time); any other entry must match a plugin id or a `provides` capability of a
   * plugin in the same load set.
   */
  requires?: string[];
  /** Capability names this plugin provides; another plugin's `requires` may name them. */
  provides?: string[];
  configSchema?: unknown;
}

/** Everything a plugin is handed at setup. Scoped to exactly one Agent. */
export interface PluginContext {
  readonly agentId: string;
  readonly events: EventBus;
  readonly actions: ActionBus;
  /** This plugin's config slice (from AgentDefinition.config[pluginId]). */
  readonly config: unknown;
  /**
   * This plugin's data directory — where it persists files/DB. Follows the
   * plugin's code location: a PUBLIC plugin's dataDir is shared across agents
   * (shared knowledge); a PRIVATE/independent plugin's dataDir is agent-isolated.
   */
  readonly dataDir: string;
  /**
   * KEY-LESS access to the global LLM communicator library. A plugin picks a
   * communicator by name and calls it; API keys and the request wire-format live
   * in the gateway and are NEVER exposed here. This is how plugins talk to LLMs
   * and flexibly switch between them. (See contracts/llm.)
   */
  readonly llm: CommunicatorLibrary;

  // ---- context block ops (BY ID; may touch any plugin's block) ----
  /** Add or replace (by id) a context block. */
  setBlock(block: ContextBlock): void;
  getBlock(id: string): ContextBlock | undefined;
  removeBlock(id: string): boolean;
  listBlocks(): Array<{ id: string; priority: number }>;

  // ---- console output (v1.1 — was `log(msg): void`) ----
  /**
   * DIAGNOSTIC logger, tagged with this plugin's id. Every line goes to the
   * host console AND is pushed on this Agent's own bus as a `log.entry` event
   * (shared/actions Events.LOG) so channel plugins can mirror it.
   */
  readonly log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  /**
   * The plugin's clean USER-FACING console line — delivered verbatim, never
   * wrapped in level/diagnostic prefixes. Called during `setup` it is the
   * plugin's STARTING MESSAGE: it lands in the startup report of whichever
   * console ran the program. Also pushed as a `log.entry` with level "print".
   */
  print(text: string): void;
}

export interface Plugin {
  manifest: PluginManifest;
  /** Register actions/listeners/context blocks. Called once by the loader. */
  setup(ctx: PluginContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

/**
 * What a plugin module DEFAULT-EXPORTS: a factory the loader calls ONCE PER
 * AGENT. ESM caches the module (code is shared), but every Agent gets its own
 * Plugin instance from this call — so keep ALL mutable state inside the
 * factory's closure (R6: instances never share live state) and keep the
 * factory itself side-effect free (construction is not setup).
 */
export type PluginFactory = () => Plugin;
