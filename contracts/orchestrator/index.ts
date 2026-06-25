/**
 * Contract: orchestrator  ·  connects: orchestrator (impl) ↔ agent_instance, loader
 *
 * The per-Agent conductor. The context-buffer lives INSIDE it. Responsibilities:
 *  1. compose the beat from its blocks by `priority` (DESC): system-target blocks →
 *     the system prompt text; message-target blocks → the messages array (groups);
 *  2. expose the eventbus (via event-system) so plugins add/modify/remove blocks;
 *  3. execute LLM-parsed tool calls async/non-blocking (via the actionbus);
 *  4. maintain the actionbus for plugin invocation;
 *  5. coordinate clock rhythm: while started, it registers the well-known clock
 *     actions (`clock.set_interval` / `clock.set_default_interval` /
 *     `clock.fire_now` — see shared/actions Actions.CLOCK_*) on the actionbus so
 *     plugins can adjust the rhythm; they are unregistered on stop().
 *  6. compose the prompt ON DEMAND: while started, it registers `prompt.compose`
 *     (Actions.PROMPT_COMPOSE) on the actionbus — gather → compose → resolve
 *     `{ context, messages }`; unregistered on stop().
 *
 * Beat (EVENT-driven, fire-and-forget): a clock tick (a `clock.tick` event) makes the
 * orchestrator emit `llm.request` as a body-less TRIGGER (Notify<{agentId}>) WITHOUT
 * awaiting — the beat ends at the emit. It does NOT decide when to send or guard the
 * round-trip: the round-trip plugin (llm-core) owns serialization — at most one request
 * in flight PER agentId, coalescing triggers that arrive while busy — and, right before
 * it sends, invokes `prompt.compose` to pull a freshly-gathered body. compose splits the
 * block buffer by `target`: "system" blocks form the system prompt text (priority DESC,
 * wrapped `<label>`); "messages" blocks each render a `Message[]` GROUP, concatenated by
 * priority DESC (order within a group preserved) into `messages` — the conversation
 * (`history`) is one such block. The orchestrator never inspects message content. The LLM
 * round-trip returns later as an `llm.return` event (Reply<LLMResponse>) whose tool calls
 * are dispatched fire-and-forget on the actionbus. As EACH dispatched call settles, a
 * `tool.result` event is emitted (Reply: id = the ToolCall id, name = the action name;
 * ok+data on success, ok:false+error on rejection) so plugins can fold tool outcomes into
 * the next beat's context.
 *
 * Degradation: compose renders each block in ISOLATION — a block whose render()
 * throws/rejects degrades to empty text for that beat (logged); it never drops
 * the other blocks or the beat. After stop(), no further beat work runs — the tick
 * subscription and registered actions are torn down.
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
