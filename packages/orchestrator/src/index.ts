/**
 * orchestrator — the per-Agent conductor. The context-buffer lives INSIDE it.
 *
 * It imports NO concrete node, only the injected `events`/`clock` and contract
 * TYPES. It holds NO LLM behavior — and, by design, makes NO decision about WHEN to
 * send. Each frame it emits a body-less TRIGGER; it composes the prompt only when
 * ASKED; and it dispatches the tool calls that come back.
 *
 * Frame (driven by clock ticks bridged onto the eventbus as CLOCK_TICK):
 *   tick / immediate wake → emit LLM_REQUEST { agentId }   ← a trigger, no body
 *
 * The round-trip plugin (llm-core) owns serialization: it keeps at most one request
 * in flight PER agentId, coalesces triggers that arrive while a request is busy, and
 * — right before it actually sends — pulls a freshly-composed body via the
 * PROMPT_COMPOSE action:
 *   prompt.compose → emit PROMPT_GATHER (plugins refresh blocks) → compose → { context, messages }
 * Composing on demand means the body always reflects the latest blocks (a message
 * that arrived while a previous request was in flight is folded into the next send),
 * and the orchestrator never has to track or guard the LLM round-trip itself.
 *
 * `compose` splits the buffer by target: system blocks → system-prompt text
 * (priority DESC, each wrapped `<label>…</label>`), message blocks → the messages
 * array (groups concatenated priority DESC, order within a group kept; the
 * conversation is one such block). Tool calls from LLM_RETURN are dispatched on the
 * actionbus fire-and-forget, each settling into a TOOL_RESULT.
 */
import type { Orchestrator } from "../../../contracts/orchestrator";
import type { EventSystem, Unsub } from "../../../contracts/event-system";
import type { Clock } from "../../../contracts/clock";
import type { ContextBlock, ComposedContext } from "../../../contracts/context";
import type { LLMResponse, Message } from "../../../contracts/llm";
import { Actions, Events } from "../../../shared/actions";
import type { Notify, Reply } from "../../../shared/actions";
import { consoleLogger, tagged } from "../../../shared/logging";
import type { Logger } from "../../../shared/logging";

