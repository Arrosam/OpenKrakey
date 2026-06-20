import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import { Actions, Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";
import type { Message, ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the NEW `browser` plugin — a Krakey-managed Chrome
// controlled over raw CDP. Derived ONLY from the contract + refined spec (the
// implementation does not exist yet and is NOT read here).
//
// Surface under test:
//   public_plugin/browser/config.ts  (PURE helpers — called directly):
//     readConfig, buildDefaultGuidance, capText, sanitizeScreenshotName,
//     pushResult, renderResults  (+ BrowserConfig / ResultEntry types)
//   public_plugin/browser/cdp.ts     (PURE exports only):
//     findChromeBinary, buildCdpMessage
//   public_plugin/browser/index.ts   (default export = PluginFactory):
//     manifest { id:"browser", version:"0.1.0", requires:["llm.register_tool"] }
//     setup -> 5 actions + 5 ToolDefs + 2 blocks + tool.result listener
//     teardown -> unregisters all 5 actions + removes both blocks
//
// HARD SCOPE LIMIT: we never trigger a Chrome launch. The only ACTION behaviors
// exercised are (a) browser.navigate with an INVALID url (rejects pre-launch),
// and (b) browser.list_tabs with no launch (resolves {launched:false,tabs:[]}).
// All Chrome happy paths are out of scope (manual/smoke acceptance).
// ---------------------------------------------------------------------------

const ID = "browser";
const GUIDANCE_BLOCK = "browser.guidance";
const RESULTS_BLOCK = "browser.results";

const NAVIGATE = "browser.navigate";
const READ_PAGE = "browser.read_page";
const LIST_TABS = "browser.list_tabs";
const ACTIVATE_TAB = "browser.activate_tab";
const SCREENSHOT = "browser.screenshot";
const ALL_TOOLS = [NAVIGATE, READ_PAGE, LIST_TABS, ACTIVATE_TAB, SCREENSHOT];

const DEFAULT_GUIDANCE_PRIORITY = 5500;
const DEFAULT_RESULTS_PRIORITY = 3000;

// ---- tolerant dynamic import: a missing module fails each test cleanly ----
const mod: any = await import("../../public_plugin/browser/index.ts").then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "browser module not implemented yet (import failed)");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// ---- tolerant dynamic import of the pure-helper modules --------------------
const config: any = await import("../../public_plugin/browser/config.ts").then(
  (m) => m,
  () => null,
);
const cdp: any = await import("../../public_plugin/browser/cdp.ts").then(
  (m) => m,
  () => null,
);
function cfgMod(): any {
  assert.ok(config, "browser/config.ts not implemented yet (import failed)");
  return config;
}
function cdpMod(): any {
  assert.ok(cdp, "browser/cdp.ts not implemented yet (import failed)");
  return cdp;
}

// ---- fake PluginContext over a REAL event system --------------------------
// Records every ToolDef declared to llm.register_tool, backs blocks with a Map,
// and records clock.fire_now invocations.
function makeCtx(rawConfig: unknown) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  sys.actions.register("llm.register_tool", async (def: unknown) => {
    tools.push(def as ToolDef);
    return true;
  });
  const fireNow: { count: number } = { count: 0 };
  const ctx: any = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config: rawConfig,
    dataDir: "/tmp/browser-test-datadir",
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
  return { ctx, store, sys, tools, fireNow };
}

// Install a recording clock.fire_now BEFORE setup, so the plugin can fire it.
function registerFireNow(sys: ReturnType<typeof createEventSystem>, fireNow: { count: number }) {
  sys.actions.register(Actions.CLOCK_FIRE_NOW, async () => {
    fireNow.count++;
    return undefined;
  });
}

async function setup(rawConfig: unknown, opts: { withClock?: boolean } = {}) {
  const p = plugin();
  const h = makeCtx(rawConfig);
  if (opts.withClock) registerFireNow(h.sys, h.fireNow);
  await p.setup(h.ctx);
  return { p, ...h };
}

function guidanceBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(GUIDANCE_BLOCK);
  assert.ok(b, "setup must register a block under id 'browser.guidance'");
  return b as ContextBlock;
}
function resultsBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(RESULTS_BLOCK);
  assert.ok(b, "setup must register a block under id 'browser.results'");
  return b as ContextBlock;
}
const renderStr = async (b: ContextBlock): Promise<string> => (await b.render()) as string;
const renderMsgs = async (b: ContextBlock): Promise<Message[]> => (await b.render()) as Message[];

// Emit a tool.result envelope (Reply<unknown> & { name }) on the bus.
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

// A representative successful navigate/read payload (carried as tool.result data).
function navData(url = "https://example.com") {
  return { url, title: "Example", launched: true };
}

// ===========================================================================
// 1. manifest / factory  (positive)
// ===========================================================================

test("manifest/factory: default export is a function (PluginFactory)", () => {
  assert.equal(typeof mod?.default, "function", "browser default export must be a function");
});

