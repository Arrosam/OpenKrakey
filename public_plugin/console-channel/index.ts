/**
 * Plugin: console-channel — the MVP terminal channel.
 *
 * One job: bridge the local terminal to the input/output event seam. stdin lines
 * become `input.message` Notifies (and wake the beat via `clock.fire_now` so a
 * reply doesn't wait for the next tick); `output.message` text is printed to
 * stdout; `agent.start` prints a one-line greeting. Future channels (Discord etc.)
 * are siblings behind this same seam.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent,
 * so the cleanup handle lives in this closure, never in shared module scope.
 */
import * as readline from "node:readline";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import { Actions, Events, type EventPayloads } from "../../shared/actions";

const createConsoleChannel: PluginFactory = (): Plugin => {
  let cleanup: (() => void) | undefined;

  return {
    manifest: { id: "console-channel", version: "0.1.0" },

    setup(ctx: PluginContext): void {
      const rl = readline.createInterface({ input: process.stdin });

      rl.on("line", (line) => {
        const text = line.trim();
        if (text === "") return;
        const payload: EventPayloads["input.message"] = {
          at: Date.now(),
          data: { text, channel: "console" },
        };
        ctx.events.emit(Events.INPUT_MESSAGE, payload);
        if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) {
          ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
        }
      });

      const unsubOutput = ctx.events.on(Events.OUTPUT_MESSAGE, (payload) => {
        const text = (payload as EventPayloads["output.message"])?.data?.text;
        if (typeof text === "string") {
          process.stdout.write("\n[krakey] " + text + "\n");
        }
      });

      const unsubStart = ctx.events.on(Events.AGENT_START, (payload) => {
        const agentId = (payload as EventPayloads["agent.start"])?.data?.agentId;
        // The channel's STARTING MESSAGE — via ctx.print so it lands in the
        // startup report of whichever console ran the program.
        ctx.print("agent '" + agentId + "' is awake — type to talk.");
      });

      cleanup = () => {
        rl.close();
        unsubOutput();
        unsubStart();
      };
    },

    teardown(): void {
      cleanup?.();
      cleanup = undefined;
    },
  };
};

export default createConsoleChannel;
