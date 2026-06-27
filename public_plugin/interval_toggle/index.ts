/**
 * Plugin: interval_toggle — lets a Krakey Agent pace ITSELF.
 *
 * Two tools, registered with the LLM:
 *   - interval.set  { intervalMs }          — change the stable frame rate (persists).
 *   - interval.hold { intervalMs, frames }  — run at intervalMs for the next `frames`
 *                                             frames, then auto-revert to the base.
 *
 * Both drive the per-Agent clock over the action bus (clock.set_interval /
 * clock.set_default_interval, payload { ms }). A hold counts down on each
 * `clock.tick`; the revert uses set_default_interval (which the clock re-reads on
 * every activation — set_interval would be clobbered by the per-frame reset). All
 * mutable state lives in the factory closure (R6); the plugin imports only the
 * plugin/llm contracts and the shared action vocabulary (R2).
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { ToolDef } from "../../contracts/llm";
import { Actions, Events } from "../../shared/actions";
import { INTERVAL_TOGGLE_SCHEMA } from "./config-schema";

const DEFAULT_BASE_MS = 900000;

const SET_TOOL: ToolDef = {
  name: "interval.set",
  description:
    "Set your OWN stable frame rate — how often you wake unprompted. Takes effect immediately and " +
    "stays until you change it again. Shorten it while actively working a task; lengthen it when idle. " +
    "intervalMs is in milliseconds (10000 = 10s, 900000 = 15min).",
  parameters: {
    type: "object",
    properties: { intervalMs: { type: "number", description: "New frame-rate interval in milliseconds (must be > 0)." } },
    required: ["intervalMs"],
  },
};

const HOLD_TOOL: ToolDef = {
  name: "interval.hold",
  description:
    "Temporarily change your frame rate for the NEXT `frames` frames, then automatically revert to your " +
    "base interval. Use it to wait: e.g. hold 28800000 (8h) for 2 frames to pause for the user, or hold " +
    "10000 (10s) for 5 frames to work quickly then settle back. intervalMs is in milliseconds.",
  parameters: {
    type: "object",
    properties: {
      intervalMs: { type: "number", description: "Interval to hold, in milliseconds (> 0)." },
      frames: { type: "number", description: "How many frames to hold it for (>= 1). Default 1." },
    },
    required: ["intervalMs"],
  },
};

const createIntervalToggle: PluginFactory = (): Plugin => {
  let baseMs = DEFAULT_BASE_MS;
  let remaining = 0;
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "interval_toggle", version: "0.1.0", requires: ["llm.register_tool"], configSchema: INTERVAL_TOGGLE_SCHEMA },

    async setup(ctx: PluginContext): Promise<void> {
      const cfg = (ctx.config ?? {}) as {
        baseIntervalMs?: unknown;
        guidance?: unknown;
        guidancePriority?: unknown;
      };
      if (typeof cfg.baseIntervalMs === "number" && cfg.baseIntervalMs > 0) baseMs = Math.floor(cfg.baseIntervalMs);

      const setDefault = async (ms: number): Promise<void> => {
        if (ctx.actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL)) {
          await ctx.actions.invoke(Actions.CLOCK_SET_DEFAULT_INTERVAL, { ms });
        }
      };
      const setCurrent = async (ms: number): Promise<void> => {
        if (ctx.actions.has(Actions.CLOCK_SET_INTERVAL)) {
          await ctx.actions.invoke(Actions.CLOCK_SET_INTERVAL, { ms });
        }
      };
      const readMs = (params: unknown): number => {
        const o = (params ?? {}) as { intervalMs?: unknown };
        const ms = typeof o.intervalMs === "number" ? o.intervalMs : NaN;
        if (!Number.isFinite(ms) || ms <= 0) throw new Error("interval: intervalMs must be a number > 0");
        return Math.floor(ms);
      };

      // interval.set — stable change (becomes the new base + applies now).
      const offSet = ctx.actions.register("interval.set", async (params: unknown) => {
        const ms = readMs(params);
        baseMs = ms;
        remaining = 0;
        await setDefault(ms);
        await setCurrent(ms);
        return { ok: true, intervalMs: ms, mode: "stable" };
      });

      // interval.hold — run at `ms` for `frames` frames, then revert to baseMs.
      const offHold = ctx.actions.register("interval.hold", async (params: unknown) => {
        const ms = readMs(params);
        const o = (params ?? {}) as { frames?: unknown };
        const frames = typeof o.frames === "number" && o.frames >= 1 ? Math.floor(o.frames) : 1;
        remaining = frames;
        await setDefault(ms);
        await setCurrent(ms);
        return { ok: true, intervalMs: ms, frames, revertsToMs: baseMs };
      });

      // Count a hold down on each frame; revert the rhythm when it elapses. Uses
      // set_default_interval so the clock's per-activation reset adopts baseMs.
      const offTick = ctx.events.on(Events.CLOCK_TICK, () => {
        if (remaining <= 0) return;
        remaining -= 1;
        if (remaining <= 0 && ctx.actions.has(Actions.CLOCK_SET_DEFAULT_INTERVAL)) {
          ctx.actions.invoke(Actions.CLOCK_SET_DEFAULT_INTERVAL, { ms: baseMs }).catch(() => {});
        }
      });

      // Guidance (system block).
      const guidanceText =
        typeof cfg.guidance === "string"
          ? cfg.guidance
          : "<interval.guidance> You control your own frame rate. Call interval.set to change your stable " +
            "wake interval (shorten it while actively working a task, lengthen it when idle). Call " +
            "interval.hold to change it for just the next N frames and then auto-revert (e.g. hold a long " +
            "interval to wait for the user, or a short one to work quickly). Intervals are in milliseconds. </interval.guidance>";
      const priority = typeof cfg.guidancePriority === "number" ? cfg.guidancePriority : 6000;
      ctx.setBlock({ id: "interval.guidance", target: "system", priority, render: () => guidanceText });

      // Declare the tools to the LLM (best-effort).
      for (const tool of [SET_TOOL, HOLD_TOOL]) {
        try {
          await ctx.actions.invoke("llm.register_tool", tool);
        } catch (err) {
          ctx.log.warn("interval_toggle: failed to register " + tool.name + ": " + String(err));
        }
      }

      unsubs = [offSet, offHold, offTick, () => ctx.removeBlock("interval.guidance")];
      ctx.print("interval-toggle: self-pacing tools ready");
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
      remaining = 0;
    },
  };
};

export default createIntervalToggle;