export function createOrchestrator(deps: {
  /** This Agent's id — stamped on the per-frame trigger as the llm-core lock key. */
  agentId: string;
  events: EventSystem;
  clock: Clock;
  log?: Logger;
}): Orchestrator {
  // ---- internal state ----
  const blocks = new Map<string, ContextBlock>(); // the context-buffer
  let running = false;
  let seq = 0; // frame counter (PROMPT_GATHER seq), bumped on each compose
  let tickUnsub: Unsub | null = null;
  let returnUnsub: Unsub | null = null;
  let actionUnsubs: Unsub[] = []; // CLOCK_* + PROMPT_COMPOSE registrations (while started)
  const log = tagged(deps.log ?? consoleLogger, "[orchestrator]");

  // ---- context composition ----
  // Split the buffer by TARGET and compose BOTH halves of the frame's request:
  //  • system blocks (target unset/"system"): priority DESC, each rendered to a string
  //    and wrapped `<label>…</label>` (label = block.label ?? block.id), joined by a
  //    blank line → the system prompt text;
  //  • message blocks (target "messages"): each renders a Message[] GROUP; the blocks
  //    are ordered priority DESC and their groups CONCATENATED (order WITHIN a group
  //    preserved) → the messages array. The conversation (history) is one such block.
  // Sort is stable, so equal priorities keep insertion order. Every block renders in
  // ISOLATION: a render that throws/rejects (or yields the wrong shape — a non-string
  // system render, a non-array message render) contributes nothing — never dropping the
  // other blocks or the frame.
  async function compose(): Promise<{ context: ComposedContext; messages: Message[] }> {
    const all = [...blocks.values()];
    const byPriority = (a: ContextBlock, b: ContextBlock): number => b.priority - a.priority;

    const sysParts = await Promise.all(
      all
        .filter((b) => (b.target ?? "system") === "system")
        .sort(byPriority)
        .map(async (b) => {
          let rendered: string | Message[];
          try {
            rendered = await b.render();
          } catch (err) {
            log.warn(`block render failed: ${b.id}: ${err}`);
            return "";
          }
          const text = typeof rendered === "string" ? rendered : "";
          if (text === "") return "";
          const label = b.label ?? b.id;
          return `<${label}>\n${text}\n</${label}>`;
        }),
    );

    const groups = await Promise.all(
      all
        .filter((b) => b.target === "messages")
        .sort(byPriority)
        .map(async (b): Promise<Message[]> => {
          let rendered: string | Message[];
          try {
            rendered = await b.render();
          } catch (err) {
            log.warn(`block render failed: ${b.id}: ${err}`);
            return [];
          }
          return Array.isArray(rendered) ? rendered : [];
        }),
    );

    return {
      context: { text: sysParts.filter((p) => p !== "").join("\n\n") },
      messages: groups.flat(),
    };
  }

  // ---- the frame ----
  /** A tick (or immediate wake) just signals "think now" — a body-less trigger
   *  stamped with this Agent's id. llm-core serializes per agentId and pulls the
   *  body via PROMPT_COMPOSE when it is ready to send. */
  function onTick(): void {
    if (!running) return;
    const trigger: Notify<{ agentId: string }> = {
      at: Date.now(),
      data: { agentId: deps.agentId },
    };
    deps.events.events.emit(Events.LLM_REQUEST, trigger);
  }

  /** Gather + compose the current prompt ON DEMAND — the PROMPT_COMPOSE action.
   *  Emits PROMPT_GATHER so plugins refresh their blocks, then composes. */
  async function composeNow(): Promise<{ context: ComposedContext; messages: Message[] }> {
    const n = ++seq;
    const gather: Notify<{ seq: number }> = { at: Date.now(), data: { seq: n } };
    deps.events.events.emit(Events.PROMPT_GATHER, gather);
    return compose();
  }

  function onReturn(payload: unknown): void {
    // Guard a malformed payload: null/undefined or non-object → ignore (no throw).
    if (payload === null || typeof payload !== "object") return;
    const p = payload as Reply<LLMResponse>;
    if (!p.ok || !p.data) return;
    const calls = p.data.toolCalls;
    if (!calls || calls.length === 0) return;
    for (const tc of calls) {
      // Fire-and-forget: each then/catch is independent, so one failing tool does
      // not affect the others. As each settles, emit TOOL_RESULT (id = the ToolCall
      // id, name = the action name) so plugins can fold the outcome into the next frame.
      deps.events.actions
        .invoke(tc.name, tc.arguments)
        .then((data) => {
          const result: Reply<unknown> & { name: string } = {
            id: tc.id,
            at: Date.now(),
            ok: true,
            data,
            name: tc.name,
          };
          deps.events.events.emit(Events.TOOL_RESULT, result);
        })
        .catch((err) => {
          log.warn(`tool dispatch failed: ${tc.name}: ${err}`);
          const result: Reply<unknown> & { name: string } = {
            id: tc.id,
            at: Date.now(),
            ok: false,
            error: String(err),
            name: tc.name,
          };
          deps.events.events.emit(Events.TOOL_RESULT, result);
        });
    }
  }

  // ---- actions registered while started ----
  // Validate { ms: number } for the clock setters: a missing/non-object params or a
  // non-finite/non-positive ms REJECTS without touching the clock.
  function readMs(params: unknown): number {
    if (params === null || typeof params !== "object") {
      throw new Error("expected params { ms: number }");
    }
    const ms = (params as { ms?: unknown }).ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
      throw new Error(`invalid ms: ${String(ms)}`);
    }
    return ms;
  }

  function registerActions(): void {
    actionUnsubs = [
      deps.events.actions.register(Actions.CLOCK_SET_INTERVAL, async (params) => {
        deps.clock.setInterval(readMs(params));
      }),
      deps.events.actions.register(Actions.CLOCK_SET_DEFAULT_INTERVAL, async (params) => {
        deps.clock.setDefaultInterval(readMs(params));
      }),
      deps.events.actions.register(Actions.CLOCK_FIRE_NOW, async () => {
        deps.clock.fireNow();
      }),
      // Compose-on-demand: the round-trip plugin calls this right before it sends.
      deps.events.actions.register(Actions.PROMPT_COMPOSE, async () => composeNow()),
    ];
  }

  return {
    start(): void {
      if (running) return; // idempotent
      running = true;
      tickUnsub = deps.events.events.on(Events.CLOCK_TICK, () => onTick());
      returnUnsub = deps.events.events.on(Events.LLM_RETURN, (p) => onReturn(p));
      registerActions();
    },

    stop(): void {
      if (!running) return; // idempotent
      running = false;
      tickUnsub?.();
      tickUnsub = null;
      returnUnsub?.();
      returnUnsub = null;
      for (const unsub of actionUnsubs) unsub();
      actionUnsubs = [];
    },

    // ---- context-block store (the "context-buffer") ----
    setBlock(block: ContextBlock): void {
      blocks.set(block.id, block);
    },

    getBlock(id: string): ContextBlock | undefined {
      return blocks.get(id);
    },

    removeBlock(id: string): boolean {
      const had = blocks.has(id);
      blocks.delete(id);
      return had;
    },

    listBlocks(): Array<{ id: string; priority: number }> {
      return [...blocks.values()].map((b) => ({ id: b.id, priority: b.priority }));
    },
  };
}