test("manifest: id 'browser' and version '0.1.0'", () => {
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

test("factory: two factory calls produce independent plugin instances (no shared state)", () => {
  assert.ok(mod, "browser module not implemented yet");
  const a = mod.default();
  const b = mod.default();
  assert.notEqual(a, b, "each factory call yields a fresh Plugin instance");
});

// ===========================================================================
// 2. setup — context blocks  (positive + boundary on priorities)
// ===========================================================================

test("guidance block: system-target at default priority 5500, id 'browser.guidance'", async () => {
  const { store } = await setup({});
  const b = guidanceBlock(store);
  assert.equal(b.id, GUIDANCE_BLOCK);
  assert.notEqual((b as any).target, "messages", "guidance must target the system prompt");
  assert.equal(b.priority, DEFAULT_GUIDANCE_PRIORITY);
  assert.equal(typeof (await renderStr(b)), "string", "system block renders a string");
});

test("guidance block: guidancePriority overrides the default", async () => {
  const { store } = await setup({ guidancePriority: 1234 });
  assert.equal(guidanceBlock(store).priority, 1234);
});

test("results block: messages-target at default priority 3000, renders [] initially", async () => {
  const { store } = await setup({});
  const b = resultsBlock(store);
  assert.equal(b.id, RESULTS_BLOCK);
  assert.equal((b as any).target, "messages", "results must target the messages array");
  assert.equal(b.priority, DEFAULT_RESULTS_PRIORITY);
  const msgs = await renderMsgs(b);
  assert.ok(Array.isArray(msgs), "messages block renders an array");
  assert.deepEqual(msgs, [], "empty before any result is recorded");
});

test("results block: resultsPriority overrides the default", async () => {
  const { store } = await setup({ resultsPriority: 777 });
  assert.equal(resultsBlock(store).priority, 777);
});

test("guidance text (via block render): names all 5 tools, says read/navigate-only + 'browser' next-beat", async () => {
  const { store } = await setup({});
  const text = await renderStr(guidanceBlock(store));
  for (const t of ALL_TOOLS) {
    assert.match(text, new RegExp(t.replace(".", "\\.")), `guidance must name ${t}`);
  }
  assert.match(text, /\bread\b/i, "guidance must contain the word 'read'");
  assert.match(text, /\bnavigate\b/i, "guidance must contain the word 'navigate'");
  assert.ok(!/\bclick\b/i.test(text), "guidance must NOT advertise click");
  assert.ok(!/\btype\b/i.test(text), "guidance must NOT advertise type");
  assert.match(text, /browser/, "guidance must mention the 'browser' result tag / next beat");
});

test("block render(): guidance + results never throw on an empty plugin", async () => {
  const { store } = await setup({});
  await assert.doesNotReject(async () => {
    const g = await renderStr(guidanceBlock(store));
    assert.equal(typeof g, "string");
    const r = await renderMsgs(resultsBlock(store));
    assert.ok(Array.isArray(r));
  });
});

// ===========================================================================
// 3. setup — the FIVE ToolDefs + FIVE actions  (positive)
// ===========================================================================

test("setup: registers EXACTLY the 5 browser actions on the actionbus", async () => {
  const { sys } = await setup({});
  for (const a of ALL_TOOLS) {
    assert.ok(sys.actions.has(a), `actions.has() must include ${a}`);
  }
  const browserActions = sys.actions.list().filter((a) => a.startsWith("browser."));
  assert.equal(browserActions.length, 5, "exactly five browser.* actions registered");
});

test("setup: declares exactly 5 ToolDefs to llm.register_tool, names = the 5 actions", async () => {
  const { tools } = await setup({});
  assert.equal(tools.length, 5, "exactly five ToolDefs declared (one per tool)");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...ALL_TOOLS].sort(), "tool names match the 5 actions");
});

test("ToolDef: each has a JSON-schema parameters object", async () => {
  const { tools } = await setup({});
  for (const t of tools) {
    assert.equal(typeof t.parameters, "object", `${t.name}: parameters is an object`);
    assert.ok(t.parameters !== null, `${t.name}: parameters non-null`);
  }
});

test("ToolDef: browser.navigate requires ['url']", async () => {
  const { tools } = await setup({});
  const nav = tools.find((t) => t.name === NAVIGATE)!;
  const params = nav.parameters as any;
  assert.ok(params.properties && params.properties.url, "navigate declares a 'url' property");
  assert.ok(Array.isArray(params.required), "navigate.required is an array");
  assert.ok(params.required.includes("url"), "navigate requires 'url'");
});

test("ToolDef: browser.activate_tab requires ['tabId']", async () => {
  const { tools } = await setup({});
  const at = tools.find((t) => t.name === ACTIVATE_TAB)!;
  const params = at.parameters as any;
  assert.ok(params.properties && params.properties.tabId, "activate_tab declares a 'tabId' property");
  assert.ok(Array.isArray(params.required), "activate_tab.required is an array");
  assert.ok(params.required.includes("tabId"), "activate_tab requires 'tabId'");
});

