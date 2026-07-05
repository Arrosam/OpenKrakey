import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEventSystem } from "../../packages/event-system/src";
import { Events, Actions } from "../../shared/actions";
import type {
  Communicator,
  CommunicatorLibrary,
  LLMRequest,
  LLMResponse,
  Capability,
  Message,
  ToolDef,
} from "../../contracts/llm";
import type { Plugin, PluginContext } from "../../contracts/plugin";
import type { ContextBlock } from "../../contracts/context";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `llm-core` plugin (METHOD B).
//
// The orchestrator emits a body-less TRIGGER (`llm.request` = Notify<{agentId}>).
// llm-core owns the per-agentId send lock: at most one request in flight per
// agentId, coalescing triggers that arrive while busy, composing the body ON DEMAND
// via the `prompt.compose` action right before each send, and pulling tools from
// `tool-manager` via `llm.list_tools`.
//
// The harness therefore stubs BOTH actions: `prompt.compose` (set via setCompose)
// and `llm.list_tools` (push to toolsRef). A trigger is emitted via trigger().
// ---------------------------------------------------------------------------

const mod: any = await import("../../public_plugin/llm-core/index.ts").then(
  (m) => m,
  () => null,
);

function plugin(): Plugin {
  assert.equal(
    typeof mod?.default,
    "function",
    "plugin not implemented yet — the default export must be a PluginFactory (public_plugin/llm-core/index.ts)",
  );
  return (mod.default as () => Plugin)();
}

// ---- communicator + library stubs ----------------------------------------

interface ChatStub extends Communicator {
  /** Every captured chat request, newest last. */
  calls: LLMRequest[];
}

/**
 * A chat-capable communicator whose chat() captures the request and resolves a
 * canned response (or rejects with a canned error). `delayMs` keeps the call
 * IN FLIGHT for that long, so coalescing/isolation can be exercised.
 */
function chatCommunicator(opts: {
  name?: string;
  response?: LLMResponse;
  reject?: unknown;
  delayMs?: number;
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
      const value = opts.response ?? { content: "hi" };
      if (opts.delayMs && opts.delayMs > 0) {
        return new Promise((r) => setTimeout(() => r(value), opts.delayMs));
      }
      return Promise.resolve(value);
    },
  };
  return stub;
}

function noChatCommunicator(name = "broken"): Communicator {
  return {
    name,
    provider: "stub",
    model: "stub-model",
    capabilities: ["chat"] as readonly Capability[],
    input: ["text"],
    output: ["text"],
  };
}

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
  /** Backing store for the stub `llm.list_tools` action — push ToolDefs here. */
  toolsRef: ToolDef[];
  /** Set what the stub `prompt.compose` returns for the next send(s). */
  setCompose(text: string, messages?: Message[]): void;
  /** How many times `prompt.compose` has been invoked. */
  composeCalls(): number;
}

function makeCtx(t: { after(fn: () => void): void }, opts: {
  config?: unknown;
  llm: CommunicatorLibrary;
  /** Skip registering the stub tool-manager (llm.list_tools). */
  noToolManager?: boolean;
  /** Skip registering the stub orchestrator (prompt.compose). */
  noCompose?: boolean;
  /** Make prompt.compose reject. */
  composeReject?: boolean;
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

  // Stub tool-manager: llm-core reads tools from this at send time.
  const toolsRef: ToolDef[] = [];
  if (!opts.noToolManager) {
    sys.actions.register("llm.list_tools", async () => [...toolsRef]);
  }

  // Stub orchestrator: llm-core composes the body on demand via prompt.compose.
  let composeResult: { context: { text: string }; messages: Message[] } = {
    context: { text: "" },
    messages: [],
  };
  let composeCount = 0;
  if (!opts.noCompose) {
    sys.actions.register(Actions.PROMPT_COMPOSE, async () => {
      composeCount++;
      if (opts.composeReject) throw new Error("compose-failed");
      return composeResult;
    });
  }

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
    log: { info: () => {}, warn: () => {}, error: () => {} },
    print: () => {},
  };
  return {
    ctx,
    events: sys.events,
    actions: sys.actions,
    toolsRef,
    setCompose: (text, messages) => {
      composeResult = { context: { text }, messages: messages ?? [] };
    },
    composeCalls: () => composeCount,
  };
}

async function setupPlugin(
  t: { after(fn: () => void): void },
  opts: {
    config?: unknown;
    llm: CommunicatorLibrary;
    noToolManager?: boolean;
    noCompose?: boolean;
    composeReject?: boolean;
  },
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

function collect(events: Harness["events"], event: string): unknown[] {
  const out: unknown[] = [];
  events.on(event, (p) => out.push(p));
  return out;
}

function settle(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Emit a body-less trigger for `agentId` (the lock key; defaults to agent-1). */
function trigger(events: Harness["events"], agentId = "agent-1"): void {
  events.emit(Events.LLM_REQUEST, { at: Date.now(), data: { agentId } });
}

// ===========================================================================
// 1. manifest
// ===========================================================================

test("manifest: id is 'llm-core'", () => {
  assert.equal(plugin().manifest.id, "llm-core");
});

test("manifest: requires includes 'llm.list_tools' (tools come from tool-manager)", () => {
  const p = plugin();
  assert.ok(Array.isArray(p.manifest.requires));
  assert.ok(p.manifest.requires!.includes("llm.list_tools"));
});

test("manifest: no longer provides 'llm.register_tool' (moved to tool-manager)", () => {
  const provides = plugin().manifest.provides ?? [];
  assert.ok(!provides.includes("llm.register_tool"));
});

test("setup: does NOT register llm.register_tool", async (t) => {
  const { actions } = await setupPlugin(t, { llm: library([chatCommunicator({})]) });
  assert.equal(actions.has("llm.register_tool"), false);
});

// ===========================================================================
// 2. trigger → round-trip
// ===========================================================================

test("trigger: one trigger composes (via prompt.compose) and emits exactly one llm.return ok:true with content", async (t) => {
  const com = chatCommunicator({ response: { content: "hi" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  trigger(h.events);
  await settle();
  assert.equal(h.composeCalls(), 1, "compose was pulled on demand");
  assert.equal(replies.length, 1, "exactly one llm.return");
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].data.content, "hi");
  assert.equal(typeof replies[0].id, "string", "llm-core stamps a corrId on the dispatch");
});

test("trigger: a fallback (no messages) composes to a single user message of context.text, no system key", async (t) => {
  const com = chatCommunicator({ response: { content: "hi" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX"); // no messages
  trigger(h.events);
  await settle();
  assert.equal(com.calls.length, 1);
  assert.deepEqual(com.calls[0].messages, [{ role: "user", content: "CTX" }]);
  assert.equal(Object.prototype.hasOwnProperty.call(com.calls[0], "system"), false);
});

test("trigger: empty composed context still produces a chat call with content ''", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("");
  trigger(h.events);
  await settle();
  assert.equal(com.calls.length, 1);
  assert.deepEqual(com.calls[0].messages, [{ role: "user", content: "" }]);
});

// ===========================================================================
// 3. tools (from tool-manager via llm.list_tools)
// ===========================================================================

test("tools: with ZERO registered tools the tools key is ABSENT", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  trigger(h.events);
  await settle();
  assert.equal(Object.prototype.hasOwnProperty.call(com.calls[0], "tools"), false);
});

test("tools: a ToolDef from llm.list_tools is included on the tools array", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { llm: library([com]) });
  h.toolsRef.push({ name: "t1", parameters: { type: "object" } });
  h.setCompose("CTX");
  trigger(h.events);
  await settle();
  assert.ok(Array.isArray(com.calls[0].tools));
  assert.equal(com.calls[0].tools!.length, 1);
  assert.equal(com.calls[0].tools![0].name, "t1");
});

test("tools: with NO llm.list_tools action on the bus, the request goes out tool-less (no throw)", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { llm: library([com]), noToolManager: true });
  h.setCompose("CTX");
  assert.doesNotThrow(() => trigger(h.events));
  await settle();
  assert.equal(com.calls.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(com.calls[0], "tools"), false);
});

