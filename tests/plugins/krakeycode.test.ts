import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Actions, Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";
import type { Message, ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the NEW `krakeycode` plugin — a coding-tool channel
// that gives the LLM filesystem + shell tools (read/write/edit/bash/list) plus
// two context blocks (a SYSTEM guidance block and a MESSAGES results block).
//
// Derived ONLY from the contract/spec (impl not read — it does not exist yet):
//   default export = PluginFactory; manifest = { id:"krakeycode",
//                                                 version:"0.1.0",
//                                                 requires:["llm.register_tool"] }
//   config slice (all optional w/ defaults):
//     mode "local"|"sandbox" (default "local"); root (default ctx.dataDir);
//     allowWrite (true); allowCommands (true); commandAllowlist [] (=all);
//     commandTimeoutMs (60000); maxReadBytes (1_000_000); maxOutputBytes
//     (200_000); maxResults (10); guidance (override); guidancePriority (7000);
//     resultsPriority (4000).
//   setup: TWO blocks (krakeycode.guidance @system/7000,
//          krakeycode.results @messages/4000) + FIVE actions/tools
//          (read_file, write_file, edit_file, bash, list_dir), each declared to
//          llm.register_tool.
//
// Windows host (win32): bash uses cmd.exe via shell:true, so commands use
// OS-AGNOSTIC `node -e "..."` so the suite passes on any platform.
// ---------------------------------------------------------------------------

const ID = "krakeycode";
const GUIDANCE_BLOCK = "krakeycode.guidance";
const RESULTS_BLOCK = "krakeycode.results";
const READ = "krakeycode.read_file";
const WRITE = "krakeycode.write_file";
const EDIT = "krakeycode.edit_file";
const BASH = "krakeycode.bash";
const LIST = "krakeycode.list_dir";
const ALL_ACTIONS = [READ, WRITE, EDIT, BASH, LIST];

// node binary the bash tests shell out to (OS-agnostic).
const NODE = process.execPath;

// ---- tolerant dynamic import: a missing module fails each test cleanly ----
const mod: any = await import("../../public_plugin/krakeycode/index.ts").then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "krakeycode module not implemented yet (import failed)");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// ---- temp-dir lifecycle (one root for the file; per-test subdirs under it) --
let TMP = "";
test.before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-kc-"));
});
test.after(() => {
  if (TMP) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
function tmpDir(): string {
  return fs.mkdtempSync(path.join(TMP, "d-"));
}

// ---- fake PluginContext over a REAL event system --------------------------
// Mirrors llm-core: a real "llm.register_tool" action records each received
// ToolDef into `tools` so tests can assert the five declarations. dataDir is a
// real temp dir so the file tools have somewhere to operate when config omits
// `root`.
function makeCtx(config: unknown, opts: { dataDir?: string } = {}) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  // Real recording action for tool registration (krakeycode invokes it per tool).
  sys.actions.register("llm.register_tool", async (def: unknown) => {
    tools.push(def as ToolDef);
    return true;
  });
  const dataDir = opts.dataDir ?? tmpDir();
  const ctx: any = {
    agentId: "agent-test",
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
  return { ctx, store, sys, tools, dataDir };
}

async function setup(config: unknown, opts: { dataDir?: string } = {}) {
  const p = plugin();
  const h = makeCtx(config, opts);
  await p.setup(h.ctx);
  return { p, ...h };
}

function guidanceBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(GUIDANCE_BLOCK);
  assert.ok(b, "setup must register a block under id 'krakeycode.guidance'");
  return b as ContextBlock;
}
function resultsBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(RESULTS_BLOCK);
  assert.ok(b, "setup must register a block under id 'krakeycode.results'");
  return b as ContextBlock;
}
const renderStr = async (b: ContextBlock): Promise<string> => (await b.render()) as string;
const renderMsgs = async (b: ContextBlock): Promise<Message[]> => (await b.render()) as Message[];

