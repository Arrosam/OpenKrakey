import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import type { ContextBlock } from "../../contracts/context";
import type { Message } from "../../contracts/llm";
import { TranscriptStore, type TranscriptEntry } from "../../public_plugin/web-chat/transcript-store";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the conversation-WINDOWING helper being added to the
// web-chat plugin. The implementation does NOT exist yet; these tests are the
// acceptance criteria and are written from the spec only.
//
// SPEC (public_plugin/web-chat/windowing.ts):
//   windowTranscript(entries: readonly TranscriptEntry[], maxTurns: number,
//                    maxChars: number): readonly TranscriptEntry[]
//   - empty entries -> [].
//   - candidates = the LAST `maxTurns` entries (all if fewer).
//   - walk candidates NEWEST->oldest accumulating entry.text.length; include each
//     while cumulative <= maxChars; ALWAYS include at least the single newest
//     entry even if it alone exceeds maxChars; break at the first older entry that
//     would push cumulative over maxChars.
//   - return kept entries in CHRONOLOGICAL (oldest->newest) order. No mutation of
//     input. Entry granularity only (no per-entry text clipping).
//
// CONFIG DEFAULTS (public_plugin/web-chat/index.ts):
//   conversationMaxTurns (default 60), conversationMaxChars (default 24000);
//   invalid/missing/non-positive -> default. web-chat.conversation render() calls
//   windowTranscript(r.store.list(), maxTurns, maxChars) then maps each entry as
//   today: agent -> {role:"assistant", content}; user -> {role:"user", content,
//   name:"web-chat"}.
//
// The windowing module is imported through a TOLERANT dynamic import so a missing
// module fails each test on a clean assertion (mirroring system-prompt.test.ts).
// ---------------------------------------------------------------------------

const winMod: any = await import("../../public_plugin/web-chat/windowing.ts").then(
  (m) => m,
  () => null,
);

/** Tolerant accessor: a missing windowing module fails each test cleanly. */
function windowTranscript(
  entries: readonly TranscriptEntry[],
  maxTurns: number,
  maxChars: number,
): readonly TranscriptEntry[] {
  assert.ok(winMod, "windowing module not implemented yet (import of public_plugin/web-chat/windowing.ts failed)");
  assert.equal(
    typeof winMod?.windowTranscript,
    "function",
    "windowing.ts must export a function `windowTranscript`",
  );
  return winMod.windowTranscript(entries, maxTurns, maxChars);
}

/** Build a TranscriptEntry with the given text/role (timestamp is irrelevant here). */
const mk = (text: string, role: "user" | "agent" = "user"): TranscriptEntry => ({
  role,
  text,
  at: 0,
});

// ===========================================================================
// Part 1 — windowTranscript (pure function)
// ===========================================================================

test("1. empty array -> []", () => {
  const out = windowTranscript([], 60, 24000);
  assert.deepEqual(out, []);
  assert.equal(out.length, 0);
});

test("2. under turn limit: 5 entries -> all 5, same order, same text identity", () => {
  const es = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")];
  const out = windowTranscript(es, 60, 24000);
  assert.equal(out.length, 5);
  assert.deepEqual(
    out.map((e) => e.text),
    ["a", "b", "c", "d", "e"],
  );
  // Kept entries are the SAME entry objects, in the SAME chronological order.
  for (let i = 0; i < es.length; i++) {
    assert.equal(out[i], es[i], `entry ${i} must be the same identity, unchanged`);
  }
});

test("3. exactly at turn limit: N entries with maxTurns=N -> all N", () => {
  const N = 7;
  const es = Array.from({ length: N }, (_, i) => mk(String(i)));
  const out = windowTranscript(es, N, 24000);
  assert.equal(out.length, N);
  assert.deepEqual(
    out.map((e) => e.text),
    es.map((e) => e.text),
  );
});

test("4. over turn limit: 10 entries, maxTurns=3, huge chars -> last 3 chronological", () => {
  const es = Array.from({ length: 10 }, (_, i) => mk(String(i))); // "0".."9"
  const out = windowTranscript(es, 3, Number.MAX_SAFE_INTEGER);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((e) => e.text),
    ["7", "8", "9"],
  );
  // None of the first 7 are present.
  const keptTexts = new Set(out.map((e) => e.text));
  for (const t of ["0", "1", "2", "3", "4", "5", "6"]) {
    assert.ok(!keptTexts.has(t), `older entry "${t}" must be dropped`);
  }
});

test("5. char cap drops oldest: 5 entries of len 1000, maxChars=2500 -> newest 2", () => {
  // 5 entries, each text length EXACTLY 1000; the last char encodes the index 0..4.
  const exact = Array.from({ length: 5 }, (_, i) => mk("y".repeat(999) + String(i)));
  const out = windowTranscript(exact, 60, 2500);
  // 2 newest = 2000 <= 2500; a 3rd would be 3000 > 2500.
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((e) => e.text[e.text.length - 1]),
    ["3", "4"],
    "must keep the newest two (indices 3 and 4) in chronological order",
  );
  for (const e of out) {
    assert.equal(e.text.length, 1000, "entries must NOT be clipped (entry granularity only)");
  }
});

test("6. single oversized newest: 1 entry len 99999, maxChars=24000 -> still returned", () => {
  const es = [mk("z".repeat(99999))];
  const out = windowTranscript(es, 60, 24000);
  assert.equal(out.length, 1, "the single newest entry is always kept even if it exceeds maxChars");
  assert.equal(out[0], es[0]);
  assert.equal(out[0].text.length, 99999, "no clipping of the oversized entry");
});