test("ToolDef: browser.read_page has an OPTIONAL format enum (text|html), not required", async () => {
  const { tools } = await setup({});
  const rp = tools.find((t) => t.name === READ_PAGE)!;
  const params = rp.parameters as any;
  assert.ok(params.properties && params.properties.format, "read_page declares a 'format' property");
  const fmt = params.properties.format;
  if (Array.isArray(fmt.enum)) {
    assert.deepEqual([...fmt.enum].sort(), ["html", "text"], "format enum is text|html");
  }
  const required = Array.isArray(params.required) ? params.required : [];
  assert.ok(!required.includes("format"), "format is NOT required");
});

test("ToolDef: list_tabs and screenshot declare no required params", async () => {
  const { tools } = await setup({});
  for (const name of [LIST_TABS, SCREENSHOT]) {
    const t = tools.find((x) => x.name === name)!;
    const params = t.parameters as any;
    const required = Array.isArray(params.required) ? params.required : [];
    assert.equal(required.length, 0, `${name} has no required params`);
  }
});

// ===========================================================================
// 4. action behaviors that DO NOT launch Chrome  (positive + negative)
// ===========================================================================

for (const bad of [
  { label: "not a url string", url: "not a url" },
  { label: "empty string", url: "" },
  { label: "number", url: 123 as any },
]) {
  test(`navigate: invalid url (${bad.label}) REJECTS on validation before any launch`, async () => {
    const { sys } = await setup({});
    await assert.rejects(
      sys.actions.invoke(NAVIGATE, { url: bad.url }),
      `navigate must reject an invalid url (${bad.label}) before launching Chrome`,
    );
  });
}

test("navigate: a missing url object rejects before launch", async () => {
  const { sys } = await setup({});
  await assert.rejects(sys.actions.invoke(NAVIGATE, {}), "missing url must reject");
});

test("list_tabs: never-launched -> resolves {launched:false, tabs:[]} (no auto-launch)", async () => {
  const { sys } = await setup({});
  const res: any = await sys.actions.invoke(LIST_TABS, {});
  assert.ok(res && typeof res === "object", "list_tabs resolves an object");
  assert.equal(res.launched, false, "read-only introspection must NOT auto-launch Chrome");
  assert.ok(Array.isArray(res.tabs), "tabs is an array");
  assert.deepEqual(res.tabs, [], "tabs is empty when Chrome was never launched");
});

// REGRESSION (smoke-test bug): a misconfigured chromePath used to crash the whole
// host process via an unhandled child-process 'error' (ENOENT) on spawn, instead
// of rejecting the tool call. Contract: a launch failure MUST reject the tool
// call (a normal promise rejection) and never tear down the process. This test
// lets the plugin attempt a REAL spawn of a non-existent binary — that fails
// immediately with ENOENT (no real Chrome, no network needed); the failure must
// arrive as a rejection that assert.rejects can catch. A valid data: URL is used
// so the failure is the launch, not URL validation.
test("navigate: a bad chromePath fails GRACEFULLY (rejects, does not crash the host)", async () => {
  const p = plugin();
  const { ctx } = makeCtx({ headless: true, chromePath: "C:/nonexistent/definitely-not-chrome.exe" });
  await p.setup(ctx);
  await assert.rejects(
    () => ctx.actions.invoke("browser.navigate", { url: "data:text/html,x" }),
    /chrome|launch|spawn|ENOENT/i,
    "a bad chromePath must reject browser.navigate, not crash the host",
  );
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "teardown must be safe when Chrome never came up");
});

// ===========================================================================
// 5. tool.result loop -> browser.results block  (state transition + negative)
// ===========================================================================

test("result loop: an own ok:true result -> one {role:'user', name:'browser'} message tagged ok", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: NAVIGATE, ok: true, data: navData("https://k.example") });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  assert.equal(m.role, "user");
  assert.equal(m.name, "browser");
  const content = String(m.content);
  assert.match(content, /browser tool result/, "header identifies a browser tool result");
  assert.match(content, new RegExp(NAVIGATE.replace(".", "\\.")), "header names the tool");
  assert.match(content, /\bok\b/, "header marks success as ok");
});

test("result loop: each of the 5 browser tools is accepted into the ring", async () => {
  for (const name of ALL_TOOLS) {
    const { store, sys } = await setup({});
    emitToolResult(sys, { name, ok: true, data: navData() });
    const msgs = await renderMsgs(resultsBlock(store));
    assert.equal(msgs.length, 1, `${name} result must be recorded`);
    assert.equal(msgs[0].name, "browser");
  }
});

test("result loop: a FOREIGN tool.result name is ignored (block stays empty)", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: "searxng.search", ok: true, data: { results: [] } });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "another tool's result must not enter the browser ring");
});

