/**
 * Black-box edge tests for the llm-gateway's NEW OpenAI **Responses API** provider
 * (`provider: "openai-responses"`).
 *
 * Implementation-agnostic: these exercise only the observable behavior promised by
 * `contracts/llm/index.ts` (the key-less, capability-aware Communicator surface +
 * the normalized chat/embed envelopes) and `shared/config` (LLMConfig /
 * CommunicatorDef). The gateway implementation is deliberately NOT read.
 *
 * Contract for this provider (from the task brief + overviews):
 *   - capabilities: chat + embed.
 *   - chat targets `${baseURL ?? "https://api.openai.com/v1"}/responses` (Bearer auth).
 *       request body: { model, input: <ARRAY>, instructions?: <string from `system`>, tools?: FLAT }
 *       response body (Responses API):
 *         { output: [ { type:"message", role:"assistant", content:[ {type:"output_text", text} ] },
 *                     { type:"function_call", call_id, name, arguments:"<json-string>" } ],
 *           output_text, usage:{ input_tokens, output_tokens }, status }
 *       normalized -> { content, toolCalls:[{id,name,arguments(parsed)}], stopReason, usage }.
 *   - embed targets the shared `${baseURL ?? "https://api.openai.com/v1"}/embeddings` (Bearer).
 *   - the returned communicator never carries the apiKey.
 *
 * The network is mocked: `globalThis.fetch` is replaced per-test with a stub that
 * records the last (url, init) and returns a per-test settable canned body + status.
 * No real HTTP, no real provider, no other nodes. fetch is reset between every test.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCommunicatorLibrary } from "../packages/llm-gateway/src";
import type { LLMConfig } from "../shared/config";
import type { LLMResponse, EmbedResponse } from "../contracts/llm";

// ---------------------------------------------------------------------------
// fetch mock harness (self-contained; independent of other test files)
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let originalFetch: typeof globalThis.fetch;
let lastCall: FetchCall | undefined;
let cannedBody: unknown;
let cannedStatus: number;

/** Read a header off the recorded request init in a shape-tolerant way. */
function header(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  const lower = name.toLowerCase();
  if (h instanceof Headers) {
    const v = h.get(name);
    return v === null ? undefined : v;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) {
      if (String(k).toLowerCase() === lower) return String(v);
    }
    return undefined;
  }
  for (const k of Object.keys(h as Record<string, string>)) {
    if (k.toLowerCase() === lower) return (h as Record<string, string>)[k];
  }
  return undefined;
}

/** The Bearer / x-api-key auth value of the last request, whichever is present. */
function authValue(init: RequestInit | undefined): string | undefined {
  return header(init, "authorization") ?? header(init, "x-api-key");
}

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

/** Wrap a bare communicator map into a full LLMConfig. */
function cfg(communicators: LLMConfig["communicators"], def?: string): LLMConfig {
  return def === undefined ? { communicators } : { communicators, default: def };
}

/** An `openai-responses` communicator def with sensible defaults + overrides. */
const RESP = (
  over: Partial<{
    apiKey: string;
    model: string;
    baseURL: string;
    capabilities: any;
    input: any;
    output: any;
  }> = {},
) => ({
  provider: "openai-responses",
  model: over.model ?? "gpt-5",
  apiKey: over.apiKey ?? "k",
  ...(over.baseURL ? { baseURL: over.baseURL } : {}),
  ...(over.capabilities ? { capabilities: over.capabilities } : {}),
  ...(over.input ? { input: over.input } : {}),
  ...(over.output ? { output: over.output } : {}),
});

/** A Responses-API success body (message text + one function_call). */
const responsesOK = (text = "hello") => ({
  output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    { type: "function_call", call_id: "fc_1", name: "do_thing", arguments: '{"x":1}' },
  ],
  output_text: text,
  usage: { input_tokens: 11, output_tokens: 7 },
  status: "completed",
});

/** A Responses-API body with text only (no function_call, no output_text top-level). */
const responsesTextOnly = (text = "hello") => ({
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 4, output_tokens: 2 },
  status: "completed",
});

