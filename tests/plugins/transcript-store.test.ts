/**
 * UNIT edge tests for the `web-chat` plugin's TranscriptStore — the bounded per-agent
 * chat transcript + serialized `chat.jsonl` persistence extracted in web-chat's SRP
 * split (see overviews/nodes/web-chat.md change log 2026-06-15).
 *
 * Contract surface under test (derived ONLY from the web-chat node overview/spec — the
 * documented `TranscriptStore` API and the persistence behavior; NO web-chat
 * implementation internals were read):
 *
 *   import { TranscriptStore, MAX_TRANSCRIPT } from ".../web-chat/transcript-store";
 *   - TranscriptStore.load(chatPath): Promise<TranscriptStore>
 *       Loads any prior transcript at `chatPath` from disk (empty if none).
 *   - store.append(entry): void|Promise   // { role, text, id?, status?, at }
 *       Appends a message to the BOUNDED in-memory transcript (cap MAX_TRANSCRIPT,
 *       FIFO drop-oldest) and persists it (serialized async append).
 *   - store.list(): entries[]   // the in-memory transcript (oldest-first)
 *   - store.maxId(): number     // the max numeric `id` across stored entries
 *
 *   Bound: MAX_TRANSCRIPT (1000 per the spec) — the in-memory + on-disk + replay
 *   transcript never exceeds it; the OLDEST entries are evicted first (FIFO), so
 *   chronological order of the RETAINED window is preserved.
 *
 * This is a direct unit test (no child process / no server): it pins the eviction
 * semantics (cap + FIFO order + maxId) so an upcoming internal rewrite of the
 * eviction mechanism cannot regress order or cap. It should already PASS.
 *
 * Runs via `node --import tsx --test` (the repo's `npm test`), like every file
 * under tests/. Tests are NOT typechecked by tsc — they execute via tsx.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TranscriptStore, MAX_TRANSCRIPT } from "../../public_plugin/web-chat/transcript-store";

/** A unique temp `chat.jsonl` path under the OS temp dir (its parent exists). */
function tempChatPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-tstore-"));
  return path.join(dir, "chat.jsonl");
}

/** Append, awaiting if the store returns a promise (serialized async writes). */
async function append(store: any, entry: Record<string, unknown>): Promise<void> {
  await Promise.resolve(store.append(entry));
}

// ===========================================================================
// The exported bound is sane (a positive integer) — the eviction tests below
// are written against MAX_TRANSCRIPT so they track the real cap, but the bound
// itself must be a usable number.
// ===========================================================================

test("transcript-store: MAX_TRANSCRIPT is a positive integer cap", () => {
  assert.equal(typeof MAX_TRANSCRIPT, "number", "MAX_TRANSCRIPT must be a number");
  assert.ok(Number.isInteger(MAX_TRANSCRIPT), "MAX_TRANSCRIPT must be an integer");
  assert.ok(MAX_TRANSCRIPT > 0, "MAX_TRANSCRIPT must be > 0 (got " + MAX_TRANSCRIPT + ")");
});

// ===========================================================================
// State transition / BVA — eviction keeps exactly the LAST MAX_TRANSCRIPT
// entries, in chronological (FIFO) order, and maxId tracks the newest id.
// ===========================================================================

