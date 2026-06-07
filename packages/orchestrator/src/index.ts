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
import { Events } from "../../../shared/actions";
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
  let seq = 0; // beat counter
  const log = tagged(deps.log ?? consoleLogger, "[orchestrator]");

  // ---- context composition ----
  async function compose(): Promise<ComposedContext> {
    // Sort by priority DESC; JS sort is stable, so equal priorities keep
    // insertion order. Empty buffer → { text: "" }.
    const sorted = [...blocks.values()].sort((a, b) => b.priority - a.priority);
    const parts = await Promise.all(sorted.map((b) => b.render()));
    return { text: parts.join("\n") };
  }

  // ---- the beat ----
  async function runBeat(): Promise<void> {
    try {
      const n = ++seq;
      // Let plugins refresh their blocks synchronously before we compose.
      const gather: Notify<{ seq: number }> = { at: Date.now(), data: { seq: n } };
      deps.events.events.emit(Events.PROMPT_GATHER, gather);

      const context = await compose();

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
      if (beatQueued) {
        beatQueued = false;
        setImmediate(() => {
          beatBusy = true;
          runBeat();
        });
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
    const p = payload as Reply<LLMResponse>;
    if (!p.ok || !p.data) return;
    const calls = p.data.toolCalls;
    if (!calls || calls.length === 0) return;
    for (const tc of calls) {
      // Fire-and-forget: each .catch is independent, so one failing tool does
      // not affect the others and does not abort the beat.
      deps.events.actions
        .invoke(tc.name, tc.arguments)
        .catch((err) => log.warn(`tool dispatch failed: ${tc.name}: ${err}`));
    }
  }

  return {
    start(): void {
      if (running) return; // idempotent
      running = true;
      tickUnsub = deps.events.events.on(Events.CLOCK_TICK, () => onTick());
      returnUnsub = deps.events.events.on(Events.LLM_RETURN, (p) => onReturn(p));
    },

    stop(): void {
      if (!running) return; // idempotent
      running = false;
      tickUnsub?.();
      tickUnsub = null;
      returnUnsub?.();
      returnUnsub = null;
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
