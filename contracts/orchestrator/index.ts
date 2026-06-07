/**
 * Contract: orchestrator  ·  connects: orchestrator (impl) ↔ agent_instance, loader
 *
 * The per-Agent conductor. The context-buffer lives INSIDE it. Responsibilities:
 *  1. compose the full context from its blocks by `priority` (DESC, high on top);
 *  2. expose the eventbus (via event-system) so plugins add/modify/remove blocks;
 *  3. execute LLM-parsed tool calls async/non-blocking (via the actionbus);
 *  4. maintain the actionbus for plugin invocation;
 *  5. coordinate clock rhythm.
 * Beat: clock tick → compose → invoke `llm.chat` → parse → dispatch.
 *
 * `agent_instance` uses start/stop; `loader` wires PluginContext's block ops to
 * the block-store methods below.
 */
import type { ContextBlock } from "../context";

export interface Orchestrator {
  /** Begin conducting (subscribe to clock tick, run beats). */
  start(): void;
  stop(): void;

  // ---- context-block store (the "context-buffer") ----
  setBlock(block: ContextBlock): void;
  getBlock(id: string): ContextBlock | undefined;
  removeBlock(id: string): boolean;
  listBlocks(): Array<{ id: string; priority: number }>;
}
