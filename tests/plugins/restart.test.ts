import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import type { ContextBlock } from "../../contracts/context";
import type { Message, ToolDef } from "../../contracts/llm";
import { Events } from "../../shared/actions";
import {
  markerPath,
  readMarker,
  writeMarkerSync,
  deleteMarker,
  type RestartMarker,
} from "../../public_plugin/restart/marker.ts";

// ---------------------------------------------------------------------------
// Edge tests for the `restart` plugin. The plugin no longer owns process
// lifecycle: instead of process.exit it invokes the core `core.restart` action,
// which IS exercisable in-process by stubbing that action on the bus. dryRun still
// reports the plan WITHOUT restarting. Covered: tool registration, guidance, the
// reconstructed launch command (dryRun), the live core.restart delegation, and the
// no-seam degrade path.
//
// F1 (restart-completed observability): the LIVE branch drops a persisted marker
// on disk before invoking core.restart; on the NEXT boot the plugin's setup reads
// that marker and, when FRESH, injects a one-shot 'restart completed' observation
// message so the model knows its restart succeeded and does NOT loop restart.now.
// These tests are written from the pinned surface BEFORE it exists and go RED on
// main (no marker.ts, no observation block, no note fields) — they turn green once
// the F1 change lands. Every test uses its OWN fresh mkdtemp dataDir so marker
// files never collide.
// ---------------------------------------------------------------------------

const RESTART = "restart.now";
const GUIDANCE = "restart.guidance";
const OBSERVATION = "restart.observation";
const DEFAULT_MAX_AGE_MS = 300000; // config completedNoticeMaxAgeMs default

const mod: any = await import("../../public_plugin/restart/index.ts").then((m) => m, () => null);
function plugin(): any {
  assert.ok(mod, "restart module failed to import");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

/** A throwaway data dir, unique per test, so marker files never collide. */
function freshDataDir(): string {
  return fs.mkdtempSync(join(os.tmpdir(), "krakey-restart-"));
}

function makeCtx(config: unknown, dataDir: string = freshDataDir()) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  sys.actions.register("llm.register_tool", async (def: unknown) => { tools.push(def as ToolDef); return true; });
  const ctx: any = {
    agentId: "a", events: sys.events, actions: sys.actions, config, dataDir,
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => store.set(b.id, b),
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} }, print() {},
  };
  return { ctx, store, sys, tools, dataDir };
}
async function setup(config: unknown, dataDir?: string) {
  const p = plugin();
  const h = makeCtx(config, dataDir);
  await p.setup(h.ctx);
  return { p, ...h };
}

/** Render a messages-target block and assert it produced exactly one message. */
async function renderMessages(block: ContextBlock): Promise<Message[]> {
  const out = await block.render();
  assert.ok(Array.isArray(out), "a messages-target block must render an array");
  return out as Message[];
}

/** Concatenate a message's textual content (string or ContentPart[]) into one string. */
function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return (m.content as Array<{ type: string; text?: string }>)
    .map((p) => (p.type === "text" ? p.text ?? "" : ""))
    .join("");
}

// ===========================================================================
// manifest / basic registration
// ===========================================================================

test("manifest: id 'restart' v0.1.0", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "restart");
  assert.equal(p.manifest.version, "0.1.0");
});

test("setup: registers restart.now, declares one ToolDef, sets a system guidance block", async () => {
  const { sys, tools, store } = await setup({ dryRun: true });
  assert.ok(sys.actions.list().includes(RESTART), "restart.now registered");
  assert.deepEqual(tools.map((t) => t.name), [RESTART]);
  const b = store.get(GUIDANCE);
  assert.ok(b, "guidance block present");
  assert.notEqual((b as any).target, "messages", "guidance targets the system prompt");
});

test("teardown: removes the guidance block and unregisters the tool", async () => {
  const { p, sys, store } = await setup({ dryRun: true });
  await p.teardown();
  assert.equal(store.get(GUIDANCE), undefined, "guidance removed");
  assert.ok(!sys.actions.list().includes(RESTART), "restart.now unregistered");
});

// ===========================================================================
// restart.now — dryRun (positive: reports the plan, writes NOTHING to disk)
// ===========================================================================

