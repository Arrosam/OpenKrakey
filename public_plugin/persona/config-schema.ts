import type { ConfigSchema } from "../../contracts/plugin";

export const PERSONA_SCHEMA: ConfigSchema = [
  {
    key: "text",
    label: "Persona text",
    type: "text",
    default: "You are Krakey, an autonomous agent. Be concise and helpful.",
    help: "The identity system block. Rendered at the very top of the prompt (stable prefix → prompt-cache hits).",
  },
  {
    key: "priority",
    label: "Block priority",
    type: "number",
    default: 10000,
    min: 0,
    step: 100,
    help: "Higher = closer to the top of the composed context.",
  },
];