// ===========================================================================
// 4. messages from prompt.compose
// ===========================================================================

test("messages: composed messages become the chat messages; context.text becomes system", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  const convo: Message[] = [
    { role: "user", content: "hi", name: "web-chat" },
    { role: "assistant", content: "yo" },
  ];
  h.setCompose("SYSTEM-CTX", convo);
  trigger(h.events);
  await settle();
  assert.equal(com.calls[0].system, "SYSTEM-CTX");
  assert.deepEqual(com.calls[0].messages, convo);
});

test("messages: tool turns keep toolCallId/name and assistant toolCalls pass through verbatim", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  const convo: Message[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "time.now", arguments: {} }] },
    { role: "tool", content: '{"iso":"x"}', toolCallId: "c1", name: "time.now" },
  ];
  h.setCompose("CTX", convo);
  trigger(h.events);
  await settle();
  assert.deepEqual(com.calls[0].messages, convo);
  assert.equal(com.calls[0].system, "CTX");
});

// ===========================================================================
// 5. output.message
// ===========================================================================

test("output.message: non-empty content emits output.message with data.text = content", async (t) => {
  const com = chatCommunicator({ response: { content: "hello world" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const outs = collect(h.events, Events.OUTPUT_MESSAGE) as any[];
  trigger(h.events);
  await settle();
  assert.equal(outs.length, 1);
  assert.equal(outs[0].data.text, "hello world");
});

test("output.message: empty content emits llm.return but NO output.message", async (t) => {
  const com = chatCommunicator({ response: { content: "" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const outs = collect(h.events, Events.OUTPUT_MESSAGE) as any[];
  trigger(h.events);
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, true);
  assert.equal(outs.length, 0);
});

// ===========================================================================
// 6. communicator selection
// ===========================================================================

test("selection: config {communicator:'named'} uses library.get('named')", async (t) => {
  const named = chatCommunicator({ name: "named", response: { content: "A" } });
  const other = chatCommunicator({ name: "other", response: { content: "B" } });
  const h = await setupPlugin(t, { config: { communicator: "named" }, llm: library([other, named]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  trigger(h.events);
  await settle();
  assert.equal(named.calls.length, 1);
  assert.equal(other.calls.length, 0);
  assert.equal(replies[0].data.content, "A");
});

test("selection: no config uses first of withCapability('chat')", async (t) => {
  const first = chatCommunicator({ name: "first", response: { content: "FIRST" } });
  const second = chatCommunicator({ name: "second", response: { content: "SECOND" } });
  const h = await setupPlugin(t, { llm: library([first, second]) });
  h.setCompose("CTX");
  trigger(h.events);
  await settle();
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
});

test("selection: skips non-chat communicators when choosing the default", async (t) => {
  const embed = embedOnlyCommunicator("embedder");
  const chat = chatCommunicator({ name: "chatter", response: { content: "C" } });
  const h = await setupPlugin(t, { llm: library([embed, chat]) });
  h.setCompose("CTX");
  trigger(h.events);
  await settle();
  assert.equal(chat.calls.length, 1);
});

test("selection: NO chat-capable communicator -> llm.return ok:false, no throw, no output", async (t) => {
  const h = await setupPlugin(t, { llm: library([embedOnlyCommunicator()]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const outs = collect(h.events, Events.OUTPUT_MESSAGE) as any[];
  assert.doesNotThrow(() => trigger(h.events));
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").length > 0);
  assert.equal(outs.length, 0);
});

test("selection: config names a non-existent communicator -> ok:false, no fallback", async (t) => {
  const real = chatCommunicator({ name: "real", response: { content: "x" } });
  const h = await setupPlugin(t, { config: { communicator: "ghost" }, llm: library([real]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  assert.doesNotThrow(() => trigger(h.events));
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.equal(real.calls.length, 0);
});

// ===========================================================================
// 7. chat() rejection
// ===========================================================================

test("rejection: chat() rejection -> llm.return ok:false with the error text, no output", async (t) => {
  const com = chatCommunicator({ reject: new Error("boom") });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const outs = collect(h.events, Events.OUTPUT_MESSAGE) as any[];
  trigger(h.events);
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").includes("boom"));
  assert.equal(outs.length, 0);
});

// ===========================================================================
// 8. config temperature / maxTokens forwarding
// ===========================================================================

test("config: temperature is forwarded onto the chat request when set", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { config: { temperature: 0.42 }, llm: library([com]) });
  h.setCompose("CTX");
  trigger(h.events);
  await settle();
  assert.equal(com.calls[0].temperature, 0.42);
});

test("config: maxTokens is forwarded onto the chat request when set", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { config: { maxTokens: 256 }, llm: library([com]) });
  h.setCompose("CTX");
  trigger(h.events);
  await settle();
  assert.equal(com.calls[0].maxTokens, 256);
});

test("config: temperature=0 (boundary) is forwarded, not dropped as falsy", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { config: { temperature: 0 }, llm: library([com]) });
  h.setCompose("CTX");
  trigger(h.events);
  await settle();
  assert.equal(com.calls[0].temperature, 0);
});

// ===========================================================================
// 9. llm.request.sent — the EXACT dispatched request
// ===========================================================================

function collectSent(events: Harness["events"]): Array<{ id: string; at: number; data: { request: LLMRequest } }> {
  return collect(events, Events.LLM_REQUEST_SENT) as Array<{
    id: string;
    at: number;
    data: { request: LLMRequest };
  }>;
}

test("request.sent: data.request deep-equals the chat() arg; id matches the llm.return", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } });
  const h = await setupPlugin(t, { config: { temperature: 0.7, maxTokens: 128 }, llm: library([com]) });
  h.toolsRef.push({ name: "t1", description: "d", parameters: { type: "object" } });
  h.setCompose("SYS", [
    { role: "user", content: "q", name: "web-chat" },
    { role: "assistant", content: "a" },
  ]);
  const sent = collectSent(h.events);
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  trigger(h.events);
  await settle();

  assert.equal(com.calls.length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data.request, com.calls[0], "mirror deep-equals the dispatched request");
  assert.equal(sent[0].id, replies[0].id, "sent and return share the corrId");
  const req = sent[0].data.request;
  assert.equal(req.system, "SYS");
  assert.equal(req.tools!.length, 1);
  assert.equal(req.temperature, 0.7);
  assert.equal(req.maxTokens, 128);
});

test("request.sent: STILL emitted when chat() rejects (alongside the ok:false llm.return)", async (t) => {
  const com = chatCommunicator({ reject: new Error("boom") });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const sent = collectSent(h.events);
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  trigger(h.events);
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data.request, com.calls[0]);
  assert.equal(replies[0].ok, false);
});

test("request.sent: NOT emitted when there is no chat-capable communicator", async (t) => {
  const h = await setupPlugin(t, { llm: library([embedOnlyCommunicator()]) });
  h.setCompose("CTX");
  const sent = collectSent(h.events);
  trigger(h.events);
  await settle();
  assert.equal(sent.length, 0);
});

// ===========================================================================
// 10. compose robustness
// ===========================================================================

test("compose: with NO prompt.compose action, a trigger dispatches NOTHING (no chat, no return)", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { llm: library([com]), noCompose: true });
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  assert.doesNotThrow(() => trigger(h.events));
  await settle();
  assert.equal(com.calls.length, 0, "nothing to compose => nothing sent");
  assert.equal(replies.length, 0);
});

test("compose: a rejecting prompt.compose dispatches nothing and does not throw", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { llm: library([com]), composeReject: true });
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  assert.doesNotThrow(() => trigger(h.events));
  await settle();
  assert.equal(com.calls.length, 0);
  assert.equal(replies.length, 0);
});