test("restart.now (dryRun): returns the plan WITHOUT restarting, with a node launch command", async () => {
  const { sys, dataDir } = await setup({ dryRun: true });
  const res: any = await sys.actions.invoke(RESTART, { reason: "loading a new plugin" });
  assert.equal(res.restarting, false, "must NOT restart in dry run");
  assert.equal(res.dryRun, true);
  assert.ok(Array.isArray(res.command) && res.command.length >= 1, "reports a launch command");
  assert.equal(res.command[0], process.execPath, "command starts with the node executable");
  // F1: dryRun must NOT persist a marker.
  assert.equal(
    fs.existsSync(markerPath(dataDir)),
    false,
    "dryRun must NOT write a restart marker to disk",
  );
});

test("restart.now (dryRun): result carries a non-empty additive note mentioning DRY RUN and that no restart happened", async () => {
  const { sys } = await setup({ dryRun: true });
  const res: any = await sys.actions.invoke(RESTART, {});
  assert.equal(typeof res.note, "string", "dryRun result must carry a string note");
  assert.ok(res.note.length > 0, "dryRun note must be non-empty");
  assert.match(res.note, /DRY RUN/i, "dryRun note must mention DRY RUN");
  assert.match(res.note, /not|no|without/i, "dryRun note must convey that no restart happened");
});

// ===========================================================================
// restart.now — LIVE (delegates to core.restart AND persists the marker)
// ===========================================================================

test("restart.now (live): invokes core.restart with the configured delayMs (and never process.exit)", async () => {
  const { sys } = await setup({ delayMs: 2222 });
  const calls: unknown[] = [];
  sys.actions.register("core.restart", async (p: unknown) => { calls.push(p); return { restarting: true }; });
  const res: any = await sys.actions.invoke(RESTART, {});
  // This test process is still alive afterwards ⇒ the plugin did NOT call process.exit.
  assert.equal(res.restarting, true, "reports it is restarting");
  assert.equal(res.delayMs, 2222);
  assert.deepEqual(calls, [{ delayMs: 2222 }], "core.restart invoked once with the configured delayMs");
});

test("restart.now (live): writes a marker { completed:false } with requestedAt ≈ now and the launch command BEFORE invoking", async () => {
  const { sys, dataDir } = await setup({ delayMs: 1500 });
  const before = Date.now();
  sys.actions.register("core.restart", async () => ({ restarting: true }));
  await sys.actions.invoke(RESTART, { reason: "loading a new plugin" });
  const after = Date.now();

  assert.equal(fs.existsSync(markerPath(dataDir)), true, "live restart must persist a marker file");
  const m = readMarker(dataDir);
  assert.ok(m, "marker must read back as a valid RestartMarker");
  assert.equal(m!.completed, false, "the freshly written marker must be completed:false");
  assert.equal(m!.reason, "loading a new plugin", "marker must carry the given reason");
  assert.ok(
    m!.requestedAt >= before && m!.requestedAt <= after,
    `requestedAt (${m!.requestedAt}) must fall within [${before}, ${after}]`,
  );
  assert.ok(Array.isArray(m!.command), "marker command must be an array");
  assert.equal(m!.command![0], process.execPath, "marker command must start with the node executable");
});

test("restart.now (live): marker writes BEFORE core.restart is invoked (observable inside the seam)", async () => {
  const { sys, dataDir } = await setup({});
  let markerAtInvokeTime: RestartMarker | null = null;
  sys.actions.register("core.restart", async () => {
    // The marker must already be on disk by the time core.restart runs.
    markerAtInvokeTime = readMarker(dataDir);
    return { restarting: true };
  });
  await sys.actions.invoke(RESTART, {});
  assert.ok(markerAtInvokeTime, "marker must already exist when core.restart is invoked");
  assert.equal(markerAtInvokeTime!.completed, false, "marker written before invoke is completed:false");
});

test("restart.now (live): result carries a non-empty note mentioning rebooting and 'Do NOT call restart.now again'", async () => {
  const { sys } = await setup({});
  sys.actions.register("core.restart", async () => ({ restarting: true }));
  const res: any = await sys.actions.invoke(RESTART, {});
  assert.equal(typeof res.note, "string", "live result must carry a string note");
  assert.ok(res.note.length > 0, "live note must be non-empty");
  assert.match(res.note, /reboot|restart/i, "live note must mention rebooting/restarting");
  assert.match(res.note, /do NOT call restart\.now again/i, "live note must warn not to call restart.now again");
});

