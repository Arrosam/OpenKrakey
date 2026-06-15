/**
 * orchestrator — the per-Agent conductor. The context-buffer lives INSIDE it.
 *
 * It imports NO concrete node, only the injected `events`/`clock` and contract
 * TYPES. It holds NO LLM behavior (no prompt building, no provider calls): it
 * only emits/handles generic lifecycle events and dispatches tool actions by
 * name on the actionbus.
 *
 * Beat (driven by clock ticks bridged onto the eventbus as CLOCK_TICK):
 *   tick → PROMPT_GATHER (plugins refresh blocks) → compose → LLM_REQUEST.
 * The beat ends at the emit — the LLM round-trip returns later as LLM_RETURN,
 * whose tool calls are dispatched fire-and-forget on the actionbus.
 */
import type { Orchestrator } from "../../../contracts/orchestrator";
import type { EventSystem, Unsub } from "../../../contracts/event-system";
import type { Clock } from "../../../contracts/clock";
import type { ContextBlock, ComposedContext } from "../../../contracts/context";
import type { LLMResponse } from "../../../contracts/llm";
import { Actions, Events } from "../../../shared/actions";
import type { Notify, Request, Reply } from "../../../shared/actions";
import { consoleLogger, tagged } from "../../../shared/logging";
import type { Logger } from "../../../shared/logging";

export function createOrchestrator(deps: {
  events: EventSystem;
  clock: Clock;
  log?: Logger;
}): Orchestrator {
  // ---- internal state ----
  const blocks = new Map<string, ContextBlock>(); // the context-buffer
  let running = false;
  let beatBusy = false;
  let beatQueued = false;
  let tickUnsub: Unsub | null = null;
  let returnUnsub: Unsub | null = null;
  let clockUnsubs: Unsub[] = []; // CLOCK_* action registrations (while started)
  let seq = 0; // beat counter
  const log = tagged(deps.log ?? consoleLogger, "[orchestrator]");

  // ---- context composition ----
  async function compose(): Promise<ComposedContext> {
    // Sort by priority DESC; JS sort is stable, so equal priorities keep
    // insertion order. Empty buffer → { text: "" }.
    const sorted = [...blocks.values()].sort((a, b) => b.priority - a.priority);
    // Render every block in ISOLATION: a block whose render() throws or rejects
    // degrades to "" for this beat (logged); it never drops the others or the beat.
    // ENCAPSULATE each non-empty block in its label — `<label>…</label>`, where
    // label = block.label ?? block.id — so every plugin's contribution is a bounded,
    // labelled block. Empty/failed blocks contribute nothing; blocks join by a blank line.
    const parts = await Promise.all(
      sorted.map(async (b) => {
        let text: string;
        try {
          text = await b.render();
        } catch (err) {
          log.warn(`block render failed: ${b.id}: ${err}`);
          text = "";
        }
        if (text === "") return "";
        const label = b.label ?? b.id;
        return `<${label}>\n${text}\n</${label}>`;
      }),
    );
    return { text: parts.filter((p) => p !== "").join("\n\n") };
  }

  // ---- the beat ----
  async function runBeat(): Promise<void> {
    // After stop() no beat work runs — emit nothing, even for a queued beat.
    if (!running) {
      beatBusy = false;
      beatQueued = false;
      return;
    }
    try {
      const n = ++seq;
      // Let plugins refresh their blocks synchronously before we compose.
      const gather: Notify<{ seq: number }> = { at: Date.now(), data: { seq: n } };
      deps.events.events.emit(Events.PROMPT_GATHER, gather);

      const context = await compose();
      // compose() is async; if we were stopped mid-flight, emit nothing further.
      if (!running) return;

      // Request the LLM round-trip; do NOT await — the beat ends here. The reply
      // arrives later as LLM_RETURN. In Phase 0 nobody listens and that is fine.
      const payload: Request<{ context: ComposedContext }> = {
        id: String(n),
        at: Date.now(),
        data: { context },
      };
      deps.events.events.emit(Events.LLM_REQUEST, payload);
    } catch (err) {
      log.warn(`beat failed: ${err}`);
    } finally {
      beatBusy = false;
      // Only spin up a queued beat if still running; the re-entry also guards
      // !running, so a stop() between scheduling and execution emits nothing.
      if (beatQueued && running) {
        beatQueued = false;
        setImmediate(() => {
          if (!running) return;
          beatBusy = true;
          runBeat();
        });
      } else {
        beatQueued = false;
      }
    }
  }

  function onTick(): void {
    // At most one beat in flight and at most one queued.
    if (beatBusy) {
      beatQueued = true;
      return;
    }
    beatBusy = true;
    runBeat();
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
      // not affect the others and does not abort the beat. As each settles, emit
      // TOOL_RESULT (id = the ToolCall id, name = the action name) so plugins can
      // fold the outcome into the next beat's context.
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

  // ---- clock-rhythm actions (registered while started) ----
  // Validate { ms: number } for the setters: a missing/non-object params or a
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

  function registerClockActions(): void {
    clockUnsubs = [
      deps.events.actions.register(Actions.CLOCK_SET_INTERVAL, async (params) => {
        deps.clock.setInterval(readMs(params));
      }),
      deps.events.actions.register(Actions.CLOCK_SET_DEFAULT_INTERVAL, async (params) => {
        deps.clock.setDefaultInterval(readMs(params));
      }),
      deps.events.actions.register(Actions.CLOCK_FIRE_NOW, async () => {
        deps.clock.fireNow();
      }),
    ];
  }

  return {
    start(): void {
      if (running) return; // idempotent
      running = true;
      tickUnsub = deps.events.events.on(Events.CLOCK_TICK, () => onTick());
      returnUnsub = deps.events.events.on(Events.LLM_RETURN, (p) => onReturn(p));
      registerClockActions();
    },

    stop(): void {
      if (!running) return; // idempotent
      running = false;
      beatQueued = false; // drop any beat queued behind an in-flight one
      tickUnsub?.();
      tickUnsub = null;
      returnUnsub?.();
      returnUnsub = null;
      for (const unsub of clockUnsubs) unsub();
      clockUnsubs = [];
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