// ===========================================================================
// 11. malformed triggers ignored
// ===========================================================================

for (const [label, payload] of [
  ["undefined", undefined],
  ["null", null],
  ["a string", "nope"],
] as Array<[string, unknown]>) {
  test(`malformed trigger: ${label} -> no compose, no chat, no throw`, async (t) => {
    const com = chatCommunicator({});
    const h = await setupPlugin(t, { llm: library([com]) });
    h.setCompose("CTX");
    assert.doesNotThrow(() => h.events.emit(Events.LLM_REQUEST, payload));
    await settle();
    assert.equal(com.calls.length, 0);
    assert.equal(h.composeCalls(), 0);
  });
}

test("trigger without agentId falls back to ctx.agentId and still sends", async (t) => {
  const com = chatCommunicator({});
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  h.events.emit(Events.LLM_REQUEST, { at: Date.now(), data: {} });
  await settle();
  assert.equal(com.calls.length, 1, "a trigger with no agentId still composes+sends under the agent's own id");
});

// ===========================================================================
// 12. METHOD B — per-agentId single-flight + coalescing
// ===========================================================================

test("single-flight: a trigger while a request is in flight does NOT start a 2nd request; it coalesces to one follow-up", async (t) => {
  const com = chatCommunicator({ delayMs: 50 });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");

  trigger(h.events); // starts request #1 (in flight ~50ms)
  await settle(10);
  assert.equal(com.calls.length, 1, "one request in flight");

  // Two more triggers WHILE #1 is in flight — must coalesce to a single follow-up.
  trigger(h.events);
  trigger(h.events);
  await settle(10);
  assert.equal(com.calls.length, 1, "no concurrent request while one is in flight");

  await settle(80); // #1 resolves → exactly ONE coalesced follow-up runs
  assert.equal(com.calls.length, 2, "exactly one coalesced follow-up after the in-flight request");

  await settle(80);
  assert.equal(com.calls.length, 2, "no further requests without a new trigger");
});