test("transcript-store: eviction keeps the last MAX_TRANSCRIPT entries in order (FIFO drop-oldest)", async () => {
  const chatPath = tempChatPath();
  const overflow = 5;
  const total = MAX_TRANSCRIPT + overflow;

  const s = await TranscriptStore.load(chatPath);
  try {
    // A fresh store starts empty.
    assert.deepEqual(s.list(), [], "a fresh store loads an empty transcript");

    // Append MAX_TRANSCRIPT + 5 user entries with strictly increasing ids/text.
    // ids start at 1; text encodes the id so order is verifiable by content.
    for (let id = 1; id <= total; id++) {
      await append(s, { role: "user", text: "m" + id, id, status: "sent", at: id });
    }

    const list = s.list();

    // CAP: never exceeds MAX_TRANSCRIPT.
    assert.equal(
      list.length,
      MAX_TRANSCRIPT,
      "the transcript is capped at MAX_TRANSCRIPT (got " + list.length + ", appended " + total + ")",
    );

    // FIFO: the oldest `overflow` (ids 1..5) are evicted; the FIRST retained
    // entry is the 6th appended (id === overflow+1).
    const firstId = overflow + 1; // 6
    assert.equal(list[0].id, firstId, "the oldest 5 entries are evicted; first retained id is " + firstId);
    assert.equal(list[0].text, "m" + firstId, "the first retained entry's text matches its id (order preserved)");

    // The LAST retained entry is the newest appended.
    assert.equal(list[list.length - 1].id, total, "the last retained entry is the newest (id " + total + ")");
    assert.equal(list[list.length - 1].text, "m" + total, "the last retained entry's text is the newest");

    // STRICT chronological order across the whole retained window: ids run
    // firstId..total with no gaps or reordering.
    for (let i = 0; i < list.length; i++) {
      const expectedId = firstId + i;
      assert.equal(list[i].id, expectedId, "retained entry at index " + i + " must have id " + expectedId);
      assert.equal(list[i].text, "m" + expectedId, "retained entry at index " + i + " text must be m" + expectedId);
    }

    // maxId reflects the newest id (NOT the count, NOT a stale evicted id).
    assert.equal(s.maxId(), total, "maxId() equals the newest appended id (" + total + ")");
  } finally {
    fs.rmSync(path.dirname(chatPath), { recursive: true, force: true });
  }
});

// ===========================================================================
// BVA — at exactly the cap, nothing is evicted (the boundary just below
// overflow): all MAX_TRANSCRIPT entries are retained, oldest first.
// ===========================================================================

test("transcript-store: at exactly MAX_TRANSCRIPT entries nothing is evicted (boundary)", async () => {
  const chatPath = tempChatPath();
  const s = await TranscriptStore.load(chatPath);
  try {
    for (let id = 1; id <= MAX_TRANSCRIPT; id++) {
      await append(s, { role: "user", text: "x" + id, id, status: "sent", at: id });
    }
    const list = s.list();
    assert.equal(list.length, MAX_TRANSCRIPT, "exactly MAX_TRANSCRIPT entries are all retained (none evicted)");
    assert.equal(list[0].id, 1, "the very first entry is still present at the boundary (nothing dropped yet)");
    assert.equal(list[list.length - 1].id, MAX_TRANSCRIPT, "the last entry is the newest");
    assert.equal(s.maxId(), MAX_TRANSCRIPT, "maxId() is the newest id at the boundary");
  } finally {
    fs.rmSync(path.dirname(chatPath), { recursive: true, force: true });
  }
});

// ===========================================================================
// One past the cap — a single eviction drops exactly the oldest entry.
// ===========================================================================

test("transcript-store: one past MAX_TRANSCRIPT evicts exactly the single oldest entry", async () => {
  const chatPath = tempChatPath();
  const total = MAX_TRANSCRIPT + 1;
  const s = await TranscriptStore.load(chatPath);
  try {
    for (let id = 1; id <= total; id++) {
      await append(s, { role: "user", text: "y" + id, id, status: "sent", at: id });
    }
    const list = s.list();
    assert.equal(list.length, MAX_TRANSCRIPT, "the cap holds at MAX_TRANSCRIPT");
    assert.equal(list[0].id, 2, "exactly the oldest (id 1) was evicted; first retained id is 2");
    assert.equal(list[list.length - 1].id, total, "the newest entry is retained");
    assert.equal(s.maxId(), total, "maxId() is the newest id");
  } finally {
    fs.rmSync(path.dirname(chatPath), { recursive: true, force: true });
  }
});

// ===========================================================================
// Empty store — list() empty and maxId() has a sane empty value.
// ===========================================================================

test("transcript-store: a fresh store is empty and maxId() is a sane empty value", async () => {
  const chatPath = tempChatPath();
  const s = await TranscriptStore.load(chatPath);
  try {
    assert.deepEqual(s.list(), [], "no entries before any append");
    const m = s.maxId();
    assert.equal(typeof m, "number", "maxId() returns a number even when empty");
    // No entries were appended, so no positive id can have been issued: the
    // empty max must be <= 0 (0 or a negative sentinel), never a positive id.
    assert.ok(m <= 0, "an empty transcript's maxId() must be <= 0 (got " + m + ")");
  } finally {
    fs.rmSync(path.dirname(chatPath), { recursive: true, force: true });
  }
});
