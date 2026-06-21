// public_plugin/history/history-store.ts — in-memory log + best-effort persistence.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry, HistoryConfig } from "./history";

/** Input accepted by `record` — `at` defaults to now, `ok`/`kind` are optional. */
export interface RecordInput {
  source: string;
  kind: string;
  ok?: boolean;
  text: string;
  at?: number;
}

/**
 * Persists a compacting list of entries to `history.json` under the data dir.
 * Every persistence path is best-effort: an unwritable dataDir degrades to an
 * in-memory-only log, and no mutation ever throws.
 */
export class HistoryStore {
  private readonly dataDir: string;
  private readonly cfg: HistoryConfig;
  private readonly path: string;
  private entries: Entry[] = [];
  private counter = 0;
  /** Serializes async persists so the latest snapshot wins without interleaving. */
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, cfg: HistoryConfig) {
    this.dataDir = dataDir;
    this.cfg = cfg;
    this.path = join(dataDir, "history.json");
  }

  /**
   * Load persisted entries. Missing file, parse error, or a non-array all reset
   * to an empty log. Keeps only valid entries and seeds `counter` past the max
   * numeric id seen. Never throws.
   */
  load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.entries = [];
      return;
    }
    if (!Array.isArray(parsed)) {
      this.entries = [];
      return;
    }

    const valid: Entry[] = [];
    let maxId = 0;
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== "number" || !Number.isFinite(r.id)) continue;
      if (typeof r.source !== "string") continue;
      if (typeof r.kind !== "string") continue;
      if (typeof r.text !== "string") continue;
      if (typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
      const entry: Entry = {
        id: r.id,
        source: r.source,
        kind: r.kind,
        text: r.text,
        at: r.at,
      };
      if (typeof r.ok === "boolean") entry.ok = r.ok;
      valid.push(entry);
      if (r.id > maxId) maxId = r.id;
    }
    this.entries = valid;
    this.counter = maxId;
  }

  /** A copy of the current entries (oldest-first), safe for callers to keep. */
  list(): Entry[] {
    return this.entries.slice();
  }

  /**
   * Append an entry, then enforce capacity. When over `maxEntries`, drop the
   * oldest `(length - keepRecent)` entries and return them so they can be
   * distilled. Persists best-effort. Never throws.
   */
  record(input: RecordInput): { entry: Entry; dropped: Entry[] } {
    const text = summarizeText(input.text, this.cfg.maxEntryChars);
    const entry: Entry = {
      id: ++this.counter,
      source: input.source,
      kind: input.kind,
      text,
      at: typeof input.at === "number" ? input.at : Date.now(),
    };
    if (input.ok !== undefined) entry.ok = input.ok;
    this.entries.push(entry);

    let dropped: Entry[] = [];
    if (this.entries.length > this.cfg.maxEntries) {
      const removeCount = this.entries.length - this.cfg.keepRecent;
      if (removeCount > 0) {
        dropped = this.entries.slice(0, removeCount);
        this.entries = this.entries.slice(removeCount);
      }
    }

    this.persist();
    return { entry, dropped };
  }

  /** Write the current snapshot synchronously, best-effort. */
  flushSync(): void {
    this.writeRaw(safeStringify(this.entries));
  }

  /** Best-effort async persist; chained so writes never interleave. */
  private persist(): void {
    const data = safeStringify(this.entries);
    this.chain = this.chain.then(() => {
      this.writeRaw(data);
    });
    // Swallow any rejection so the chain stays alive and nothing escapes.
    this.chain = this.chain.catch(() => {});
  }

  /** The single low-level writer — creates the dir and writes, swallowing errors. */
  private writeRaw(data: string): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.path, data, "utf8");
    } catch {
      // Unwritable dataDir → degrade to in-memory only.
    }
  }
}

/** Trim + truncate an entry's text to `cap` chars. Local to avoid a cross-import cycle. */
function summarizeText(text: string, cap: number): string {
  const limit = Math.max(1, Math.floor(cap));
  let s = typeof text === "string" ? text : String(text ?? "");
  s = s.trim();
  if (s.length > limit) s = s.slice(0, limit) + "…";
  return s;
}

/** JSON.stringify that never throws. */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "[]" : json;
  } catch {
    return "[]";
  }
}
