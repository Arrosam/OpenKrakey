/**
 * Shared: actions — the canonical bus vocabulary: well-known names + payload SHAPES.
 *
 * Division of labour (see ARCHITECTURE §3):
 *  - EventBus carries the small set of GENERIC lifecycle events below — the core
 *    emits them to ACTIVATE plugins (startup, gather prompt blocks, LLM request/
 *    return, channel I/O). Each payload specializes one of the reusable base
 *    envelopes (Notify / Request / Reply).
 *  - ActionBus carries plugin-registered, invokable operations (tool calls,
 *    channel ops) and inter-plugin calls. Those names are plugin-specific and are
 *    registered at setup, so they are NOT enumerated here.
 */
import type { LLMRequest, LLMResponse } from "../../contracts/llm";

/**
 * Well-known actions invoked on the actionbus. (LLM access is NOT an action —
 * plugins use the key-less `PluginContext.llm` library directly.)
 *
 * CLOCK_* rhythm controls are registered by the orchestrator while it is started
 * (unregistered on stop). Params: the two setters take `{ ms: number }` (positive);
 * `clock.fire_now` takes none.
 */
export const Actions = {
  CLOCK_SET_INTERVAL: "clock.set_interval",
  CLOCK_SET_DEFAULT_INTERVAL: "clock.set_default_interval",
  CLOCK_FIRE_NOW: "clock.fire_now",
  /**
   * Compose the current frame's prompt ON DEMAND. Registered by the orchestrator
   * while started; takes no params and resolves the assembled
   * `{ context: ComposedContext; messages: Message[] }`. The round-trip plugin
   * (llm-core) invokes it right before it sends, so the body always reflects the
   * latest blocks (it gathers first). Keeps the orchestrator LLM-agnostic — it
   * never decides WHEN to send; it only composes when asked.
   */
  PROMPT_COMPOSE: "prompt.compose",
  /**
   * Request a GRACEFUL restart of the whole runtime. Registered by the core
   * composition root (agent_instance, fed a `requestRestart` callback by boot)
   * while an Agent is started — present only when boot wired the callback. Params:
   * `{ delayMs?: number }`. The handler stops every Agent (running each plugin's
   * teardown, so best-effort state like the web-chat transcript is flushed) BEFORE
   * re-execing the process — unlike a raw `process.exit`, which skips teardown. The
   * `restart` plugin invokes it (guarded by `has`) instead of exiting itself, so it
   * never owns process lifecycle. Core registers it; no plugin can `provide` it.
   */
  CORE_RESTART: "core.restart",
} as const;

/** Well-known generic events emitted on the eventbus to activate plugins. */
export const Events = {
  AGENT_START: "agent.start",
  CLOCK_TICK: "clock.tick",
  PROMPT_GATHER: "prompt.gather",
  LLM_REQUEST: "llm.request",
  LLM_REQUEST_SENT: "llm.request.sent",
  LLM_RETURN: "llm.return",
  INPUT_MESSAGE: "input.message",
  OUTPUT_MESSAGE: "output.message",
  TOOL_RESULT: "tool.result",
  LOG: "log.entry",
} as const;

export type ActionName = (typeof Actions)[keyof typeof Actions];
export type EventName = (typeof Events)[keyof typeof Events];

// ---- Reusable base event envelopes ----
/** One-way notification (fire-and-forget). */
export interface Notify<T = unknown> {
  at: number;
  data: T;
}
/** Expects a matching Reply with the same `id`. */
export interface Request<T = unknown> {
  id: string;
  at: number;
  data: T;
}
/** The reply to a Request (same `id`). */
export interface Reply<T = unknown> {
  id: string;
  at: number;
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Concrete well-known event payloads. Each specializes a base envelope. Keys are
 * the `Events` string values (kept literal so this compiles as an interface).
 */
export interface EventPayloads {
  "agent.start": Notify<{ agentId: string }>;
  "clock.tick": Notify<{ seq: number }>;
  "prompt.gather": Notify<{ seq: number }>;
  /**
   * A TRIGGER: the agent wants an LLM round-trip this frame. It carries NO body —
   * the orchestrator emits one per tick/immediate-wake and stays LLM-agnostic. The
   * round-trip plugin (llm-core) owns serialization: it keeps at most one request
   * in flight PER agentId, coalesces triggers that arrive while busy, and composes
   * the body on demand via `prompt.compose` right before it sends. `agentId` is the
   * lock key.
   */
  "llm.request": Notify<{ agentId: string }>;
  /**
   * The EXACT request `llm-core` dispatches to the provider — system + messages +
   * tools + temperature/maxTokens, the assembled `LLMRequest` — surfaced so observers
   * (the inspector) can show what was actually sent. Carries the same `id` (corrId) as
   * the frame's `llm.request`. `llm-core` emits it fire-and-forget; it depends on no one
   * consuming it.
   */
  "llm.request.sent": Request<{ request: LLMRequest }>;
  "llm.return": Reply<LLMResponse>;
  "input.message": Notify<{ text: string; from?: string; channel?: string; meta?: Record<string, unknown> }>;
  "output.message": Notify<{ text: string; to?: string; channel?: string; meta?: Record<string, unknown> }>;
  /** Emitted by the orchestrator as each dispatched tool call settles (id = ToolCall id). */
  "tool.result": Reply<unknown> & { name: string };
  /**
   * A plugin console line mirrored onto the bus by the loader-built ctx:
   * ctx.log.* carries its level; ctx.print carries level "print" (the plugin's
   * clean user-facing line — during setup, its starting message).
   */
  "log.entry": Notify<{ level: "info" | "warn" | "error" | "print"; pluginId: string; text: string }>;
}

// Compile-time guard: every Events value has a payload entry and vice-versa.
type _EventsMatchPayloads = EventName extends keyof EventPayloads
  ? keyof EventPayloads extends EventName
    ? true
    : never
  : never;
const _eventsMatchPayloads: _EventsMatchPayloads = true;
void _eventsMatchPayloads;