// Emit a tool.result envelope (Reply<unknown> & { name }) on the bus, as the
// orchestrator does for each settled tool call.
let _resSeq = 0;
function emitToolResult(
  sys: ReturnType<typeof createEventSystem>,
  fields: { name: string; ok: boolean; data?: unknown; error?: string },
) {
  sys.events.emit(Events.TOOL_RESULT, {
    id: "tr-" + ++_resSeq,
    at: Date.now(),
    ok: fields.ok,
    name: fields.name,
    data: fields.data,
    error: fields.error,
  });
}

// ===========================================================================
// 1. manifest / factory
// ===========================================================================

test("manifest/factory: default export is a function (PluginFactory)", () => {
  assert.equal(typeof mod?.default, "function", "krakeycode default export must be a function");
});

test("manifest: id 'krakeycode' and version '0.1.0'", () => {
  const p = plugin();
  assert.equal(p.manifest.id, ID);
  assert.equal(p.manifest.version, "0.1.0");
});

test("manifest: requires includes 'llm.register_tool'", () => {
  const p = plugin();
  assert.ok(Array.isArray(p.manifest.requires), "requires must be an array");
  assert.ok(
    p.manifest.requires.includes("llm.register_tool"),
    "requires must include llm.register_tool",
  );
});

// ===========================================================================
// 2. setup — context blocks
// ===========================================================================

test("guidance block: system-target at default priority 7000, label 'krakeycode.guidance'", async () => {
  const { store } = await setup({});
  const b = guidanceBlock(store);
  assert.equal(b.id, GUIDANCE_BLOCK);
  assert.notEqual((b as any).target, "messages", "guidance must target the system prompt");
  assert.equal(b.priority, 7000);
  assert.equal((b as any).label, GUIDANCE_BLOCK);
  assert.equal(typeof (await renderStr(b)), "string", "system block renders a string");
});

test("guidance block: guidancePriority overrides the default", async () => {
  const { store } = await setup({ guidancePriority: 12345 });
  assert.equal(guidanceBlock(store).priority, 12345);
});

test("guidance text: mentions krakeycode.read_file, docs/PLUGIN_DEV.md, and mode word 'local'", async () => {
  const { store } = await setup({});
  const text = await renderStr(guidanceBlock(store));
  assert.match(text, /krakeycode\.read_file/, "must name the read_file tool");
  assert.match(text, /docs\/PLUGIN_DEV\.md/, "must point at the dev guide path");
  assert.match(text, /\blocal\b/, "must state the current mode word (local by default)");
});

test("guidance text: cfg.guidance overrides verbatim", async () => {
  const { store } = await setup({ guidance: "CUSTOM GUIDANCE TEXT" });
  assert.equal(await renderStr(guidanceBlock(store)), "CUSTOM GUIDANCE TEXT");
});

test("results block: messages-target at default priority 4000, renders [] initially", async () => {
  const { store } = await setup({});
  const b = resultsBlock(store);
  assert.equal(b.id, RESULTS_BLOCK);
  assert.equal((b as any).target, "messages", "results must target the messages array");
  assert.equal(b.priority, 4000);
  const msgs = await renderMsgs(b);
  assert.ok(Array.isArray(msgs), "messages block renders an array");
  assert.deepEqual(msgs, [], "empty before any tool result arrives");
});

test("results block: resultsPriority overrides the default", async () => {
  const { store } = await setup({ resultsPriority: 999 });
  assert.equal(resultsBlock(store).priority, 999);
});

// ===========================================================================
// 3. setup — actions & ToolDefs
// ===========================================================================

test("setup: registers all five tool actions on the actionbus", async () => {
  const { sys } = await setup({});
  const list = sys.actions.list();
  for (const name of ALL_ACTIONS) {
    assert.ok(list.includes(name), `actions.list() must include ${name}`);
  }
});

test("setup: declares exactly five ToolDefs to llm.register_tool", async () => {
  const { tools } = await setup({});
  assert.equal(tools.length, 5, "exactly five ToolDefs declared");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...ALL_ACTIONS].sort());
});

test("ToolDefs: each has a non-empty description and a parameters object", async () => {
  const { tools } = await setup({});
  for (const t of tools) {
    assert.equal(typeof t.description, "string", `${t.name} description is a string`);
    assert.ok((t.description as string).length > 0, `${t.name} description is non-empty`);
    assert.equal(typeof t.parameters, "object", `${t.name} parameters is an object`);
    assert.ok(t.parameters !== null, `${t.name} parameters is non-null`);
  }
});

