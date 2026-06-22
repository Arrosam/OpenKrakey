// public_plugin/history/history.ts — pure helpers. None of these ever throw.

/** One recorded tool-use / pushed entry in the log. */
export interface Entry {
  id: number;
  source: string;
  kind: string;
  ok?: boolean;
  text: string;
  at: number;
}

/** The plugin's resolved, defensive configuration. */
export interface HistoryConfig {
  maxEntries: number;
  keepRecent: number;
  logPriority: number;
  maxEntryChars: number;
  maxLogChars: number;
  noteImportance: number;
  captureToolResults: boolean;
}

const DEFAULTS: HistoryConfig = {
  maxEntries: 50,
  keepRecent: 20,
  logPriority: 4500,
  maxEntryChars: 300,
  maxLogChars: 4000,
  noteImportance: 2,
  captureToolResults: true,
};

/** A config value is honoured ONLY when it is a genuine finite number. */
function numberOr(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** Floor a numeric config field to an integer >= 1. */
function countOr(v: unknown, d: number): number {
  return Math.max(1, Math.floor(numberOr(v, d)));
}

/**
 * Defensively coerce a raw config slice into a complete HistoryConfig. Each key
 * falls back to its default unless the raw value is a usable number/boolean.
 */
export function readConfig(raw: unknown): HistoryConfig {
  const c = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});

  // noteImportance: an int in [1,5]; default 2 when not a finite number.
  let noteImportance: number;
  if (typeof c.noteImportance === "number" && Number.isFinite(c.noteImportance)) {
    noteImportance = Math.min(5, Math.max(1, Math.round(c.noteImportance)));
  } else {
    noteImportance = 2;
  }

  return {
    maxEntries: countOr(c.maxEntries, DEFAULTS.maxEntries),
    keepRecent: countOr(c.keepRecent, DEFAULTS.keepRecent),
    logPriority: numberOr(c.logPriority, DEFAULTS.logPriority),
    maxEntryChars: countOr(c.maxEntryChars, DEFAULTS.maxEntryChars),
    maxLogChars: countOr(c.maxLogChars, DEFAULTS.maxLogChars),
    noteImportance,
    captureToolResults: typeof c.captureToolResults === "boolean" ? c.captureToolResults : true,
  };
}

/**
 * Turn any value into a compact one-line string, truncated to `cap` chars. Never
 * throws: strings are used as-is, everything else is JSON-stringified (with a
 * String() fallback), then whitespace is collapsed.
 */
export function summarize(value: unknown, cap: number): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      const json = JSON.stringify(value);
      s = json === undefined ? String(value) : json;
    } catch {
      try {
        s = String(value);
      } catch {
        s = "";
      }
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.floor(cap));
  if (s.length > limit) s = s.slice(0, limit) + "…";
  return s;
}

/**
 * Render the log in ARRIVAL (chronological, oldest→newest) order as a string,
 * within `cfg.maxLogChars`. Returns "" for an empty/non-array input. When the
 * budget is tight, keeps the NEWEST entries (selecting from newest backward,
 * always including at least the single newest), then displays the selected
 * entries oldest→newest. Never throws.
 */
export function renderLog(entries: Entry[], cfg: HistoryConfig): string {
  if (!Array.isArray(entries) || entries.length === 0) return "";

  const header = "Recent tool actions (oldest first):";
  const budget = Math.max(1, Math.floor(cfg.maxLogChars));

  // Select which entries fit by walking from the newest backward; always include
  // at least the single newest. Each line: `[ok]`/`[err]` per the entry's `ok`.
  const selected: string[] = [];
  let length = header.length;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const tag = e.ok !== false ? "[ok]" : "[err]";
    const line = `${tag} ${e.source}: ${e.text}`;
    const added = line.length + 1; // +1 for the newline join
    if (i < entries.length - 1 && length + added > budget) break; // always include the newest
    selected.push(line);
    length += added;
  }

  // `selected` is newest→oldest; display in chronological (oldest→newest) order.
  selected.reverse();

  return [header, ...selected].join("\n");
}