test("single-flight: with nothing queued, a request that finishes does NOT auto-repeat", async (t) => {
  const com = chatCommunicator({ delayMs: 20, response: { content: "x" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  trigger(h.events);
  await settle(80);
  assert.equal(com.calls.length, 1, "one trigger => exactly one request, no spurious repeat");
});

test("single-flight: the coalesced follow-up RE-COMPOSES (carries context updated while waiting)", async (t) => {
  const com = chatCommunicator({ delayMs: 50, response: { content: "x" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("BEFORE");
  trigger(h.events); // #1 composes "BEFORE"
  await settle(10);

  // Update what compose returns, then trigger while #1 is still in flight.
  h.setCompose("AFTER");
  trigger(h.events);
  await settle(80);

  assert.equal(com.calls.length, 2);
  assert.equal(com.calls[0].messages![0].content, "BEFORE", "first request used the original body");
  assert.equal(com.calls[1].messages![0].content, "AFTER", "the follow-up re-composed with the updated body");
});

test("isolation: triggers for DIFFERENT agentIds run concurrently (separate locks)", async (t) => {
  const com = chatCommunicator({ delayMs: 50 });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  trigger(h.events, "A");
  trigger(h.events, "B");
  await settle(15);
  assert.equal(com.calls.length, 2, "two distinct agentIds => two concurrent in-flight requests");
});

test("isolation: a SECOND trigger for the SAME agentId during flight coalesces (one follow-up), unlike a different id", async (t) => {
  const com = chatCommunicator({ delayMs: 40 });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  trigger(h.events, "A");
  trigger(h.events, "A"); // same id -> coalesces
  await settle(12);
  assert.equal(com.calls.length, 1, "same-id second trigger does not start a concurrent request");
  await settle(80);
  assert.equal(com.calls.length, 2, "one coalesced follow-up for A");
});

test("lock release: a chat() rejection still releases the lock — a later trigger sends again", async (t) => {
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
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];

  trigger(h.events);
  await settle();
  assert.equal(com.calls.length, 1);
  assert.equal(replies[0].ok, false);

  // The lock must have been released despite the rejection.
  trigger(h.events);
  await settle();
  assert.equal(com.calls.length, 2, "a later trigger sends again (the lock was released after the failure)");
  assert.equal(replies[1].ok, true);
  assert.equal(replies[1].data.content, "recovered");
});

// ===========================================================================
// 14. CONTEXT OVERFLOW (context.full) — NEW behavior
// ===========================================================================
//
// Per frame llm-core composes the body via `prompt.compose`, ESTIMATES its token
// size, and compares against a budget derived from the chosen communicator:
//
//   budget   = (config.contextLimitTokens ?? communicator.contextLength)
//              − (config.maxTokens ?? 0) − safetyTokens          (safetyTokens default 200)
//   estimate ≈ ( len(system text) + Σ len(each message's text content)
//               + len(JSON.stringify(tool defs)) ) / charsPerToken   (charsPerToken default 4)
//
// When estimate > budget it emits `context.full` (a synchronous, fire-and-forget
// Notify) so message-block plugins can shrink, then RE-COMPOSES and re-checks —
// up to `maxReduceRounds` times (default 3). `round` increments 1,2,3,…  No matter
// what, it ALWAYS sends exactly once (it never drops the frame on overflow).
//
// Detection is INERT unless a window is known: a communicator with no
// `contextLength` and no `contextLimitTokens` override => never emits.
// ---------------------------------------------------------------------------

/** A chat communicator that also advertises a context window (tokens). */
function chatComWithWindow(opts: {
  name?: string;
  contextLength?: number;
  response?: LLMResponse;
}): ChatStub {
  const stub = chatCommunicator({ name: opts.name, response: opts.response });
  // contextLength is readonly in the type; assign through a cast for the stub.
  (stub as { contextLength?: number }).contextLength = opts.contextLength;
  return stub;
}

/** Capture every context.full payload (newest last). */
function collectFull(
  events: Harness["events"],
): Array<{ at: number; data: { estimatedTokens: number; limit: number; overBy: number; round: number } }> {
  return collect(events, Events.CONTEXT_FULL) as Array<{
    at: number;
    data: { estimatedTokens: number; limit: number; overBy: number; round: number };
  }>;
}

/** A single user message whose text content is exactly `n` chars. */
function msgOfLen(n: number): Message {
  return { role: "user", content: "x".repeat(n) };
}

// ---- 14a. INERT: no window known --------------------------------------------

test("overflow/inert: communicator WITHOUT contextLength and no override -> NO context.full, one compose, one chat", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } }); // no contextLength
  const h = await setupPlugin(t, { llm: library([com]) });
  // A deliberately enormous body that WOULD overflow any sane window.
  h.setCompose("Z".repeat(100_000), [msgOfLen(100_000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "no window => detection is inert");
  assert.equal(h.composeCalls(), 1, "exactly one compose (no reduce loop)");
  assert.equal(com.calls.length, 1, "current behavior preserved: exactly one chat()");
});

test("overflow/inert: a huge body still SENDS unchanged when no window is known", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  // Use explicit messages so the body lands on `system` (not the no-messages fallback).
  const huge = "HUGE-SYSTEM".repeat(20_000);
  h.setCompose(huge, [{ role: "user", content: "hi" }]);
  trigger(h.events);
  await settle();
  assert.equal(com.calls.length, 1);
  assert.equal(com.calls[0].system, huge, "system text forwarded verbatim, never truncated when inert");
  assert.deepEqual(com.calls[0].messages, [{ role: "user", content: "hi" }]);
});

// ---- 14b. FITS: window present, body under budget ---------------------------

test("overflow/fits: small body under budget -> NO context.full, one chat", async (t) => {
  const com = chatComWithWindow({ contextLength: 8000, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX", [{ role: "user", content: "hi" }]); // a handful of chars
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "comfortably under budget => no overflow event");
  assert.equal(com.calls.length, 1);
});

test("overflow/fits BVA: estimate exactly AT budget (not strictly over) -> NO context.full", async (t) => {
  // window 1000, maxTokens 0 (unset), safety 200 default => budget = 800 tokens.
  // charsPerToken default 4 => budget = 3200 chars. Build a body of exactly 3200
  // chars: estimate == budget, which is NOT "> budget" => no emission.
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("", [msgOfLen(3200)]); // 3200 chars / 4 = 800 == budget
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "estimate == budget is not OVER the budget");
  assert.equal(com.calls.length, 1);
});

test("overflow/fits BVA: budget accounts for maxTokens reservation (body fits only because window is large enough)", async (t) => {
  // window 2000, maxTokens 600, safety 200 => budget = 1200 tokens = 4800 chars.
  // A 4000-char body (=1000 tokens) is under 1200 => fits.
  const com = chatComWithWindow({ contextLength: 2000, response: { content: "ok" } });
  const h = await setupPlugin(t, { config: { maxTokens: 600 }, llm: library([com]) });
  h.setCompose("", [msgOfLen(4000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0);
  assert.equal(com.calls.length, 1);
  assert.equal(com.calls[0].maxTokens, 600, "maxTokens still forwarded");
});

// ---- 14c. OVER budget: emits, first round metadata, still sends -------------

test("overflow/over: huge body over a small window -> emits context.full and STILL chats exactly once", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  // Same huge body every compose (no reducer wired) => overflows every round.
  h.setCompose("Z".repeat(200_000));
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "at least one context.full when over budget");
  assert.equal(com.calls.length, 1, "overflow never drops the frame: exactly one chat()");
});

test("overflow/over: first emission has round===1, limit===budget, and sensible estimate/overBy", async (t) => {
  // window 1000, maxTokens 0, safety 200 => budget = 800 tokens.
  // body: 8000-char user message => estimate = 2000 tokens. overBy = 1200.
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("", [msgOfLen(8000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1);
  const first = fulls[0].data;
  assert.equal(first.round, 1, "first emission of the frame is round 1");
  assert.equal(first.limit, 800, "limit === budget = contextLength - maxTokens - safety");
  assert.equal(first.estimatedTokens, 2000, "estimate = 8000 chars / 4 charsPerToken");
  assert.equal(first.overBy, 1200, "overBy = estimate - budget");
  assert.equal(typeof fulls[0].at, "number", "Notify carries a timestamp");
});

test("overflow/over BVA: estimate one token OVER budget still emits", async (t) => {
  // budget 800 tokens = 3200 chars; 3204 chars => 801 tokens => overBy 1.
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("", [msgOfLen(3204)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "just-over budget triggers an emission");
  assert.equal(fulls[0].data.round, 1);
  assert.equal(fulls[0].data.overBy, 1, "minimal overshoot reported as overBy 1");
  assert.equal(com.calls.length, 1);
});

test("overflow/over: tool defs JSON counts toward the estimate (window-only body would otherwise fit)", async (t) => {
  // window 1000 => budget 800 tokens = 3200 chars. Body alone is 3000 chars
  // (=750 tokens, fits), but a large tool-def JSON pushes the total over.
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.toolsRef.push({
    name: "big",
    description: "D".repeat(2000), // serialized JSON adds well over 200 chars
    parameters: { type: "object" },
  });
  h.setCompose("", [msgOfLen(3000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "tool-def chars push the estimate over budget");
  assert.equal(com.calls.length, 1);
  assert.ok(Array.isArray(com.calls[0].tools), "tools still dispatched");
});

// ---- 14d. config knobs: charsPerToken / safetyTokens ------------------------

test("overflow/config: charsPerToken changes the estimate (denser packing fits what a 4:1 ratio would overflow)", async (t) => {
  // window 1000 => budget 800 tokens. A 6400-char body is 1600 tokens at 4:1
  // (overflow) but only 800 tokens at 8:1 (== budget, fits).
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { config: { charsPerToken: 8 }, llm: library([com]) });
  h.setCompose("", [msgOfLen(6400)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "at 8 chars/token the body fits exactly => no overflow");
  assert.equal(com.calls.length, 1);
});

test("overflow/config: larger safetyTokens shrinks the budget and forces an overflow that the default would not", async (t) => {
  // window 1000, maxTokens 0. body 3000 chars = 750 tokens.
  // default safety 200 => budget 800 => fits. safety 400 => budget 600 => overflow.
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { config: { safetyTokens: 400 }, llm: library([com]) });
  h.setCompose("", [msgOfLen(3000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "a larger safety margin makes the same body overflow");
  assert.equal(fulls[0].data.limit, 600, "budget = 1000 - 0 - 400");
  assert.equal(com.calls.length, 1);
});

test("overflow/config BVA: safetyTokens 0 uses the whole window minus maxTokens", async (t) => {
  // window 1000, maxTokens 0, safety 0 => budget 1000 tokens = 4000 chars.
  // 4000-char body == budget => fits (not strictly over).
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, { config: { safetyTokens: 0 }, llm: library([com]) });
  h.setCompose("", [msgOfLen(4000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "with zero safety the full window is usable");
  assert.equal(com.calls.length, 1);
});

// ---- 14e. contextLimitTokens override ---------------------------------------

test("overflow/override: contextLimitTokens drives detection even when communicator.contextLength is undefined", async (t) => {
  const com = chatCommunicator({ response: { content: "ok" } }); // NO contextLength
  // override 1000 => budget 800 tokens. 8000-char body = 2000 tokens => overflow.
  const h = await setupPlugin(t, { config: { contextLimitTokens: 1000 }, llm: library([com]) });
  h.setCompose("", [msgOfLen(8000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "override supplies the window when the communicator omits it");
  assert.equal(fulls[0].data.limit, 800);
  assert.equal(com.calls.length, 1);
});

test("overflow/override: contextLimitTokens OVERRIDES a present communicator.contextLength", async (t) => {
  // communicator says 100000 (huge) but the override pins 1000 => budget 800.
  // 8000-char body overflows the override-derived budget.
  const com = chatComWithWindow({ contextLength: 100000, response: { content: "ok" } });
  const h = await setupPlugin(t, { config: { contextLimitTokens: 1000 }, llm: library([com]) });
  h.setCompose("", [msgOfLen(8000)]);
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "the explicit override wins over the communicator's metadata");
  assert.equal(fulls[0].data.limit, 800, "budget computed from the override, not 100000");
  assert.equal(com.calls.length, 1);
});

// ---- 14f. BOUNDED: no-op reducers do not loop forever -----------------------

/**
 * Register a custom prompt.compose on a harness built with noCompose:true.
 * `bodyFor(callIndex)` returns the system text for the 1-based Nth compose call,
 * so a test can model a reducer that shrinks (or refuses to shrink) over rounds.
 * Returns a live counter of how many times compose ran.
 */
function customCompose(
  h: Harness,
  bodyFor: (call: number) => { text: string; messages?: Message[] },
): { calls: () => number } {
  let n = 0;
  h.actions.register(Actions.PROMPT_COMPOSE, async () => {
    n += 1;
    const { text, messages } = bodyFor(n);
    return { context: { text }, messages: messages ?? [] };
  });
  return { calls: () => n };
}

test("overflow/bounded: a reducer that never shrinks is capped at maxReduceRounds emissions and still sends once", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, {
    config: { maxReduceRounds: 2 },
    llm: library([com]),
    noCompose: true,
  });
  // Same huge body every call => overflow persists; loop must stop at the cap.
  const c = customCompose(h, () => ({ text: "", messages: [msgOfLen(40000)] }));
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "overflow is detected");
  assert.ok(fulls.length <= 2, `at most maxReduceRounds (2) emissions, got ${fulls.length}`);
  assert.equal(com.calls.length, 1, "still sends exactly once (no infinite loop)");
  assert.ok(c.calls() <= 3, "compose runs at most maxReduceRounds+1 times (initial + reductions)");
});

test("overflow/bounded BVA: maxReduceRounds=1 emits at most once for a stuck reducer", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, {
    config: { maxReduceRounds: 1 },
    llm: library([com]),
    noCompose: true,
  });
  customCompose(h, () => ({ text: "", messages: [msgOfLen(40000)] }));
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1 && fulls.length <= 1, `exactly one emission, got ${fulls.length}`);
  assert.equal(com.calls.length, 1);
});

test("overflow/bounded: rounds increment 1..N monotonically across a frame (no reuse, no gaps)", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, {
    config: { maxReduceRounds: 3 },
    llm: library([com]),
    noCompose: true,
  });
  customCompose(h, () => ({ text: "", messages: [msgOfLen(40000)] }));
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  const rounds = fulls.map((f) => f.data.round);
  assert.deepEqual(
    rounds,
    rounds.map((_, i) => i + 1),
    "rounds are a contiguous 1..N sequence",
  );
  assert.equal(com.calls.length, 1);
});

// ---- 14g. SETTLES: a shrinking reducer eventually fits ----------------------

test("overflow/settles: a reducer that shrinks each round eventually fits, then chats once with the reduced body", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, {
    config: { maxReduceRounds: 5 },
    llm: library([com]),
    noCompose: true,
  });
  // budget = 800 tokens = 3200 chars.
  // call 1: 8000 chars (over) -> emit round 1
  // call 2: 4000 chars (over) -> emit round 2
  // call 3: 2000 chars (FITS) -> send
  const sizes = [8000, 4000, 2000];
  customCompose(h, (call) => ({ text: "", messages: [msgOfLen(sizes[Math.min(call - 1, sizes.length - 1)])] }));
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "overflow emitted while still over budget");
  assert.equal(fulls.length, 2, "emits once per over-budget round, stops once it fits");
  assert.equal(com.calls.length, 1, "exactly one chat()");
  assert.equal(
    (com.calls[0].messages![0].content as string).length,
    2000,
    "the SENT body is the reduced (fitting) one, not an earlier oversized compose",
  );
});

