/**
 * Plugin: retry — accelerate the next frame when the LLM round-trip fails.
 *
 * Listens to `llm.return`. On a failed Reply (ok === false) it shortens the
 * clock interval (optionally with exponential backoff) so the agent wakes sooner
 * and tries again; a success (ok === true) resets the failure streak. It never
 * registers tools/context blocks, never composes a prompt, and never owns the
 * clock — every clock call is guarded by ctx.actions.has(...). The orchestrator
 * registers the clock actions at runtime, so the manifest declares no `requires`.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Reply } from "../../shared/actions";
import type { LLMResponse } from "../../contracts/llm";
import type { Unsub } from "../../contracts/event-system";
import { Events, Actions } from "../../shared/actions";
import { RETRY_SCHEMA } from "./config-schema";

const factory: PluginFactory = (): Plugin => {
  // All mutable state lives in this closure (R6) — never module scope.
  let consecutiveFailures = 0;
  let unsubs: Unsub[] = [];
  let ctx: PluginContext | undefined;

  return {
    manifest: {
      id: "retry",
      version: "0.1.0",
      configSchema: RETRY_SCHEMA,
    },

    setup(c: PluginContext): void {
      ctx = c;

      // Resolve config defensively from the plugin's slice, falling back to defaults.
      const cfg = (ctx.config ?? {}) as Record<string, unknown>;
      const retryIntervalMs =
        typeof cfg.retryIntervalMs === "number" ? cfg.retryIntervalMs : 15000;
      const backoff = typeof cfg.backoff === "boolean" ? cfg.backoff : false;
      const maxRetryIntervalMs =
        typeof cfg.maxRetryIntervalMs === "number" ? cfg.maxRetryIntervalMs : 120000;
      const maxConsecutiveRetries =
        typeof cfg.maxConsecutiveRetries === "number" ? cfg.maxConsecutiveRetries : 0;
      const logRetries = typeof cfg.logRetries === "boolean" ? cfg.logRetries : true;

      const unsub = ctx.events.on(Events.LLM_RETURN, (payload) => {
        if (!payload || typeof payload !== "object") return;
        const ok = (payload as Reply<LLMResponse>).ok;
        if (ok === false) {
          consecutiveFailures++;
          if (maxConsecutiveRetries > 0 && consecutiveFailures > maxConsecutiveRetries) return;
          const ms = backoff
            ? Math.min(maxRetryIntervalMs, retryIntervalMs * 2 ** (consecutiveFailures - 1))
            : retryIntervalMs;
          if (ctx!.actions.has(Actions.CLOCK_SET_INTERVAL)) {
            ctx!.actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms }).catch(() => {});
          }
          if (logRetries) {
            ctx!.log.info(
              `retry: LLM round-trip failed — waking in ${ms}ms (failure #${consecutiveFailures})`,
            );
          }
        } else if (ok === true) {
          consecutiveFailures = 0;
        }
      });
      unsubs.push(unsub);

      ctx.print("retry: ready — will accelerate the next frame after a failed LLM round-trip");
    },

    teardown(): void {
      for (const unsub of unsubs) unsub();
      unsubs = [];
      consecutiveFailures = 0;
    },
  };
};

export default factory;
