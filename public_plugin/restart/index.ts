/**
 * Plugin: restart — lets a Krakey Agent restart the whole runtime.
 *
 * One tool, restart.now: the runtime reads plugins + config ONLY at startup, so
 * this is how a freshly-written plugin or a config edit is brought live. The plugin
 * does NOT own process lifecycle — it invokes the core `core.restart` action
 * (Actions.CORE_RESTART, provided by the composition root), which stops every Agent
 * GRACEFULLY (running each plugin's teardown, so best-effort state is flushed) before
 * boot exits with RESTART_EXIT_CODE and the krakey supervisor relaunches. That is the
 * whole point versus a raw process.exit: a restart no longer
 * loses, e.g., web-chat read-receipts. `dryRun` reports the plan without restarting;
 * if the core seam is absent (not running under boot), restart.now degrades to a
 * no-op + warning rather than exiting the process itself.
 *
 * Powerful, so NOT in the default loadout — opt a specific agent into it.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { ToolDef, Message } from "../../contracts/llm";
import { Actions, Events } from "../../shared/actions";
import { RESTART_SCHEMA } from "./config-schema";
import { readMarker, writeMarkerSync, deleteMarker, type RestartMarker } from "./marker";

const RESTART_TOOL: ToolDef = {
  name: "restart.now",
  description:
    "Restart the whole Krakey runtime. THIS is how newly-added plugins are loaded and changed config is " +
    "applied — the runtime reads plugins and config only at startup, so after you write a new plugin or edit " +
    "config, call restart.now to bring it live. The runtime exits and the krakey supervisor immediately starts " +
    "a fresh copy in its place — new plugins and config apply on the way up; the chat and inspector " +
    "briefly drop while it cycles. Use deliberately, only when you intend to reload.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Optional short reason, logged before restarting." } },
    required: [],
  },
};

/**
 * The exact command that launched this runtime (node + execArgv + script + args).
 * Kept here only so `dryRun` can REPORT the plan; the plugin never spawns a process
 * itself. boot does not re-exec either: it exits with RESTART_EXIT_CODE (see
 * shared/config) and the krakey supervisor (the `krakey run` foreground loop / the
 * `krakey start` daemon supervisor) relaunches this same command.
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
        completedNoticeMaxAgeMs?: unknown;
      };
      const delayMs = typeof cfg.delayMs === "number" && cfg.delayMs >= 0 ? Math.floor(cfg.delayMs) : 1500;
      const dryRun = cfg.dryRun === true;
      const maxAgeMs =
        typeof cfg.completedNoticeMaxAgeMs === "number" && cfg.completedNoticeMaxAgeMs >= 0
          ? Math.floor(cfg.completedNoticeMaxAgeMs)
          : 300000;

      // ---- restart-completed observability ----
      // On this (fresh) boot, was there a restart the previous copy requested but
      // never marked done? If so, and it's recent, tell the agent ONCE that the
      // restart it asked for has completed — then immediately flip the marker to
      // completed so a later reboot never re-shows the same notice.
      let observation: RestartMarker | null = null;
      const prev = readMarker(ctx.dataDir);
      const age = prev ? Date.now() - prev.requestedAt : 0;
      const fresh = prev != null && prev.completed === false && age <= maxAgeMs && age >= -60000;
      if (fresh && prev) {
        observation = prev;
        writeMarkerSync(ctx.dataDir, { ...prev, completed: true });
      } else {
        // Absent / already completed / stale / corrupt: drop it (safe no-op when absent).
        deleteMarker(ctx.dataDir);
      }

      const off = ctx.actions.register("restart.now", async (params: unknown) => {
        const reason = (params as { reason?: unknown })?.reason;
        if (typeof reason === "string" && reason) ctx.print("restart: " + reason);
        const { exe, args } = launchCommand();
        if (dryRun) {
          ctx.print("restart: DRY RUN — would restart the runtime");
          return {
            restarting: false,
            dryRun: true,
            command: [exe, ...args],
            delayMs,
            note:
              "DRY RUN - no restart happened. This is only a plan preview. Do NOT call restart.now again to " +
              "check; to actually restart, an operator must turn off dryRun in the restart config.",
          };
        }
        // The CORE owns process lifecycle: invoke the GRACEFUL core.restart action so
        // every plugin's teardown runs (flushing best-effort state) before boot exits
        // with RESTART_EXIT_CODE and the krakey supervisor relaunches — never a raw
        // process.exit from a plugin. Degrade (don't restart) if the seam isn't
        // present, e.g. not running under boot.
        if (!ctx.actions.has(Actions.CORE_RESTART)) {
          ctx.log.warn(
            "restart: core.restart is unavailable — cannot restart (is the runtime started by boot?)",
          );
          return {
            restarting: false,
            error: "core.restart unavailable",
            note: "Restart is unavailable (not running under the krakey supervisor). Calling again will not help.",
          };
        }
        // Drop a breadcrumb the fresh copy reads on the next boot so it can tell the
        // agent this exact request completed. Best-effort — writeMarkerSync never throws.
        writeMarkerSync(ctx.dataDir, {
          requestedAt: Date.now(),
          reason: typeof reason === "string" ? reason : "",
          completed: false,
          command: [exe, ...args],
        });
        ctx.print("restart: restarting the runtime…");
        await ctx.actions.invoke(Actions.CORE_RESTART, { delayMs });
        return {
          restarting: true,
          delayMs,
          note:
            "Restart requested - the runtime is rebooting now. Do NOT call restart.now again; when you wake " +
            "up this request is complete.",
        };
      });

      const guidanceText =
        typeof cfg.guidance === "string"
          ? cfg.guidance
          : "<restart.guidance> You can restart yourself with restart.now. The runtime loads plugins and " +
            "config ONLY at startup, so after you add or edit a plugin or change config, call restart.now to " +
            "apply it. The runtime exits and the krakey supervisor immediately starts a fresh copy — new " +
            "plugins and config apply on the way up. Restarting briefly drops the chat and inspector while the " +
            "runtime cycles — use it deliberately. (The delayMs config is legacy and ignored by the current " +
            "mechanism; the supervisor applies its own short delay.) Calling restart.now reboots the whole " +
            "runtime. When you wake up after a restart, that request is COMPLETE - the runtime you are running " +
            "in now IS the fresh copy. NEVER call restart.now again for a request you already made. If you see " +
            "a [restart completed] notice in your context, the restart already happened and the work is done. " +
            "</restart.guidance>";
      const priority = typeof cfg.guidancePriority === "number" ? cfg.guidancePriority : 5800;
      ctx.setBlock({ id: "restart.guidance", target: "system", priority, render: () => guidanceText });

      // A ONE-SHOT message block registered ONLY on a fresh restart: it injects a
      // single message telling the agent the request it made has completed, so it
      // stops trying to restart for it. When the marker is NOT fresh (absent /
      // completed / stale / corrupt) the block is never registered at all — the
      // block store returns undefined for its id. Once registered, it renders [] the
      // moment `observation` is cleared (below, on the first LLM return), so the
      // notice never repeats.
      if (fresh) {
        ctx.setBlock({
          id: "restart.observation",
          target: "messages",
          priority: 250,
          render: (): Message[] => {
            if (!observation) return [];
            const iso = new Date(observation.requestedAt).toISOString();
            const reasonClause = observation.reason ? ', reason: "' + observation.reason + '"' : "";
            return [
              {
                role: "user",
                name: "restart",
                content:
                  "[restart completed] The restart you requested at " +
                  iso +
                  reasonClause +
                  " HAS COMPLETED. The runtime you are in now is the fresh copy that restart produced - new " +
                  "plugins and config are already applied. This request is DONE; do NOT call restart.now again " +
                  "for it.",
              },
            ];
          },
        });
      }
      // One-shot: after the first LLM round-trip that saw the notice, drop it so the
      // block renders [] from then on. (Harmless when the block was never registered.)
      const offReturn = ctx.events.on(Events.LLM_RETURN, () => {
        observation = null;
      });

      try {
        await ctx.actions.invoke("llm.register_tool", RESTART_TOOL);
      } catch (err) {
        ctx.log.warn("restart: failed to register tool: " + String(err));
      }

      // Only wire the observation removeBlock when we actually registered the block —
      // never call removeBlock for an id that was never set (fresh === false).
      unsubs = [off, () => ctx.removeBlock("restart.guidance"), offReturn];
      if (fresh) unsubs.push(() => ctx.removeBlock("restart.observation"));
      ctx.print("restart: self-restart tool ready" + (dryRun ? " (dry run)" : ""));
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
    },
  };
};

export default createRestart;