test("overflow/settles: settling on the first reduction emits exactly round 1 then sends", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, {
    config: { maxReduceRounds: 5 },
    llm: library([com]),
    noCompose: true,
  });
  // call 1: over (8000 chars). call 2+: fits (1000 chars).
  customCompose(h, (call) => ({ text: "", messages: [msgOfLen(call === 1 ? 8000 : 1000)] }));
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 1, "one over-budget round before it fits");
  assert.equal(fulls[0].data.round, 1);
  assert.equal(com.calls.length, 1);
  assert.equal((com.calls[0].messages![0].content as string).length, 1000, "sent the reduced body");
});

// ---- 14h. negative / error-guessing ----------------------------------------

test("overflow/negative: contextLength of 0 is treated as 'no window' (inert), not a zero budget", async (t) => {
  // A 0-token window is meaningless; detection should not fire on every frame.
  const com = chatComWithWindow({ contextLength: 0, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("anything at all");
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "contextLength 0 is inert (no usable window)");
  assert.equal(com.calls.length, 1);
});

test("overflow/negative: an empty composed body never overflows a real window", async (t) => {
  const com = chatComWithWindow({ contextLength: 8000, response: { content: "ok" } });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose(""); // empty
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0);
  assert.equal(com.calls.length, 1);
  assert.deepEqual(com.calls[0].messages, [{ role: "user", content: "" }]);
});

test("overflow/negative: NO chat-capable communicator -> no context.full (nothing to budget against)", async (t) => {
  const h = await setupPlugin(t, { llm: library([embedOnlyCommunicator()]) });
  h.setCompose("Z".repeat(500_000));
  const fulls = collectFull(h.events);
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "with no communicator there is no window and no send");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
});

test("overflow/negative: chat() rejection after an overflow still resolves one ok:false return (overflow does not swallow the error path)", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000 });
  // make this communicator reject
  com.chat = (req: LLMRequest) => {
    com.calls.push(req);
    return Promise.reject(new Error("boom"));
  };
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("Z".repeat(200_000));
  const fulls = collectFull(h.events);
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "overflow still detected before the failing send");
  assert.equal(com.calls.length, 1, "still exactly one send attempt");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").includes("boom"));
});

