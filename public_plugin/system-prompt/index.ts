/**
 * Plugin: system-prompt  ·  the Agent's OPERATING MODEL (basic usage).
 *
 * Contributes ONE stable SYSTEM-target context block (priority 9000, just below
 * persona's 10000 identity anchor) that introduces the LLM to HOW this agent works:
 * it runs on a recurring frame; its plain reply each frame is a PRIVATE MONOLOGUE shown
 * to no one; to affect anything outside its own head it must call a TOOL (each tool's
 * description says what it does + where its output goes); an idle frame is just thinking.
 *
 * It is CHANNEL-AGNOSTIC by design — it never names a specific channel's send tool
 * (e.g. web-chat.send_message). A channel teaches its OWN send path via that tool's
 * description; this block teaches only the general model. Identity lives in `persona`;
 * this is operation. Like persona it owns no events/actions — just the block.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent, so the
 * captured context lives in this closure, never in shared module scope.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Message } from "../../contracts/llm";
import { SYSTEM_PROMPT_SCHEMA } from "./config-schema";

const BLOCK_ID = "system-prompt";
const REMINDER_BLOCK_ID = "system-prompt.reminder";
const DEFAULT_PRIORITY = 9000;
const REMINDER_PRIORITY = 200;
const DEFAULT_TEXT =
  "Every frame you think, and may act. ALL of the plain text you produce — every word, " +
  "every frame — is your PRIVATE MONOLOGUE. It is read by NO ONE: never shown to a user, " +
  "never delivered to any channel, never stored, never acted upon. It is only your own " +
  "reasoning.\n" +
  "The ONLY way to affect anything outside your own head — to be heard by anyone, to " +
  "send a message, to use any capability — is to call one of your tools. Each tool's " +
  "description says what it does and where its output goes; nothing you write outside a " +
  "tool call ever reaches anyone or has any effect.\n" +
  "You run on a recurring FRAME LOOP — each frame is your own clock ticking, NOT a new " +
  "request from anyone. Every frame you are shown the full history, including messages " +
  "and results you have ALREADY handled. Before you act, judge the current situation: " +
  "is there something genuinely NEW and unaddressed — a message you haven't answered, a " +
  "fresh tool result to use? If so, act on it. If nothing has changed since your last " +
  "frame, just think; do not re-send a message you've already sent, re-run a tool whose " +
  "effect already holds, or act merely because a frame occurred. Doing nothing is the " +
  "right move when nothing is new.\n" +
  "If a tool call fails, read its result. A tool that failed with the same error twice " +
  "will not succeed if you call it again unchanged - reflect in your monologue on why, " +
  "then change your approach or stop; do not keep re-calling a tool that keeps failing " +
  "the same way.";

// A trailing messages-target reminder, rendered LAST (lowest priority among message
// blocks) so the recency-sensitive operating rule sits closest to the model's turn.
// Channel-agnostic by design — it names no channel or tool, mirroring the system block.
const REMINDER_TEXT =
  "[Operating reminder] Your plain text this frame is a PRIVATE MONOLOGUE — to affect " +
  "anything (reply to anyone, use any capability) you MUST call a tool. Check the " +
  "current situation now: re-read the most recent user message and any status notes " +
  "above, and act only on what is genuinely NEW and unaddressed this frame. If you are " +
  "mid-task, re-read the newest user message FIRST — it may have changed your priorities " +
  "or asked you to stop.";

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
      // A trailing messages-target reminder. priority 200 places it LAST among message
      // blocks (lowest priority) so it lands closest to the model's turn for recency.
      ctx.setBlock({
        id: REMINDER_BLOCK_ID,
        target: "messages",
        priority: REMINDER_PRIORITY,
        render: (): Message[] => [
          { role: "user", name: "operating-reminder", content: REMINDER_TEXT },
        ],
      });
    },

    teardown(): void {
      context?.removeBlock(BLOCK_ID);
      context?.removeBlock(REMINDER_BLOCK_ID);
      context = undefined;
    },
  };
};

export default createSystemPrompt;