test("result loop: an ok:false result -> rendered content contains 'Error: <message>'", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: READ_PAGE, ok: false, error: "navigation failed" });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1);
  const content = String(msgs[0].content);
  assert.match(content, /error/i, "header marks the failure as error");
  assert.match(content, /Error:\s*navigation failed/, "body carries 'Error: navigation failed'");
});

test("result loop: ring bounded by maxResults (emit max+1, keep only last max)", async () => {
  const max = 3;
  const { store, sys } = await setup({ maxResults: max });
  for (let i = 0; i < max + 1; i++) {
    emitToolResult(sys, { name: NAVIGATE, ok: true, data: navData(`https://x/${i}`) });
  }
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, max, "ring keeps exactly maxResults entries");
  const all = msgs.map((m) => String(m.content)).join("\n");
  assert.ok(!all.includes("https://x/0"), "oldest entry (0) was evicted");
  assert.ok(all.includes("https://x/3"), "newest entry (3) retained");
});

test("result loop: invokes clock.fire_now after an own result when registered", async () => {
  const { sys, fireNow } = await setup({}, { withClock: true });
  emitToolResult(sys, { name: NAVIGATE, ok: true, data: navData() });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(fireNow.count >= 1, "clock.fire_now must be invoked after recording an own result");
});

test("result loop: does NOT invoke clock.fire_now for a FOREIGN result", async () => {
  const { sys, fireNow } = await setup({}, { withClock: true });
  emitToolResult(sys, { name: "searxng.search", ok: true, data: { results: [] } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fireNow.count, 0, "a foreign tool result must not trigger a beat");
});

test("result loop: does NOT throw when clock.fire_now is not registered", async () => {
  const { sys } = await setup({}); // no clock
  assert.equal(sys.actions.has(Actions.CLOCK_FIRE_NOW), false, "precondition: no clock action");
  assert.doesNotThrow(() => {
    emitToolResult(sys, { name: NAVIGATE, ok: true, data: navData() });
  });
  await new Promise((r) => setTimeout(r, 20));
});

// ---- malformed payloads: the listener must never throw ----
for (const payload of [
  { label: "null payload", value: null },
  { label: "non-object (string)", value: "oops" },
  { label: "missing name", value: { id: "x", at: 1, ok: true } },
  { label: "name is not a string", value: { id: "x", at: 1, ok: true, name: 42 } },
]) {
  test(`result loop: malformed payload (${payload.label}) is ignored without throwing`, async () => {
    const { store, sys } = await setup({});
    assert.doesNotThrow(() => {
      sys.events.emit(Events.TOOL_RESULT, payload.value);
    }, `malformed tool.result (${payload.label}) must not throw in the listener`);
    const msgs = await renderMsgs(resultsBlock(store));
    assert.deepEqual(msgs, [], "malformed payloads add no result message");
  });
}

test("result loop: render() stays pure after pushes (renders cleanly, name:'browser' on each)", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: NAVIGATE, ok: true, data: navData("https://a") });
  emitToolResult(sys, { name: READ_PAGE, ok: false, error: "boom" });
  const first = await renderMsgs(resultsBlock(store));
  const second = await renderMsgs(resultsBlock(store)); // render twice — must be stable & non-mutating
  assert.equal(first.length, 2);
  assert.equal(second.length, 2, "render() is idempotent / does not consume the ring");
  for (const m of first) {
    assert.equal(m.role, "user");
    assert.equal(m.name, "browser");
  }
});

// ===========================================================================
// 6. total-char budgeting — oldest degrades to header-only  (boundary)
// ===========================================================================

test("budget: combined size over maxResultsTotalChars -> the OLDER entry renders header-only", async () => {
  const big = "y".repeat(400);
  const { store, sys } = await setup({
    maxResults: 10,
    maxResultChars: 5000,
    maxResultsTotalChars: 500,
  });
  emitToolResult(sys, { name: NAVIGATE, ok: true, data: { url: "https://older", body: big } });
  emitToolResult(sys, { name: NAVIGATE, ok: true, data: { url: "https://newer", body: big } });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.ok(msgs.length >= 2, "both entries rendered (older degraded, not dropped)");
  const joined = msgs.map((m) => String(m.content));
  const olderMsg = joined.find((c) => /older/.test(c));
  const newerMsg = joined.find((c) => /newer/.test(c));
  assert.ok(olderMsg, "older entry still present (as a header line)");
  assert.ok(newerMsg, "newer entry present");
  assert.ok(String(newerMsg).includes(big), "newest message keeps its full body");
  assert.ok(!String(olderMsg).includes(big), "oldest message is stripped of its large body");
  assert.ok(
    String(olderMsg).length < String(newerMsg).length,
    "older header-only must be shorter than newer full",
  );
});

// ===========================================================================
// 7. teardown  (state transition: present -> gone; idempotent; never throws)
// ===========================================================================

