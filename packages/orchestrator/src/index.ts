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
 * A beat stays IN FLIGHT from the moment it starts composing until its LLM
 * round-trip returns as LLM_RETURN (whose tool calls are dispatched
 * fire-and-forget). The clock keeps ticking on its own rhythm regardless, so when
 * the interval is shorter than the model's response time — or a burst of
 * immediate wakes (CLOCK_FIRE_NOW on a tool result / new message) stacks up — a
 * tick can arrive while a request is still pending. Rather than fire a SECOND,
 * overlapping LLM_REQUEST, the orchestrator pauses: it records a single coalesced
 * follow-up (`beatQueued`) and runs exactly one fresh beat once the in-flight
 * request returns (or a safety timeout elapses). Because the follow-up re-gathers
 * and re-composes, it sends an UPDATED request reflecting whatever changed while
 * we waited. A safety timeout guards the only no-return cases (no llm-core loaded,
 * or a hung provider) so the guard can never permanently wedge the agent.
 */
import type { Orchestrator } from "../../../contracts/orchestrator";
import type { EventSystem, Unsub } from "../../../contracts/event-system";
import type { Clock } from "../../../contracts/clock";
import type { ContextBlock, ComposedContext } from "../../../contracts/context";
import type { LLMResponse, Message } from "../../../contracts/llm";
import { Actions, Events } from "../../../shared/actions";
import type { Notify, Request, Reply } from "../../../shared/actions";
import { consoleLogger, tagged } from "../../../shared/logging";
import type { Logger } from "../../../shared/logging";

