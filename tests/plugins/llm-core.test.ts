import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Events } from "../../shared/actions";
import type {
  Communicator,
  CommunicatorLibrary,
  LLMRequest,
  LLMResponse,
  Capability,
} from "../../contracts/llm";
import type { Plugin, PluginContext } from "../../contracts/plugin";
import type { ContextBlock } from "../../contracts/context";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `llm-core` plugin.
//
// Derived ONLY from contracts/plugin, contracts/llm, shared/actions and the
// node spec overview (overviews/nodes/llm-core.md). No implementation under
// packages/ or public_plugin/ is read or assumed.
//
// RED-STATE: the plugin module may not exist yet. It is loaded with a guarded
// dynamic import so a missing module produces a clean ASSERTION failure
// ("plugin not implemented yet") rather than a file-level crash. Each test
// asserts mod?.default before driving it.
// ---------------------------------------------------------------------------

const mod: any = await import("../../public_plugin/llm-core/index.ts").then(
  (m) => m,
  () => null,
);

/** Pull the Plugin default export, failing on a clean assertion if absent. */
function plugin(): Plugin {
  assert.equal(
    typeof mod?.default,
    "function",
    "plugin not implemented yet — the default export must be a PluginFactory (public_plugin/llm-core/index.ts)",
  );
  // The factory runs once per Agent; each call here is one fresh instance.
  return (mod.default as () => Plugin)();
}

// ---- communicator + library stubs ----------------------------------------

interface ChatStub extends Communicator {
  /** Every captured chat request, newest last. */
  calls: LLMRequest[];
}

/**
 * A chat-capable communicator whose chat() captures the request and resolves a
 * canned response (or rejects with a canned error when `reject` is set).
 */
function chatCommunicator(opts: {
  name?: string;
  response?: LLMResponse;
  reject?: unknown;
}): ChatStub {
  const calls: LLMRequest[] = [];
  const stub: ChatStub = {
    name: opts.name ?? "stubcom",
    provider: "stub",
    model: "stub-model",
    capabilities: ["chat"] as readonly Capability[],
    input: ["text"],
    output: ["text"],
    calls,
    chat(req: LLMRequest): Promise<LLMResponse> {
      calls.push(req);
      if ("reject" in opts) return Promise.reject(opts.reject);
      return Promise.resolve(opts.response ?? { content: "hi" });
    },
  };
  return stub;
}

/** A communicator that declares chat capability but has NO chat method. */
function noChatCommunicator(name = "broken"): Communicator {
  return {
    name,
    provider: "stub",
    model: "stub-model",
    capabilities: ["chat"] as readonly Capability[],
    input: ["text"],
    output: ["text"],
    // no chat method
  };
}

/** A communicator that is NOT chat-capable (embed only). */
function embedOnlyCommunicator(name = "embedder"): Communicator {
  return {
    name,
    provider: "stub",
    model: "stub-model",
    capabilities: ["embed"] as readonly Capability[],
    input: ["text"],
    output: ["text"],
    embed: () => Promise.resolve({ embeddings: [[0]] }),
  };
}

/** Build a CommunicatorLibrary over the given communicators (order preserved). */
function library(coms: Communicator[]): CommunicatorLibrary {
  return {
    get: (name) => coms.find((c) => c.name === name),
    has: (name) => coms.some((c) => c.name === name),
    list: () => coms.map((c) => c.name),
    withCapability: (cap: Capability) =>
      coms.filter((c) => c.capabilities.includes(cap)).map((c) => c.name),
  };
}

// ---- block store stub ------------------------------------------------------

function blockStore() {
  const blocks = new Map<string, ContextBlock>();
  return {
    setBlock: (b: ContextBlock) => void blocks.set(b.id, b),
    getBlock: (id: string) => blocks.get(id),
    removeBlock: (id: string) => blocks.delete(id),
    listBlocks: () => Array.from(blocks.values()).map((b) => ({ id: b.id, priority: b.priority })),
  };
}

// ---- PluginContext factory + harness --------------------------------------

interface Harness {
  ctx: PluginContext;
  events: ReturnType<typeof createEventSystem>["events"];
  actions: ReturnType<typeof createEventSystem>["actions"];
}

