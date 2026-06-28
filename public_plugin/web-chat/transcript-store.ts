/**
 * The web channel's per-agent chat transcript — the in-memory history plus its
 * bounded, best-effort `chat.jsonl` persistence. One store per Agent (R6: each
 * agent keeps its own); the hub never sees it, only the per-factory closure does.
 *
 * Bounding (H-3): at most MAX_TRANSCRIPT entries are kept in memory AND on disk, so
 * both replay-on-connect and the on-disk file stay bounded no matter how long an
 * agent runs. Persistence is best-effort: file writes are async, serialized, and
 * swallow errors so they never block or break message delivery (M-7); once `closed`
 * (teardown) async appends no-op, leaving the synchronous compacting rewrite
 * authoritative (M-9).
 *
 * Storage is an indexed ring (a backing array with a `head` index + `count`): at
 * capacity an append advances `head` instead of shifting the array, so eviction is
 * O(1). The backing array is bulk-compacted (dead prefix sliced off) only once it
 * grows past 2×MAX_TRANSCRIPT, which makes appends amortized O(1) while keeping the
 * retained window bounded. `list()` materializes the live window in FIFO order.
 */
import * as fs from "node:fs";

/** Hard cap on transcript entries kept in memory and rewritten to disk (bounds replay + file growth). */
export const MAX_TRANSCRIPT = 1000;

/**
 * One persisted line of an agent's chat transcript (the chat.jsonl wire shape).
 * `id`/`status` are present only for user messages (carried so a replayed `sent`
 * tick survives a reload); agent messages have just role/text/at.
 */
export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  id?: number;
  status?: string;
  at: number;
}

export class TranscriptStore {
  /**
   * Backing store for the indexed ring. The live window is `buf[head .. head+count)`
   * (oldest→newest); slots before `head` are evicted entries awaiting bulk compaction.
   */
  private buf: TranscriptEntry[];
  /** Index of the oldest retained entry in `buf` (advanced on eviction; reset by compaction). */
  private head = 0;
  /** Number of retained entries (always <= MAX_TRANSCRIPT). */
  private count: number;
  /** Absolute path of this agent's chat.jsonl under ctx.dataDir (agent-isolated at runtime). */
  private readonly chatPath: string;
  /**
   * Serialized async append chain: each `append` chains its file write onto the
   * prior one so writes never interleave and never block delivery (M-7). Errors are
   * swallowed (best-effort persistence). Goes inert once `closed` is set (teardown).
   */
  private writing: Promise<void> = Promise.resolve();
  /** Set true in compactSync so any in-flight async append no-ops, leaving the sync rewrite authoritative. */
  private closed = false;

  private constructor(chatPath: string, entries: TranscriptEntry[]) {
    this.chatPath = chatPath;
    this.buf = entries;
    this.count = entries.length;
  }

