/**
 * inspector/store.ts — per-agent persisted JSONL record store.
 *
 * A bounded, append-only mirror of the in-memory ring (hub.ts), persisted under
 * the SHARED inspector dataDir so the dashboard can restore a window of history
 * across a restart. One file per agent: `<dataDir>/<sanitized agentId>/events.jsonl`.
 *
 * Design notes:
 *  - BEST-EFFORT, never throws. Persistence is a debugging convenience, not a
 *    source of truth — every disk op is wrapped and errors are swallowed. A failed
 *    write must NEVER break the bus handler that called append().
 *  - SERIALIZED async append chain. Writes are chained off a single promise so
 *    lines never interleave; append() returns void (fire-and-forget) and the chain
 *    is awaitable via flush().
 *  - BOUNDED. An in-process index counts persisted lines; once the file grows past
 *    2× the cap we rewrite it down to the most-recent `maxPersistedEntries` lines.
 *  - PATH-SAFE. A path-hostile agentId (contains '/', '\\', '..', or a leading dot)
 *    degrades the store to IN-MEMORY-ONLY: append is a no-op and window() is empty,
 *    so a malicious id can never escape the dataDir.
 *  - SEPARATE FILES. Two different agentIds under the same dataDir get distinct
 *    subdirectories, so their histories never mix.
 *
 * Persists the EXACT EventRecord shape from hub.ts (one JSON object per line).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { EventRecord } from "./hub";

export interface EventStoreConfig {
  maxPersistedEntries: number;
  retentionMs: number;
  persist: boolean;
}

const FILE_NAME = "events.jsonl";

/**
 * Reject a path-hostile agentId. We only allow ids that resolve to a single,
 * plain directory segment: no separators, no parent traversal, no leading dot.
 */
function sanitizeAgentId(agentId: string): string | null {
  if (typeof agentId !== "string" || agentId.length === 0) return null;
  if (agentId.indexOf("/") !== -1 || agentId.indexOf("\\") !== -1) return null;
  if (agentId.indexOf("..") !== -1) return null;
  if (agentId.charAt(0) === ".") return null;
  return agentId;
}

export class EventStore {
  private readonly cap: number;
  private readonly retentionMs: number;
  private readonly persistEnabled: boolean;
  /** Null when in-memory-only (persist:false OR a path-hostile id). */
  private readonly filePath: string | null;
  /** Highest persisted seq seen at load (and updated on append); 0 if empty. */
  private highestSeq = 0;
  /** Count of lines currently in the file (drives the compaction threshold). */
  private lineCount = 0;
  /** The restored window — set once by load(), exposed via window(). */
  private restored: EventRecord[] = [];
  /** The serialized write chain; append() and compactSync() both extend it. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(filePath: string | null, cfg: EventStoreConfig) {
    this.cap = cfg.maxPersistedEntries > 0 ? Math.floor(cfg.maxPersistedEntries) : 1;
    this.retentionMs = cfg.retentionMs > 0 ? cfg.retentionMs : 0;
    this.persistEnabled = cfg.persist === true;
    this.filePath = filePath;
  }

  /**
   * Open (and read) the store for one agent. Reads the existing JSONL file,
   * skipping malformed lines, keeps the last `maxPersistedEntries`, and applies
   * retention. Always resolves (never rejects) — a read failure just yields an
   * empty window.
   */
  static async load(dataDir: string, agentId: string, cfg: EventStoreConfig): Promise<EventStore> {
    // persist:false ⇒ pure in-memory no-op store (window empty, append no-op).
    if (cfg.persist !== true) {
      return new EventStore(null, cfg);
    }
    const safe = sanitizeAgentId(agentId);
    if (safe === null) {
      // Path-hostile id: degrade to in-memory only (never touch the disk).
      return new EventStore(null, cfg);
    }
    const agentDir = path.join(dataDir, safe);
    const filePath = path.join(agentDir, FILE_NAME);
    const store = new EventStore(filePath, cfg);
    await store.readWindow();
    return store;
  }