test("ToolDefs: required[] matches the spec per tool", async () => {
  const { tools } = await setup({});
  const byName = new Map(tools.map((t) => [t.name, t]));
  const requiredOf = (name: string): string[] => {
    const def = byName.get(name);
    assert.ok(def, `${name} ToolDef declared`);
    const req = (def!.parameters as any)?.required;
    assert.ok(Array.isArray(req), `${name} parameters.required is an array`);
    return [...req].sort();
  };
  assert.deepEqual(requiredOf(READ), ["path"]);
  assert.deepEqual(requiredOf(WRITE), ["content", "path"]);
  assert.deepEqual(requiredOf(EDIT), ["newText", "oldText", "path"]);
  assert.deepEqual(requiredOf(BASH), ["command"]);
  assert.deepEqual(requiredOf(LIST), ["path"]);
});

// ===========================================================================
// 4. read_file
// ===========================================================================

test("read_file: reads an existing utf8 file — content matches, truncated:false, path absolute", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "hello.txt");
  fs.writeFileSync(fp, "hello world", "utf8");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(READ, { path: fp });
  assert.equal(res.content, "hello world");
  assert.equal(res.truncated, false);
  assert.equal(res.encoding, "utf8");
  assert.equal(res.bytes, Buffer.byteLength("hello world"));
  assert.ok(path.isAbsolute(res.path), "returned path is absolute");
  assert.equal(path.resolve(res.path), path.resolve(fp), "path resolves to the file read");
});

test("read_file: maxBytes truncates — truncated:true and bytes == cap", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "big.txt");
  fs.writeFileSync(fp, "abcdefghij", "utf8"); // 10 bytes
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(READ, { path: fp, maxBytes: 4 });
  assert.equal(res.truncated, true);
  assert.equal(res.bytes, 4);
  assert.equal(res.content, "abcd");
});

test("read_file: encoding 'base64' round-trips to the original bytes", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "bin.dat");
  const original = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10]);
  fs.writeFileSync(fp, original);
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(READ, { path: fp, encoding: "base64" });
  assert.equal(res.encoding, "base64");
  assert.deepEqual(Buffer.from(res.content, "base64"), original);
});

test("read_file: missing file rejects", async () => {
  const dir = tmpDir();
  const { sys } = await setup({});
  await assert.rejects(sys.actions.invoke(READ, { path: path.join(dir, "nope.txt") }));
});

// ===========================================================================
// 5. write_file
// ===========================================================================

test("write_file: create — created:true and file on disk matches", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "new.txt");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(WRITE, { path: fp, content: "fresh" });
  assert.equal(res.created, true);
  assert.equal(fs.readFileSync(fp, "utf8"), "fresh");
});

test("write_file: overwrite an existing file — created:false", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "exists.txt");
  fs.writeFileSync(fp, "old", "utf8");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(WRITE, { path: fp, content: "new" });
  assert.equal(res.created, false);
  assert.equal(fs.readFileSync(fp, "utf8"), "new");
});

test("write_file: append:true appends rather than overwriting", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "log.txt");
  fs.writeFileSync(fp, "A", "utf8");
  const { sys } = await setup({});
  await sys.actions.invoke(WRITE, { path: fp, content: "B", append: true });
  assert.equal(fs.readFileSync(fp, "utf8"), "AB");
});

test("write_file: createDirs:true makes nested parent dirs and writes the file", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "a", "b", "c", "deep.txt");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(WRITE, {
    path: fp,
    content: "deep",
    createDirs: true,
  });
  assert.equal(res.created, true);
  assert.equal(fs.readFileSync(fp, "utf8"), "deep");
});

test("write_file: encoding 'base64' decodes content onto disk", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "decoded.bin");
  const bytes = Buffer.from([0x10, 0x20, 0x30, 0xff]);
  const { sys } = await setup({});
  await sys.actions.invoke(WRITE, {
    path: fp,
    content: bytes.toString("base64"),
    encoding: "base64",
  });
  assert.deepEqual(fs.readFileSync(fp), bytes);
});