test("restart.now (live) with reason omitted: marker.reason is the empty string", async () => {
  const { sys, dataDir } = await setup({});
  sys.actions.register("core.restart", async () => ({ restarting: true }));
  await sys.actions.invoke(RESTART, {});
  const m = readMarker(dataDir);
  assert.ok(m, "marker present");
  assert.equal(m!.reason, "", "an omitted reason persists as the empty string");
});

// ===========================================================================
// restart.now — no-seam DEGRADE (no marker, non-empty note explaining why)
// ===========================================================================

test("restart.now (live) with NO core.restart seam: degrades to a no-op + error (no throw, no exit)", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(RESTART, {});
  assert.equal(res.restarting, false, "must not claim to restart without the core seam");
  assert.ok(typeof res.error === "string" && res.error.length > 0, "reports why it could not restart");
});

test("restart.now (degrade): writes NO marker and carries a non-empty note mentioning it is unavailable", async () => {
  const { sys, dataDir } = await setup({});
  const res: any = await sys.actions.invoke(RESTART, {});
  assert.equal(
    fs.existsSync(markerPath(dataDir)),
    false,
    "the degrade path must NOT write a restart marker",
  );
  assert.equal(typeof res.note, "string", "degrade result must carry a string note");
  assert.ok(res.note.length > 0, "degrade note must be non-empty");
  assert.match(res.note, /unavailable|not available|cannot|could not|can't/i, "degrade note must say restart is unavailable");
});

// ===========================================================================
// F1 — setup() observation block from a FRESH marker (state transition on disk)
// ===========================================================================

test("setup with a FRESH marker: registers the 'restart.observation' messages block at priority 250", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() - 5000; // 5s ago — well within the 5-min window
  writeMarkerSync(dataDir, { requestedAt, reason: "loading a new plugin", completed: false });

  const { store } = await setup({}, dataDir);
  const b = store.get(OBSERVATION);
  assert.ok(b, "a fresh, uncompleted marker must register the observation block");
  assert.equal(b!.target, "messages", "the observation block must target the messages array");
  assert.equal(b!.priority, 250, "the observation block priority must be 250");
});

test("setup with a FRESH marker: the observation renders ONE {role:'user', name:'restart'} completed message including the ISO time and reason", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() - 5000;
  const iso = new Date(requestedAt).toISOString();
  writeMarkerSync(dataDir, { requestedAt, reason: "loading a new plugin", completed: false });

  const { store } = await setup({}, dataDir);
  const msgs = await renderMessages(store.get(OBSERVATION)!);
  assert.equal(msgs.length, 1, "the observation must render exactly one message");
  const m = msgs[0];
  assert.equal(m.role, "user", "the completed message must be role:'user'");
  assert.equal(m.name, "restart", "the completed message must carry name:'restart'");
  const text = messageText(m);
  assert.match(text, /\[restart completed\]/i, "the message must be tagged '[restart completed]'");
  assert.ok(text.includes(iso), `the message must contain the ISO time ${iso}`);
  assert.match(text, /loading a new plugin/, "the message must include the reason clause");
  assert.match(text, /do NOT call restart\.now again/i, "the message must tell the model not to restart again");
});

test("setup with a FRESH marker whose reason is '': the completed message OMITS the reason clause", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() - 5000;
  writeMarkerSync(dataDir, { requestedAt, reason: "", completed: false });

  const { store } = await setup({}, dataDir);
  const msgs = await renderMessages(store.get(OBSERVATION)!);
  const text = messageText(msgs[0]);
  assert.match(text, /\[restart completed\]/i, "still a completed message");
  // No reason ⇒ no dangling "reason:" clause. Be lenient about phrasing but require
  // the word 'reason' not to appear (the clause is only rendered when non-empty).
  assert.doesNotMatch(text, /reason/i, "an empty reason must not produce a reason clause");
});

