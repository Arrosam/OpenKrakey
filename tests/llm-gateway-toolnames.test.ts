/**
 * Edge tests for the tool-name ENCODE/DECODE bug fix in the llm-gateway adapters
 * (openai-completion + anthropic).
 *
 * THE BUG (found against a real DeepSeek endpoint): Krakey tool names contain dots
 * (e.g. "web-chat.send_message", "log.fetch", "interval.set"). The OpenAI
 * function-calling spec — enforced by OpenAI, DeepSeek, and Anthropic's cloud APIs —
 * requires tool/function names to match /^[a-zA-Z0-9_-]+$/ (NO dots). So a dotted
 * tool name currently 400s on strict providers.
 *
 * THE CONTRACT (observable behavior these tests pin):
 *   (a) SEND-side ENCODE: every tool name placed on the wire must be provider-legal —
 *       match /^[a-zA-Z0-9_-]+$/ (i.e. contain NO dot). OpenAI carries the name at
 *       body.tools[i].function.name; Anthropic at body.tools[i].name.
 *   (b) RECEIVE-side DECODE: a returned tool_call whose function name is the ENCODED
 *       form must be decoded back to the ORIGINAL dotted action name in the parsed
 *       LLMResponse.toolCalls[].name, so the orchestrator dispatches to the real action.
 *   (c) ROUND-TRIP: encode-then-decode restores the exact original name.
 *   (d) EDGE: no-tools requests don't break; an already-legal name passes through
 *       unchanged on the wire AND decodes to itself; an UNKNOWN returned name (never
 *       sent) decodes to itself (pass-through, no throw).
 *
 * These tests are encoding-agnostic: they assert only that the wire name is dot-free
 * and matches the legal pattern, and that the round-trip restores the original. They
 * do NOT hard-code a specific scheme (e.g. exactly "_"), so the dev has latitude — the
 * RECEIVE-side cases derive the encoded name by first capturing what the adapter
 * actually put on the wire, then echoing THAT exact name back in the canned response.
 *
 * The network is mocked: `globalThis.fetch` is replaced per-test with a stub that
 * records the last (url, init) it saw and returns a per-test settable canned body +
 * status. fetch is reset between every test. (Same harness pattern as tests/llm.test.ts.)
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCommunicatorLibrary } from "../packages/llm-gateway/src";
import type { LLMConfig } from "../shared/config";
import type { CommunicatorLibrary, LLMResponse, ToolDef } from "../contracts/llm";

// ---------------------------------------------------------------------------
// fetch mock harness (mirrors tests/llm.test.ts)
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let originalFetch: typeof globalThis.fetch;
let lastCall: FetchCall | undefined;
let cannedBody: unknown;
let cannedStatus: number;

/** Parse the JSON body the gateway sent (string body expected). */
function sentBody(init: RequestInit | undefined): any {
  const b = init?.body;
  if (typeof b === "string") return JSON.parse(b);
  if (b == null) return undefined;
  return JSON.parse(Buffer.from(b as ArrayBuffer).toString("utf8"));
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastCall = undefined;
  cannedBody = {};
  cannedStatus = 200;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : typeof input?.url === "string"
            ? input.url
            : String(input);
    lastCall = { url, init };
    return new Response(JSON.stringify(cannedBody), {
      status: cannedStatus,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// config builders
// ---------------------------------------------------------------------------

function cfg(communicators: LLMConfig["communicators"]): LLMConfig {
  return { communicators };
}

function openaiLib(): CommunicatorLibrary {
  return createCommunicatorLibrary(
    cfg({
      o: {
        provider: "openai-completion",
        model: "deepseek-chat",
        apiKey: "sk-test-key",
        baseURL: "https://api.deepseek.com/v1",
      },
    }),
  );
}

function anthropicLib(): CommunicatorLibrary {
  return createCommunicatorLibrary(
    cfg({ a: { provider: "anthropic", model: "claude-3-5-sonnet", apiKey: "sk-ant-test" } }),
  );
}

// ---------------------------------------------------------------------------
// tool def + response builders
// ---------------------------------------------------------------------------

const EMPTY_SCHEMA = { type: "object", properties: {}, required: [] } as const;

function tool(name: string): ToolDef {
  return { name, description: "d", parameters: { ...EMPTY_SCHEMA } };
}

/** The legal-name regex the OpenAI/DeepSeek/Anthropic cloud APIs enforce. */
const LEGAL = /^[a-zA-Z0-9_-]+$/;

/** Pull the on-the-wire tool names for the OpenAI body shape. */
function openaiWireToolNames(init: RequestInit | undefined): string[] {
  const body = sentBody(init);
  const tools = body?.tools ?? [];
  return tools.map((t: any) => t?.function?.name);
}

/** Pull the on-the-wire tool names for the Anthropic body shape. */
function anthropicWireToolNames(init: RequestInit | undefined): string[] {
  const body = sentBody(init);
  const tools = body?.tools ?? [];
  return tools.map((t: any) => t?.name);
}

/** A canned OpenAI chat response carrying a single tool_call with `name`. */
function openaiToolCallResp(name: string) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name, arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

/** A canned Anthropic response carrying a single tool_use block with `name`. */
function anthropicToolUseResp(name: string) {
  return {
    content: [{ type: "tool_use", id: "tu_1", name, input: {} }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * Send `originalName` as a tool, capture the encoded wire name the adapter used,
 * then (in a fresh round) echo that exact encoded name back and return the decoded
 * LLMResponse.toolCalls[0].name. This keeps the test encoding-agnostic: we never
 * assume HOW the adapter encodes, only that decode(encode(x)) === x.
 */
async function openaiRoundTrip(originalName: string): Promise<{ wire: string; decoded: string | undefined }> {
  const c = openaiLib().get("o")!;
  // SEND: capture the encoded wire name.
  cannedBody = openaiToolCallResp("noop"); // response unused this round
  await c.chat!({ messages: [{ role: "user", content: "hi" }], tools: [tool(originalName)] });
  const wire = openaiWireToolNames(lastCall!.init)[0];
  // RECEIVE: echo the captured encoded name back.
  cannedBody = openaiToolCallResp(wire);
  const res: LLMResponse = await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool(originalName)],
  });
  return { wire, decoded: res.toolCalls?.[0]?.name };
}

async function anthropicRoundTrip(originalName: string): Promise<{ wire: string; decoded: string | undefined }> {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");
  await c.chat!({ messages: [{ role: "user", content: "hi" }], tools: [tool(originalName)] });
  const wire = anthropicWireToolNames(lastCall!.init)[0];
  cannedBody = anthropicToolUseResp(wire);
  const res: LLMResponse = await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool(originalName)],
  });
  return { wire, decoded: res.toolCalls?.[0]?.name };
}