/** A canned openai-shaped embeddings body. */
const embedOK = () => ({ data: [{ embedding: [1, 2] }], usage: { prompt_tokens: 3 } });

// ===========================================================================
// 1. SELECTABLE + CAPABILITY-GATED
// ===========================================================================

test("responses: selectable — get() returns a communicator with provider 'openai-responses'", () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: { provider: "openai-responses", model: "gpt-5", apiKey: "k", capabilities: ["chat"] } }),
  );
  const c = lib.get("gptr");
  assert.ok(c, "get('gptr') must return a communicator");
  assert.equal(c!.provider, "openai-responses");
  assert.equal(c!.model, "gpt-5");
  assert.equal(c!.name, "gptr");
});

test("responses: ['chat'] gating — chat is a function; embed/rerank/ocr undefined", () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: { provider: "openai-responses", model: "gpt-5", apiKey: "k", capabilities: ["chat"] } }),
  );
  const c = lib.get("gptr")!;
  assert.equal(typeof c.chat, "function", "chat must be a function");
  assert.equal(c.embed, undefined, "embed must be undefined for a chat-only communicator");
  assert.equal(c.rerank, undefined, "rerank must be undefined");
  assert.equal(c.ocr, undefined, "ocr must be undefined");
});

test("responses: ['chat','embed'] gating — both chat and embed exposed; rerank/ocr undefined", () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ capabilities: ["chat", "embed"] }) }),
  );
  const c = lib.get("gptr")!;
  assert.equal(typeof c.chat, "function", "chat must be a function");
  assert.equal(typeof c.embed, "function", "embed must be a function");
  assert.equal(c.rerank, undefined, "rerank must be undefined");
  assert.equal(c.ocr, undefined, "ocr must be undefined");
});

test("responses: appears under withCapability for each declared capability", () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ capabilities: ["chat", "embed"] }) }),
  );
  assert.deepEqual(lib.withCapability("chat"), ["gptr"]);
  assert.deepEqual(lib.withCapability("embed"), ["gptr"]);
  assert.deepEqual(lib.withCapability("rerank"), []);
  assert.deepEqual(lib.withCapability("ocr"), []);
});

// ===========================================================================
// 2. chat() NORMALIZATION — Responses-API body -> normalized envelope
// ===========================================================================

test("responses chat: normalizes content/toolCalls(parsed)/stopReason/usage", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  assert.ok(c.chat, "chat must be present");
  cannedBody = responsesOK("hello");

  const res: LLMResponse = await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(res.content, "hello");
  assert.deepEqual(
    res.toolCalls,
    [{ id: "fc_1", name: "do_thing", arguments: { x: 1 } }],
    "function_call -> ToolCall with call_id->id and arguments JSON-parsed",
  );
  assert.equal(
    res.stopReason,
    "tool_use",
    "a completed response whose output contains a function_call normalizes to 'tool_use'",
  );
  assert.ok(res.usage, "usage must be present");
  assert.equal(res.usage!.inputTokens, 11);
  assert.equal(res.usage!.outputTokens, 7);
});

test("responses chat: tool-call arguments are an object (parsed), not the raw JSON string", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.ok(res.toolCalls && res.toolCalls.length === 1, "exactly one tool call expected");
  const args = res.toolCalls![0].arguments;
  assert.equal(typeof args, "object", "arguments must be JSON-parsed into an object");
  assert.notEqual(typeof args, "string", "arguments must NOT remain a raw JSON string");
  assert.deepEqual(args, { x: 1 });
});

// ===========================================================================
// 3. CONTENT FALLBACK — derive text from output[] when output_text is absent
// ===========================================================================

test("responses chat: derives content from output[] message item when top-level output_text is absent", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  // No top-level output_text — adapter must walk output[] -> message -> output_text content.
  cannedBody = responsesTextOnly("derived-from-output");

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "derived-from-output");
  assert.ok(
    res.toolCalls === undefined || res.toolCalls.length === 0,
    "a text-only Responses body must yield no tool calls",
  );
});

