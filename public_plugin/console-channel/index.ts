/**
 * Plugin: console-channel — the MVP terminal channel.
 *
 * One job: bridge the local terminal to the input/output event seam. stdin lines
 * become `input.message` Notifies (and wake the beat via `clock.fire_now` so a
 * reply doesn't wait for the next tick); `output.message` text is printed to
 * stdout prefixed with the speaking agent's id; `agent.start` prints a one-line
 * greeting. Future channels (Discord etc.) are siblings behind this same seam.
 *
 * process.stdin / process.stdout are PROCESS singletons, but boot runs many
 * Agents in one process — each loads its own instance of this plugin. So the
 * terminal is owned by a single module-level HUB (the only legitimate
 * process-singleton owner; the per-Agent factory state still lives in each
 * closure, R6): the first Agent to set up binds the single readline; the last
 * to tear down closes it (refcount). One typed line is routed to EXACTLY ONE
 * Agent (never fanned out): with a single Agent the line is delivered verbatim
 * (byte-identical to a one-Agent process); with several, `@<id> <msg>` addresses
 * (and switches to) that Agent, a bare `@<id>` just switches, an unknown id is
 * named back with the roster, and any other line goes to the active Agent
 * (default: the first registered).
 *
 * The default export is a PluginFactory — the loader calls it once per Agent,
 * so the per-Agent cleanup handle lives in this closure, never in shared module
 * scope; only the hub (a process resource) is module-level.
 */
import * as readline from "node:readline";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import { Actions, Events, type EventPayloads } from "../../shared/actions";

// ---------------------------------------------------------------------------
// Module-level terminal hub: the single owner of process.stdin/stdout for the
// whole process, shared by every per-Agent instance and refcounted by them.
// Holds nothing per-Agent beyond an opaque { agentId, deliver } registry, so no
// Agent can observe another's input or output (R6).
// ---------------------------------------------------------------------------
interface Registration {
  readonly agentId: string;
  /** Deliver one input line to THIS agent (emit input.message + wake its beat). */
  readonly deliver: (text: string) => void;
}

let rl: readline.Interface | undefined;
let regs: Registration[] = [];
let active: Registration | undefined;

/** Write one clean line to the shared stdout, attributed to the speaking agent. */
function hubWrite(agentId: string, text: string): void {
  process.stdout.write("\n[" + agentId + "] " + text + "\n");
}

/** Route one stdin line to EXACTLY ONE agent (never fan-out). */
function routeLine(line: string): void {
  const text = line.trim();
  if (text === "") return;

  // Single agent: deliver verbatim — byte-identical to a one-Agent process, and
  // a message that legitimately starts with "@" is NOT treated as addressing.
  if (regs.length <= 1) {
    regs[0]?.deliver(text);
    return;
  }

  // Several agents: route to exactly one. "@<id> <msg>" addresses (and makes
  // active) that agent; "@<id>" alone just switches; an unknown id is named back
  // with the roster; anything else goes to the active agent (default: first).
  if (text.startsWith("@")) {
    const sp = text.indexOf(" ");
    const id = (sp === -1 ? text.slice(1) : text.slice(1, sp)).trim();
    const rest = sp === -1 ? "" : text.slice(sp + 1).trim();
    const target = regs.find((r) => r.agentId === id);
    if (target === undefined) {
      process.stdout.write(
        "\n[console] no agent '" + id + "'. available: " +
          regs.map((r) => r.agentId).join(", ") + "\n",
      );
      return;
    }
    active = target;
    if (rest !== "") target.deliver(rest);
    return;
  }

  (active ?? regs[0]).deliver(text);
}

/** Attach one agent to the hub; returns its detach handle (refcount down). */
function hubAttach(reg: Registration): () => void {
  regs.push(reg);
  if (active === undefined) active = reg;
  if (rl === undefined) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on("line", routeLine);
  }
  return () => {
    regs = regs.filter((r) => r !== reg);
    if (active === reg) active = regs[0];
    if (regs.length === 0 && rl !== undefined) {
      rl.close();
      rl = undefined;
      active = undefined;
    }
  };
}

const createConsoleChannel: PluginFactory = (): Plugin => {
  let cleanup: (() => void) | undefined;

  return {
    manifest: { id: "console-channel", version: "0.1.0" },

    setup(ctx: PluginContext): void {
      const detach = hubAttach({
        agentId: ctx.agentId,
        deliver: (text) => {
          const payload: EventPayloads["input.message"] = {
            at: Date.now(),
            data: { text, channel: "console" },
          };
          ctx.events.emit(Events.INPUT_MESSAGE, payload);
          if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) {
            ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
          }
        },
      });

      const unsubOutput = ctx.events.on(Events.OUTPUT_MESSAGE, (payload) => {
        const text = (payload as EventPayloads["output.message"])?.data?.text;
        if (typeof text === "string") {
          hubWrite(ctx.agentId, text);
        }
      });

      const unsubStart = ctx.events.on(Events.AGENT_START, (payload) => {
        const agentId = (payload as EventPayloads["agent.start"])?.data?.agentId;
        // The channel's STARTING MESSAGE — via ctx.print so it lands in the
        // startup report of whichever console ran the program.
        ctx.print("agent '" + agentId + "' is awake — type to talk.");
      });

      cleanup = () => {
        detach();
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
