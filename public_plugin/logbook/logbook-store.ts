/**
 * logbook · store — a bounded JSONL activity store.
 *
 * Two tiers:
 *  - an in-memory ring capped at `ringSize` (fast queries; what the tool reads),
 *  - an append-only JSONL file at <dataDir>/activity.jsonl (durability across
 *    restarts), written through a serialized async chain (best-effort; never
 *    throws), compacted when it grows past 2× `maxFileEntries`.
 *
 * The store assigns the monotonic `seq` (seeded past the persisted max on load),
 * so records survive a restart with a coherent, increasing sequence.
 */
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord, LogFilter } from "./logbook";
import { query as pureQuery } from "./logbook";

const FILE = "activity.jsonl";

export interface StoreConfig {
  ringSize: number;
  maxFileEntries: number;
}

export class LogbookStore {
  private readonly dataDir: string;
  private readonly ringSize: number;
  private readonly maxFileEntries: number;

  /** In-memory ring (chronological; oldest at index 0). */
  private ring: LogRecord[] = [];
  /** Next sequence number to assign. */
  private seq = 0;
  /** Count of physical lines currently in the file (approx; drives compaction). */
  private fileLines = 0;
  /** Serialized write chain — every disk op links onto this so writes never race. */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(dataDir: string, cfg: StoreConfig, seed: LogRecord[], seqStart: number) {
    this.dataDir = dataDir;
    this.ringSize = Math.max(1, Math.floor(cfg.ringSize));
    this.maxFileEntries = Math.max(1, Math.floor(cfg.maxFileEntries));
    this.ring = seed.slice(-this.ringSize);
    this.seq = seqStart;
    this.fileLines = seed.length;
  }

  /** The on-disk file path. */
  private get filePath(): string {
    return join(this.dataDir, FILE);
  }

  /**
   * Restore the last `maxFileEntries` valid records from disk (skipping malformed
   * lines) and seed `seq` past the max so new records keep increasing. Missing /
   * unreadable file → an empty store. Never throws.
   */
  static async load(dataDir: string, cfg: StoreConfig): Promise<LogbookStore> {
    const max = Math.max(1, Math.floor(cfg.maxFileEntries));
    let records: LogRecord[] = [];
    try {
      const raw = await readFile(join(dataDir, FILE), "utf8");
      records = parseJsonl(raw);
    } catch {
      records = [];
    }
    // Keep only the most-recent maxFileEntries.
    if (records.length > max) records = records.slice(records.length - max);

    let maxSeq = -1;
    for (const r of records) if (typeof r.seq === "number" && r.seq > maxSeq) maxSeq = r.seq;
    const seqStart = maxSeq + 1;

    return new LogbookStore(dataDir, cfg, records, seqStart);
  }

  /** The next seq the store would assign (without consuming it). */
  nextSeq(): number {
    return this.seq;
  }

  /**
   * Append a record: assign its seq, push into the ring (evicting the oldest past
   * `ringSize`), and queue a best-effort durable write. Returns the stored record.
   */
  append(rec: Omit<LogRecord, "seq"> | LogRecord): LogRecord {
    const stored: LogRecord = { ...(rec as LogRecord), seq: this.seq++ };
    this.ring.push(stored);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }
    this.queueWrite(stored);
    return stored;
  }

  /** A snapshot copy of the in-memory ring (chronological). */
  list(): LogRecord[] {
    return this.ring.slice();
  }

  /** Run a pure query over the in-memory ring. */
  query(filter: LogFilter): LogRecord[] {
    return pureQuery(this.ring, filter);
  }

  /** Await the pending write chain so a subsequent reload sees all appends. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Synchronous compacting rewrite for teardown: collapse the file down to the
   * last `maxFileEntries` records (the in-memory ring is the freshest source we
   * have synchronously). Best-effort; swallows errors.
   */
  compactSync(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const keep = this.ring.slice(-this.maxFileEntries);
      const body = keep.map((r) => JSON.stringify(r)).join("\n");
      writeFileSync(this.filePath, body ? body + "\n" : "", "utf8");
      this.fileLines = keep.length;
    } catch {
      /* best-effort — never throw on teardown */
    }
  }

  /** Link one record's durable write onto the serialized chain (errors swallowed). */
  private queueWrite(rec: LogRecord): void {
    const line = JSON.stringify(rec) + "\n";
    this.writeChain = this.writeChain
      .then(async () => {
        await ensureDir(this.dataDir);
        await appendFile(this.filePath, line, "utf8");
        this.fileLines += 1;
        if (this.fileLines > this.maxFileEntries * 2) {
          await this.compactAsync();
        }
      })
      .catch(() => {
        /* best-effort durability — never reject the chain */
      });
  }

  /**
   * Async compacting rewrite: keep the most-recent `maxFileEntries` rows from the
   * in-memory ring. Runs inside the write chain so no append interleaves.
   */
  private async compactAsync(): Promise<void> {
    const keep = this.ring.slice(-this.maxFileEntries);
    const body = keep.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(this.filePath, body ? body + "\n" : "", "utf8");
    this.fileLines = keep.length;
  }
}

/** Parse JSONL, skipping blank and malformed lines. */
function parseJsonl(raw: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof (obj as LogRecord).seq === "number") {
        out.push(obj as LogRecord);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Best-effort mkdir -p; ignores "already exists". */
async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}
