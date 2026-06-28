import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptStore } from "../../public_plugin/web-chat/transcript-store.ts";

// ---------------------------------------------------------------------------
// Read-receipt PERSISTENCE edge tests for TranscriptStore.
//
// Regression: markRead() flipped the in-memory entry only; the "read" status
// reached disk solely via compactSync() on a CLEAN teardown. Any non-graceful
// exit (crash, kill, restart.now's process.exit) skipped it, so a reloaded
// transcript showed every message as "sent". markRead must now WRITE THROUGH so
// "read" survives a reload with NO compactSync.
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-ts-"));
  createdDirs.push(dir);
  return path.join(dir, "chat.jsonl");
}
const settle = () => new Promise((r) => setTimeout(r, 50));

// Clean up every temp dir tmpFile() created (the rest of the suite pairs mkdtempSync
// with rmSync; this file must not orphan a dir on each run).
after(() => {
  for (const d of createdDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

test("markRead persists 'read' to disk immediately — survives a reload WITHOUT teardown/compactSync", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "hi", id: 1, status: "sent", at: 1 });
  s.append({ role: "agent", text: "hello", at: 2 });
  await settle(); // REAL timing: the "sent" append flushes to disk FIRST...
  s.markRead(1); // ...then, frames later, the read flips.
  await settle(); // let the write-through flush
  // Reload from disk exactly as a fresh boot would — NO compactSync was called.
  await s.flush(); // deterministic: wait for the write chain to reach disk (no timing race)
  const reloaded = await TranscriptStore.load(p);
  const entry = reloaded.list().find((e) => e.id === 1);
  assert.equal(entry?.status, "read", "the 'read' status must survive a reload without a graceful teardown");
});

test("markRead: unknown id is a no-op (no throw); already-read id is idempotent (no duplicate lines)", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "hi", id: 1, status: "sent", at: 1 });
  await settle();
  s.markRead(999); // unknown id
  s.markRead(1);
  s.markRead(1); // again — already read
  await settle();
  await s.flush(); // deterministic: wait for the write chain to reach disk (no timing race)
  const reloaded = await TranscriptStore.load(p);
  assert.equal(reloaded.list().find((e) => e.id === 1)?.status, "read");
  assert.equal(reloaded.list().length, 1, "no duplicate lines from repeated markRead");
});

test("interleaved append + markRead persist without duplicating lines", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "a", id: 1, status: "sent", at: 1 });
  await settle();
  s.markRead(1);
  s.append({ role: "user", text: "b", id: 2, status: "sent", at: 2 });
  s.append({ role: "agent", text: "reply", at: 3 });
  await settle();
  s.markRead(2);
  await settle();
  await s.flush(); // deterministic: wait for the write chain to reach disk (no timing race)
  const reloaded = await TranscriptStore.load(p);
  const userIds = reloaded.list().filter((e) => e.role === "user").map((e) => e.id);
  assert.deepEqual(userIds, [1, 2], "exactly one line per user message (no dup from rewrite/append interleave)");
  assert.equal(reloaded.list().find((e) => e.id === 1)?.status, "read");
  assert.equal(reloaded.list().find((e) => e.id === 2)?.status, "read");
});

test("markReadMany: flips every id and persists in one rewrite; survives reload, no duplicate lines", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "a", id: 1, status: "sent", at: 1 });
  s.append({ role: "user", text: "b", id: 2, status: "sent", at: 2 });
  s.append({ role: "user", text: "c", id: 3, status: "sent", at: 3 });
  await settle(); // the "sent" appends flush first (real timing)
  s.markReadMany([1, 2, 3]);
  await settle();
  await s.flush(); // deterministic: wait for the write chain to reach disk (no timing race)
  const reloaded = await TranscriptStore.load(p);
  const users = reloaded.list().filter((e) => e.role === "user");
  assert.deepEqual(users.map((e) => e.id), [1, 2, 3], "exactly one line per message (no dup)");
  assert.ok(users.every((e) => e.status === "read"), "every id flipped to read and persisted across reload");
});

test("markReadMany: an all-no-op set (unknown / already-read ids) adds no lines and does not throw", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "a", id: 1, status: "sent", at: 1 });
  await settle();
  s.markReadMany([1]); // flips id 1
  await settle();
  s.markReadMany([1, 999]); // 1 already read, 999 unknown → no change
  await settle();
  await s.flush(); // deterministic: wait for the write chain to reach disk (no timing race)
  const reloaded = await TranscriptStore.load(p);
  assert.equal(reloaded.list().length, 1, "no duplicate / extra lines from a no-op markReadMany");
  assert.equal(reloaded.list()[0].status, "read");
});

test("compactSync still writes the authoritative read statuses on teardown", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "hi", id: 1, status: "sent", at: 1 });
  s.markRead(1);
  s.compactSync(); // teardown path
  await s.flush(); // deterministic: wait for the write chain to reach disk (no timing race)
  const reloaded = await TranscriptStore.load(p);
  assert.equal(reloaded.list().find((e) => e.id === 1)?.status, "read");
});
