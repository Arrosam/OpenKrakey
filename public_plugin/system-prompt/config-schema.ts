import type { ConfigSchema } from "../../contracts/plugin";

export const SYSTEM_PROMPT_SCHEMA: ConfigSchema = [
  {
    key: "text",
    label: "Operating-model text",
    type: "text",
    default:
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
      "right move when nothing is new.",
    help: "Channel-agnostic. Teaches the monologue rule + basic tool use. Never names a specific channel.",
  },
  {
    key: "priority",
    label: "Block priority",
    type: "number",
    default: 9000,
    min: 0,
    step: 100,
    help: "Higher = closer to the top of the composed context.",
  },
];