// ===========================================================================
// 1. SEND-side (ENCODE) — every wire tool name is provider-legal (dot-free)
// ===========================================================================

// --- OpenAI ---------------------------------------------------------------

test("openai send: dotted tool names are encoded to a legal (dot-free) wire form", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = openaiToolCallResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("web-chat.send_message"), tool("log.fetch")],
  });

  const names = openaiWireToolNames(lastCall!.init);
  assert.equal(names.length, 2, "both tools must appear on the wire");
  for (const n of names) {
    assert.equal(typeof n, "string", `wire tool name must be a string, got ${typeof n}`);
    assert.ok(!n.includes("."), `wire tool name must contain NO dot, got: ${n}`);
    assert.ok(LEGAL.test(n), `wire tool name must match ${LEGAL}, got: ${n}`);
  }
});

test("openai send: a multi-dot name 'a.b.c' is encoded legal (boundary: several dots)", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = openaiToolCallResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("a.b.c")],
  });

  const name = openaiWireToolNames(lastCall!.init)[0];
  assert.ok(!name.includes("."), `multi-dot name must be fully de-dotted, got: ${name}`);
  assert.ok(LEGAL.test(name), `multi-dot name must encode legal, got: ${name}`);
});

test("openai send: an already-legal name 'search' passes through UNCHANGED (boundary: 0 dots)", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = openaiToolCallResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("search")],
  });

  const name = openaiWireToolNames(lastCall!.init)[0];
  assert.equal(name, "search", `a name with no dots must be unchanged on the wire, got: ${name}`);
  assert.ok(LEGAL.test(name));
});