function makeCtx(t: { after(fn: () => void): void }, opts: {
  config?: unknown;
  llm: CommunicatorLibrary;
}): Harness {
  const sys = createEventSystem();
  const store = blockStore();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmcore-"));
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  const ctx: PluginContext = {
    agentId: "agent-1",
    events: sys.events,
    actions: sys.actions,
    config: opts.config,
    dataDir,
    llm: opts.llm,
    setBlock: store.setBlock,
    getBlock: store.getBlock,
    removeBlock: store.removeBlock,
    listBlocks: store.listBlocks,
    log: () => {},
  };
  return { ctx, events: sys.events, actions: sys.actions };
}

/** Setup the plugin against a fresh context. Registers teardown via t.after. */
async function setupPlugin(
  t: { after(fn: () => void): void },
  opts: { config?: unknown; llm: CommunicatorLibrary },
): Promise<Harness & { p: Plugin }> {
  const p = plugin();
  const h = makeCtx(t, opts);
  await p.setup(h.ctx);
  t.after(async () => {
    try {
      await p.teardown?.();
    } catch {
      /* teardown must never throw the suite */
    }
  });
  return { ...h, p };
}

/** Collect every payload emitted on `event` into a live array. */
function collect(events: Harness["events"], event: string): unknown[] {
  const out: unknown[] = [];
  events.on(event, (p) => out.push(p));
  return out;
}

/** Let async emit/await chains flush before asserting. */
function settle(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build an llm.request Request envelope. */
function llmRequest(id: string, text: string) {
  return { id, at: Date.now(), data: { context: { text } } };
}

// ===========================================================================
// 1. Default export shape / manifest
// ===========================================================================

test("manifest: id is 'llm-core'", () => {
  const p = plugin();
  assert.equal(p.manifest.id, "llm-core");
});

test("manifest: provides includes 'llm.register_tool'", () => {
  const p = plugin();
  assert.ok(Array.isArray(p.manifest.provides), "provides must be an array");
  assert.ok(
    p.manifest.provides!.includes("llm.register_tool"),
    "provides must include llm.register_tool",
  );
});

test("manifest: exposes setup and teardown functions", () => {
  const p = plugin();
  assert.equal(typeof p.setup, "function");
  assert.equal(typeof p.teardown, "function");
});

test("setup: registers the llm.register_tool action on the actionbus", async (t) => {
  const lib = library([chatCommunicator({})]);
  const { actions } = await setupPlugin(t, { llm: lib });
  assert.equal(actions.has("llm.register_tool"), true);
  assert.ok(actions.list().includes("llm.register_tool"));
});

// ===========================================================================
// 2. llm.register_tool action
// ===========================================================================

// ---- positive --------------------------------------------------------------

test("register_tool: a valid ToolDef resolves true", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  const res = await actions.invoke("llm.register_tool", {
    name: "t1",
    description: "first tool",
    parameters: { type: "object" },
  });
  assert.equal(res, true);
});

test("register_tool: name-only ToolDef (no description/parameters) resolves true", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  const res = await actions.invoke("llm.register_tool", { name: "bare" });
  assert.equal(res, true);
});

// ---- state transitions -----------------------------------------------------

test("register_tool: a registered def appears on the next chat request's tools", async (t) => {
  const com = chatCommunicator({});
  const { actions, events } = await setupPlugin(t, { llm: library([com]) });
  await actions.invoke("llm.register_tool", { name: "t1", description: "d" });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(com.calls.length, 1);
  const tools = com.calls[0].tools ?? [];
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "t1");
});

test("register_tool: two distinct names both appear on the chat request", async (t) => {
  const com = chatCommunicator({});
  const { actions, events } = await setupPlugin(t, { llm: library([com]) });
  await actions.invoke("llm.register_tool", { name: "a" });
  await actions.invoke("llm.register_tool", { name: "b" });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  const names = (com.calls[0].tools ?? []).map((d) => d.name).sort();
  assert.deepEqual(names, ["a", "b"]);
});

