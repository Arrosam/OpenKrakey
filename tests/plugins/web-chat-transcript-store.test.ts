import { test } from "node:test";
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

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-ts-"));
  return path.join(dir, "chat.jsonl");
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("markRead persists 'read' to disk immediately — survives a reload WITHOUT teardown/compactSync", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "hi", id: 1, status: "sent", at: 1 });
  s.append({ role: "agent", text: "hello", at: 2 });
  await settle(); // REAL timing: the "sent" append flushes to disk FIRST...
  s.markRead(1); // ...then, beats later, the read flips.
  await settle(); // let the write-through flush
  // Reload from disk exactly as a fresh boot would — NO compactSync was called.
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
  const reloaded = await TranscriptStore.load(p);
  const userIds = reloaded.list().filter((e) => e.role === "user").map((e) => e.id);
  assert.deepEqual(userIds, [1, 2], "exactly one line per user message (no dup from rewrite/append interleave)");
  assert.equal(reloaded.list().find((e) => e.id === 1)?.status, "read");
  assert.equal(reloaded.list().find((e) => e.id === 2)?.status, "read");
});

test("compactSync still writes the authoritative read statuses on teardown", async () => {
  const p = tmpFile();
  const s = await TranscriptStore.load(p);
  s.append({ role: "user", text: "hi", id: 1, status: "sent", at: 1 });
  s.markRead(1);
  s.compactSync(); // teardown path
  const reloaded = await TranscriptStore.load(p);
  assert.equal(reloaded.list().find((e) => e.id === 1)?.status, "read");
});