test("write_file: allowWrite:false rejects", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "blocked.txt");
  const { sys } = await setup({ allowWrite: false });
  await assert.rejects(sys.actions.invoke(WRITE, { path: fp, content: "x" }));
  assert.equal(fs.existsSync(fp), false, "no file written when writes are disabled");
});

// ===========================================================================
// 6. edit_file
// ===========================================================================

test("edit_file: unique oldText — replacements:1 and file changed", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "edit.txt");
  fs.writeFileSync(fp, "the quick brown fox", "utf8");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(EDIT, {
    path: fp,
    oldText: "quick",
    newText: "slow",
  });
  assert.equal(res.replacements, 1);
  assert.equal(fs.readFileSync(fp, "utf8"), "the slow brown fox");
});

test("edit_file: oldText occurring twice WITHOUT replaceAll rejects and leaves file unchanged", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "dup.txt");
  const before = "aa-aa";
  fs.writeFileSync(fp, before, "utf8");
  const { sys } = await setup({});
  await assert.rejects(sys.actions.invoke(EDIT, { path: fp, oldText: "aa", newText: "bb" }));
  assert.equal(fs.readFileSync(fp, "utf8"), before, "file untouched on ambiguous edit");
});

test("edit_file: replaceAll:true replaces all occurrences (replacements === 2)", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "all.txt");
  fs.writeFileSync(fp, "aa-aa", "utf8");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(EDIT, {
    path: fp,
    oldText: "aa",
    newText: "bb",
    replaceAll: true,
  });
  assert.equal(res.replacements, 2);
  assert.equal(fs.readFileSync(fp, "utf8"), "bb-bb");
});

test("edit_file: oldText absent rejects", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "absent.txt");
  fs.writeFileSync(fp, "hello", "utf8");
  const { sys } = await setup({});
  await assert.rejects(sys.actions.invoke(EDIT, { path: fp, oldText: "xyz", newText: "q" }));
});

test("edit_file: newText '$&' is inserted LITERALLY (not a regex backref)", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "literal.txt");
  fs.writeFileSync(fp, "value=HERE", "utf8");
  const { sys } = await setup({});
  await sys.actions.invoke(EDIT, { path: fp, oldText: "HERE", newText: "$&" });
  assert.equal(fs.readFileSync(fp, "utf8"), "value=$&", "newText lands as the two chars '$&'");
});

test("edit_file: allowWrite:false rejects", async () => {
  const dir = tmpDir();
  const fp = path.join(dir, "ro.txt");
  fs.writeFileSync(fp, "keep", "utf8");
  const { sys } = await setup({ allowWrite: false });
  await assert.rejects(sys.actions.invoke(EDIT, { path: fp, oldText: "keep", newText: "drop" }));
  assert.equal(fs.readFileSync(fp, "utf8"), "keep", "file untouched when writes are disabled");
});

test("edit_file: missing file rejects", async () => {
  const dir = tmpDir();
  const { sys } = await setup({});
  await assert.rejects(
    sys.actions.invoke(EDIT, { path: path.join(dir, "ghost.txt"), oldText: "a", newText: "b" }),
  );
});

// ===========================================================================
// 7. bash  (OS-agnostic via `node -e`)
// ===========================================================================

test("bash: node stdout command — exitCode 0, stdout contains text, timedOut:false", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(BASH, {
    command: `"${NODE}" -e "process.stdout.write('hello')"`,
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /hello/);
  assert.equal(res.timedOut, false);
  assert.equal(typeof res.durationMs, "number");
});

test("bash: non-zero exit RESOLVES with exitCode 3 (does not reject)", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(BASH, {
    command: `"${NODE}" -e "process.exit(3)"`,
  });
  assert.equal(res.exitCode, 3);
  assert.equal(res.timedOut, false);
});

test("bash: a command exceeding timeoutMs sets timedOut:true", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(BASH, {
    command: `"${NODE}" -e "setTimeout(()=>{},10000)"`,
    timeoutMs: 300,
  });
  assert.equal(res.timedOut, true);
});

