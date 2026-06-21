/**
 * Plugin: system-prompt  ·  the Agent's OPERATING MODEL (basic usage).
 *
 * Contributes ONE stable SYSTEM-target context block (priority 9000, just below
 * persona's 10000 identity anchor) that introduces the LLM to HOW this agent works:
 * it runs on a recurring beat; its plain reply each beat is a PRIVATE MONOLOGUE shown
 * to no one; to affect anything outside its own head it must call a TOOL (each tool's
 * description says what it does + where its output goes); an idle beat is just thinking.
 *
 * It is CHANNEL-AGNOSTIC by design — it never names a specific channel's send tool
 * (e.g. web.send_message). A channel teaches its OWN send path via that tool's
 * description; this block teaches only the general model. Identity lives in `persona`;
 * this is operation. Like persona it owns no events/actions — just the block.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent, so the
 * captured context lives in this closure, never in shared module scope.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import { SYSTEM_PROMPT_SCHEMA } from "./config-schema";

const BLOCK_ID = "system-prompt";
const DEFAULT_PRIORITY = 9000;
const DEFAULT_TEXT =
  "Every beat you think, and may act. ALL of the plain text you produce — every word, " +
  "every beat — is your PRIVATE MONOLOGUE. It is read by NO ONE: never shown to a user, " +
  "never delivered to any channel, never stored, never acted upon. It is only your own " +
  "reasoning.\n" +
  "The ONLY way to affect anything outside your own head — to be heard by anyone, to " +
  "send a message, to use any capability — is to call one of your tools. Each tool's " +
  "description says what it does and where its output goes; nothing you write outside a " +
  "tool call ever reaches anyone or has any effect.\n" +
  "On a beat where there is nothing worth doing, simply think; never force an action " +
  "just to act.";

interface SystemPromptConfig {
  text?: string;
  priority?: number;
}

const createSystemPrompt: PluginFactory = (): Plugin => {
  let context: PluginContext | undefined;

  return {
    manifest: { id: "system-prompt", version: "0.1.0", configSchema: SYSTEM_PROMPT_SCHEMA },

    setup(ctx: PluginContext): void {
      context = ctx;
      const { text, priority } = (ctx.config ?? {}) as SystemPromptConfig;
      ctx.setBlock({
        id: BLOCK_ID,
        // Nominate the label so the orchestrator wraps this block as
        // <system-prompt>…</system-prompt> in the composed system text.
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

export default createSystemPrompt;
