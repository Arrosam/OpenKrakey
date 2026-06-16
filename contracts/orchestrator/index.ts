/**
 * Contract: orchestrator  ·  connects: orchestrator (impl) ↔ agent_instance, loader
 *
 * The per-Agent conductor. The context-buffer lives INSIDE it. Responsibilities:
 *  1. compose the full context from its blocks by `priority` (DESC, high on top);
 *  2. expose the eventbus (via event-system) so plugins add/modify/remove blocks;
 *  3. execute LLM-parsed tool calls async/non-blocking (via the actionbus);
 *  4. maintain the actionbus for plugin invocation;
 *  5. coordinate clock rhythm: while started, it registers the well-known clock
 *     actions (`clock.set_interval` / `clock.set_default_interval` /
 *     `clock.fire_now` — see shared/actions Actions.CLOCK_*) on the actionbus so
 *     plugins can adjust the rhythm; they are unregistered on stop().
 *
 * Beat (EVENT-driven, fire-and-forget): clock tick (a `clock.tick` event) →
 * emit `prompt.gather` (plugins refresh blocks; a conversation provider — `history` —
 * contributes the current conversation as a `conversation.snapshot` event the
 * orchestrator captures) → compose → emit `llm.request` (Request<{context, messages}>)
 * WITHOUT awaiting — the beat ends at the emit. The orchestrator only TRANSPORTS
 * `messages` (the captured snapshot, already wire-ready); it never builds or inspects
 * them. The LLM round-trip returns later as an `llm.return` event (Reply<LLMResponse>)
 * whose tool calls are dispatched fire-and-forget on the actionbus. As EACH dispatched
 * call settles, a `tool.result` event is emitted (Reply: id = the ToolCall id,
 * name = the action name; ok+data on success, ok:false+error on rejection) so
 * plugins can fold tool outcomes into the next beat's context.
 *
 * Degradation: compose renders each block in ISOLATION — a block whose render()
 * throws/rejects degrades to empty text for that beat (logged); it never drops
 * the other blocks or the beat. After stop(), no further beat work runs: a beat
 * queued behind an in-flight one is cancelled.
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