test("7. oversized newest + 3 small older -> only the newest returned", () => {
  const older = [mk("aa"), mk("bb"), mk("cc")];
  const newest = mk("w".repeat(99999));
  const es = [...older, newest];
  const out = windowTranscript(es, 60, 24000);
  assert.equal(out.length, 1, "the newest alone already exceeds maxChars, so no older entry fits");
  assert.equal(out[0], newest);
});

test("8. both caps, turns tighter: 100 'x' entries, maxTurns=10, maxChars=50 -> 10", () => {
  const es = Array.from({ length: 100 }, () => mk("x")); // each len 1
  const out = windowTranscript(es, 10, 50);
  // 10 candidates, total chars 10 <= 50, so all 10 candidates fit.
  assert.equal(out.length, 10);
  for (const e of out) assert.equal(e.text, "x");
});

test("9. both caps, chars tighter: 100 'x' entries, maxTurns=10, maxChars=5 -> 5 (newest 5)", () => {
  const es = Array.from({ length: 100 }, () => mk("x")); // each len 1
  const out = windowTranscript(es, 10, 5);
  // candidates = last 10; cumulative cap 5 => keep newest 5.
  assert.equal(out.length, 5);
  for (const e of out) assert.equal(e.text, "x");
  // The kept entries must be the newest 5 candidates (identity check).
  for (let i = 0; i < 5; i++) {
    assert.equal(out[i], es[95 + i], `kept entry ${i} must be candidate index ${95 + i}`);
  }
});

test("10. no mutation: store.list() unaffected after windowTranscript", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-win-nomut-"));
  tmpDirs.push(dir);
  const chatPath = path.join(dir, "chat.jsonl");
  const seeded: TranscriptEntry[] = [
    { role: "user", text: "u1", id: 1, status: "sent", at: 1 },
    { role: "agent", text: "a1", at: 2 },
    { role: "user", text: "u2", id: 2, status: "read", at: 3 },
    { role: "agent", text: "a2", at: 4 },
    { role: "user", text: "u3", id: 3, status: "sent", at: 5 },
    { role: "agent", text: "a3", at: 6 },
  ];
  fs.writeFileSync(chatPath, seeded.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const store = await TranscriptStore.load(chatPath);
  const originalLen = store.list().length;
  assert.ok(originalLen > 5, "precondition: >5 entries loaded");

  const before = store.list();
  windowTranscript(store.list(), 1, 1);
  const after = store.list();

  assert.equal(store.list().length, originalLen, "store.list().length must be unchanged");
  assert.deepEqual(
    after.map((e) => e.text),
    before.map((e) => e.text),
    "the store's entries must be unchanged after windowing",
  );
});

// ===========================================================================
// Part 2 — config defaults integration (web plugin caps conversation at 60)
// ===========================================================================

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWebCtx(config: unknown, dataDir: string) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const ctx: any = {
    agentId: "agent-web-windowing",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir,
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => {
      store.set(b.id, b);
    },
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} },
    print() {},
  };
  return { ctx, store, sys };
}

test("config default conversationMaxTurns=60 caps the web-chat.conversation block to <= 60 messages (80 seeded)", async () => {
  const createWeb = (await import("../../public_plugin/web-chat/index.ts")).default;
  assert.equal(typeof createWeb, "function", "web-chat plugin must default-export a PluginFactory");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-win-cfg-"));
  tmpDirs.push(dir);
  const chatPath = path.join(dir, "chat.jsonl");

  // Seed MORE THAN 60 valid TranscriptEntry JSONL lines: 80 alternating turns.
  const SEEDED = 80;
  const lines: string[] = [];
  for (let i = 0; i < SEEDED; i++) {
    const role: "user" | "agent" = i % 2 === 0 ? "user" : "agent";
    const e: TranscriptEntry =
      role === "user"
        ? { role, text: "u" + i, id: i + 1, status: "sent", at: i + 1 }
        : { role, text: "a" + i, at: i + 1 };
    lines.push(JSON.stringify(e));
  }
  fs.writeFileSync(chatPath, lines.join("\n") + "\n");

  const plugin = createWeb();
  // Ephemeral port 0 so the server binds without conflict.
  const { ctx, store } = makeWebCtx({ port: 0 }, dir);

  try {
    // If setup throws because windowing / config defaults aren't implemented yet,
    // surface it as a clean assertion rather than a raw rejection.
    await plugin.setup(ctx).then(
      () => undefined,
      (err: unknown) => {
        assert.fail(
          "web-chat plugin setup() threw — windowing/config-defaults feature not implemented yet: " +
            String(err),
        );
      },
    );

    const block = store.get("web-chat.conversation");
    assert.ok(block, "setup must register the 'web-chat.conversation' block");

    const rendered = (await (block as ContextBlock).render()) as Message[];
    assert.ok(Array.isArray(rendered), "web-chat.conversation render() must return a Message[]");
    // The conversation TURNS are windowed to <= 60; a single trailing situational
    // status marker (name:"web-chat.status") may be appended BEYOND that turn budget.
    const turns = rendered.filter((m) => m.name !== "web-chat.status");
    const markers = rendered.filter((m) => m.name === "web-chat.status");
    assert.ok(
      turns.length <= 60,
      `web-chat.conversation must window TURNS to <= 60 (default conversationMaxTurns) but got ${turns.length} from ${SEEDED} seeded`,
    );
    assert.ok(markers.length <= 1, "at most one trailing status marker is appended");
    // Sanity: it should still contain the most recent turns mapped correctly.
    assert.ok(turns.length > 0, "with 80 seeded entries the conversation must not be empty");
    for (const m of rendered) {
      assert.ok(m.role === "assistant" || m.role === "user", "each turn maps to assistant|user");
    }
  } finally {
    await plugin.teardown();
  }
});