test("bash: allowCommands:false rejects", async () => {
  const { sys } = await setup({ allowCommands: false });
  await assert.rejects(
    sys.actions.invoke(BASH, { command: `"${NODE}" -e "process.stdout.write('x')"` }),
  );
});

test("bash: stdout is capped at maxOutputBytes", async () => {
  const cap = 1000;
  const { sys } = await setup({ maxOutputBytes: cap });
  const res: any = await sys.actions.invoke(BASH, {
    command: `"${NODE}" -e "process.stdout.write('x'.repeat(500000))"`,
  });
  assert.ok(
    Buffer.byteLength(res.stdout) <= cap,
    `stdout (${Buffer.byteLength(res.stdout)} bytes) must be <= cap ${cap}`,
  );
});

// ===========================================================================
// 8. list_dir
// ===========================================================================

test("list_dir: lists files (type 'file', size>0 for non-empty) and a subdir (type 'dir', size 0)", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "content", "utf8");
  fs.mkdirSync(path.join(dir, "sub"));
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(LIST, { path: dir });
  const byName = new Map(res.entries.map((e: any) => [e.name, e]));
  const file = byName.get("a.txt") as any;
  const sub = byName.get("sub") as any;
  assert.ok(file, "file entry present");
  assert.equal(file.type, "file");
  assert.ok(file.size > 0, "non-empty file has size > 0");
  assert.ok(sub, "subdir entry present");
  assert.equal(sub.type, "dir");
  assert.equal(sub.size, 0, "dir size is 0");
});

test("list_dir: depth 1 (default) does NOT include the nested file", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "x", "utf8");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(LIST, { path: dir });
  const names = res.entries.map((e: any) => e.name);
  assert.ok(!names.includes(path.join("sub", "nested.txt")), "no nested entry at depth 1");
  assert.ok(!names.includes("nested.txt"), "nested file not surfaced at depth 1");
});

test("list_dir: depth 2 includes the nested file with a path-joined relative name", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "x", "utf8");
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(LIST, { path: dir, depth: 2 });
  const names = res.entries.map((e: any) => e.name);
  assert.ok(
    names.includes(path.join("sub", "nested.txt")),
    "nested file present with path.join('sub','nested.txt') name",
  );
});

test("list_dir: missing dir rejects", async () => {
  const dir = tmpDir();
  const { sys } = await setup({});
  await assert.rejects(sys.actions.invoke(LIST, { path: path.join(dir, "no-such-dir") }));
});

// ===========================================================================
// 9. sandbox mode (mode:"sandbox", root: temp dir) — path confinement + allowlist
// ===========================================================================

test("sandbox: read_file with a traversal path rejects (escapes the sandbox root)", async () => {
  const root = tmpDir();
  // a real file OUTSIDE root, to ensure rejection is about confinement not absence.
  const outsideDir = tmpDir();
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top-secret", "utf8");
  const { sys } = await setup({ mode: "sandbox", root });
  await assert.rejects(
    sys.actions.invoke(READ, { path: "../../../../../../../../etc/passwd" }),
    "traversal must be rejected",
  );
});

test("sandbox: edit_file with an absolute path outside root rejects", async () => {
  const root = tmpDir();
  const outsideDir = tmpDir();
  const outside = path.join(outsideDir, "x.txt");
  fs.writeFileSync(outside, "abc", "utf8");
  const { sys } = await setup({ mode: "sandbox", root });
  await assert.rejects(sys.actions.invoke(EDIT, { path: outside, oldText: "abc", newText: "z" }));
  assert.equal(fs.readFileSync(outside, "utf8"), "abc", "outside file untouched");
});

test("sandbox: a valid relative path resolves under root and works", async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "inside.txt"), "ok", "utf8");
  const { sys } = await setup({ mode: "sandbox", root });
  const res: any = await sys.actions.invoke(READ, { path: "inside.txt" });
  assert.equal(res.content, "ok");
});

