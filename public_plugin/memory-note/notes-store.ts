/**
 * memory-note — the notes store: persistence, id counter, capacity eviction.
 *
 * State is owned by the PluginFactory closure (R6); this is created once per Agent
 * in setup and handed `dataDir`. All filesystem work is best-effort and serialized
 * (chained on a promise) and never throws out of a mutation. The on-disk shape is a
 * plain JSON array of Note records in `notes.json` directly under dataDir.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MemoryNoteConfig, Note, NoteKind } from "./notes";
import { KIND_PREFIX } from "./notes";

const FILE = "notes.json";

export interface RememberInput {
  text: string;
  kind: NoteKind;
  importance: number;
}

export interface RememberResult {
  id: string;
  kind: NoteKind;
  importance: number;
  evicted: { id: string; importance: number } | null;
}

export interface ForgetResult {
  removed: boolean;
  id: string;
}

/** Parse `<prefix><n>` and return n, or 0 if it doesn't match the pattern. */
function counterOf(id: unknown): number {
  if (typeof id !== "string") return 0;
  const m = /^[a-z](\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** Type guard for a loaded record; tolerant — only the shape we render/evict on. */
function isValidNote(v: unknown): v is Note {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    (n.kind === "goal" || n.kind === "keep-in-mind" || n.kind === "thought" || n.kind === "finding") &&
    typeof n.text === "string" &&
    typeof n.importance === "number" &&
    typeof n.at === "number"
  );
}

export class NotesStore {
  private notes: Note[] = [];
  private counter = 0;
  private readonly path: string;
  /** Serializes best-effort writes so the file is never written concurrently. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly cfg: MemoryNoteConfig,
  ) {
    this.path = join(dataDir, FILE);
  }

  /** Load from disk. Missing file / parse error / non-array → start EMPTY. */
  load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.notes = [];
      this.counter = 0;
      return;
    }
    if (!Array.isArray(parsed)) {
      this.notes = [];
      this.counter = 0;
      return;
    }
    this.notes = parsed.filter(isValidNote);
    // Seed the counter past the max n found in ANY loaded id (globally unique ids).
    this.counter = this.notes.reduce((max, n) => Math.max(max, counterOf(n.id)), 0);
  }

  /** A read-only snapshot for rendering. */
  list(): Note[] {
    return this.notes;
  }

  remember(input: RememberInput): RememberResult {
    const n = ++this.counter;
    const id = `${KIND_PREFIX[input.kind]}${n}`;

    let text = input.text.trim();
    if (text.length > this.cfg.maxNoteChars) {
      text = text.slice(0, this.cfg.maxNoteChars) + "…";
    }

    const note: Note = { id, kind: input.kind, text, importance: input.importance, at: Date.now() };
    this.notes.push(note);

    const evicted = this.enforceCapacity();
    this.persist();

    return { id, kind: input.kind, importance: input.importance, evicted };
  }

  forget(id: string): ForgetResult {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    const removed = this.notes.length !== before;
    if (removed) this.persist();
    return { removed, id };
  }

  /**
   * While over capacity, evict the LEAST-IMPORTANT note: lowest importance, tie →
   * oldest (smallest at), further tie → smallest counter id. The just-inserted note
   * is itself eligible. Returns the note removed THIS call (only one removal is
   * possible per remember, since we add exactly one), else null.
   */
  private enforceCapacity(): { id: string; importance: number } | null {
    let evicted: { id: string; importance: number } | null = null;
    while (this.notes.length > this.cfg.maxNotes) {
      let victimIdx = 0;
      for (let i = 1; i < this.notes.length; i++) {
        if (this.isWorse(this.notes[i], this.notes[victimIdx])) victimIdx = i;
      }
      const [removed] = this.notes.splice(victimIdx, 1);
      evicted = { id: removed.id, importance: removed.importance };
    }
    return evicted;
  }

  /** True if `a` is a worse keep (more eligible for eviction) than `b`. */
  private isWorse(a: Note, b: Note): boolean {
    if (a.importance !== b.importance) return a.importance < b.importance;
    if (a.at !== b.at) return a.at < b.at;
    return counterOf(a.id) < counterOf(b.id);
  }

  /** Best-effort, serialized full-array rewrite. Never throws out of here. */
  private persist(): void {
    const snapshot = JSON.stringify(this.notes);
    this.writeChain = this.writeChain
      .then(() => {
        try {
          mkdirSync(this.dataDir, { recursive: true });
          writeFileSync(this.path, snapshot, "utf8");
        } catch {
          /* best-effort: degrade silently if dataDir is unwritable */
        }
      })
      .catch(() => {});
  }

  /** Final best-effort SYNCHRONOUS flush on teardown. Never throws. */
  flushSync(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.notes), "utf8");
    } catch {
      /* best-effort */
    }
  }
}