test("responses chat: content is always a string even with no usable text in output[]", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  // Only a function_call, no message text, no output_text -> content must still be a string.
  cannedBody = {
    output: [{ type: "function_call", call_id: "fc_2", name: "noop", arguments: "{}" }],
    usage: { input_tokens: 1, output_tokens: 1 },
    status: "completed",
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(typeof res.content, "string", "content must always be a string");
  assert.equal(res.content, "");
  assert.deepEqual(res.toolCalls, [{ id: "fc_2", name: "noop", arguments: {} }]);
});

// ===========================================================================
// 4. WIRE FORMAT — endpoint, auth, request body shape, instructions, flat tools
// ===========================================================================

test("responses chat: request URL ends with /responses and carries Bearer auth", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: { provider: "openai-responses", model: "gpt-5", apiKey: "k", capabilities: ["chat"] } }),
  );
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/responses"),
    `URL must end with /responses, got: ${lastCall!.url}`,
  );
  assert.equal(authValue(lastCall!.init), "Bearer k", "Authorization must be 'Bearer k'");
});

test("responses chat: default base URL is api.openai.com/v1 when baseURL omitted", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  assert.ok(
    lastCall!.url.includes("api.openai.com/v1"),
    `default OpenAI base expected, got: ${lastCall!.url}`,
  );
  assert.ok(lastCall!.url.endsWith("/responses"));
});

test("responses chat: a custom baseURL is honored (and still ends with /responses)", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ capabilities: ["chat"], baseURL: "https://proxy.local/v9" }) }),
  );
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  assert.ok(
    lastCall!.url.startsWith("https://proxy.local/v9"),
    `custom base must be used, got: ${lastCall!.url}`,
  );
  assert.ok(lastCall!.url.endsWith("/responses"), `got: ${lastCall!.url}`);
});

test("responses chat: body has model + an `input` ARRAY (not `messages`)", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal(body.model, "gpt-5", "body.model must be the configured model");
  assert.ok(Array.isArray(body.input), "Responses API body must use an `input` ARRAY");
  assert.equal(
    body.messages,
    undefined,
    "the Responses API must NOT send a top-level `messages` field",
  );
});

test("responses chat: `system` becomes a top-level `instructions` field, NOT a system item in input[]", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({ messages: [{ role: "user", content: "hi" }], system: "sys" });

  const body = sentBody(lastCall!.init);
  assert.equal(body.instructions, "sys", "system must be mapped to top-level `instructions`");
  assert.ok(Array.isArray(body.input), "input must still be an array");
  const hasSystemItem = body.input.some((it: any) => it && it.role === "system");
  assert.equal(
    hasSystemItem,
    false,
    `no system message must appear inside input[]: ${JSON.stringify(body.input)}`,
  );
});

test("responses chat: with no `system`, no `instructions` field is sent", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.ok(
    body.instructions === undefined || body.instructions === null,
    `instructions must be absent when no system is set, got: ${JSON.stringify(body.instructions)}`,
  );
});

test("responses chat: tools are FLAT ({type:'function', name at top level}, not nested under `function`)", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
  });

  const body = sentBody(lastCall!.init);
  assert.ok(Array.isArray(body.tools), "body.tools must be an array");
  assert.equal(body.tools.length, 1, "exactly one tool entry expected");
  const t = body.tools[0];
  assert.equal(t.type, "function", "tool entry must be of type 'function'");
  assert.equal(t.name, "f", "tool name must be FLAT (top-level), not nested under `function`");
  assert.equal(
    t.function,
    undefined,
    `tool entry must NOT nest under a 'function' key: ${JSON.stringify(t)}`,
  );
  assert.equal(t.description, "d", "description must be carried at top level");
});

test("responses chat: the user message text reaches the request `input` array", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("hello");

  await c.chat!({ messages: [{ role: "user", content: "PING-123" }] });

  const raw =
    typeof lastCall!.init?.body === "string"
      ? lastCall!.init!.body
      : Buffer.from(lastCall!.init!.body as ArrayBuffer).toString("utf8");
  assert.ok(raw.includes("PING-123"), "the user content must be serialized into the request body");
});

// ===========================================================================
// 5. embed() VIA THIS PROVIDER — shared /embeddings endpoint
// ===========================================================================