test("setup with a FRESH marker: rewrites the on-disk marker to completed:true (state transition)", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() - 5000;
  writeMarkerSync(dataDir, { requestedAt, reason: "loading a new plugin", completed: false });

  await setup({}, dataDir);
  const m = readMarker(dataDir);
  assert.ok(m, "marker must still exist after a fresh-marker setup");
  assert.equal(m!.completed, true, "setup must flip the fresh marker to completed:true");
  assert.equal(m!.requestedAt, requestedAt, "requestedAt must be preserved when marking completed");
});

// ===========================================================================
// F1 — setup() one-shot: after LLM_RETURN the observation renders []
// ===========================================================================

test("setup FRESH then LLM_RETURN: the observation block renders [] (one-shot; shown once then retired)", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() - 5000;
  writeMarkerSync(dataDir, { requestedAt, reason: "loading a new plugin", completed: false });

  const { store, sys } = await setup({}, dataDir);
  const block = store.get(OBSERVATION);
  assert.ok(block, "observation block present before the return");

  // First render shows the message...
  const first = await renderMessages(block!);
  assert.equal(first.length, 1, "renders the completed message before llm.return");

  // ...then a single frame's llm.return retires it.
  sys.events.emit(Events.LLM_RETURN, { at: Date.now(), data: {} });
  await Promise.resolve();

  // Re-fetch (the block may be removed, or may render []): either way it contributes nothing.
  const after = store.get(OBSERVATION);
  const rendered = after ? await after.render() : [];
  assert.ok(Array.isArray(rendered), "after llm.return the observation must render an array");
  assert.equal((rendered as Message[]).length, 0, "after llm.return the observation contributes no messages");
});

// ===========================================================================
// F1 — setup() with a COMPLETED marker: no block, marker deleted (BVA on `completed`)
// ===========================================================================

test("setup with a completed:true marker: NO observation block and the marker file is deleted", async () => {
  const dataDir = freshDataDir();
  writeMarkerSync(dataDir, { requestedAt: Date.now() - 5000, reason: "loading a new plugin", completed: true });

  const { store } = await setup({}, dataDir);
  assert.equal(store.get(OBSERVATION), undefined, "a completed marker must NOT register an observation block");
  assert.equal(
    fs.existsSync(markerPath(dataDir)),
    false,
    "a completed marker must be deleted on setup",
  );
});

// ===========================================================================
// F1 — setup() age BVA: stale marker suppressed & deleted; future-skew still fresh
// ===========================================================================

test("setup with a STALE marker (10 min old, default max 5 min): NO block and the marker is deleted", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago
  writeMarkerSync(dataDir, { requestedAt, reason: "loading a new plugin", completed: false });

  const { store } = await setup({}, dataDir); // default completedNoticeMaxAgeMs = 300000 (5 min)
  assert.equal(store.get(OBSERVATION), undefined, "a stale marker must NOT register an observation block");
  assert.equal(
    fs.existsSync(markerPath(dataDir)),
    false,
    "a stale marker must be deleted on setup",
  );
});

test("setup with a future-skewed marker (requestedAt = now + 30s): still FRESH (clock-skew tolerance)", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() + 30 * 1000; // 30s in the future — inside the -60000ms skew window
  writeMarkerSync(dataDir, { requestedAt, reason: "loading a new plugin", completed: false });

  const { store } = await setup({}, dataDir);
  const b = store.get(OBSERVATION);
  assert.ok(b, "a marker up to 60s in the future must still be treated as fresh");
  assert.equal(b!.target, "messages", "the observation block must target the messages array");
});

test("setup honours a custom completedNoticeMaxAgeMs: a 30s-old marker is STALE when max is 10000ms", async () => {
  const dataDir = freshDataDir();
  const requestedAt = Date.now() - 30 * 1000; // 30s ago
  writeMarkerSync(dataDir, { requestedAt, reason: "loading a new plugin", completed: false });

  const { store } = await setup({ completedNoticeMaxAgeMs: 10000 }, dataDir); // 10s window
  assert.equal(store.get(OBSERVATION), undefined, "a marker older than the configured window must be treated as stale");
  assert.equal(
    fs.existsSync(markerPath(dataDir)),
    false,
    "the stale marker must be deleted on setup",
  );
});

// ===========================================================================
// F1 — setup() absent / corrupt marker (negative / robustness)
// ===========================================================================

