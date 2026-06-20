import type { ConfigSchema } from "../../contracts/plugin";

export const SYSTEM_PROMPT_SCHEMA: ConfigSchema = [
  {
    key: "text",
    label: "Operating-model text",
    type: "text",
    default:
      "You run on a recurring beat: each beat you think, and may act. The plain text you " +
      "produce each beat is your PRIVATE MONOLOGUE — your own reasoning — and is shown to " +
      "NO ONE.\n" +
      "To affect anything outside your own head — to speak to a user, send a message, or " +
      "use any capability — you MUST call one of your tools. Each tool's description tells " +
      "you what it does and where its output goes; nothing you write outside a tool call " +
      "reaches anyone.\n" +
      "On a beat where there is nothing worth doing, simply think; never force an action " +
      "just to act.",
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