test("overflow/state: a second frame re-runs detection from round 1 (counter is per-frame, not cumulative)", async (t) => {
  const com = chatComWithWindow({ contextLength: 1000, response: { content: "ok" } });
  const h = await setupPlugin(t, {
    config: { maxReduceRounds: 2 },
    llm: library([com]),
    noCompose: true,
  });
  customCompose(h, () => ({ text: "", messages: [msgOfLen(40000)] }));
  const fulls = collectFull(h.events);

  trigger(h.events);
  await settle();
  const firstFrame = fulls.length;
  assert.ok(firstFrame >= 1 && firstFrame <= 2);
  assert.equal(fulls[0].data.round, 1, "frame 1 starts at round 1");

  // Second, independent frame.
  trigger(h.events);
  await settle();
  assert.equal(com.calls.length, 2, "two frames => two sends");
  const secondFrameStart = fulls[firstFrame]?.data.round;
  assert.equal(secondFrameStart, 1, "the new frame restarts the round counter at 1");
});

// ===========================================================================
// 16. REACTIVE CONTEXT-OVERFLOW RETRY — NEW behavior
// ===========================================================================
//
// Distinct from §14's PROACTIVE char-estimate path. This path is triggered by the
// PROVIDER: when `communicator.chat()` REJECTS and `String(err)` matches a context
// pattern AND the shared `maxReduceRounds` budget is not exhausted, llm-core:
//   1. emits `context.full` (escalating `round`),
//   2. re-invokes `prompt.compose` (so reactors that shed produce a smaller body),
//   3. reassembles and RETRIES `chat()`.
// Every real `chat()` attempt emits `llm.request.sent`. Otherwise (non-context
// error, retryOnContextError:false, or budget exhausted) it reports ONE
// `llm.return{ok:false, error}` immediately. Exactly ONE terminal `llm.return`.
//
// New config keys on llm-core's slice:
//   - retryOnContextError: boolean (default true)
//   - contextErrorPatterns: string[] (default set below), matched
//     CASE-INSENSITIVELY against String(err).
//
// ASSUMPTIONS (need confirmation — not all explicit in the contract):
//  A1. `round` is drawn from the SAME `maxReduceRounds` budget the proactive path
//      uses (a SHARED per-frame cap). In a pure-reactive scenario (no proactive
//      window) the first reactive emission is round===1 and rounds increment
//      1,2,3,… across successive provider rejections within the one frame.
//  A2. With `maxReduceRounds` reactive retries permitted, `chat()` is attempted at
//      most `maxReduceRounds + 1` times (initial send + one retry per budgeted
//      round), then the last error is reported terminally.
//  A3. The default `contextErrorPatterns` include `context_length_exceeded`,
//      `maximum context length`, `prompt is too long`, `input is too long`,
//      `too many tokens`, and `reduce the length`. Matching is case-insensitive
//      on `String(err)` (so an Error's `.message`, surfaced by Error.toString, is
//      what we match against).
//  A4. The reactive path is INDEPENDENT of any context window: it fires even when
//      no `contextLength`/`contextLimitTokens` is known (the proactive path inert).
//  A5. `maxReduceRounds:0` disables BOTH the proactive reduce loop and the reactive
//      retry — a context rejection reports ok:false on the first failure.
// ---------------------------------------------------------------------------

/** A representative default-pattern context-overflow error string. */
const CTX_ERR = "context_length_exceeded";

/**
 * A chat communicator whose chat() rejects for the first `failTimes` calls with
 * `error`, then resolves `response`. Records every call. Models a provider that
 * keeps rejecting until the body is small enough (or forever, if failTimes is
 * Infinity). Optionally advertises a context window.
 */
function flakyContextCom(opts: {
  name?: string;
  failTimes: number;
  error: unknown;
  response?: LLMResponse;
  contextLength?: number;
}): ChatStub {
  let n = 0;
  const stub: ChatStub = {
    name: opts.name ?? "flaky-ctx",
    provider: "stub",
    model: "stub-model",
    capabilities: ["chat"],
    input: ["text"],
    output: ["text"],
    calls: [],
    chat(req: LLMRequest): Promise<LLMResponse> {
      stub.calls.push(req);
      n += 1;
      if (n <= opts.failTimes) return Promise.reject(opts.error);
      return Promise.resolve(opts.response ?? { content: "recovered" });
    },
  };
  if (opts.contextLength !== undefined) {
    (stub as { contextLength?: number }).contextLength = opts.contextLength;
  }
  return stub;
}

// ---- 16a. CONTEXT ERROR THEN SUCCESS (positive / state-transition) ----------

test("reactive: a context-length rejection then a success -> exactly one ok:true, >=1 context.full (first round 1), >=2 chat()", async (t) => {
  const com = flakyContextCom({
    failTimes: 1,
    error: new Error(`Request failed: ${CTX_ERR}`),
    response: { content: "recovered" },
  });
  const h = await setupPlugin(t, { llm: library([com]), noCompose: true });
  // A reducer that shrinks on the retry (proves re-compose feeds chat()).
  customCompose(h, (call) => ({ text: "", messages: [msgOfLen(call === 1 ? 8000 : 100)] }));
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  const sent = collectSent(h.events);
  trigger(h.events);
  await settle();

  assert.equal(replies.length, 1, "exactly one terminal llm.return");
  assert.equal(replies[0].ok, true, "the retried send succeeded");
  assert.equal(replies[0].data.content, "recovered");
  assert.ok(fulls.length >= 1, "at least one context.full emitted on the provider error");
  assert.equal(fulls[0].data.round, 1, "first reactive emission is round 1");
  assert.ok(com.calls.length >= 2, "chat() retried after the context rejection");
  assert.ok(sent.length >= 2, "each real chat() attempt emits llm.request.sent");
  // The retried send carried the SMALLER re-composed body.
  assert.equal(
    (com.calls[com.calls.length - 1].messages![0].content as string).length,
    100,
    "the successful retry used the re-composed (shrunk) body",
  );
});

test("reactive: the retried chat() carries a FRESH re-composed body (compose runs again)", async (t) => {
  const com = flakyContextCom({
    failTimes: 1,
    error: new Error(CTX_ERR),
    response: { content: "ok" },
  });
  const h = await setupPlugin(t, { llm: library([com]), noCompose: true });
  const c = customCompose(h, (call) => ({ text: "", messages: [msgOfLen(call === 1 ? 5000 : 50)] }));
  trigger(h.events);
  await settle();
  assert.ok(c.calls() >= 2, "prompt.compose re-invoked for the retry");
  assert.equal(com.calls.length, 2, "one failed send + one successful retry");
  assert.equal((com.calls[0].messages![0].content as string).length, 5000, "first send used the original body");
  assert.equal((com.calls[1].messages![0].content as string).length, 50, "retry used the re-composed body");
});

// ---- 16b. PERSISTENT CONTEXT ERROR (boundary / bounded loop) -----------------