test("sandbox: commandAllowlist ['node'] runs a 'node ...' command", async () => {
  const root = tmpDir();
  const { sys } = await setup({ mode: "sandbox", root, commandAllowlist: ["node"] });
  const res: any = await sys.actions.invoke(BASH, {
    command: `node -e "process.stdout.write('allowed')"`,
  });
  assert.match(res.stdout, /allowed/);
});

test("sandbox: a command not in commandAllowlist rejects", async () => {
  const root = tmpDir();
  const { sys } = await setup({ mode: "sandbox", root, commandAllowlist: ["node"] });
  await assert.rejects(sys.actions.invoke(BASH, { command: `git status` }));
});

test("sandbox: empty commandAllowlist allows any command", async () => {
  const root = tmpDir();
  const { sys } = await setup({ mode: "sandbox", root, commandAllowlist: [] });
  const res: any = await sys.actions.invoke(BASH, {
    command: `"${NODE}" -e "process.stdout.write('any')"`,
  });
  assert.match(res.stdout, /any/);
});

// ===========================================================================
// 10. results fold (Events.TOOL_RESULT → krakeycode.results block)
// ===========================================================================

test("results fold: an own tool.result (ok:true) yields one user message naming the tool and 'ok'", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: READ, ok: true, data: { content: "hi" } });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  assert.equal(m.role, "user");
  assert.equal(m.name, "krakeycode");
  const content = String(m.content);
  assert.match(content, /krakeycode\.read_file/, "content names the tool");
  assert.match(content, /\bok\b/, "content states ok");
});

test("results fold: a FOREIGN tool.result name is ignored (ring stays empty)", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: "web.send_message", ok: true, data: { delivered: true } });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "foreign tool result does not enter the ring");
});

test("results fold: an ok:false result yields a message containing 'error' and the error string", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: WRITE, ok: false, error: "ENOENT boom" });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1);
  const content = String(msgs[0].content);
  assert.match(content, /error/i, "content marks the failure as error");
  assert.match(content, /ENOENT boom/, "content carries the error string");
});

test("results fold: ring respects maxResults (oldest dropped)", async () => {
  const max = 3;
  const { store, sys } = await setup({ maxResults: max });
  for (let i = 0; i < max + 2; i++) {
    emitToolResult(sys, { name: READ, ok: true, data: { i } });
  }
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, max, "ring keeps exactly maxResults entries");
});

test("results fold: invokes clock.fire_now on an own result when that action is registered", async () => {
  const { sys } = await setup({});
  let fired = 0;
  sys.actions.register(Actions.CLOCK_FIRE_NOW, async () => {
    fired++;
    return undefined;
  });
  emitToolResult(sys, { name: LIST, ok: true, data: { entries: [] } });
  // allow the fire-and-forget invoke to settle.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(fired >= 1, "clock.fire_now must be invoked on an own tool result");
});

test("results fold: does NOT throw when clock.fire_now is not registered", async () => {
  const { sys } = await setup({});
  assert.equal(sys.actions.has(Actions.CLOCK_FIRE_NOW), false, "precondition: no clock action");
  assert.doesNotThrow(() => {
    emitToolResult(sys, { name: BASH, ok: true, data: { exitCode: 0 } });
  });
  await new Promise((r) => setTimeout(r, 20));
});

// ===========================================================================
// 11. teardown
// ===========================================================================

test("teardown: removes both context blocks", async () => {
  const { p, store } = await setup({});
  assert.ok(store.get(GUIDANCE_BLOCK), "guidance present before teardown");
  assert.ok(store.get(RESULTS_BLOCK), "results present before teardown");
  await p.teardown();
  assert.equal(store.get(GUIDANCE_BLOCK), undefined, "guidance removed");
  assert.equal(store.get(RESULTS_BLOCK), undefined, "results removed");
});

test("teardown: unregisters all five actions (only llm.register_tool remains on the bus)", async () => {
  const { p, sys } = await setup({});
  await p.teardown();
  const remaining = sys.actions.list();
  for (const name of ALL_ACTIONS) {
    assert.ok(!remaining.includes(name), `${name} must be unregistered after teardown`);
  }
});

test("teardown: is idempotent (double teardown does not throw)", async () => {
  const { p } = await setup({});
  await p.teardown();
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "second teardown must not throw");
});