test("responses embed: returns normalized embeddings + usage from a canned openai body", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["embed"] }) }));
  const c = lib.get("gptr")!;
  assert.ok(c.embed, "embed must be present");
  cannedBody = embedOK();

  const res: EmbedResponse = await c.embed!({ input: "x" });

  assert.deepEqual(res.embeddings, [[1, 2]], "embeddings must come from data[].embedding");
  assert.ok(res.usage, "usage must be present");
  assert.equal(res.usage!.inputTokens, 3, "prompt_tokens must map to usage.inputTokens");
});

test("responses embed: request hits /embeddings with Bearer auth", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ capabilities: ["embed"], apiKey: "ek" }) }),
  );
  const c = lib.get("gptr")!;
  cannedBody = embedOK();

  await c.embed!({ input: "x" });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/embeddings"),
    `embed must route to the shared /embeddings endpoint, got: ${lastCall!.url}`,
  );
  assert.equal(authValue(lastCall!.init), "Bearer ek", "embed must use Bearer auth");
  const body = sentBody(lastCall!.init);
  assert.ok("input" in body, "embed body must carry input");
  assert.equal(body.input, "x");
});

// ===========================================================================
// 6. TRANSPORT ERRORS — a non-2xx from /responses rejects chat()
// ===========================================================================

test("responses transport: a 500 from /responses makes chat() reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedStatus = 500;
  cannedBody = { error: { message: "boom" } };

  await assert.rejects(
    () => c.chat!({ messages: [{ role: "user", content: "hi" }] }),
    "a 500 from /responses must reject",
  );
});

test("responses transport: after a 500 reject the same communicator recovers on the next success", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;

  cannedStatus = 500;
  cannedBody = { error: { message: "boom" } };
  await assert.rejects(() => c.chat!({ messages: [{ role: "user", content: "hi" }] }));

  cannedStatus = 200;
  cannedBody = responsesOK("recovered");
  const res = await c.chat!({ messages: [{ role: "user", content: "hi again" }] });
  assert.equal(res.content, "recovered");
});

// ===========================================================================
// 7. SECURITY — the API key is never exposed on the Communicator
// ===========================================================================

test("responses security: communicator has no own 'apiKey' property", () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ apiKey: "super-secret-responses-key", capabilities: ["chat", "embed"] }) }),
  );
  const c = lib.get("gptr")!;
  assert.equal(
    Object.prototype.hasOwnProperty.call(c, "apiKey"),
    false,
    "'apiKey' must not be an own property of the communicator",
  );
  assert.equal((c as any).apiKey, undefined);
});

test("responses security: no own enumerable property value equals the secret key", () => {
  const SECRET = "responses-secret-98765";
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ apiKey: SECRET, capabilities: ["chat", "embed"] }) }),
  );
  const c = lib.get("gptr")!;
  for (const [k, v] of Object.entries(c)) {
    assert.notEqual(v, SECRET, `own property '${k}' leaks the API key`);
  }
});

// ===========================================================================
// 8. stopReason NORMALIZATION — Responses status -> named vocabulary
// ===========================================================================

test("responses stopReason: a completed text-only response normalizes to 'stop'", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesTextOnly("plain");

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(
    res.stopReason,
    "stop",
    "a completed response with no function_call normalizes to 'stop'",
  );
});

test("responses stopReason: status 'incomplete' with reason 'max_output_tokens' normalizes to 'length'", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = {
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "cut off" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(
    res.stopReason,
    "length",
    "incomplete + max_output_tokens normalizes to 'length'",
  );
});

// ===========================================================================
// 9. ASSISTANT toolCalls REPLAY — Message.toolCalls -> function_call input item
// ===========================================================================