  /** Read + parse the persisted file into the bounded restored window. */
  private async readWindow(): Promise<void> {
    if (!this.filePath) return;
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, "utf8");
    } catch {
      // Missing file (fresh agent) or any read error → empty window.
      this.restored = [];
      this.lineCount = 0;
      this.highestSeq = 0;
      return;
    }
    const lines = text.split("\n");
    const parsed: EventRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue; // skip blank (incl. trailing newline)
      let rec: EventRecord;
      try {
        rec = JSON.parse(line) as EventRecord;
      } catch {
        continue; // skip malformed line
      }
      if (!rec || typeof rec !== "object" || typeof rec.seq !== "number") continue;
      parsed.push(rec);
    }
    // The file is the persisted line count (valid lines only).
    this.lineCount = parsed.length;

    // Keep only the last `cap` entries. Retention is NOT applied here — it is
    // applied in window() against a fresh `now` snapshot, so the boundary is
    // evaluated at read time (and never drifts past the entry during the awaited
    // file read above).
    const window = parsed.length > this.cap ? parsed.slice(parsed.length - this.cap) : parsed;

    this.restored = window;
    // highestSeq tracks the max persisted seq (across ALL parsed lines, not just
    // the retained window) so restart keeps seq monotonic even if retention drops
    // every restored row.
    let max = 0;
    for (let i = 0; i < parsed.length; i++) {
      if (parsed[i].seq > max) max = parsed[i].seq;
    }
    this.highestSeq = max;
  }

  /**
   * The restored window, oldest → newest (bounded to the cap). When retentionMs > 0,
   * entries OLDER than the wall-clock window are pruned: a record is kept iff
   * `at >= Date.now() - retentionMs` (INCLUSIVE boundary). retentionMs === 0 disables
   * retention (keep everything). `now` is snapshotted here at call time.
   */
  window(): EventRecord[] {
    if (this.retentionMs <= 0) return this.restored.slice();
    const cutoff = Date.now() - this.retentionMs;
    return this.restored.filter((r) => typeof r.at === "number" && r.at >= cutoff);
  }

  /** Highest persisted seq (0 if empty) — used to keep seq monotonic on restart. */
  maxSeq(): number {
    return this.highestSeq;
  }

  /**
   * Append one record (fire-and-forget). No-op when persistence is disabled, the
   * id was path-hostile, or the store is closed. Chains the write so lines never
   * interleave, and swallows every error.
   */
  append(rec: EventRecord): void {
    if (!this.persistEnabled || !this.filePath || this.closed) return;
    if (rec.seq > this.highestSeq) this.highestSeq = rec.seq;
    let line: string;
    try {
      line = JSON.stringify(rec) + "\n";
    } catch {
      return; // un-serializable record: skip (never throw)
    }
    this.lineCount++;
    const filePath = this.filePath;
    const needCompact = this.lineCount > this.cap * 2;
    this.chain = this.chain.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      } catch {
        /* swallow */
      }
      try {
        await fs.promises.appendFile(filePath, line, "utf8");
      } catch {
        /* swallow */
      }
    });
    // Past 2× the cap, rewrite the file down to the most-recent `cap` lines. The
    // rewrite is chained AFTER the append above so it sees the just-written line.
    if (needCompact) this.compact();
  }

  /** Async compaction: rewrite the file keeping the most-recent `cap` lines. */
  private compact(): void {
    if (!this.filePath || this.closed) return;
    const filePath = this.filePath;
    const cap = this.cap;
    this.chain = this.chain.then(async () => {
      try {
        const text = await fs.promises.readFile(filePath, "utf8");
        const lines = text.split("\n").filter((l) => l.length > 0);
        const keep = lines.length > cap ? lines.slice(lines.length - cap) : lines;
        await fs.promises.writeFile(filePath, keep.join("\n") + (keep.length ? "\n" : ""), "utf8");
        this.lineCount = keep.length;
      } catch {
        /* swallow — compaction is best-effort */
      }
    });
  }

  /**
   * Synchronous compaction — used on teardown (hubDeregister) where we cannot
   * await. Best-effort: reads, trims to the last `cap` lines, rewrites. Swallows.
   */
  compactSync(): void {
    if (!this.filePath || this.closed) return;
    try {
      const text = fs.readFileSync(this.filePath, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      if (lines.length <= this.cap) return;
      const keep = lines.slice(lines.length - this.cap);
      fs.writeFileSync(this.filePath, keep.join("\n") + "\n", "utf8");
      this.lineCount = keep.length;
    } catch {
      /* swallow — best-effort */
    }
  }

  /** Await the serialized write chain (so a test can observe the on-disk state). */
  async flush(): Promise<void> {
    try {
      await this.chain;
    } catch {
      /* the chain steps already swallow; this is belt-and-suspenders */
    }
  }
}