test("teardown: removes BOTH context blocks", async () => {
  const { p, store } = await setup({});
  assert.ok(store.get(GUIDANCE_BLOCK), "guidance present before teardown");
  assert.ok(store.get(RESULTS_BLOCK), "results present before teardown");
  await p.teardown();
  assert.equal(store.get(GUIDANCE_BLOCK), undefined, "guidance removed");
  assert.equal(store.get(RESULTS_BLOCK), undefined, "results removed");
});

test("teardown: unregisters ALL 5 actions", async () => {
  const { p, sys } = await setup({});
  for (const a of ALL_TOOLS) assert.ok(sys.actions.has(a), `${a} registered before teardown`);
  await p.teardown();
  for (const a of ALL_TOOLS) {
    assert.equal(sys.actions.has(a), false, `${a} unregistered after teardown`);
  }
});

test("teardown: does NOT throw even though Chrome was never launched", async () => {
  const { p } = await setup({});
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "teardown must be safe with no live Chrome");
});

test("teardown: is idempotent (double teardown does not throw)", async () => {
  const { p } = await setup({});
  await p.teardown();
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "second teardown must not throw");
});

// ===========================================================================
// 8. config.ts — readConfig  (positive defaults + override + negative type-guard)
// ===========================================================================

const CONFIG_DEFAULTS: Record<string, unknown> = {
  chromePath: null,
  headless: true,
  remoteDebugPort: 0,
  navigationTimeoutMs: 30000,
  commandTimeoutMs: 10000,
  maxTextChars: 50000,
  screenshotDir: null,
  guidance: null,
  guidancePriority: 5500,
  resultsPriority: 3000,
  maxResults: 10,
  maxResultChars: 4000,
  maxResultsTotalChars: 16000,
};

test("readConfig: undefined -> all documented defaults", () => {
  const m = cfgMod();
  const cfg = m.readConfig(undefined);
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) {
    assert.deepEqual(cfg[k], v, `default ${k} === ${JSON.stringify(v)}`);
  }
});

test("readConfig: {} -> all documented defaults", () => {
  const m = cfgMod();
  const cfg = m.readConfig({});
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) {
    assert.deepEqual(cfg[k], v, `default ${k}`);
  }
});

test("readConfig: null -> all documented defaults", () => {
  const m = cfgMod();
  const cfg = m.readConfig(null);
  assert.equal(cfg.headless, true);
  assert.equal(cfg.maxResults, 10);
  assert.equal(cfg.guidancePriority, 5500);
});

test("readConfig: overrides only the supplied valid fields, others stay default", () => {
  const m = cfgMod();
  const cfg = m.readConfig({ headless: false, guidancePriority: 1234 });
  assert.equal(cfg.headless, false, "headless overridden");
  assert.equal(cfg.guidancePriority, 1234, "guidancePriority overridden");
  assert.equal(cfg.maxResults, 10, "untouched field keeps its default");
  assert.equal(cfg.resultsPriority, 3000, "untouched field keeps its default");
});

test("readConfig: a string-typed valid override is taken (chromePath, screenshotDir, guidance)", () => {
  const m = cfgMod();
  const cfg = m.readConfig({
    chromePath: "C:/chrome.exe",
    screenshotDir: "/shots",
    guidance: "CUSTOM",
  });
  assert.equal(cfg.chromePath, "C:/chrome.exe");
  assert.equal(cfg.screenshotDir, "/shots");
  assert.equal(cfg.guidance, "CUSTOM");
});

test("readConfig: wrong-typed numeric field falls back to default (maxResults:'x' -> 10)", () => {
  const m = cfgMod();
  const cfg = m.readConfig({ maxResults: "x" });
  assert.equal(cfg.maxResults, 10, "non-number maxResults falls back to default");
});

for (const wrong of [
  { field: "headless", value: "yes", expect: true },
  { field: "remoteDebugPort", value: "9222", expect: 0 },
  { field: "navigationTimeoutMs", value: null, expect: 30000 },
  { field: "commandTimeoutMs", value: {}, expect: 10000 },
  { field: "maxTextChars", value: [], expect: 50000 },
  { field: "guidancePriority", value: "high", expect: 5500 },
  { field: "resultsPriority", value: false, expect: 3000 },
  { field: "maxResultChars", value: "4000", expect: 4000 },
  { field: "maxResultsTotalChars", value: null, expect: 16000 },
]) {
  test(`readConfig: wrong-typed ${wrong.field} (${JSON.stringify(wrong.value)}) falls back to default`, () => {
    const m = cfgMod();
    const cfg = m.readConfig({ [wrong.field]: wrong.value });
    assert.deepEqual(cfg[wrong.field], wrong.expect, `${wrong.field} falls back to default`);
  });
}

