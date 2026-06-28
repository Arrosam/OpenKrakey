/**
 * logbook · config-schema — PURE DATA (imports ONLY the ConfigSchema type).
 *
 * Declares the logbook plugin's settings so config tools (cli, config-web) can
 * auto-render them. Inert at runtime: the loader/orchestrator never read this;
 * the plugin resolves its own defaults defensively in setup.
 */
import type { ConfigSchema } from "../../contracts/plugin";

/**
 * The activity taxonomy the logbook records — each value is the canonical event
 * NAME from shared/actions Events. Kept in step with that enum (the setup-time
 * subscription loop iterates the live Events object; this list is the UI mirror
 * so an operator can narrow what gets captured).
 */
const CAPTURE_OPTIONS: Array<{ value: string; label: string; summary: string }> = [
  { value: "agent.start", label: "Agent start", summary: "Agent boot / start lifecycle event" },
  { value: "clock.tick", label: "Clock tick", summary: "Each frame's heartbeat tick" },
  { value: "prompt.gather", label: "Prompt gather", summary: "Per-frame prompt-block gather" },
  { value: "llm.request", label: "LLM request (trigger)", summary: "A frame wants an LLM round-trip" },
  { value: "llm.request.sent", label: "LLM request sent", summary: "The exact request dispatched to the provider" },
  { value: "llm.return", label: "LLM return", summary: "The provider's reply (ok / error)" },
  { value: "input.message", label: "Input message", summary: "An inbound channel message" },
  { value: "output.message", label: "Output message", summary: "An outbound channel message" },
  { value: "tool.result", label: "Tool result", summary: "A dispatched tool call settling" },
  { value: "log.entry", label: "Log entry", summary: "A plugin diagnostic / print line" },
  { value: "context.full", label: "Context overflow", summary: "The assembled prompt exceeded the budget" },
];

export const LOGBOOK_SCHEMA: ConfigSchema = [
  {
    key: "ringSize",
    label: "In-memory ring size",
    type: "number",
    default: 500,
    min: 1,
    step: 1,
    unit: "records",
    help: "How many of the most recent records are kept in memory for fast queries.",
  },
  {
    key: "maxFileEntries",
    label: "Persisted file entries",
    type: "number",
    default: 5000,
    min: 1,
    step: 1,
    unit: "records",
    help: "How many records the on-disk activity.jsonl keeps (compacted when it grows past 2×).",
  },
  {
    key: "maxSummaryChars",
    label: "Max summary length",
    type: "number",
    default: 200,
    min: 1,
    step: 1,
    unit: "chars",
    help: "Each record's one-line summary is capped to this many characters.",
  },
  {
    key: "captureTypes",
    label: "Captured activity",
    type: "multienum",
    options: CAPTURE_OPTIONS,
    default: CAPTURE_OPTIONS.map((o) => o.value),
    help: "Which kinds of activity to record. Leave all selected to capture everything.",
  },
  {
    key: "defaultFetchLimit",
    label: "Default fetch limit",
    type: "number",
    default: 50,
    min: 1,
    step: 1,
    unit: "records",
    help: "How many records log.fetch returns when the caller does not specify a limit.",
  },
  {
    key: "maxFetchLimit",
    label: "Max fetch limit",
    type: "number",
    default: 200,
    min: 1,
    step: 1,
    unit: "records",
    help: "Upper bound on how many records a single log.fetch call may return.",
  },
  {
    key: "resultsPriority",
    label: "Results block priority",
    type: "number",
    default: 3200,
    step: 1,
    help: "Context priority of the messages block that feeds fetched records back to the agent.",
  },
  {
    key: "maxResultsTotalChars",
    label: "Max results block size",
    type: "number",
    default: 4000,
    min: 1,
    step: 1,
    unit: "chars",
    help: "Total character budget for the fold-back results block; oldest results drop first.",
  },
  {
    key: "guidance",
    label: "Guidance override",
    type: "text",
    placeholder:
      "Leave blank to use the built-in guidance teaching the log.fetch tool.",
    help: "Optional replacement for the system guidance that teaches the agent about log.fetch.",
  },
  {
    key: "guidancePriority",
    label: "Guidance block priority",
    type: "number",
    default: 6400,
    step: 1,
    help: "Context priority of the system block that teaches the agent about the log.fetch tool.",
  },
];
