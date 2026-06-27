/**
 * Plugin: persona  ·  the Agent's stable identity.
 *
 * Contributes ONE high-priority context block (stable-prefix convention, 10000+)
 * whose text comes from the Agent's config. It always renders at the top of the
 * composed context so the prompt prefix stays byte-stable across frames — the
 * thing prompt caching keys on. That is the whole job: no events, no actions.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent,
 * so the captured context lives in this closure, never in shared module scope.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import { PERSONA_SCHEMA } from "./config-schema";

const BLOCK_ID = "persona";
const DEFAULT_PRIORITY = 10000;
const DEFAULT_TEXT = "You are Krakey, an autonomous agent. Be concise and helpful.";

interface PersonaConfig {
  text?: string;
  priority?: number;
}

const createPersona: PluginFactory = (): Plugin => {
  let context: PluginContext | undefined;

  return {
    manifest: { id: "persona", version: "0.1.0", configSchema: PERSONA_SCHEMA },

    setup(ctx: PluginContext): void {
      context = ctx;
      const { text, priority } = (ctx.config ?? {}) as PersonaConfig;
      ctx.setBlock({
        id: BLOCK_ID,
        // Nominate the block's label so the orchestrator encapsulates this block
        // as <persona>…</persona> when it composes the context.
        label: BLOCK_ID,
        priority: priority ?? DEFAULT_PRIORITY,
        render: () => text ?? DEFAULT_TEXT,
      });
    },

    teardown(): void {
      context?.removeBlock(BLOCK_ID);
      context = undefined;
    },
  };
};

export default createPersona;