for (const wrong of [
  { field: "chromePath", value: 42 },
  { field: "screenshotDir", value: 7 },
  { field: "guidance", value: true },
]) {
  test(`readConfig: wrong-typed ${wrong.field} (non-string) falls back to default null`, () => {
    const m = cfgMod();
    const cfg = m.readConfig({ [wrong.field]: wrong.value });
    assert.equal(cfg[wrong.field], null, `${wrong.field} non-string falls back to null`);
  });
}

// ===========================================================================
// 9. config.ts — buildDefaultGuidance  (positive)
// ===========================================================================

test("buildDefaultGuidance: mentions all 5 tools, read/navigate-only, next-beat 'browser'", () => {
  const m = cfgMod();
  const cfg = m.readConfig({});
  const text = String(m.buildDefaultGuidance(cfg));
  for (const t of ALL_TOOLS) {
    assert.match(text, new RegExp(t.replace(".", "\\.")), `guidance text names ${t}`);
  }
  assert.match(text, /\bread\b/i, "guidance contains 'read'");
  assert.match(text, /\bnavigate\b/i, "guidance contains 'navigate'");
  assert.ok(!/\bclick\b/i.test(text), "guidance must NOT advertise click");
  assert.ok(!/\btype\b/i.test(text), "guidance must NOT advertise type");
  assert.match(text, /next beat/i, "guidance mentions results arrive on the next beat");
  assert.match(text, /browser/, "guidance mentions the 'browser' tag");
});

// ===========================================================================
// 10. config.ts — capText  (boundary value analysis)
// ===========================================================================

test("capText: empty string -> {content:'', truncated:false, chars:0}", () => {
  const m = cfgMod();
  assert.deepEqual(m.capText("", 10), { content: "", truncated: false, chars: 0 });
});

test("capText: length under max -> unchanged, not truncated, chars = original length", () => {
  const m = cfgMod();
  const r = m.capText("abc", 10);
  assert.equal(r.content, "abc");
  assert.equal(r.truncated, false);
  assert.equal(r.chars, 3);
});

test("capText: length EXACTLY max -> not truncated (boundary)", () => {
  const m = cfgMod();
  const r = m.capText("abcde", 5);
  assert.equal(r.content, "abcde");
  assert.equal(r.truncated, false);
  assert.equal(r.chars, 5);
});

test("capText: length max+1 -> truncated with N=1 (boundary)", () => {
  const m = cfgMod();
  const r = m.capText("abcdef", 5);
  assert.equal(r.truncated, true);
  assert.equal(r.chars, 6, "chars reports the ORIGINAL length");
  assert.ok(r.content.startsWith("abcde"), "content starts with the first max chars");
  assert.match(r.content, /1 chars truncated/, "N = original - max = 1");
  assert.match(r.content, /…/, "content carries the ellipsis marker");
});

test("capText: well over max -> N = length-max, content = slice(0,max)+marker", () => {
  const m = cfgMod();
  const s = "x".repeat(100);
  const r = m.capText(s, 30);
  assert.equal(r.truncated, true);
  assert.equal(r.chars, 100);
  assert.ok(r.content.startsWith("x".repeat(30)), "keeps the first 30 chars");
  assert.match(r.content, /70 chars truncated/, "N = 100 - 30 = 70");
});

test("capText: max = 0 with non-empty input -> truncated, all chars dropped", () => {
  const m = cfgMod();
  const r = m.capText("abc", 0);
  assert.equal(r.truncated, true);
  assert.equal(r.chars, 3);
  assert.match(r.content, /3 chars truncated/, "N = 3 - 0 = 3");
});

// ===========================================================================
// 11. config.ts — sanitizeScreenshotName  (positive + boundary + negative)
// ===========================================================================

test("sanitizeScreenshotName: non-empty name replaces / and \\ with _ and appends .png", () => {
  const m = cfgMod();
  assert.equal(m.sanitizeScreenshotName("a/b\\c", 5), "a_b_c.png");
});

test("sanitizeScreenshotName: a clean name just gets .png appended", () => {
  const m = cfgMod();
  assert.equal(m.sanitizeScreenshotName("shot", 5), "shot.png");
});

test("sanitizeScreenshotName: every slash/backslash is replaced (not just the first)", () => {
  const m = cfgMod();
  assert.equal(m.sanitizeScreenshotName("//x\\\\y", 5), "__x__y.png");
});

test("sanitizeScreenshotName: empty string -> screenshot_<now>.png", () => {
  const m = cfgMod();
  assert.equal(m.sanitizeScreenshotName("", 5), "screenshot_5.png");
});

for (const bad of [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "number", value: 42 },
  { label: "object", value: {} },
]) {
  test(`sanitizeScreenshotName: non-string name (${bad.label}) -> screenshot_<now>.png`, () => {
    const m = cfgMod();
    assert.equal(m.sanitizeScreenshotName(bad.value, 7), "screenshot_7.png");
  });
}

// ===========================================================================
// 12. config.ts — pushResult  (boundary: ring trim at exactly max and max+1)
// ===========================================================================

