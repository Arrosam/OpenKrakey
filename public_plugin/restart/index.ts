/**
 * Plugin: restart — lets a Krakey Agent restart the whole runtime.
 *
 * One tool, restart.now: the runtime reads plugins + config ONLY at startup, so
 * this is how a freshly-written plugin or a config edit is brought live. The plugin
 * does NOT own process lifecycle — it invokes the core `core.restart` action
 * (Actions.CORE_RESTART, provided by the composition root), which stops every Agent
 * GRACEFULLY (running each plugin's teardown, so best-effort state is flushed) before
 * re-execing. That is the whole point versus a raw process.exit: a restart no longer
 * loses, e.g., web-chat read-receipts. `dryRun` reports the plan without restarting;
 * if the core seam is absent (not running under boot), restart.now degrades to a
 * no-op + warning rather than exiting the process itself.
 *
 * Powerful, so NOT in the default loadout — opt a specific agent into it.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { ToolDef } from "../../contracts/llm";
import { Actions } from "../../shared/actions";
import { RESTART_SCHEMA } from "./config-schema";

const RESTART_TOOL: ToolDef = {
  name: "restart.now",
  description:
    "Restart the whole Krakey runtime. THIS is how newly-added plugins are loaded and changed config is " +
    "applied — the runtime reads plugins and config only at startup, so after you write a new plugin or edit " +
    "config, call restart.now to bring it live. A fresh copy starts in this one's place; the chat and inspector " +
    "briefly drop while it cycles. Use deliberately, only when you intend to reload.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Optional short reason, logged before restarting." } },
    required: [],
  },
};

/**
 * The exact command that launched this runtime (node + execArgv + script + args).
 * Kept here only so `dryRun` can REPORT the plan; the real re-exec lives in the core
 * (boot.spawnReplacement) — the plugin never spawns a process itself.
 */
function launchCommand(): { exe: string; args: string[] } {
  return { exe: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)] };
}

const createRestart: PluginFactory = (): Plugin => {
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "restart", version: "0.1.0", requires: ["llm.register_tool"], configSchema: RESTART_SCHEMA },

    async setup(ctx: PluginContext): Promise<void> {
      const cfg = (ctx.config ?? {}) as {
        delayMs?: unknown;
        dryRun?: unknown;
        guidance?: unknown;
        guidancePriority?: unknown;
      };
      const delayMs = typeof cfg.delayMs === "number" && cfg.delayMs >= 0 ? Math.floor(cfg.delayMs) : 1500;
      const dryRun = cfg.dryRun === true;

      const off = ctx.actions.register("restart.now", async (params: unknown) => {
        const reason = (params as { reason?: unknown })?.reason;
        if (typeof reason === "string" && reason) ctx.print("restart: " + reason);
        const { exe, args } = launchCommand();
        if (dryRun) {
          ctx.print("restart: DRY RUN — would restart the runtime");
          return { restarting: false, dryRun: true, command: [exe, ...args], delayMs };
        }
        // The CORE owns process lifecycle: invoke the GRACEFUL core.restart action so
        // every plugin's teardown runs (flushing best-effort state) before the
        // re-exec — never a raw process.exit from a plugin. Degrade (don't restart) if
        // the seam isn't present, e.g. not running under boot.
        if (!ctx.actions.has(Actions.CORE_RESTART)) {
          ctx.log.warn(
            "restart: core.restart is unavailable — cannot restart (is the runtime started by boot?)",
          );
          return { restarting: false, error: "core.restart unavailable" };
        }
        ctx.print("restart: restarting the runtime…");
        await ctx.actions.invoke(Actions.CORE_RESTART, { delayMs });
        return { restarting: true, delayMs };
      });

      const guidanceText =
        typeof cfg.guidance === "string"
          ? cfg.guidance
          : "<restart.guidance> You can restart yourself with restart.now. The runtime loads plugins and " +
            "config ONLY at startup, so after you add or edit a plugin or change config, call restart.now to " +
            "apply it. Restarting briefly drops the chat and inspector while the runtime cycles — use it " +
            "deliberately. </restart.guidance>";
      const priority = typeof cfg.guidancePriority === "number" ? cfg.guidancePriority : 5800;
      ctx.setBlock({ id: "restart.guidance", target: "system", priority, render: () => guidanceText });

      try {
        await ctx.actions.invoke("llm.register_tool", RESTART_TOOL);
      } catch (err) {
        ctx.log.warn("restart: failed to register tool: " + String(err));
      }

      unsubs = [off, () => ctx.removeBlock("restart.guidance")];
      ctx.print("restart: self-restart tool ready" + (dryRun ? " (dry run)" : ""));
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
    },
  };
};

export default createRestart;