test("reactive/bounded: a context error that never clears emits context.full at most maxReduceRounds times, then ONE ok:false carrying the message", async (t) => {
  const MAX = 3; // default maxReduceRounds
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error(`fatal: ${CTX_ERR}`),
  });
  const h = await setupPlugin(t, { llm: library([com]), noCompose: true });
  customCompose(h, () => ({ text: "", messages: [msgOfLen(40000)] }));
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();

  assert.ok(fulls.length >= 1, "overflow detected at least once");
  assert.ok(fulls.length <= MAX, `context.full emitted at most maxReduceRounds (${MAX}), got ${fulls.length}`);
  assert.equal(replies.length, 1, "exactly one terminal llm.return (no infinite loop)");
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").includes(CTX_ERR), "the terminal error carries the provider message");
  assert.ok(
    com.calls.length <= MAX + 1,
    `chat() attempted at most maxReduceRounds+1 (${MAX + 1}) times, got ${com.calls.length}`,
  );
  assert.ok(com.calls.length >= 2, "it did retry at least once before giving up");
});

test("reactive/bounded BVA: maxReduceRounds=1 retries exactly once (>=1, <=1 context.full; <=2 chat()) then ok:false", async (t) => {
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error(CTX_ERR),
  });
  const h = await setupPlugin(t, { config: { maxReduceRounds: 1 }, llm: library([com]), noCompose: true });
  customCompose(h, () => ({ text: "", messages: [msgOfLen(40000)] }));
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 1, "exactly one reactive emission at maxReduceRounds=1");
  assert.equal(fulls[0].data.round, 1);
  assert.ok(com.calls.length <= 2, `at most maxReduceRounds+1 (2) chat() attempts, got ${com.calls.length}`);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
});

test("reactive/bounded: reactive rounds increment 1..N monotonically (contiguous, no gaps) for a stuck provider", async (t) => {
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error(CTX_ERR),
  });
  const h = await setupPlugin(t, { config: { maxReduceRounds: 3 }, llm: library([com]), noCompose: true });
  customCompose(h, () => ({ text: "", messages: [msgOfLen(40000)] }));
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  const rounds = fulls.map((f) => f.data.round);
  assert.deepEqual(
    rounds,
    rounds.map((_, i) => i + 1),
    "reactive emissions carry a contiguous 1..N round sequence",
  );
});

// ---- 16c. NON-CONTEXT ERROR (negative — no retry) ---------------------------

test("reactive/negative: a NON-context rejection (\"boom\") -> NO context.full, NO retry, ONE ok:false with \"boom\", chat() once", async (t) => {
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error("boom"),
    response: { content: "never" },
  });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  const outs = collect(h.events, Events.OUTPUT_MESSAGE) as any[];
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "a non-context error never triggers the reactive retry");
  assert.equal(com.calls.length, 1, "no retry: chat() called exactly once");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").includes("boom"));
  assert.equal(outs.length, 0);
});

test("reactive/negative: a context SUBSTRING in an unrelated word does NOT match a default pattern", async (t) => {
  // "uncontextualized" contains "context" but not any default phrase.
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error("uncontextualized failure: 503"),
  });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "a stray 'context' substring is not a context-overflow pattern");
  assert.equal(com.calls.length, 1, "no retry");
  assert.equal(replies[0].ok, false);
});

// ---- 16d. retryOnContextError:false (state-transition / config) -------------

test("reactive/config: retryOnContextError:false reports a context rejection immediately (one ok:false, no context.full, one chat())", async (t) => {
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error(`Error: ${CTX_ERR}`),
    response: { content: "never" },
  });
  const h = await setupPlugin(t, { config: { retryOnContextError: false }, llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "retry disabled => no reactive context.full");
  assert.equal(com.calls.length, 1, "retry disabled => exactly one chat() attempt");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").includes(CTX_ERR));
});

// ---- 16e. WORKS WITHOUT A WINDOW (proactive path inert) ---------------------

test("reactive/no-window: with NO contextLength and no contextLimitTokens, a context rejection STILL retries (>=1 context.full, >=2 chat())", async (t) => {
  const com = flakyContextCom({
    failTimes: 1,
    error: new Error(CTX_ERR), // no window advertised
    response: { content: "recovered" },
  });
  const h = await setupPlugin(t, { llm: library([com]), noCompose: true });
  // Small body so the PROACTIVE path is inert even if a window existed.
  customCompose(h, () => ({ text: "", messages: [{ role: "user", content: "hi" }] }));
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "reactive path fires independent of any context window");
  assert.equal(fulls[0].data.round, 1);
  assert.ok(com.calls.length >= 2, "it retried even though no window is known");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, true, "the retry succeeded");
});

test("reactive/no-window: a persistent context error with no window is still bounded by maxReduceRounds", async (t) => {
  const MAX = 3;
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error(`maximum context length is 8192 tokens`), // a DIFFERENT default phrase
  });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1 && fulls.length <= MAX, `bounded by maxReduceRounds, got ${fulls.length}`);
  assert.ok(com.calls.length <= MAX + 1, `chat() bounded at maxReduceRounds+1, got ${com.calls.length}`);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
});

// ---- 16f. PATTERN OVERRIDE (config / equivalence partitioning) --------------

test("reactive/patterns: a custom contextErrorPatterns makes a matching error retry", async (t) => {
  const com = flakyContextCom({
    failTimes: 1,
    error: new Error("provider said: my-overflow at row 3"),
    response: { content: "recovered" },
  });
  const h = await setupPlugin(t, {
    config: { contextErrorPatterns: ["my-overflow"] },
    llm: library([com]),
  });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "the custom pattern triggers the reactive retry");
  assert.ok(com.calls.length >= 2, "it retried on the custom pattern");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, true);
});

test("reactive/patterns: a custom contextErrorPatterns REPLACES the defaults (a default phrase no longer retries)", async (t) => {
  // With only ["my-overflow"] configured, the default phrase must NOT match.
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error(CTX_ERR), // a DEFAULT phrase, but defaults are overridden
  });
  const h = await setupPlugin(t, {
    config: { contextErrorPatterns: ["my-overflow"] },
    llm: library([com]),
  });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "the overridden patterns no longer include the default phrase");
  assert.equal(com.calls.length, 1, "no retry for an error outside the custom pattern set");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
});

test("reactive/patterns: matching is CASE-INSENSITIVE against String(err)", async (t) => {
  const com = flakyContextCom({
    failTimes: 1,
    error: new Error("MAXIMUM CONTEXT LENGTH exceeded"), // uppercased default phrase
    response: { content: "recovered" },
  });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "an uppercased context phrase still matches (case-insensitive)");
  assert.ok(com.calls.length >= 2, "it retried on the case-insensitive match");
  assert.equal(replies[0].ok, true);
});

