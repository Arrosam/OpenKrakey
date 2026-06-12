/**
 * Plugin: toolbox — the basic tool kit.
 *
 * One job: give the LLM a clock it can READ (`time.now`, this plugin's own action)
 * and two clocks it can SET. The pacing tools are pure ToolDefs whose names point at
 * the orchestrator's already-registered rhythm actions (`clock.set_interval` /
 * `clock.set_default_interval`) — so the LLM calling them IS the self-pacing loop,
 * with no glue code here. We register a handler ONLY for `time.now`; the orchestrator
 * owns the clock.* actions.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent, so
 * the Unsub lives in this closure, never in shared module scope.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { ToolDef } from "../../contracts/llm";
import type { Unsub } from "../../contracts/event-system";
import { Actions } from "../../shared/actions";

/** Shared JSON Schema for the two pacing tools: a single `ms` number. */
const MS_SCHEMA = {
  type: "object",
  properties: { ms: { type: "number" } },
  required: ["ms"],
} as const;

const createToolbox: PluginFactory = (): Plugin => {
  let unsubTimeNow: Unsub | undefined;

  return {
    manifest: { id: "toolbox", version: "0.1.0", requires: ["llm.register_tool"] },

    async setup(ctx: PluginContext) {
      // `time.now` — our own action. Params ignored; one timestamp capture so the two
      // fields always agree.
      unsubTimeNow = ctx.actions.register("time.now", async () => {
        const now = Date.now();
        return { iso: new Date(now).toISOString(), epochMs: now };
      });

      const defs: ToolDef[] = [
        {
          name: "time.now",
          description: "Get the current date and time.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: Actions.CLOCK_SET_INTERVAL,
          description:
            "Re-time ONLY the current beat: fire the next think sooner or later, once, in `ms` milliseconds. Does not change the steady pace.",
          parameters: MS_SCHEMA,
        },
        {
          name: Actions.CLOCK_SET_DEFAULT_INTERVAL,
          description:
            "Set the agent's steady thinking pace, in milliseconds — the default interval every beat uses from now on.",
          parameters: MS_SCHEMA,
        },
      ];

      for (const def of defs) {
        try {
          await ctx.actions.invoke("llm.register_tool", def);
        } catch (err) {
          ctx.log(`toolbox: failed to register tool "${def.name}": ${String(err)}`);
        }
      }
    },

    teardown() {
      unsubTimeNow?.();
      unsubTimeNow = undefined;
    },
  };
};

export default createToolbox;