test("openai send: a single configured tool (boundary: 1 tool) is encoded legal", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = openaiToolCallResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("interval.set")],
  });

  const names = openaiWireToolNames(lastCall!.init);
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes("."), `got: ${names[0]}`);
  assert.ok(LEGAL.test(names[0]));
});

test("openai send: several tools (mix of dotted + legal) are ALL legal on the wire", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = openaiToolCallResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [
      tool("web-chat.send_message"),
      tool("log.fetch"),
      tool("interval.set"),
      tool("search"),
      tool("a.b.c"),
    ],
  });

  const names = openaiWireToolNames(lastCall!.init);
  assert.equal(names.length, 5, "all five tools must appear on the wire");
  for (const n of names) {
    assert.ok(!n.includes("."), `wire tool name must contain NO dot, got: ${n}`);
    assert.ok(LEGAL.test(n), `wire tool name must match ${LEGAL}, got: ${n}`);
  }
});

test("openai send: distinct dotted names encode to DISTINCT legal wire names (no collision)", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = openaiToolCallResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("web-chat.send_message"), tool("log.fetch"), tool("interval.set")],
  });

  const names = openaiWireToolNames(lastCall!.init);
  assert.equal(new Set(names).size, names.length, `encoded wire names must stay distinct, got: ${JSON.stringify(names)}`);
});

// --- Anthropic ------------------------------------------------------------

test("anthropic send: dotted tool names are encoded to a legal (dot-free) wire form", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("web-chat.send_message"), tool("log.fetch")],
  });

  const names = anthropicWireToolNames(lastCall!.init);
  assert.equal(names.length, 2, "both tools must appear on the wire");
  for (const n of names) {
    assert.equal(typeof n, "string", `wire tool name must be a string, got ${typeof n}`);
    assert.ok(!n.includes("."), `wire tool name must contain NO dot, got: ${n}`);
    assert.ok(LEGAL.test(n), `wire tool name must match ${LEGAL}, got: ${n}`);
  }
});

test("anthropic send: a multi-dot name 'a.b.c' is encoded legal (boundary: several dots)", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("a.b.c")],
  });

  const name = anthropicWireToolNames(lastCall!.init)[0];
  assert.ok(!name.includes("."), `multi-dot name must be fully de-dotted, got: ${name}`);
  assert.ok(LEGAL.test(name), `multi-dot name must encode legal, got: ${name}`);
});

test("anthropic send: an already-legal name 'search' passes through UNCHANGED (boundary: 0 dots)", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("search")],
  });

  const name = anthropicWireToolNames(lastCall!.init)[0];
  assert.equal(name, "search", `a name with no dots must be unchanged on the wire, got: ${name}`);
  assert.ok(LEGAL.test(name));
});

test("anthropic send: a single configured tool (boundary: 1 tool) is encoded legal", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("interval.set")],
  });

  const names = anthropicWireToolNames(lastCall!.init);
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes("."), `got: ${names[0]}`);
  assert.ok(LEGAL.test(names[0]));
});

test("anthropic send: several tools (mix of dotted + legal) are ALL legal on the wire", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [
      tool("web-chat.send_message"),
      tool("log.fetch"),
      tool("interval.set"),
      tool("search"),
      tool("a.b.c"),
    ],
  });

  const names = anthropicWireToolNames(lastCall!.init);
  assert.equal(names.length, 5, "all five tools must appear on the wire");
  for (const n of names) {
    assert.ok(!n.includes("."), `wire tool name must contain NO dot, got: ${n}`);
    assert.ok(LEGAL.test(n), `wire tool name must match ${LEGAL}, got: ${n}`);
  }
});

