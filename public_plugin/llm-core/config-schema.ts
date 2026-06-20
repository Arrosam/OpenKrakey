import type { ConfigSchema } from "../../contracts/plugin";

export const LLM_CORE_SCHEMA: ConfigSchema = [
  {
    key: "communicator",
    label: "AI service",
    type: "string",
    placeholder: "(first chat-capable service)",
    help: "Name of the configured AI service this agent talks to. Leave blank to use the first chat-capable service.",
  },
  {
    key: "temperature",
    label: "Temperature",
    type: "number",
    min: 0,
    max: 2,
    step: 0.1,
    placeholder: "provider default",
    help: "Sampling temperature. Leave blank to use the provider default.",
  },
  {
    key: "maxTokens",
    label: "Max output tokens",
    type: "number",
    min: 1,
    step: 1,
    placeholder: "provider default",
    help: "Upper bound on the reply length. Leave blank for the provider default.",
  },
];
