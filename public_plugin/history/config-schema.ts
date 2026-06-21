// public_plugin/history/config-schema.ts — PURE DATA, import only the type.
// A config tool reads this WITHOUT executing the plugin, so it must stay free of
// any runtime import or side effect.
import type { ConfigSchema } from "../../contracts/plugin";

export const HISTORY_SCHEMA: ConfigSchema = [
  {
    key: "maxEntries",
    label: "Max entries",
    type: "number",
    default: 50,
    min: 1,
    step: 1,
    help: "Compact once the stored log exceeds this many entries.",
  },
  {
    key: "keepRecent",
    label: "Keep recent",
    type: "number",
    default: 20,
    min: 1,
    step: 1,
    help: "How many of the newest entries to keep when compacting; older ones are distilled.",
  },
  {
    key: "logPriority",
    label: "Block priority",
    type: "number",
    default: 4500,
    step: 100,
    help: "Priority of the rendered tool-action log system block (composed priority DESC).",
  },
  {
    key: "maxEntryChars",
    label: "Max chars per entry",
    type: "number",
    default: 300,
    min: 1,
    step: 1,
    help: "Each entry's text is truncated to this many characters.",
  },
  {
    key: "maxLogChars",
    label: "Max log chars",
    type: "number",
    default: 4000,
    min: 1,
    step: 1,
    help: "Total character budget for the rendered log (newest entries fill it first).",
  },
  {
    key: "noteImportance",
    label: "Checkpoint importance",
    type: "number",
    default: 2,
    min: 1,
    max: 5,
    step: 1,
    help: "Importance (1–5) of the memory-note checkpoint written when the log compacts.",
  },
  {
    key: "captureToolResults",
    label: "Auto-capture tool results",
    type: "boolean",
    default: true,
    help: "Automatically log every tool.result event on the bus.",
  },
];