test("register_tool: re-registering the same name REPLACES (later def wins)", async (t) => {
  const com = chatCommunicator({});
  const { actions, events } = await setupPlugin(t, { llm: library([com]) });
  await actions.invoke("llm.register_tool", { name: "t1", description: "first" });
  await actions.invoke("llm.register_tool", { name: "t1", description: "second" });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  const tools = com.calls[0].tools ?? [];
  // same name registered twice -> exactly one entry, the later def
  assert.equal(tools.filter((d) => d.name === "t1").length, 1);
  assert.equal(tools[0].description, "second");
});

// ---- negative --------------------------------------------------------------

test("register_tool: rejects on null params", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  await assert.rejects(actions.invoke("llm.register_tool", null));
});

test("register_tool: rejects when params is not an object (string)", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  await assert.rejects(actions.invoke("llm.register_tool", "t1"));
});

test("register_tool: rejects when name is missing", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  await assert.rejects(actions.invoke("llm.register_tool", { description: "no name" }));
});

test("register_tool: rejects on empty-string name", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  await assert.rejects(actions.invoke("llm.register_tool", { name: "" }));
});

test("register_tool: rejects when name is not a string (number)", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  await assert.rejects(actions.invoke("llm.register_tool", { name: 123 }));
});

// ===========================================================================
// 3. llm.request round-trip
// ===========================================================================

test("llm.request: round-trip emits exactly one llm.return with matching id, ok, content", async (t) => {
  const com = chatCommunicator({ response: { content: "hi" } });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("7", "CTX"));
  await settle();
  assert.equal(replies.length, 1, "exactly one llm.return");
  assert.equal(replies[0].id, "7");
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].data.content, "hi");
});

test("llm.request: chat receives messages [{role:'user', content: context.text}]", async (t) => {
  const com = chatCommunicator({ response: { content: "hi" } });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  events.emit(Events.LLM_REQUEST, llmRequest("7", "CTX"));
  await settle();
  assert.equal(com.calls.length, 1);
  assert.deepEqual(com.calls[0].messages, [{ role: "user", content: "CTX" }]);
});

test("llm.request: reply id equals request id (BVA - id '0')", async (t) => {
  const com = chatCommunicator({ response: { content: "x" } });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("0", "CTX"));
  await settle();
  assert.equal(replies[0].id, "0");
});

test("llm.request: reply id equals request id (empty-string id)", async (t) => {
  const com = chatCommunicator({ response: { content: "x" } });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("", "CTX"));
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, "");
});

test("llm.request: empty context text still produces a chat call with content ''", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  events.emit(Events.LLM_REQUEST, llmRequest("1", ""));
  await settle();
  assert.equal(com.calls.length, 1);
  assert.deepEqual(com.calls[0].messages, [{ role: "user", content: "" }]);
});

// ===========================================================================
// 4. Tools array presence / absence on the chat request
// ===========================================================================

test("chat request: with ZERO registered tools the tools key is ABSENT", async (t) => {
  const com = chatCommunicator({});
  const { events } = await setupPlugin(t, { llm: library([com]) });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(com.calls.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(com.calls[0], "tools"),
    false,
    "tools key must be omitted when no tools are registered",
  );
});

test("chat request: registered ToolDef is included on the tools array", async (t) => {
  const com = chatCommunicator({});
  const { events, actions } = await setupPlugin(t, { llm: library([com]) });
  await actions.invoke("llm.register_tool", { name: "t1", parameters: { type: "object" } });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.ok(Array.isArray(com.calls[0].tools));
  assert.equal(com.calls[0].tools!.length, 1);
  assert.equal(com.calls[0].tools![0].name, "t1");
});

// ===========================================================================
// 5. output.message emission
// ===========================================================================

test("output.message: non-empty content emits output.message Notify with data.text = content", async (t) => {
  const com = chatCommunicator({ response: { content: "hello world" } });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  const outs = collect(events, Events.OUTPUT_MESSAGE) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(outs.length, 1, "exactly one output.message");
  assert.equal(outs[0].data.text, "hello world");
});

test("output.message: empty content emits llm.return but NO output.message", async (t) => {
  const com = chatCommunicator({ response: { content: "" } });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  const outs = collect(events, Events.OUTPUT_MESSAGE) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(replies.length, 1, "llm.return still emitted for empty content");
  assert.equal(replies[0].ok, true);
  assert.equal(outs.length, 0, "no output.message for empty content");
});