/** Safety net: if an LLM_REQUEST never returns (no llm-core, or a hung provider),
 *  release the in-flight guard after this long so the agent never wedges. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function createOrchestrator(deps: {
  events: EventSystem;
  clock: Clock;
  log?: Logger;
  /** Override the in-flight safety timeout (ms). Defaults to 120s. */
  requestTimeoutMs?: number;
}): Orchestrator {
  // ---- internal state ----
  const blocks = new Map<string, ContextBlock>(); // the context-buffer
  let running = false;
  // A beat is "busy" from the moment it starts composing (`composing`) through to
  // its LLM round-trip returning (`awaitingReturn`). Ticks/immediate-fires that
  // arrive while busy do NOT start a concurrent beat — they set `beatQueued`, and
  // ONE coalesced follow-up runs once the in-flight request returns (or times out).
  let composing = false; // synchronous compose phase of a beat
  let awaitingReturn = false; // LLM_REQUEST emitted, waiting for its matching LLM_RETURN
  let inFlightId: string | null = null; // id of the awaited request (returns matched by id)
  let beatQueued = false; // at most one coalesced follow-up
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  let tickUnsub: Unsub | null = null;
  let returnUnsub: Unsub | null = null;
  let clockUnsubs: Unsub[] = []; // CLOCK_* action registrations (while started)
  let seq = 0; // beat counter
  const requestTimeoutMs =
    typeof deps.requestTimeoutMs === "number" && deps.requestTimeoutMs > 0
      ? deps.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const log = tagged(deps.log ?? consoleLogger, "[orchestrator]");

  /** True while a beat is composing OR its LLM round-trip is still pending. */
  function busy(): boolean {
    return composing || awaitingReturn;
  }

  function clearSafetyTimer(): void {
    if (safetyTimer !== null) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  }

  // ---- context composition ----
  // Split the buffer by TARGET and compose BOTH halves of the beat's request:
  //  • system blocks (target unset/"system"): priority DESC, each rendered to a string
  //    and wrapped `<label>…</label>` (label = block.label ?? block.id), joined by a
  //    blank line → the system prompt text;
  //  • message blocks (target "messages"): each renders a Message[] GROUP; the blocks
  //    are ordered priority DESC and their groups CONCATENATED (order WITHIN a group
  //    preserved) → the messages array. The conversation (history) is one such block.
  // Sort is stable, so equal priorities keep insertion order. Every block renders in
  // ISOLATION: a render that throws/rejects (or yields the wrong shape — a non-string
  // system render, a non-array message render) contributes nothing — never dropping the
  // other blocks or the beat.
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

  // ---- the beat ----
  /** Arm the safety net for the request we're currently awaiting (`inFlightId`). */
  function armSafetyTimer(): void {
    clearSafetyTimer();
    const awaited = inFlightId;
    safetyTimer = setTimeout(() => {
      safetyTimer = null;
      // Only act if we're still awaiting the SAME request (not already released).
      if (!running || !awaitingReturn || inFlightId !== awaited) return;
      log.warn(
        `LLM request ${awaited} did not return within ${requestTimeoutMs}ms — releasing the beat guard`,
      );
      releaseInFlight();
    }, requestTimeoutMs);
    // The safety net must never keep the process alive on its own.
    (safetyTimer as { unref?: () => void }).unref?.();
  }

  // The beat fully finished (compose failed, or the LLM round-trip returned / timed
  // out). If a follow-up was queued while we were busy, run exactly ONE now — a
  // fresh beat that re-gathers, so it carries the latest context.
  function drainQueue(): void {
    if (beatQueued && running) {
      beatQueued = false;
      setImmediate(() => {
        if (!running || busy()) return;
        composing = true;
        runBeat();
      });
    } else {
      beatQueued = false;
    }
  }

  /** Release the in-flight guard (on a matching LLM_RETURN or the safety timeout). */
  function releaseInFlight(): void {
    clearSafetyTimer();
    awaitingReturn = false;
    inFlightId = null;
    drainQueue();
  }

  async function runBeat(): Promise<void> {
    // After stop() no beat work runs — emit nothing, even for a queued beat.
    if (!running) {
      composing = false;
      beatQueued = false;
      return;
    }
    let emitted = false;
    try {
      const n = ++seq;
      // Let plugins refresh their blocks before we compose. A conversation provider
      // (history) contributes the conversation as a message-target block, so compose()
      // assembles BOTH the system text and the messages array from the buffer.
      const gather: Notify<{ seq: number }> = { at: Date.now(), data: { seq: n } };
      deps.events.events.emit(Events.PROMPT_GATHER, gather);

      const { context, messages } = await compose();
      // compose() is async; if we were stopped mid-flight, emit nothing further.
      if (!running) return;

      // Request the LLM round-trip; do NOT await — the beat does not BLOCK here, but
      // it stays IN FLIGHT until LLM_RETURN. Enter the in-flight window BEFORE emitting
      // so a synchronous return can be matched, not missed.
      const payload: Request<{ context: ComposedContext; messages: Message[] }> = {
        id: String(n),
        at: Date.now(),
        data: { context, messages },
      };
      awaitingReturn = true;
      inFlightId = String(n);
      armSafetyTimer();
      emitted = true;
      deps.events.events.emit(Events.LLM_REQUEST, payload);
    } catch (err) {
      log.warn(`beat failed: ${err}`);
    } finally {
      composing = false;
      // If no request went out (compose threw, or we were stopped mid-flight) there
      // will be no LLM_RETURN — the beat is done, so drain any queued follow-up now.
      // If a request DID go out we wait for its return (or the safety timeout).
      if (!emitted && !awaitingReturn) {
        drainQueue();
      }
    }
  }

  function onTick(): void {
    // While a beat is in flight (composing or awaiting its LLM return), do not start
    // a concurrent one — record a single coalesced follow-up instead.
    if (busy()) {
      beatQueued = true;
      return;
    }
    composing = true;
    runBeat();
  }

  function onReturn(payload: unknown): void {
    // Guard a malformed payload: null/undefined or non-object → ignore (no throw).
    if (payload === null || typeof payload !== "object") return;
    const p = payload as Reply<LLMResponse> & { id?: unknown };
    // Release the in-flight guard if this return matches the request we're awaiting.
    // Tool dispatch (below) is INDEPENDENT of the guard, so an unmatched/stray return
    // still dispatches its tools exactly as before.
    if (awaitingReturn && String(p.id) === inFlightId) {
      releaseInFlight();
    }
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
      composing = false;
      awaitingReturn = false; // drop the in-flight guard
      inFlightId = null;
      beatQueued = false; // drop any beat queued behind an in-flight one
      clearSafetyTimer();
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