function entry(at: number): any {
  return { at, toolName: NAVIGATE, ok: true, url: `https://x/${at}` };
}

test("pushResult: appends to an empty ring, returns a NEW array", () => {
  const m = cfgMod();
  const ring: any[] = [];
  const out = m.pushResult(ring, entry(1), 10);
  assert.notEqual(out, ring, "returns a new array (does not mutate the input)");
  assert.equal(out.length, 1);
  assert.equal(out[0].at, 1);
});

test("pushResult: under max grows the ring (newest appended last)", () => {
  const m = cfgMod();
  let ring: any[] = [];
  for (let i = 1; i <= 3; i++) ring = m.pushResult(ring, entry(i), 5);
  assert.deepEqual(ring.map((e: any) => e.at), [1, 2, 3]);
});

test("pushResult: at EXACTLY max keeps all (boundary)", () => {
  const m = cfgMod();
  let ring: any[] = [];
  for (let i = 1; i <= 3; i++) ring = m.pushResult(ring, entry(i), 3);
  assert.equal(ring.length, 3, "length equals max");
  assert.deepEqual(ring.map((e: any) => e.at), [1, 2, 3]);
});

test("pushResult: at max+1 drops the OLDEST, length capped at max (boundary)", () => {
  const m = cfgMod();
  let ring: any[] = [];
  for (let i = 1; i <= 4; i++) ring = m.pushResult(ring, entry(i), 3);
  assert.equal(ring.length, 3, "length never exceeds max");
  assert.deepEqual(ring.map((e: any) => e.at), [2, 3, 4], "oldest (1) dropped, newest (4) kept");
});

test("pushResult: max = 1 keeps only the newest entry", () => {
  const m = cfgMod();
  let ring: any[] = [];
  for (let i = 1; i <= 3; i++) ring = m.pushResult(ring, entry(i), 1);
  assert.deepEqual(ring.map((e: any) => e.at), [3], "only the newest survives");
});

// ===========================================================================
// 13. config.ts — renderResults  (positive + boundary budget + format)
// ===========================================================================

const RC = (over: Record<string, unknown> = {}) => cfgMod().readConfig(over);

test("renderResults: empty ring -> []", () => {
  const m = cfgMod();
  assert.deepEqual(m.renderResults([], RC()), []);
});

test("renderResults: every message has role 'user' and name 'browser'", () => {
  const m = cfgMod();
  const ring = [
    { at: 1, toolName: NAVIGATE, ok: true, data: { a: 1 }, url: "https://a" },
    { at: 2, toolName: READ_PAGE, ok: false, error: "boom", url: "https://b" },
  ];
  const msgs = m.renderResults(ring, RC());
  assert.equal(msgs.length, 2);
  for (const msg of msgs) {
    assert.equal(msg.role, "user");
    assert.equal(msg.name, "browser");
    assert.equal(typeof msg.content, "string");
  }
});

