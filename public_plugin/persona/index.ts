/**
 * Plugin: persona  ·  the Agent's stable identity.
 *
 * Contributes ONE high-priority context block (stable-prefix convention, 10000+)
 * whose text comes from the Agent's config. It always renders at the top of the
 * composed context so the prompt prefix stays byte-stable across beats — the
 * thing prompt caching keys on. That is the whole job: no events, no actions.
 */
import type { Plugin, PluginContext } from "../../contracts/plugin";

const BLOCK_ID = "persona";
const DEFAULT_PRIORITY = 10000;
const DEFAULT_TEXT = "You are Krakey, an autonomous agent. Be concise and helpful.";

interface PersonaConfig {
  text?: string;
  priority?: number;
}

let context: PluginContext | undefined;

const persona: Plugin = {
  manifest: { id: "persona", version: "0.1.0" },

  setup(ctx: PluginContext): void {
    context = ctx;
    const { text, priority } = (ctx.config ?? {}) as PersonaConfig;
    ctx.setBlock({
      id: BLOCK_ID,
      priority: priority ?? DEFAULT_PRIORITY,
      render: () => text ?? DEFAULT_TEXT,
    });
  },

  teardown(): void {
    context?.removeBlock(BLOCK_ID);
    context = undefined;
  },
};

export default persona;