  /**
   * Load a chat.jsonl into a store, one JSON object per line; skip malformed lines
   * and keep only the LAST MAX_TRANSCRIPT valid entries (H-3 bound). Each kept entry
   * preserves its `id`/`status` so a persisted `sent`/`read` tick replays after a
   * restart (M-9). Async read — never blocks the event loop.
   */
  static async load(chatPath: string): Promise<TranscriptStore> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(chatPath, "utf8");
    } catch {
      return new TranscriptStore(chatPath, []); // no history yet (or unreadable) — start empty
    }
    const out: TranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s) as TranscriptEntry;
        if (e && (e.role === "user" || e.role === "agent") && typeof e.text === "string") out.push(e);
      } catch {
        /* ignore a malformed line */
      }
    }
    const kept = out.length > MAX_TRANSCRIPT ? out.slice(out.length - MAX_TRANSCRIPT) : out;
    return new TranscriptStore(chatPath, kept);
  }

  /**
   * The entries to replay to a connecting client, oldest→newest, capped at
   * MAX_TRANSCRIPT. Materializes the ring's live window into a fresh array (read
   * only for replay), so the caller never observes the evicted prefix.
   */
  list(): readonly TranscriptEntry[] {
    return this.buf.slice(this.head, this.head + this.count);
  }

  /** The largest persisted message id (0 if none) — used to seed the id counter past every restart. */
  maxId(): number {
    let max = 0;
    const end = this.head + this.count;
    for (let i = this.head; i < end; i++) {
      const id = this.buf[i].id;
      if (typeof id === "number") max = Math.max(max, id);
    }
    return max;
  }

  /**
   * Append one entry to the in-memory transcript AND chat.jsonl. The in-memory
   * transcript is capped at MAX_TRANSCRIPT (oldest evicted in O(1) by advancing the
   * ring head) so both replay and the on-disk rewrite stay bounded (H-3); the dead
   * prefix is bulk-sliced only once the backing array exceeds 2×MAX_TRANSCRIPT, so
   * appends are amortized O(1). The file write is async and serialized onto `writing`
   * so it never blocks delivery and writes never interleave (M-7); a disk error is
   * swallowed (best-effort persistence) and once `closed` is set the append is
   * skipped, leaving compactSync's rewrite authoritative (M-9).
   */
  append(entry: TranscriptEntry): void {
    this.buf.push(entry);
    if (this.count < MAX_TRANSCRIPT) {
      this.count++;
    } else {
      // At capacity: evict the oldest in O(1) by advancing the head. Bulk-compact
      // the dead prefix only when it has grown large, keeping appends amortized O(1).
      this.head++;
      if (this.head > MAX_TRANSCRIPT) {
        this.buf = this.buf.slice(this.head);
        this.head = 0;
      }
    }
    this.writing = this.writing
      .then(() =>
        this.closed ? undefined : fs.promises.appendFile(this.chatPath, JSON.stringify(entry) + "\n"),
      )
      .catch(() => {});
  }

  /** Flip one entry to "read" and persist (see markReadMany for the rationale). */
  markRead(id: number): void {
    if (this.flip(id)) this.persist();
  }

  /**
   * Flip MANY entries to "read" in ONE persisted rewrite. A completed frame marks every
   * message it carried read at once; coalescing avoids a full-file rewrite PER message.
   * No-op (no write) when nothing actually changed.
   */
  markReadMany(ids: readonly number[]): void {
    let changed = false;
    for (const id of ids) changed = this.flip(id) || changed;
    if (changed) this.persist();
  }

  /**
   * Await every file write enqueued so far (the serialized `writing` chain). Persistence
   * is otherwise fire-and-forget; this lets a caller wait for the current append/persist
   * chain to actually reach disk — e.g. before a deterministic reload, so a reader never
   * races an in-flight write. Resolves even if a write failed (errors are swallowed,
   * best-effort persistence).
   */
  async flush(): Promise<void> {
    await this.writing;
  }

  /** Flip one retained entry to "read" in memory; returns true iff it changed. No-op for an unknown/already-read id. */
  private flip(id: number): boolean {
    const end = this.head + this.count;
    for (let i = this.head; i < end; i++) {
      if (this.buf[i].id === id) {
        if (this.buf[i].status === "read") return false;
        this.buf[i].status = "read";
        return true;
      }
    }
    return false;
  }

  /**
   * Persist the current window NOW so the "read" flips survive a NON-graceful exit
   * (crash, kill, or restart.now's process.exit — none run teardown/compactSync).
   * Append-only JSONL can't patch a line in place, so rewrite the compacted window. The
   * snapshot is taken SYNCHRONOUSLY (the file content as of this call) and the write is
   * chained onto `writing`, so it never interleaves with appends (no duplicated lines)
   * and never blocks delivery; once `closed` (teardown), it no-ops and the synchronous
   * compactSync rewrite is authoritative.
   */
  private persist(): void {
    const snapshot = this.serialize();
    this.writing = this.writing
      .then(() => (this.closed ? undefined : fs.promises.writeFile(this.chatPath, snapshot)))
      .catch(() => {});
  }

  /** The live window serialized as chat.jsonl text (trailing newline iff non-empty). */
  private serialize(): string {
    const kept = this.buf.slice(this.head, this.head + this.count);
    return kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : "");
  }

  /**
   * Stop the async append chain, then synchronously rewrite the file from the
   * in-memory transcript — compacting it to <= MAX_TRANSCRIPT entries and baking in
   * current statuses (e.g. messages flipped to "read"), so it replays exactly after a
   * clean restart (M-9). Setting `closed` first makes any in-flight async append/
   * write-through a no-op, leaving this sync write authoritative. Best-effort.
   */
  compactSync(): void {
    this.closed = true;
    try {
      fs.writeFileSync(this.chatPath, this.serialize());
    } catch {
      /* persistence is best-effort — a write failure must not break shutdown */
    }
  }
}