test("anthropic send: distinct dotted names encode to DISTINCT legal wire names (no collision)", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("web-chat.send_message"), tool("log.fetch"), tool("interval.set")],
  });

  const names = anthropicWireToolNames(lastCall!.init);
  assert.equal(new Set(names).size, names.length, `encoded wire names must stay distinct, got: ${JSON.stringify(names)}`);
});

// ===========================================================================
// 2. RECEIVE-side (DECODE) — encoded returned name decodes to the original dotted name
// ===========================================================================

// --- OpenAI ---------------------------------------------------------------

test("openai receive: a returned tool_call referencing the encoded name decodes to 'web-chat.send_message'", async () => {
  const { wire, decoded } = await openaiRoundTrip("web-chat.send_message");
  assert.ok(!wire.includes("."), `precondition: wire name must be encoded (dot-free), got: ${wire}`);
  assert.equal(
    decoded,
    "web-chat.send_message",
    `decoded tool name must be the ORIGINAL dotted action, got: ${decoded}`,
  );
});

test("openai receive: 'log.fetch' decodes back to 'log.fetch'", async () => {
  const { decoded } = await openaiRoundTrip("log.fetch");
  assert.equal(decoded, "log.fetch", `got: ${decoded}`);
});

test("openai receive: a multi-dot 'a.b.c' decodes back to 'a.b.c'", async () => {
  const { decoded } = await openaiRoundTrip("a.b.c");
  assert.equal(decoded, "a.b.c", `multi-dot name must round-trip exactly, got: ${decoded}`);
});

// --- Anthropic ------------------------------------------------------------

test("anthropic receive: a returned tool_use block w/ the encoded name decodes to 'web-chat.send_message'", async () => {
  const { wire, decoded } = await anthropicRoundTrip("web-chat.send_message");
  assert.ok(!wire.includes("."), `precondition: wire name must be encoded (dot-free), got: ${wire}`);
  assert.equal(
    decoded,
    "web-chat.send_message",
    `decoded tool name must be the ORIGINAL dotted action, got: ${decoded}`,
  );
});

test("anthropic receive: 'log.fetch' decodes back to 'log.fetch'", async () => {
  const { decoded } = await anthropicRoundTrip("log.fetch");
  assert.equal(decoded, "log.fetch", `got: ${decoded}`);
});

test("anthropic receive: a multi-dot 'a.b.c' decodes back to 'a.b.c'", async () => {
  const { decoded } = await anthropicRoundTrip("a.b.c");
  assert.equal(decoded, "a.b.c", `multi-dot name must round-trip exactly, got: ${decoded}`);
});

// ===========================================================================
// 3. ROUND-TRIP — encode-then-decode restores the exact original name
// ===========================================================================

test("openai round-trip: 'web-chat.send_message' sent then echoed decodes to exactly 'web-chat.send_message'", async () => {
  const { wire, decoded } = await openaiRoundTrip("web-chat.send_message");
  assert.notEqual(wire, "web-chat.send_message", "the wire form must differ (it was encoded)");
  assert.ok(LEGAL.test(wire), `wire must be legal, got: ${wire}`);
  assert.equal(decoded, "web-chat.send_message");
});

test("anthropic round-trip: 'web-chat.send_message' sent then echoed decodes to exactly 'web-chat.send_message'", async () => {
  const { wire, decoded } = await anthropicRoundTrip("web-chat.send_message");
  assert.notEqual(wire, "web-chat.send_message", "the wire form must differ (it was encoded)");
  assert.ok(LEGAL.test(wire), `wire must be legal, got: ${wire}`);
  assert.equal(decoded, "web-chat.send_message");
});

// ===========================================================================
// 4. NEGATIVE / EDGE
// ===========================================================================

// --- no tools (boundary: 0 tools) must not break -------------------------

test("openai edge: a request with NO tools succeeds and omits/empties body.tools", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = {
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "hi");
  const body = sentBody(lastCall!.init);
  const tools = body.tools ?? [];
  assert.ok(Array.isArray(tools), "tools, if present, must be an array");
  assert.equal(tools.length, 0, "no tools were supplied -> none on the wire");
});

