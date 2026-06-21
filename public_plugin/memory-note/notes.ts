/**
 * memory-note — pure helpers (no I/O, no side effects).
 *
 * The note model, a defensive config reader, the built-in guidance builder, and
 * the notebook render function. Everything here is pure so it can run every beat
 * cheaply and NEVER throw.
 */

export type NoteKind = "goal" | "keep-in-mind" | "thought" | "finding";

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  importance: number;
  at: number;
}

/** The resolved, fully-defaulted config slice. */
export interface MemoryNoteConfig {
  guidance: string | null;
  guidancePriority: number;
  notesPriority: number;
  maxNotes: number;
  maxNoteChars: number;
  maxNotesTotalChars: number;
}

export const DEFAULTS = {
  guidancePriority: 6700,
  notesPriority: 8500,
  maxNotes: 100,
  maxNoteChars: 600,
  maxNotesTotalChars: 6000,
} as const;

export const KINDS: readonly NoteKind[] = ["goal", "keep-in-mind", "thought", "finding"];

/** id prefix per kind. */
export const KIND_PREFIX: Record<NoteKind, string> = {
  goal: "g",
  "keep-in-mind": "k",
  thought: "t",
  finding: "f",
};

/** Section headings + render order. */
const SECTIONS: ReadonlyArray<{ kind: NoteKind; heading: string }> = [
  { kind: "goal", heading: "Goals" },
  { kind: "keep-in-mind", heading: "Keep in mind" },
  { kind: "thought", heading: "Thoughts" },
  { kind: "finding", heading: "Findings" },
];

/** Coerce an arbitrary value to a finite number, or fall back. */
function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read `ctx.config` defensively: tolerate undefined / non-object / garbage values,
 * coerce or fall back to defaults, never throw.
 */
export function readConfig(raw: unknown): MemoryNoteConfig {
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const guidanceRaw = cfg.guidance;
  const guidance =
    typeof guidanceRaw === "string" && guidanceRaw.trim() !== "" ? guidanceRaw : null;

  return {
    guidance,
    guidancePriority: numberOr(cfg.guidancePriority, DEFAULTS.guidancePriority),
    notesPriority: numberOr(cfg.notesPriority, DEFAULTS.notesPriority),
    maxNotes: Math.max(1, Math.floor(numberOr(cfg.maxNotes, DEFAULTS.maxNotes))),
    maxNoteChars: numberOr(cfg.maxNoteChars, DEFAULTS.maxNoteChars),
    maxNotesTotalChars: numberOr(cfg.maxNotesTotalChars, DEFAULTS.maxNotesTotalChars),
  };
}

/** The built-in guidance text shown when the operator provides no override. */
export function buildGuidance(maxNotes: number): string {
  return [
    "This is your private long-term notebook — only you see it.",
    `Use memory-note.remember to save a goal, a keep-in-mind, a thought, or a finding, each with an importance from 1 (minor) to 5 (critical).`,
    "The whole notebook is always shown back to you in the <memory-note> section, so you never have to recall it from memory.",
    `It holds at most ${maxNotes} notes and DROPS THE LEAST-IMPORTANT note when full, so set importance honestly.`,
    "Use memory-note.forget to drop a note by its id once it no longer matters.",
  ].join(" ");
}

/**
 * Resolve the guidance text: config override if a non-empty string, else built-in.
 */
export function guidanceText(cfg: MemoryNoteConfig): string {
  return cfg.guidance !== null ? cfg.guidance : buildGuidance(cfg.maxNotes);
}

/** Order notes within a section: importance DESC, then newest (at DESC). */
function sortForRender(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => b.importance - a.importance || b.at - a.at);
}

/**
 * Render the whole notebook into a single string for the context block.
 * Pure and total — it must NEVER throw. Empty notebook → "".
 */
export function renderNotes(notes: Note[], cfg: MemoryNoteConfig): string {
  if (!Array.isArray(notes) || notes.length === 0) return "";

  const header =
    `Your notebook (${notes.length}/${cfg.maxNotes}). ` +
    `Maintain it with memory-note.remember / memory-note.forget.`;

  const budget = cfg.maxNotesTotalChars;
  const lines: string[] = [header];
  let used = header.length;
  let shown = 0;

  outer: for (const { kind, heading } of SECTIONS) {
    const inKind = sortForRender(notes.filter((n) => n.kind === kind));
    if (inKind.length === 0) continue;

    const headingLine = `## ${heading}`;
    let headingShown = false;

    for (const n of inKind) {
      const noteLine = `[${n.id} ★${n.importance}] ${n.text}`;
      // +1 per added line for the newline join cost; charge the heading the first
      // time this section contributes a note.
      const cost = noteLine.length + 1 + (headingShown ? 0 : headingLine.length + 1);
      // Stop adding further note lines once the budget would be exceeded.
      if (used + cost > budget) break outer;

      if (!headingShown) {
        lines.push(headingLine);
        used += headingLine.length + 1;
        headingShown = true;
      }
      lines.push(noteLine);
      used += noteLine.length + 1;
      shown++;
    }
  }

  const hidden = notes.length - shown;
  if (hidden > 0) {
    lines.push(`(… ${hidden} more note${hidden === 1 ? "" : "s"} hidden)`);
  }

  return lines.join("\n");
}
