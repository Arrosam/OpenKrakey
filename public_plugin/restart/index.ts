/**
 * Plugin: restart — lets a Krakey Agent restart the whole runtime.
 *
 * One tool, restart.now: the runtime reads plugins + config ONLY at startup, so
 * this is how a freshly-written plugin or a config edit is brought live. It spawns
 * a DETACHED replacement that waits `delayMs` (so this process can exit and free
 * its loopback ports first), then re-runs the exact launch command (node + its
 * flags such as `--import tsx` + the boot entry + args), and exits this process.
 *
 * BEST-EFFORT + cross-platform via the OS shell. For a hardened restart, a
 * launcher-level supervisor loop (re-exec on a sentinel exit code) is preferable;
 * this keeps it self-contained. `dryRun` reports the plan without restarting.
 *
 * Powerful, so NOT in the default loadout — opt a specific agent into it.
 */
import * as cp from "node:child_process";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { ToolDef } from "../../contracts/llm";
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

/** The exact command that launched this runtime (node + execArgv + script + args). */
function launchCommand(): { exe: string; args: string[] } {
  return { exe: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)] };
}

/**
 * Spawn a DETACHED replacement that waits `delayMs` (so this process can exit and
 * free its ports first), then re-runs the launch command. Cross-platform via the
 * OS shell; quoting guards paths with spaces.
 */
function spawnReplacement(delayMs: number): void {
  const { exe, args } = launchCommand();
  const cwd = process.cwd();
  const env = process.env;
  if (process.platform === "win32") {
    const q = (s: string): string => '"' + s.replace(/"/g, '""') + '"';
    const cmd = [exe, ...args].map(q).join(" ");
    const secs = Math.max(1, Math.ceil(delayMs / 1000));
    cp.spawn("cmd.exe", ["/c", "timeout /t " + secs + " /nobreak >nul & " + cmd], {
      cwd, env, detached: true, stdio: "ignore", windowsHide: true,
    }).unref();
  } else {
    const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
    const cmd = [exe, ...args].map(q).join(" ");
    cp.spawn("sh", ["-c", "sleep " + Math.max(0, delayMs) / 1000 + "; exec " + cmd], {
      cwd, env, detached: true, stdio: "ignore",
    }).unref();
  }
}

const createRestart: PluginFactory = (): Plugin => {
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "restart", version: "0.1.0", configSchema: RESTART_SCHEMA },

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
        ctx.print("restart: restarting the runtime…");
        spawnReplacement(delayMs);
        // Exit shortly after so this tool result can settle/log first.
        setTimeout(() => process.exit(0), 250);
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
