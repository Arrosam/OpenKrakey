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
  /** The bounded in-memory history, replayed to a browser on connect. */
  private readonly entries: TranscriptEntry[];
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
    this.entries = entries;
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

  /** The entries to replay to a connecting client (live array; read-only by contract). */
  list(): readonly TranscriptEntry[] {
    return this.entries;
  }

  /** The largest persisted message id (0 if none) — used to seed the id counter past every restart. */
  maxId(): number {
    let max = 0;
    for (const e of this.entries) {
      if (typeof e.id === "number") max = Math.max(max, e.id);
    }
    return max;
  }

  /**
   * Append one entry to the in-memory transcript AND chat.jsonl. The in-memory
   * transcript is capped at MAX_TRANSCRIPT (oldest dropped) so both replay and the
   * on-disk rewrite stay bounded (H-3). The file write is async and serialized onto
   * `writing` so it never blocks delivery and writes never interleave (M-7); a disk
   * error is swallowed (best-effort persistence) and once `closed` is set the append
   * is skipped, leaving compactSync's rewrite authoritative (M-9).
   */
  append(entry: TranscriptEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_TRANSCRIPT) this.entries.shift();
    this.writing = this.writing
      .then(() =>
        this.closed ? undefined : fs.promises.appendFile(this.chatPath, JSON.stringify(entry) + "\n"),
      )
      .catch(() => {});
  }

  /**
   * Flip the matching in-memory entry's status to "read" so a reconnect/replay shows
   * "read" immediately, and compactSync bakes it onto disk (M-9). No-op if no entry
   * carries that id.
   */
  markRead(id: number): void {
    const t = this.entries.find((e) => e.id === id);
    if (t) t.status = "read";
  }

  /**
   * Stop the async append chain, then synchronously rewrite the file from the
   * in-memory transcript — compacting it to <= MAX_TRANSCRIPT entries and baking in
   * current statuses (e.g. messages flipped to "read"), so it replays exactly after a
   * clean restart (M-9). Setting `closed` first makes any in-flight async append a
   * no-op, leaving this sync write authoritative. Best-effort.
   */
  compactSync(): void {
    this.closed = true;
    try {
      fs.writeFileSync(
        this.chatPath,
        this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : ""),
      );
    } catch {
      /* persistence is best-effort — a write failure must not break shutdown */
    }
  }
}