test("setup with NO marker file: no observation block and no throw (absent = no-op)", async () => {
  const dataDir = freshDataDir(); // empty dir, no marker written
  const { store } = await setup({}, dataDir);
  assert.equal(store.get(OBSERVATION), undefined, "an absent marker must not register an observation block");
});

test("setup with a CORRUPT marker file ('{not json'): no block, no throw, and readMarker returns null", async () => {
  const dataDir = freshDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(markerPath(dataDir), "{not json", "utf8");

  // setup must not throw on a corrupt marker.
  const { store } = await setup({}, dataDir);
  assert.equal(store.get(OBSERVATION), undefined, "a corrupt marker must not register an observation block");
  assert.equal(readMarker(dataDir), null, "readMarker must return null for a corrupt file");
});

test("setup with a SHAPE-INVALID marker (missing fields): no block, no throw", async () => {
  const dataDir = freshDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  // Valid JSON but not a RestartMarker (no requestedAt/completed).
  fs.writeFileSync(markerPath(dataDir), JSON.stringify({ hello: "world" }), "utf8");

  const { store } = await setup({}, dataDir);
  assert.equal(store.get(OBSERVATION), undefined, "a shape-invalid marker must not register an observation block");
  assert.equal(readMarker(dataDir), null, "readMarker must return null for a shape-invalid file");
});

// ===========================================================================
// F1 — marker.ts helpers (direct unit coverage of the pinned surface)
// ===========================================================================

test("marker helpers: writeMarkerSync then readMarker round-trips a RestartMarker", () => {
  const dataDir = freshDataDir();
  const marker: RestartMarker = {
    requestedAt: 1_700_000_000_000,
    reason: "loading a new plugin",
    completed: false,
    command: [process.execPath, "x.js"],
  };
  writeMarkerSync(dataDir, marker);
  const back = readMarker(dataDir);
  assert.deepEqual(back, marker, "readMarker must round-trip exactly what writeMarkerSync wrote");
});

test("marker helpers: markerPath is dataDir/restart-marker.json", () => {
  const dataDir = freshDataDir();
  assert.equal(markerPath(dataDir), join(dataDir, "restart-marker.json"));
});

test("marker helpers: readMarker on a missing file returns null (no throw)", () => {
  const dataDir = freshDataDir(); // nothing written
  assert.equal(readMarker(dataDir), null, "missing marker reads back as null");
});

test("marker helpers: writeMarkerSync creates the directory recursively when absent", () => {
  const base = freshDataDir();
  const nested = join(base, "deep", "nested"); // does not exist yet
  const marker: RestartMarker = { requestedAt: Date.now(), reason: "", completed: false };
  writeMarkerSync(nested, marker); // must mkdir -p
  assert.equal(fs.existsSync(markerPath(nested)), true, "writeMarkerSync must create missing parent dirs");
  assert.deepEqual(readMarker(nested), marker, "the marker must read back after a recursive write");
});

test("marker helpers: deleteMarker removes an existing marker and is a no-op when absent", () => {
  const dataDir = freshDataDir();
  writeMarkerSync(dataDir, { requestedAt: Date.now(), reason: "", completed: true });
  assert.equal(fs.existsSync(markerPath(dataDir)), true, "precondition: marker exists");
  deleteMarker(dataDir);
  assert.equal(fs.existsSync(markerPath(dataDir)), false, "deleteMarker removes the file");
  // Best-effort: a second delete on an absent file must not throw.
  assert.doesNotThrow(() => deleteMarker(dataDir), "deleteMarker on an absent file must be a no-op");
});

// ===========================================================================
// F1 — guidance text gains lifecycle phrasing
// ===========================================================================

test("guidance block: text gains restart-lifecycle phrasing (completion + never-loop)", async () => {
  const { store } = await setup({ dryRun: true });
  const b = store.get(GUIDANCE);
  assert.ok(b, "guidance block present");
  const rendered = await b!.render();
  assert.equal(typeof rendered, "string", "the guidance block renders a system-prompt string");
  const text = rendered as string;
  assert.match(text, /restart completed/i, "guidance must mention the 'restart completed' lifecycle");
  assert.match(
    text,
    /never call restart\.now again|do NOT call restart\.now again/i,
    "guidance must warn the model never to loop restart.now",
  );
});