test("anthropic edge: a request with NO tools succeeds and omits/empties body.tools", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "hi");
  const body = sentBody(lastCall!.init);
  const tools = body.tools ?? [];
  assert.ok(Array.isArray(tools), "tools, if present, must be an array");
  assert.equal(tools.length, 0, "no tools were supplied -> none on the wire");
});

// --- already-legal name: unchanged on wire AND decodes to itself ----------

test("openai edge: a legal name 'search' is unchanged on the wire AND decodes to 'search'", async () => {
  const c = openaiLib().get("o")!;
  // SEND: capture wire name.
  cannedBody = openaiToolCallResp("noop");
  await c.chat!({ messages: [{ role: "user", content: "hi" }], tools: [tool("search")] });
  const wire = openaiWireToolNames(lastCall!.init)[0];
  assert.equal(wire, "search", `legal name must be unchanged on the wire, got: ${wire}`);

  // RECEIVE: echo it back, must decode to itself.
  cannedBody = openaiToolCallResp("search");
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }], tools: [tool("search")] });
  assert.equal(res.toolCalls?.[0]?.name, "search", `legal name must decode to itself, got: ${res.toolCalls?.[0]?.name}`);
});

test("anthropic edge: a legal name 'search' is unchanged on the wire AND decodes to 'search'", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("noop");
  await c.chat!({ messages: [{ role: "user", content: "hi" }], tools: [tool("search")] });
  const wire = anthropicWireToolNames(lastCall!.init)[0];
  assert.equal(wire, "search", `legal name must be unchanged on the wire, got: ${wire}`);

  cannedBody = anthropicToolUseResp("search");
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }], tools: [tool("search")] });
  assert.equal(res.toolCalls?.[0]?.name, "search", `legal name must decode to itself, got: ${res.toolCalls?.[0]?.name}`);
});

// --- unknown returned name (never sent): pass-through, no throw -----------

test("openai edge: an UNKNOWN returned tool name (never sent) decodes to itself (pass-through, no throw)", async () => {
  const c = openaiLib().get("o")!;
  // A returned name the adapter never encoded — it must pass through unchanged.
  cannedBody = openaiToolCallResp("totally_unknown_tool");

  let res!: LLMResponse;
  await assert.doesNotReject(async () => {
    res = await c.chat!({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("web-chat.send_message")],
    });
  }, "an unknown returned tool name must not throw");
  assert.equal(
    res.toolCalls?.[0]?.name,
    "totally_unknown_tool",
    `unknown name must pass through unchanged, got: ${res.toolCalls?.[0]?.name}`,
  );
});

test("anthropic edge: an UNKNOWN returned tool name (never sent) decodes to itself (pass-through, no throw)", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = anthropicToolUseResp("totally_unknown_tool");

  let res!: LLMResponse;
  await assert.doesNotReject(async () => {
    res = await c.chat!({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("web-chat.send_message")],
    });
  }, "an unknown returned tool name must not throw");
  assert.equal(
    res.toolCalls?.[0]?.name,
    "totally_unknown_tool",
    `unknown name must pass through unchanged, got: ${res.toolCalls?.[0]?.name}`,
  );
});

// --- a text-only response (no tool_calls) is unaffected by the decode step --

test("openai edge: a text-only response (no tool_calls) is unaffected by the decode step", async () => {
  const c = openaiLib().get("o")!;
  cannedBody = {
    choices: [{ message: { content: "just text" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  const res = await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("web-chat.send_message")],
  });
  assert.equal(res.content, "just text");
  assert.ok(
    res.toolCalls === undefined || res.toolCalls.length === 0,
    "no tool calls expected for a text-only response",
  );
});

test("anthropic edge: a text-only response (no tool_use) is unaffected by the decode step", async () => {
  const c = anthropicLib().get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "just text" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const res = await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("web-chat.send_message")],
  });
  assert.equal(res.content, "just text");
  assert.ok(
    res.toolCalls === undefined || res.toolCalls.length === 0,
    "no tool calls expected for a text-only response",
  );
});
