import type { ConfigSchema } from "../../contracts/plugin";

export const INTERVAL_TOGGLE_SCHEMA: ConfigSchema = [
  { key: "baseIntervalMs", label: "Base heartbeat (revert target)", type: "number", default: 900000, min: 1, step: 1000, unit: "ms",
    help: "The heartbeat to revert to after a temporary hold (interval.hold). Set it to this agent's normal interval (60000 = 1 minute)." },
  { key: "guidance", label: "Guidance override", type: "text", placeholder: "(uses built-in guidance)", help: "Overrides the interval-toggle guidance shown to the LLM." },
  { key: "guidancePriority", label: "Guidance block priority", type: "number", default: 6000, min: 0, step: 100 },
];