test("responses toolCalls replay: assistant toolCalls -> a function_call input item with a JSON-string arguments", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("ok");

  await c.chat!({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", arguments: { x: 1 } }] },
      { role: "tool", toolCallId: "t1", content: "result" },
    ],
  });

  const body = sentBody(lastCall!.init);
  assert.ok(Array.isArray(body.input), "Responses body.input must be an array");
  const fc = body.input.find((it: any) => it && it.type === "function_call");
  assert.ok(fc, `a function_call input item must be present: ${JSON.stringify(body.input)}`);
  assert.equal(fc.call_id, "t1", "the ToolCall id maps to call_id");
  assert.equal(fc.name, "f", "the tool name is replayed");
  assert.equal(typeof fc.arguments, "string", "function_call arguments must be a JSON STRING");
  assert.deepEqual(JSON.parse(fc.arguments), { x: 1 }, "the JSON string must parse back to the arguments");
});

// ===========================================================================
// 10. INLINE BASE64 DOCUMENT WITH NO MIME — data: URI defaults to application/pdf
// ===========================================================================

test("responses document: inline base64 document with NO mime -> file_data prefixed data:application/pdf", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ capabilities: ["chat"], input: ["text", "document"] }) }),
  );
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("ok");

  await c.chat!({
    messages: [{ role: "user", content: [{ type: "document", document: { data: "REFUQQ==" } }] }],
  });

  const body = sentBody(lastCall!.init);
  const raw =
    typeof lastCall!.init?.body === "string"
      ? lastCall!.init!.body
      : Buffer.from(lastCall!.init!.body as ArrayBuffer).toString("utf8");
  assert.ok(
    raw.includes("data:application/pdf"),
    `a mime-less document must default its data: URI to application/pdf, got body: ${raw}`,
  );
  assert.ok(raw.includes("REFUQQ=="), "the original base64 must be embedded in the data: URI");
  // Sanity: the input array must carry the document, not drop it.
  assert.ok(Array.isArray(body.input), "body.input must be an array");
});

// ===========================================================================
// 11. MULTIMODAL CHAT INPUT — image wire shape (input_image)
// ===========================================================================

// ===========================================================================
// 12. PER-COMMUNICATOR TUNING FIELDS — topP / reasoningEffort wire mapping
//     (Responses has no `stop` param — it must never be sent)
// ===========================================================================

test("responses tuning: topP -> top_p and reasoningEffort -> reasoning_effort appear when configured", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      gptr: {
        provider: "openai-responses",
        model: "gpt-5",
        apiKey: "k",
        capabilities: ["chat"],
        topP: 0.8,
        reasoningEffort: "high",
      },
    }),
  );
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal(body.top_p, 0.8, "configured topP must wire to body.top_p");
  assert.deepEqual(body.reasoning, { effort: "high" }, "configured reasoningEffort must wire to body.reasoning.effort (Responses API nesting)");
});

test("responses tuning: a configured `stop` is NEVER sent (the Responses API has no stop param)", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      gptr: {
        provider: "openai-responses",
        model: "gpt-5",
        apiKey: "k",
        capabilities: ["chat"],
        stop: ["END"],
        topP: 0.5,
      },
    }),
  );
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal("stop" in body, false, "the Responses API must NOT receive a stop param");
  // topP still wires through even though stop is dropped.
  assert.equal(body.top_p, 0.5);
});

test("responses tuning: with none set, top_p / reasoning_effort / stop are all ABSENT", async () => {
  const lib = createCommunicatorLibrary(cfg({ gptr: RESP({ capabilities: ["chat"] }) }));
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal("top_p" in body, false, "top_p must be absent when topP is unset");
  assert.equal("reasoning" in body, false, "reasoning must be absent when unset");
  assert.equal("stop" in body, false, "stop must never appear on a Responses request");
});

test("responses multimodal: [text, image{url}] emits an input_image part", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ gptr: RESP({ capabilities: ["chat"], input: ["text", "image"] }) }),
  );
  const c = lib.get("gptr")!;
  cannedBody = responsesOK("ok");

  await c.chat!({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: { url: "http://x/pic.png" } },
        ],
      },
    ],
  });

  const body = sentBody(lastCall!.init);
  assert.ok(Array.isArray(body.input), "body.input must be an array");
  // Find any input_image part anywhere in the input items' content arrays.
  const flat = JSON.stringify(body.input);
  assert.ok(flat.includes("input_image"), `an input_image part must be present: ${flat}`);
  assert.ok(flat.includes("http://x/pic.png"), "the image url must reach the request body");
});
