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
// 13. teardown
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
