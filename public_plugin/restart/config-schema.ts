import type { ConfigSchema } from "../../contracts/plugin";

export const RESTART_SCHEMA: ConfigSchema = [
  { key: "delayMs", label: "Restart delay", type: "number", default: 1500, min: 0, step: 100, unit: "ms",
    help: "How long the replacement process waits before binding, so this process can fully exit and free its loopback ports first." },
  { key: "dryRun", label: "Dry run (no real restart)", type: "boolean", default: false,
    help: "When on, restart.now reports what it WOULD do but does not actually restart. Useful for testing." },
  { key: "guidance", label: "Guidance override", type: "text", placeholder: "(uses built-in guidance)", help: "Overrides the restart guidance shown to the LLM." },
  { key: "guidancePriority", label: "Guidance block priority", type: "number", default: 5800, min: 0, step: 100 },
];