test("renderResults: ok entry header format + JSON body", () => {
  const m = cfgMod();
  const data = { url: "https://a", title: "Hi" };
  const ring = [{ at: 1700000000000, toolName: NAVIGATE, ok: true, data, url: "https://a" }];
  const msgs = m.renderResults(ring, RC());
  const c = String(msgs[0].content);
  assert.match(c, /\[browser tool result \| browser\.navigate \| ok \| url: https:\/\/a \|/, "header shape");
  assert.ok(c.includes(JSON.stringify(data, null, 2)), "ok body is pretty-printed JSON of data");
});

test("renderResults: error entry header marks 'error' and body is 'Error: <message>'", () => {
  const m = cfgMod();
  const ring = [{ at: 1700000000000, toolName: READ_PAGE, ok: false, error: "nope", url: "https://b" }];
  const msgs = m.renderResults(ring, RC());
  const c = String(msgs[0].content);
  assert.match(c, /\| error \| url: https:\/\/b \|/, "header marks error + url");
  assert.match(c, /Error:\s*nope/, "body carries the error message");
});

test("renderResults: undefined url renders an EMPTY url field in the header", () => {
  const m = cfgMod();
  const ring = [{ at: 1700000000000, toolName: LIST_TABS, ok: true, data: { tabs: [] } }];
  const msgs = m.renderResults(ring, RC());
  const c = String(msgs[0].content);
  assert.match(c, /\| url:  \|/, "url field is empty (two spaces around it) when entry.url is undefined");
});

test("renderResults: per-entry body capped at maxResultChars via capText", () => {
  const m = cfgMod();
  const big = "z".repeat(5000);
  const ring = [{ at: 1, toolName: NAVIGATE, ok: true, data: { body: big }, url: "https://a" }];
  const msgs = m.renderResults(ring, RC({ maxResultChars: 100, maxResultsTotalChars: 1000000 }));
  const c = String(msgs[0].content);
  assert.ok(!c.includes(big), "the full 5000-char body must not be present (capped)");
  assert.match(c, /chars truncated/, "body shows the capText truncation marker");
});

test("renderResults: newest-first — the NEWEST entry is always rendered FULL even over budget", () => {
  const m = cfgMod();
  const big = "q".repeat(800);
  // ring order is oldest-first; renderResults walks newest-first for the budget.
  const ring = [
    { at: 1, toolName: NAVIGATE, ok: true, data: { tag: "older", body: big }, url: "https://older" },
    { at: 2, toolName: NAVIGATE, ok: true, data: { tag: "newer", body: big }, url: "https://newer" },
  ];
  const msgs = m.renderResults(ring, RC({ maxResultChars: 5000, maxResultsTotalChars: 500 }));
  const joined = msgs.map((x: any) => String(x.content));
  const newer = joined.find((c) => /newer/.test(c))!;
  const older = joined.find((c) => /older/.test(c))!;
  assert.ok(newer.includes(big), "newest entry keeps its full body");
  assert.ok(!older.includes(big), "older entry degrades to header-only over budget");
  assert.ok(older.length < newer.length, "older header-only is shorter than newer full");
});

test("renderResults: under budget — BOTH entries render full (boundary, just below limit)", () => {
  const m = cfgMod();
  const small = "s".repeat(50);
  const ring = [
    { at: 1, toolName: NAVIGATE, ok: true, data: { tag: "older", body: small }, url: "https://older" },
    { at: 2, toolName: NAVIGATE, ok: true, data: { tag: "newer", body: small }, url: "https://newer" },
  ];
  const msgs = m.renderResults(ring, RC({ maxResultChars: 5000, maxResultsTotalChars: 1000000 }));
  const joined = msgs.map((x: any) => String(x.content));
  assert.ok(joined.find((c) => /older/.test(c))!.includes(small), "older keeps its body under budget");
  assert.ok(joined.find((c) => /newer/.test(c))!.includes(small), "newer keeps its body under budget");
});

// ===========================================================================
// 14. cdp.ts — findChromeBinary  (positive + negative, via dependency injection)
// ===========================================================================

test("findChromeBinary: a non-empty override is returned verbatim (no probing)", () => {
  const m = cdpMod();
  let probed = false;
  const out = m.findChromeBinary("C:/x/chrome.exe", "win32", () => {
    probed = true;
    return true;
  });
  assert.equal(out, "C:/x/chrome.exe");
  assert.equal(probed, false, "override must short-circuit before probing the fs");
});

test("findChromeBinary: probes candidates and returns the FIRST that exists", () => {
  const m = cdpMod();
  const out = m.findChromeBinary(null, "linux", (p: string) => p === "/usr/bin/chromium");
  assert.equal(out, "/usr/bin/chromium", "returns the first existing candidate");
});

test("findChromeBinary: none exist -> throws naming 'no Chrome' and 'chromePath'", () => {
  const m = cdpMod();
  assert.throws(
    () => m.findChromeBinary(null, "win32", () => false),
    (err: any) => {
      const msg = String(err?.message ?? err);
      assert.match(msg, /no Chrome/, "error mentions 'no Chrome'");
      assert.match(msg, /chromePath/, "error points the user at chromePath");
      return true;
    },
  );
});

test("findChromeBinary: empty-string override is treated as no override (falls to probing)", () => {
  const m = cdpMod();
  // Empty string is NOT a non-empty override -> must probe; with all-false it throws.
  assert.throws(() => m.findChromeBinary("", "win32", () => false), "empty override -> probe -> throw");
});

// ===========================================================================
// 15. cdp.ts — buildCdpMessage  (positive + boundary on sessionId presence)
// ===========================================================================

test("buildCdpMessage: returns {id, method, params}; NO sessionId key when omitted", () => {
  const m = cdpMod();
  const msg = m.buildCdpMessage(1, "Page.navigate", { url: "x" });
  assert.equal(msg.id, 1);
  assert.equal(msg.method, "Page.navigate");
  assert.deepEqual(msg.params, { url: "x" });
  assert.ok(!("sessionId" in msg), "no sessionId key when none is supplied");
});

test("buildCdpMessage: a non-empty sessionId is included", () => {
  const m = cdpMod();
  const msg = m.buildCdpMessage(2, "M", {}, "s1");
  assert.equal(msg.sessionId, "s1");
  assert.equal(msg.id, 2);
});

test("buildCdpMessage: an EMPTY-string sessionId is NOT included (boundary)", () => {
  const m = cdpMod();
  const msg = m.buildCdpMessage(3, "M", {}, "");
  assert.ok(!("sessionId" in msg), "empty-string sessionId must be omitted");
});

test("buildCdpMessage: preserves the params object as given (including empty)", () => {
  const m = cdpMod();
  const msg = m.buildCdpMessage(4, "Runtime.evaluate", { expression: "1+1" }, "sess");
  assert.deepEqual(msg.params, { expression: "1+1" });
  assert.equal(msg.sessionId, "sess");
});