test("reactive/patterns: a non-Error rejection value is coerced via String(err) and matched", async (t) => {
  // Some providers reject with a bare string, not an Error.
  const com = flakyContextCom({
    failTimes: 1,
    error: "input is too long for this model",
    response: { content: "recovered" },
  });
  const h = await setupPlugin(t, { llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.ok(fulls.length >= 1, "String(err) on a bare-string rejection still matches a default phrase");
  assert.ok(com.calls.length >= 2, "retried on the coerced string match");
  assert.equal(replies[0].ok, true);
});

// ---- 16g. maxReduceRounds:0 (boundary — reactive disabled) ------------------

test("reactive/boundary: maxReduceRounds=0 performs NO reactive retry (context rejection reports ok:false immediately, one chat())", async (t) => {
  const com = flakyContextCom({
    failTimes: Number.POSITIVE_INFINITY,
    error: new Error(`Error: ${CTX_ERR}`),
    response: { content: "never" },
  });
  const h = await setupPlugin(t, { config: { maxReduceRounds: 0 }, llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  const fulls = collectFull(h.events);
  trigger(h.events);
  await settle();
  assert.equal(fulls.length, 0, "no reduce budget => no reactive emission");
  assert.equal(com.calls.length, 1, "no reduce budget => no retry");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.ok((replies[0].error ?? "").includes(CTX_ERR));
});

// ---- 16h. terminal-return invariant + lock release --------------------------

test("reactive/invariant: exactly ONE terminal llm.return across a retry-then-success sequence (no duplicate from the failed attempt)", async (t) => {
  const com = flakyContextCom({
    failTimes: 2, // two context rejections, then success
    error: new Error(CTX_ERR),
    response: { content: "recovered" },
  });
  const h = await setupPlugin(t, { config: { maxReduceRounds: 3 }, llm: library([com]), noCompose: true });
  customCompose(h, (call) => ({ text: "", messages: [msgOfLen(call < 3 ? 8000 : 80)] }));
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  trigger(h.events);
  await settle();
  assert.equal(replies.length, 1, "the intermediate failures emit NO terminal return — only the final one");
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].data.content, "recovered");
  assert.equal(com.calls.length, 3, "two failed attempts + one successful retry");
});

test("reactive/state: the lock releases after a reactive give-up — a later frame sends again", async (t) => {
  // First frame: persistent context error -> ok:false after the budget.
  // Second frame: provider recovered -> ok:true. Proves the lock was released.
  let frame = 0;
  const com: ChatStub = {
    name: "ctx-then-ok",
    provider: "stub",
    model: "m",
    capabilities: ["chat"],
    input: ["text"],
    output: ["text"],
    calls: [],
    chat(req: LLMRequest) {
      com.calls.push(req);
      if (frame === 0) return Promise.reject(new Error(CTX_ERR));
      return Promise.resolve({ content: "ok-now" });
    },
  };
  const h = await setupPlugin(t, { config: { maxReduceRounds: 2 }, llm: library([com]) });
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];

  trigger(h.events);
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false, "frame 1 gave up after the budget");
  const callsAfterFrame1 = com.calls.length;
  assert.ok(callsAfterFrame1 >= 2, "frame 1 retried within the budget");

  // Provider recovers; a fresh trigger must send again (lock released).
  frame = 1;
  trigger(h.events);
  await settle();
  assert.equal(replies.length, 2, "frame 2 produced its own terminal return");
  assert.equal(replies[1].ok, true);
  assert.equal(replies[1].data.content, "ok-now");
  assert.ok(com.calls.length > callsAfterFrame1, "frame 2 issued a new send (lock was released)");
});

// ===========================================================================
// 17. teardown
// ===========================================================================

test("teardown: after teardown a later trigger produces nothing", async (t) => {
  const com = chatCommunicator({});
  const p = plugin();
  const h = makeCtx(t, { llm: library([com]) });
  await p.setup(h.ctx);
  h.setCompose("CTX");
  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  await p.teardown?.();
  trigger(h.events);
  await settle();
  assert.equal(replies.length, 0, "listener must be unsubscribed after teardown");
  assert.equal(com.calls.length, 0);
});

// ===========================================================================
// 18. teardown-race warning silence (Finding D)
// ===========================================================================
//
// The missing-PROMPT_COMPOSE branch of sendOnce() logs a ctx.log.warn — a
// GENUINE signal that composition is unavailable — EXCEPT during/after
// teardown, where a coalesced/in-flight trigger racing the shutdown must NOT
// spam that warning. Spec: teardown() sets a `stopping` flag (never reset);
// while stopping the missing-compose branch returns early SILENTLY; while NOT
// stopping the existing warning stays. No contract/bus change.
//
// These tests swap ctx.log for a CAPTURING logger before setup (the shared
// makeCtx harness hardcodes a no-op logger), so warn() output is observable.
// The "compose unavailable" path is exercised exactly as §10 does it, via
// noCompose:true (no PROMPT_COMPOSE action registered on the bus).
// ---------------------------------------------------------------------------

/** A PluginContext whose log.warn calls are recorded, replacing the no-op. */
function captureWarns(ctx: PluginContext): { warns: string[] } {
  const warns: string[] = [];
  (ctx as { log: PluginContext["log"] }).log = {
    info: () => {},
    warn: (msg: string) => void warns.push(msg),
    error: () => {},
  };
  return { warns };
}

test("teardown-silence: a trigger already in flight when teardown runs (PROMPT_COMPOSE unregistered) logs NO warn and does not throw", async (t) => {
  const com = chatCommunicator({});
  const p = plugin();
  // noCompose:true => no prompt.compose action on the bus (the missing-compose path).
  const h = makeCtx(t, { llm: library([com]), noCompose: true });
  const { warns } = captureWarns(h.ctx);
  await p.setup(h.ctx);

  // The teardown RACE: fire the trigger so its (async) handler is already in
  // flight, then enter the stopping state synchronously BEFORE the handler's
  // microtasks resolve. The in-flight frame reaches the missing-compose branch
  // AFTER `stopping` was set — and must fall silent (no ctx.log.warn).
  let threw: unknown;
  try {
    trigger(h.events); // starts the in-flight frame (no await/settle here)
    await p.teardown?.(); // sets `stopping` while the frame is mid-flight
  } catch (e) {
    threw = e;
  }
  await settle();

  assert.equal(threw, undefined, "the teardown race must never throw");
  assert.equal(
    warns.length,
    0,
    `no missing-compose warning during/after teardown (the teardown race is silenced); got: ${JSON.stringify(warns)}`,
  );
  assert.equal(com.calls.length, 0, "nothing composed => nothing sent");
});

test("compose-unavailable OUTSIDE teardown STILL warns (the signal is real when not stopping)", async (t) => {
  const com = chatCommunicator({});
  const p = plugin();
  // Same missing-compose path, but NO teardown => not stopping => warning stays.
  const h = makeCtx(t, { llm: library([com]), noCompose: true });
  const { warns } = captureWarns(h.ctx);
  await p.setup(h.ctx);
  t.after(async () => {
    try {
      await p.teardown?.();
    } catch {
      /* teardown must never throw the suite */
    }
  });

  const replies = collect(h.events, Events.LLM_RETURN) as any[];
  assert.doesNotThrow(() => trigger(h.events), "the missing-compose path must not throw");
  await settle();

  assert.ok(
    warns.length >= 1,
    "outside teardown a missing prompt.compose is a genuine signal and must warn",
  );
  assert.equal(com.calls.length, 0, "nothing to compose => nothing sent");
  assert.equal(replies.length, 0, "no terminal llm.return when composition is unavailable");
});
