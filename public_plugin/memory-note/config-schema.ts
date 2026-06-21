/**
 * memory-note config schema — PURE DATA.
 *
 * Imports ONLY the `ConfigSchema` type (erased at compile time) so a config tool
 * can read this module without executing the plugin's runtime code. Do NOT add
 * any value imports or side effects here.
 */
import type { ConfigSchema } from "../../contracts/plugin";

export const MEMORY_NOTE_SCHEMA: ConfigSchema = [
  {
    key: "guidance",
    label: "Guidance text",
    type: "text",
    default: "",
    help: "Override the built-in notebook instructions shown to Krakey. Empty = use the built-in.",
  },
  {
    key: "guidancePriority",
    label: "Guidance block priority",
    type: "number",
    default: 6700,
    min: 0,
    step: 100,
    help: "Where the notebook guidance sits in the system-prompt ladder.",
  },
  {
    key: "notesPriority",
    label: "Notes block priority",
    type: "number",
    default: 8500,
    min: 0,
    step: 100,
    help: "Where the rendered notebook sits in the system-prompt ladder.",
  },
  {
    key: "maxNotes",
    label: "Max notes",
    type: "number",
    default: 100,
    min: 1,
    step: 1,
    help: "Capacity of the notebook. When full, the least-important note is dropped.",
  },
  {
    key: "maxNoteChars",
    label: "Max chars per note",
    type: "number",
    default: 600,
    min: 1,
    step: 1,
    help: "A single note is truncated to this many characters.",
  },
  {
    key: "maxNotesTotalChars",
    label: "Max rendered chars",
    type: "number",
    default: 6000,
    min: 1,
    step: 1,
    help: "Budget for the whole rendered notebook; extra notes are hidden once exceeded.",
  },
];