// ===========================================================================
// 6. Communicator selection
// ===========================================================================

test("selection: config {communicator:'named'} uses library.get('named')", async (t) => {
  const named = chatCommunicator({ name: "named", response: { content: "A" } });
  const other = chatCommunicator({ name: "other", response: { content: "B" } });
  // order: 'other' first, but config must override to 'named'
  const { events } = await setupPlugin(t, {
    config: { communicator: "named" },
    llm: library([other, named]),
  });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(named.calls.length, 1, "named communicator must be used");
  assert.equal(other.calls.length, 0, "non-selected communicator must not be called");
  assert.equal(replies[0].data.content, "A");
});

test("selection: no config uses first of withCapability('chat')", async (t) => {
  const first = chatCommunicator({ name: "first", response: { content: "FIRST" } });
  const second = chatCommunicator({ name: "second", response: { content: "SECOND" } });
  const { events } = await setupPlugin(t, { llm: library([first, second]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(first.calls.length, 1, "first chat-capable must be used");
  assert.equal(second.calls.length, 0);
  assert.equal(replies[0].data.content, "FIRST");
});

test("selection: skips non-chat communicators when choosing the default", async (t) => {
  const embed = embedOnlyCommunicator("embedder");
  const chat = chatCommunicator({ name: "chatter", response: { content: "C" } });
  // embed-only is listed first but is not chat-capable
  const { events } = await setupPlugin(t, { llm: library([embed, chat]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(chat.calls.length, 1);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].data.content, "C");
});

test("selection: NO chat-capable communicator -> llm.return ok:false, error non-empty, no throw, no output", async (t) => {
  const { events } = await setupPlugin(t, { llm: library([embedOnlyCommunicator()]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  const outs = collect(events, Events.OUTPUT_MESSAGE) as any[];
  assert.doesNotThrow(() => events.emit(Events.LLM_REQUEST, llmRequest("9", "CTX")));
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, "9");
  assert.equal(replies[0].ok, false);
  assert.equal(typeof replies[0].error, "string");
  assert.ok(replies[0].error.length > 0, "error must be non-empty");
  assert.equal(outs.length, 0, "no output.message on failure");
});

test("selection: chosen communicator lacks chat() -> llm.return ok:false, no throw", async (t) => {
  // library.withCapability('chat') names it, but it has no chat method
  const { events } = await setupPlugin(t, { llm: library([noChatCommunicator("broken")]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  assert.doesNotThrow(() => events.emit(Events.LLM_REQUEST, llmRequest("5", "CTX")));
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, "5");
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").length > 0);
});

test("selection: config names a non-existent communicator -> ok:false, no throw", async (t) => {
  const real = chatCommunicator({ name: "real", response: { content: "x" } });
  const { events } = await setupPlugin(t, {
    config: { communicator: "ghost" },
    llm: library([real]),
  });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  assert.doesNotThrow(() => events.emit(Events.LLM_REQUEST, llmRequest("3", "CTX")));
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, "3");
  assert.equal(replies[0].ok, false);
  assert.equal(real.calls.length, 0, "the named-but-missing config must not silently fall back and call another communicator");
});

// ===========================================================================
// 7. chat() rejection handling + listener survival
// ===========================================================================

test("rejection: chat() rejection -> llm.return ok:false with the error text, no output", async (t) => {
  const com = chatCommunicator({ reject: new Error("boom") });
  const { events } = await setupPlugin(t, { llm: library([com]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  const outs = collect(events, Events.OUTPUT_MESSAGE) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("4", "CTX"));
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, "4");
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").includes("boom"), "error text should carry the rejection");
  assert.equal(outs.length, 0);
});

test("rejection: listener survives -> a following good request still answers", async (t) => {
  // first request rejects, second succeeds (new library not possible mid-setup;
  // use a communicator that rejects once then resolves)
  let n = 0;
  const com: ChatStub = {
    name: "flaky",
    provider: "stub",
    model: "m",
    capabilities: ["chat"],
    input: ["text"],
    output: ["text"],
    calls: [],
    chat(req: LLMRequest) {
      com.calls.push(req);
      n += 1;
      if (n === 1) return Promise.reject(new Error("first-fails"));
      return Promise.resolve({ content: "recovered" });
    },
  };
  const { events } = await setupPlugin(t, { llm: library([com]) });
  const replies = collect(events, Events.LLM_RETURN) as any[];
  events.emit(Events.LLM_REQUEST, llmRequest("a", "CTX1"));
  await settle();
  events.emit(Events.LLM_REQUEST, llmRequest("b", "CTX2"));
  await settle();
  assert.equal(replies.length, 2, "both requests answered");
  assert.equal(replies[0].id, "a");
  assert.equal(replies[0].ok, false);
  assert.equal(replies[1].id, "b");
  assert.equal(replies[1].ok, true);
  assert.equal(replies[1].data.content, "recovered");
});

// ===========================================================================
// 8. Malformed request payloads are ignored
// ===========================================================================

for (const [label, payload] of [
  ["undefined", undefined],
  ["null", null],
  ["empty object {}", {}],
  ["missing data.context", { id: "1", at: 0, data: {} }],
  ["data is null", { id: "1", at: 0, data: null }],
  ["context without text", { id: "1", at: 0, data: { context: {} } }],
] as Array<[string, unknown]>) {
  test(`malformed: ${label} -> no llm.return, no chat call, no throw`, async (t) => {
    const com = chatCommunicator({});
    const { events } = await setupPlugin(t, { llm: library([com]) });
    const replies = collect(events, Events.LLM_RETURN) as any[];
    assert.doesNotThrow(() => events.emit(Events.LLM_REQUEST, payload));
    await settle();
    assert.equal(replies.length, 0, "malformed payload must not produce llm.return");
    assert.equal(com.calls.length, 0, "malformed payload must not call chat");
  });
}

// Note: a malformed payload missing data.context (label above) is the spec's
// explicit ignore case. "context without text" treats an absent text as ignorable
// — see ASSUMPTIONS in the agent report.

// ===========================================================================
// 9. teardown
// ===========================================================================

test("teardown: after teardown a later llm.request produces nothing", async (t) => {
  const com = chatCommunicator({});
  const p = plugin();
  const h = makeCtx(t, { llm: library([com]) });
  await p.setup(h.ctx);
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  await p.teardown?.();
  h.events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(replies.length, 0, "listener must be unsubscribed after teardown");
  assert.equal(com.calls.length, 0);
});

test("teardown: unregisters llm.register_tool (actions.has -> false)", async (t) => {
  const p = plugin();
  const h = makeCtx(t, { llm: library([chatCommunicator({})]) });
  await p.setup(h.ctx);
  assert.equal(h.actions.has("llm.register_tool"), true);
  await p.teardown?.();
  assert.equal(h.actions.has("llm.register_tool"), false);
});

// ===========================================================================
// 10. config temperature / maxTokens forwarding
// ===========================================================================

test("config: temperature is forwarded onto the chat request when set", async (t) => {
  const com = chatCommunicator({});
  const { events } = await setupPlugin(t, {
    config: { temperature: 0.42 },
    llm: library([com]),
  });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(com.calls[0].temperature, 0.42);
});

test("config: maxTokens is forwarded onto the chat request when set", async (t) => {
  const com = chatCommunicator({});
  const { events } = await setupPlugin(t, {
    config: { maxTokens: 256 },
    llm: library([com]),
  });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(com.calls[0].maxTokens, 256);
});

test("config: temperature=0 (boundary) is forwarded, not dropped as falsy", async (t) => {
  const com = chatCommunicator({});
  const { events } = await setupPlugin(t, {
    config: { temperature: 0 },
    llm: library([com]),
  });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(com.calls[0].temperature, 0, "temperature 0 must be forwarded");
});

test("config: with neither set, temperature and maxTokens are absent on the request", async (t) => {
  const com = chatCommunicator({});
  const { events } = await setupPlugin(t, { llm: library([com]) });
  events.emit(Events.LLM_REQUEST, llmRequest("1", "CTX"));
  await settle();
  assert.equal(com.calls[0].temperature, undefined);
  assert.equal(com.calls[0].maxTokens, undefined);
});
