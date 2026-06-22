/**
 * Black-box edge tests for the (now-expanded) `llm` contract as implemented by
 * the llm-gateway.
 *
 * These are implementation-agnostic: they exercise only the observable behavior
 * promised by `contracts/llm/index.ts` (the multi-capability Communicator /
 * CommunicatorLibrary surface + the normalized chat/embed/rerank/ocr envelopes,
 * modality metadata, key-less security, and the resilient build) and
 * `shared/config` (LLMConfig / CommunicatorDef). The gateway implementation is
 * deliberately NOT read.
 *
 * Provider -> capability matrix under test:
 *   anthropic -> chat
 *   openai    -> chat, embed
 *   cohere    -> rerank   (default base https://api.cohere.com/v2)
 *   jina      -> rerank   (default base https://api.jina.ai/v1)
 *   ocr       -> generic: implemented via vision-chat, so requires a chat-capable
 *               provider (anthropic/openai) and routes through its chat endpoint.
 * Defaults: capabilities omitted -> ["chat"]; input/output omitted -> ["text"].
 *
 * The network is mocked: `globalThis.fetch` is replaced per-test with a stub that
 * records the last (url, init) it saw and returns a per-test settable canned body
 * + status. No real HTTP, no real provider, no other nodes. fetch + env are reset
 * between every test so the cases are independent.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCommunicatorLibrary } from "../packages/llm-gateway/src";
import type { LLMConfig } from "../shared/config";
import type {
  CommunicatorLibrary,
  LLMResponse,
  EmbedResponse,
  RerankResponse,
  OCRResponse,
} from "../contracts/llm";

// ---------------------------------------------------------------------------
// fetch mock harness
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
  // plain object record
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
  // Some impls may pass a Buffer/Uint8Array — decode best-effort.
  return JSON.parse(Buffer.from(b as ArrayBuffer).toString("utf8"));
}

/** The raw string body the gateway sent (for substring / wording assertions). */
function sentBodyRaw(init: RequestInit | undefined): string {
  const b = init?.body;
  if (typeof b === "string") return b;
  if (b == null) return "";
  return Buffer.from(b as ArrayBuffer).toString("utf8");
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

function cfg(communicators: LLMConfig["communicators"], def?: string): LLMConfig {
  return def === undefined ? { communicators } : { communicators, default: def };
}

const ANTHROPIC = (
  over: Partial<{ apiKey: string; model: string; capabilities: any; input: any; output: any }> = {},
) => ({
  provider: "anthropic",
  model: over.model ?? "claude-3-5-sonnet",
  apiKey: over.apiKey ?? "sk-ant-test-key",
  ...(over.capabilities ? { capabilities: over.capabilities } : {}),
  ...(over.input ? { input: over.input } : {}),
  ...(over.output ? { output: over.output } : {}),
});

const OPENAI = (
  over: Partial<{
    apiKey: string;
    model: string;
    baseURL: string;
    capabilities: any;
    input: any;
    output: any;
  }> = {},
) => ({
  provider: "openai-completion",
  model: over.model ?? "gpt-4o",
  apiKey: over.apiKey ?? "sk-openai-test-key",
  baseURL: over.baseURL ?? "https://api.openai.com/v1",
  ...(over.capabilities ? { capabilities: over.capabilities } : {}),
  ...(over.input ? { input: over.input } : {}),
  ...(over.output ? { output: over.output } : {}),
});

const COHERE = (over: Partial<{ apiKey: string; model: string; baseURL: string }> = {}) => ({
  provider: "cohere",
  model: over.model ?? "rerank-v3.5",
  apiKey: over.apiKey ?? "co-test-key",
  capabilities: ["rerank"],
  ...(over.baseURL ? { baseURL: over.baseURL } : {}),
});

const JINA = (over: Partial<{ apiKey: string; model: string; baseURL: string }> = {}) => ({
  provider: "jina",
  model: over.model ?? "jina-reranker-v2",
  apiKey: over.apiKey ?? "jina-test-key",
  capabilities: ["rerank"],
  ...(over.baseURL ? { baseURL: over.baseURL } : {}),
});

/** Canned bodies for each provider's happy-path response. */
const anthropicOK = (text = "ok") => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});
const openaiOK = (content = "ok") => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

// ===========================================================================
// 1. LIBRARY SURFACE — construction, lookup, withCapability
// ===========================================================================

test("library: list() returns exactly the configured names (multi-communicator)", () => {
  const lib: CommunicatorLibrary = createCommunicatorLibrary(
    cfg({ alpha: ANTHROPIC(), beta: OPENAI(), gamma: COHERE() }),
  );
  const names = lib.list();
  assert.ok(Array.isArray(names), "list() must return an array");
  assert.deepEqual([...names].sort(), ["alpha", "beta", "gamma"]);
});

test("library: list() is empty for an empty catalogue", () => {
  const lib = createCommunicatorLibrary(cfg({}));
  assert.deepEqual(lib.list(), []);
});

test("library: list() handles a single configured communicator", () => {
  const lib = createCommunicatorLibrary(cfg({ only: ANTHROPIC() }));
  assert.deepEqual(lib.list(), ["only"]);
});

test("library: has() true for configured, false for unknown", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.has("alpha"), true);
  assert.equal(lib.has("nope"), false);
});

test("library: has() false for empty / whitespace-only name", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.has(""), false);
  assert.equal(lib.has("   "), false);
});

test("library: has() is case-sensitive ('Alpha' != 'alpha')", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.has("Alpha"), false);
});

test("library: get() returns a Communicator with name/provider/model set", () => {
  const lib = createCommunicatorLibrary(cfg({ main: ANTHROPIC({ model: "claude-x" }) }));
  const c = lib.get("main");
  assert.ok(c, "get('main') must return a communicator");
  assert.equal(c!.name, "main");
  assert.equal(c!.provider, "anthropic");
  assert.equal(c!.model, "claude-x");
});

test("library: get(unknown) returns undefined", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.get("ghost"), undefined);
});

test("library: get('') returns undefined for empty name", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.get(""), undefined);
});

test("library: each configured name resolves to a distinct communicator", () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC(), b: OPENAI() }));
  const a = lib.get("a");
  const b = lib.get("b");
  assert.ok(a && b);
  assert.notEqual(a, b);
  assert.equal(a!.provider, "anthropic");
  assert.equal(b!.provider, "openai-completion");
});

test("withCapability(): returns only the names declaring that capability", () => {
  const lib = createCommunicatorLibrary(
    cfg({
      chatter: ANTHROPIC(), // default ["chat"]
      embedder: OPENAI({ capabilities: ["embed"] }),
      ranker: COHERE(), // ["rerank"]
    }),
  );
  assert.deepEqual(lib.withCapability("embed"), ["embedder"]);
  assert.deepEqual(lib.withCapability("rerank"), ["ranker"]);
  assert.deepEqual([...lib.withCapability("chat")].sort(), ["chatter"]);
});

test("withCapability(): returns [] when no communicator declares the capability", () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  assert.deepEqual(lib.withCapability("rerank"), []);
  assert.deepEqual(lib.withCapability("ocr"), []);
});

test("withCapability(): a multi-capability communicator appears under each of its capabilities", () => {
  const lib = createCommunicatorLibrary(
    cfg({
      multi: OPENAI({ capabilities: ["chat", "embed"] }),
      ranker: JINA(),
    }),
  );
  assert.deepEqual(lib.withCapability("chat"), ["multi"]);
  assert.deepEqual(lib.withCapability("embed"), ["multi"]);
  assert.deepEqual(lib.withCapability("rerank"), ["ranker"]);
});

test("withCapability(): lists every communicator sharing a capability", () => {
  const lib = createCommunicatorLibrary(
    cfg({
      cohereR: COHERE(),
      jinaR: JINA(),
      chatter: ANTHROPIC(),
    }),
  );
  assert.deepEqual([...lib.withCapability("rerank")].sort(), ["cohereR", "jinaR"]);
});

// ===========================================================================
// 2. CAPABILITY GATING — only configured methods are exposed
// ===========================================================================

test("gating: ['chat'] exposes chat() only; embed/rerank/ocr are undefined", () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC({ capabilities: ["chat"] }) }));
  const c = lib.get("a")!;
  assert.equal(typeof c.chat, "function", "chat must be a function");
  assert.equal(c.embed, undefined, "embed must be undefined");
  assert.equal(c.rerank, undefined, "rerank must be undefined");
  assert.equal(c.ocr, undefined, "ocr must be undefined");
});

test("gating: default capabilities (omitted) expose chat() only", () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  assert.equal(typeof c.chat, "function");
  assert.equal(c.embed, undefined);
  assert.equal(c.rerank, undefined);
  assert.equal(c.ocr, undefined);
});

test("gating: openai ['embed'] exposes embed() only — no chat()", () => {
  const lib = createCommunicatorLibrary(cfg({ e: OPENAI({ capabilities: ["embed"] }) }));
  const c = lib.get("e")!;
  assert.equal(typeof c.embed, "function", "embed must be a function");
  assert.equal(c.chat, undefined, "chat must be undefined for an embed-only communicator");
  assert.equal(c.rerank, undefined);
  assert.equal(c.ocr, undefined);
});

test("gating: cohere ['rerank'] exposes rerank() only", () => {
  const lib = createCommunicatorLibrary(cfg({ r: COHERE() }));
  const c = lib.get("r")!;
  assert.equal(typeof c.rerank, "function", "rerank must be a function");
  assert.equal(c.chat, undefined);
  assert.equal(c.embed, undefined);
  assert.equal(c.ocr, undefined);
});

test("gating: ['chat','ocr'] exposes both chat() and ocr()", () => {
  const lib = createCommunicatorLibrary(
    cfg({ both: OPENAI({ capabilities: ["chat", "ocr"], input: ["text", "image"] }) }),
  );
  const c = lib.get("both")!;
  assert.equal(typeof c.chat, "function", "chat must be a function");
  assert.equal(typeof c.ocr, "function", "ocr must be a function");
  assert.equal(c.embed, undefined);
  assert.equal(c.rerank, undefined);
});

test("gating: a multi-capability openai ['chat','embed'] exposes both", () => {
  const lib = createCommunicatorLibrary(
    cfg({ m: OPENAI({ capabilities: ["chat", "embed"] }) }),
  );
  const c = lib.get("m")!;
  assert.equal(typeof c.chat, "function");
  assert.equal(typeof c.embed, "function");
  assert.equal(c.rerank, undefined);
  assert.equal(c.ocr, undefined);
});

// ===========================================================================
// 3. MODALITY METADATA — capabilities / input / output reflect config (+ defaults)
// ===========================================================================

test("modality: defaults — omitted capabilities -> ['chat'], input/output -> ['text']", () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  assert.deepEqual([...c.capabilities], ["chat"]);
  assert.deepEqual([...c.input], ["text"]);
  assert.deepEqual([...c.output], ["text"]);
});

test("modality: configured capabilities are exposed verbatim", () => {
  const lib = createCommunicatorLibrary(
    cfg({ m: OPENAI({ capabilities: ["chat", "embed"] }) }),
  );
  const c = lib.get("m")!;
  assert.deepEqual([...c.capabilities], ["chat", "embed"]);
});

test("modality: configured input ['text','image'] is exposed verbatim", () => {
  const lib = createCommunicatorLibrary(
    cfg({ v: OPENAI({ capabilities: ["chat"], input: ["text", "image"] }) }),
  );
  const c = lib.get("v")!;
  assert.deepEqual([...c.input], ["text", "image"]);
});

test("modality: configured output is exposed verbatim", () => {
  const lib = createCommunicatorLibrary(
    cfg({ a: ANTHROPIC({ output: ["text", "image"] }) }),
  );
  const c = lib.get("a")!;
  assert.deepEqual([...c.output], ["text", "image"]);
});

test("modality: input/image-only communicator reflects its single input modality", () => {
  const lib = createCommunicatorLibrary(
    cfg({ o: OPENAI({ capabilities: ["ocr"], input: ["image"] }) }),
  );
  const c = lib.get("o")!;
  assert.deepEqual([...c.input], ["image"]);
});

// ===========================================================================
// 4. SECURITY — the API key is never exposed on the Communicator
// ===========================================================================

test("security: communicator has no own 'apiKey' property", () => {
  const lib = createCommunicatorLibrary(cfg({ main: ANTHROPIC({ apiKey: "super-secret-key" }) }));
  const c = lib.get("main")!;
  assert.equal(
    Object.prototype.hasOwnProperty.call(c, "apiKey"),
    false,
    "'apiKey' must not be an own property of the communicator",
  );
  assert.equal((c as any).apiKey, undefined);
});

test("security: no own enumerable property value equals the secret key", () => {
  const SECRET = "super-secret-key-12345";
  const lib = createCommunicatorLibrary(cfg({ main: ANTHROPIC({ apiKey: SECRET }) }));
  const c = lib.get("main")!;
  for (const [k, v] of Object.entries(c)) {
    assert.notEqual(v, SECRET, `own property '${k}' leaks the API key`);
  }
});

test("security: key does not leak through a rerank communicator either", () => {
  const SECRET = "co-leak-me-please";
  const lib = createCommunicatorLibrary(cfg({ r: COHERE({ apiKey: SECRET }) }));
  const c = lib.get("r")!;
  assert.equal(Object.prototype.hasOwnProperty.call(c, "apiKey"), false);
  for (const [k, v] of Object.entries(c)) {
    assert.notEqual(v, SECRET, `own property '${k}' leaks the API key`);
  }
});

// ===========================================================================
// 5. ${ENV_VAR} apiKey resolution
// ===========================================================================

test("env: ${TEST_KEY} apiKey resolves and the resolved key appears in the outgoing auth header", async () => {
  const prev = process.env.TEST_KEY;
  process.env.TEST_KEY = "sekret-env-value";
  try {
    const lib = createCommunicatorLibrary(
      cfg({ main: { provider: "anthropic", model: "claude-x", apiKey: "${TEST_KEY}" } }),
    );
    const c = lib.get("main");
    assert.ok(c, "library built successfully with an env-ref key");
    assert.ok(c!.chat, "chat must be present");

    cannedBody = anthropicOK("ok");
    await c!.chat!({ messages: [{ role: "user", content: "hi" }] });

    const auth = authValue(lastCall?.init);
    assert.ok(auth, "an auth header must be present");
    assert.ok(
      auth!.includes("sekret-env-value"),
      `resolved env key must be used; saw header value: ${auth}`,
    );
  } finally {
    if (prev === undefined) delete process.env.TEST_KEY;
    else process.env.TEST_KEY = prev;
  }
});

test("env: ${TEST_KEY} resolves for an openai embed communicator's Bearer header", async () => {
  const prev = process.env.TEST_KEY;
  process.env.TEST_KEY = "sk-env-openai";
  try {
    const lib = createCommunicatorLibrary(
      cfg({
        e: {
          provider: "openai-completion",
          model: "text-embedding-3-small",
          apiKey: "${TEST_KEY}",
          baseURL: "https://api.openai.com/v1",
          capabilities: ["embed"],
        },
      }),
    );
    const c = lib.get("e");
    assert.ok(c && c.embed, "embed communicator must build with an env key");

    cannedBody = { data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1 } };
    await c!.embed!({ input: "x" });

    const auth = authValue(lastCall?.init);
    assert.ok(auth, "auth header must be present");
    assert.ok(auth!.includes("sk-env-openai"), `resolved env key expected, saw: ${auth}`);
  } finally {
    if (prev === undefined) delete process.env.TEST_KEY;
    else process.env.TEST_KEY = prev;
  }
});

// ===========================================================================
// 6. chat() — ANTHROPIC + OPENAI normalization & wire format
// ===========================================================================

test("chat (anthropic): normalizes content/toolCalls/stopReason/usage", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ a: { provider: "anthropic", model: "claude-3-5-sonnet", apiKey: "sk-ant-xyz" } }),
  );
  const c = lib.get("a")!;
  assert.ok(c.chat, "chat must be present");
  cannedBody = {
    content: [
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "foo", input: { a: 1 } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 5 },
  };

  const res: LLMResponse = await c.chat!({ messages: [{ role: "user", content: "hello" }] });

  assert.equal(res.content, "hi");
  assert.deepEqual(res.toolCalls, [{ id: "t1", name: "foo", arguments: { a: 1 } }]);
  assert.equal(res.stopReason, "tool_use");
  assert.ok(res.usage, "usage must be present");
  assert.equal(res.usage!.inputTokens, 3);
  assert.equal(res.usage!.outputTokens, 5);
});

test("chat (anthropic): request targets /v1/messages with x-api-key + anthropic-version, body has model+messages", async () => {
  const KEY = "sk-ant-header-check";
  const lib = createCommunicatorLibrary(
    cfg({ a: { provider: "anthropic", model: "claude-3-5-sonnet", apiKey: KEY } }),
  );
  const c = lib.get("a")!;
  cannedBody = anthropicOK("hi");

  await c.chat!({ messages: [{ role: "user", content: "hello" }] });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/v1/messages"),
    `URL must end with /v1/messages, got: ${lastCall!.url}`,
  );
  assert.equal(header(lastCall!.init, "x-api-key"), KEY);
  assert.ok(header(lastCall!.init, "anthropic-version"), "anthropic-version header must be present");

  const body = sentBody(lastCall!.init);
  assert.equal(body.model, "claude-3-5-sonnet");
  assert.ok(Array.isArray(body.messages), "body.messages must be an array");
  assert.equal(body.messages.length, 1);
});

test("chat (anthropic): text-only response yields content with no toolCalls", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "just text" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 4 },
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "x" }] });
  assert.equal(res.content, "just text");
  assert.ok(
    res.toolCalls === undefined || res.toolCalls.length === 0,
    "no tool calls expected for a text-only response",
  );
});

test("chat (anthropic): multiple text blocks are concatenated", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = {
    content: [
      { type: "text", text: "foo" },
      { type: "text", text: "bar" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "x" }] });
  assert.ok(
    res.content.includes("foo") && res.content.includes("bar"),
    `both text parts must appear in content, got: ${res.content}`,
  );
});

test("chat (openai): normalizes content/toolCalls(parsed)/stopReason/usage", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      o: {
        provider: "openai-completion",
        model: "gpt-4o",
        apiKey: "sk-openai-xyz",
        baseURL: "https://api.openai.com/v1",
      },
    }),
  );
  const c = lib.get("o")!;
  assert.ok(c.chat, "chat must be present");
  cannedBody = {
    choices: [
      {
        message: {
          content: "yo",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "bar", arguments: '{"x":2}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 9 },
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }], system: "sys" });

  assert.equal(res.content, "yo");
  assert.deepEqual(res.toolCalls, [{ id: "c1", name: "bar", arguments: { x: 2 } }]);
  assert.equal(res.stopReason, "tool_use", "openai finish_reason 'tool_calls' normalizes to 'tool_use'");
  assert.ok(res.usage);
  assert.equal(res.usage!.inputTokens, 7);
  assert.equal(res.usage!.outputTokens, 9);
});

test("chat (openai): request targets /chat/completions with Bearer auth + system message", async () => {
  const KEY = "sk-openai-bearer";
  const lib = createCommunicatorLibrary(
    cfg({
      o: {
        provider: "openai-completion",
        model: "gpt-4o",
        apiKey: KEY,
        baseURL: "https://api.openai.com/v1",
      },
    }),
  );
  const c = lib.get("o")!;
  cannedBody = openaiOK("yo");

  await c.chat!({ messages: [{ role: "user", content: "hi" }], system: "sys" });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/chat/completions"),
    `URL must end with /chat/completions, got: ${lastCall!.url}`,
  );
  assert.equal(header(lastCall!.init, "authorization"), `Bearer ${KEY}`);

  const body = sentBody(lastCall!.init);
  assert.equal(body.model, "gpt-4o");
  assert.ok(Array.isArray(body.messages), "body.messages must be an array");
  const hasSystem = body.messages.some(
    (m: any) => m.role === "system" && JSON.stringify(m.content).includes("sys"),
  );
  assert.ok(hasSystem, `system message must be included: ${JSON.stringify(body.messages)}`);
});

test("chat (openai): null message content normalizes to empty string with tool calls intact", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "c9", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(typeof res.content, "string", "content must always be a string");
  assert.equal(res.content, "");
  assert.deepEqual(res.toolCalls, [{ id: "c9", name: "f", arguments: {} }]);
});

// ===========================================================================
// 7. embed() — OPENAI
// ===========================================================================

test("embed (openai): normalizes data[].embedding -> embeddings[][] (order preserved) + usage", async () => {
  const lib = createCommunicatorLibrary(cfg({ e: OPENAI({ capabilities: ["embed"] }) }));
  const c = lib.get("e")!;
  assert.ok(c.embed, "embed must be present");
  cannedBody = {
    data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
    usage: { prompt_tokens: 5 },
  };

  const res: EmbedResponse = await c.embed!({ input: ["a", "b"] });

  assert.deepEqual(res.embeddings, [
    [0.1, 0.2],
    [0.3, 0.4],
  ]);
  assert.ok(res.usage, "usage must be present");
  assert.equal(res.usage!.inputTokens, 5);
});

test("embed (openai): request URL ends /embeddings, Bearer auth, body has input + model", async () => {
  const KEY = "sk-embed-key";
  const lib = createCommunicatorLibrary(
    cfg({
      e: {
        provider: "openai-completion",
        model: "text-embedding-3-small",
        apiKey: KEY,
        baseURL: "https://api.openai.com/v1",
        capabilities: ["embed"],
      },
    }),
  );
  const c = lib.get("e")!;
  cannedBody = { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }], usage: { prompt_tokens: 5 } };

  await c.embed!({ input: ["a", "b"] });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/embeddings"),
    `URL must end with /embeddings, got: ${lastCall!.url}`,
  );
  assert.equal(header(lastCall!.init, "authorization"), `Bearer ${KEY}`);

  const body = sentBody(lastCall!.init);
  assert.ok("input" in body, "body must carry input");
  assert.deepEqual(body.input, ["a", "b"]);
  assert.equal(body.model, "text-embedding-3-small");
});

test("embed (openai): a single-string input yields one embedding vector", async () => {
  const lib = createCommunicatorLibrary(cfg({ e: OPENAI({ capabilities: ["embed"] }) }));
  const c = lib.get("e")!;
  cannedBody = { data: [{ embedding: [0.5, 0.6, 0.7] }], usage: { prompt_tokens: 2 } };

  const res = await c.embed!({ input: "solo" });
  assert.equal(res.embeddings.length, 1);
  assert.deepEqual(res.embeddings[0], [0.5, 0.6, 0.7]);
});

// ===========================================================================
// 8. rerank() — COHERE + JINA
// ===========================================================================

test("rerank (cohere): normalizes results (score desc, document echoed by index)", async () => {
  const lib = createCommunicatorLibrary(cfg({ r: COHERE() }));
  const c = lib.get("r")!;
  assert.ok(c.rerank, "rerank must be present");
  cannedBody = {
    results: [
      { index: 2, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.4 },
    ],
  };

  const res: RerankResponse = await c.rerank!({
    query: "q",
    documents: ["d0", "d1", "d2"],
  });

  assert.deepEqual(res.results, [
    { index: 2, score: 0.9, document: "d2" },
    { index: 0, score: 0.4, document: "d0" },
  ]);
});

test("rerank (cohere): request hits default cohere base /rerank with query+documents in body", async () => {
  const lib = createCommunicatorLibrary(cfg({ r: COHERE() })); // no baseURL -> default
  const c = lib.get("r")!;
  cannedBody = { results: [{ index: 0, relevance_score: 0.5 }] };

  await c.rerank!({ query: "find me", documents: ["d0", "d1"] });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/rerank"),
    `URL must end with /rerank, got: ${lastCall!.url}`,
  );
  assert.ok(
    lastCall!.url.includes("api.cohere.com"),
    `default cohere base expected, got: ${lastCall!.url}`,
  );

  const body = sentBody(lastCall!.init);
  assert.equal(body.query, "find me");
  assert.deepEqual(body.documents, ["d0", "d1"]);
});

test("rerank (jina): request hits the default jina base /rerank", async () => {
  const lib = createCommunicatorLibrary(cfg({ r: JINA() })); // no baseURL -> default
  const c = lib.get("r")!;
  assert.ok(c.rerank, "rerank must be present");
  cannedBody = { results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }] };

  const res = await c.rerank!({ query: "q", documents: ["a", "b"] });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/rerank"),
    `URL must end with /rerank, got: ${lastCall!.url}`,
  );
  assert.ok(
    lastCall!.url.includes("api.jina.ai"),
    `default jina base expected, got: ${lastCall!.url}`,
  );
  assert.deepEqual(res.results, [
    { index: 1, score: 0.8, document: "b" },
    { index: 0, score: 0.2, document: "a" },
  ]);
});

test("rerank: results preserve provider order (already-descending) and map index->document", async () => {
  const lib = createCommunicatorLibrary(cfg({ r: COHERE() }));
  const c = lib.get("r")!;
  cannedBody = {
    results: [
      { index: 1, relevance_score: 0.99 },
      { index: 3, relevance_score: 0.7 },
      { index: 0, relevance_score: 0.1 },
    ],
  };

  const res = await c.rerank!({ query: "q", documents: ["zero", "one", "two", "three"] });
  assert.deepEqual(res.results, [
    { index: 1, score: 0.99, document: "one" },
    { index: 3, score: 0.7, document: "three" },
    { index: 0, score: 0.1, document: "zero" },
  ]);
});

// ===========================================================================
// 9. ocr() — GENERIC (routes through a chat-capable provider's chat endpoint)
// ===========================================================================

test("ocr (openai): routes through chat, returns { text } from the chat content", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ o: OPENAI({ capabilities: ["ocr"], input: ["image"] }) }),
  );
  const c = lib.get("o")!;
  assert.ok(c.ocr, "ocr must be present");
  // ocr routes through the CHAT endpoint internally -> mock a chat-shaped response.
  cannedBody = openaiOK("EXTRACTED");

  const res: OCRResponse = await c.ocr!({ source: { url: "http://x/img.png" } });
  assert.equal(res.text, "EXTRACTED");
});

test("ocr (openai): outgoing chat request body includes the image source URL and an extraction instruction", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ o: OPENAI({ capabilities: ["ocr"], input: ["image"] }) }),
  );
  const c = lib.get("o")!;
  cannedBody = openaiOK("EXTRACTED");

  await c.ocr!({ source: { url: "http://x/img.png" } });

  assert.ok(lastCall, "fetch must have been called");
  // Generic OCR is implemented via vision-chat -> the chat endpoint is hit.
  assert.ok(
    lastCall!.url.endsWith("/chat/completions"),
    `ocr must route through the chat endpoint, got: ${lastCall!.url}`,
  );

  const raw = sentBodyRaw(lastCall!.init);
  assert.ok(raw.includes("http://x/img.png"), "request body must carry the image source URL");
  assert.ok(
    /extract|text/i.test(raw),
    "request body must carry an extraction instruction (extract/text wording)",
  );
});

test("ocr (anthropic): also routes through the anthropic chat endpoint and returns extracted text", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ a: ANTHROPIC({ capabilities: ["ocr"], input: ["image"] }) }),
  );
  const c = lib.get("a")!;
  assert.ok(c.ocr, "ocr must be present");
  cannedBody = anthropicOK("DOC TEXT");

  const res = await c.ocr!({ source: { url: "http://x/scan.png" } });
  assert.equal(res.text, "DOC TEXT");
  assert.ok(
    lastCall!.url.endsWith("/v1/messages"),
    `ocr via anthropic must hit /v1/messages, got: ${lastCall!.url}`,
  );
});

// ===========================================================================
// 10. RESILIENCE (#1) — bad communicators are skipped, never crash the build
// ===========================================================================

test("resilience: with onError, an UNKNOWN provider is reported + absent, good one survives", () => {
  const errors: Array<{ name: string; err: unknown }> = [];
  const lib = createCommunicatorLibrary(
    cfg({
      good: ANTHROPIC(),
      bad: { provider: "definitely-not-a-provider", model: "m", apiKey: "k" },
    }),
    { onError: (name, err) => errors.push({ name, err }) },
  );

  // onError called for the bad one with an Error
  assert.equal(errors.length, 1, "exactly one onError call");
  assert.equal(errors[0].name, "bad");
  assert.ok(errors[0].err instanceof Error, "onError must receive an Error");

  // bad one is absent
  assert.equal(lib.has("bad"), false);
  assert.equal(lib.get("bad"), undefined);
  assert.ok(!lib.list().includes("bad"), "bad must not appear in list()");

  // good one present + usable
  assert.equal(lib.has("good"), true);
  assert.ok(lib.get("good"), "good communicator must be present");
  assert.deepEqual(lib.list(), ["good"]);
});

test("resilience: with onError, a MISSING-key communicator is reported + skipped", () => {
  const errors: Array<{ name: string; err: unknown }> = [];
  const lib = createCommunicatorLibrary(
    cfg({
      good: OPENAI(),
      bad: { provider: "anthropic", model: "m" }, // no apiKey
    }),
    { onError: (name, err) => errors.push({ name, err }) },
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "bad");
  assert.ok(errors[0].err instanceof Error);
  assert.equal(lib.has("bad"), false);
  assert.equal(lib.get("bad"), undefined);
  assert.equal(lib.has("good"), true);
});

test("resilience: with onError, an UNSUPPORTED capability for a provider is reported + skipped", () => {
  const errors: Array<{ name: string; err: unknown }> = [];
  const lib = createCommunicatorLibrary(
    cfg({
      good: COHERE(), // valid rerank
      bad: { provider: "openai-completion", model: "gpt-4o", apiKey: "k", capabilities: ["rerank"] }, // openai can't rerank
    }),
    { onError: (name, err) => errors.push({ name, err }) },
  );

  assert.equal(errors.length, 1, "the unsupported-capability communicator must be reported");
  assert.equal(errors[0].name, "bad");
  assert.ok(errors[0].err instanceof Error);
  assert.equal(lib.has("bad"), false);
  assert.equal(lib.get("bad"), undefined);
  assert.equal(lib.has("good"), true);
});

test("resilience: an env-ref key that resolves to nothing is reported + skipped (good survives)", () => {
  const prev = process.env.DEFINITELY_UNSET_ENV_VAR_XYZ;
  delete process.env.DEFINITELY_UNSET_ENV_VAR_XYZ;
  const errors: Array<{ name: string; err: unknown }> = [];
  try {
    const lib = createCommunicatorLibrary(
      cfg({
        good: ANTHROPIC(),
        bad: { provider: "anthropic", model: "m", apiKey: "${DEFINITELY_UNSET_ENV_VAR_XYZ}" },
      }),
      { onError: (name, err) => errors.push({ name, err }) },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "bad");
    assert.ok(errors[0].err instanceof Error);
    assert.equal(lib.has("bad"), false);
    assert.equal(lib.has("good"), true);
  } finally {
    if (prev !== undefined) process.env.DEFINITELY_UNSET_ENV_VAR_XYZ = prev;
  }
});

test("resilience: WITHOUT onError, a bad communicator does NOT throw — it is silently skipped", () => {
  let lib!: CommunicatorLibrary;
  assert.doesNotThrow(() => {
    lib = createCommunicatorLibrary(
      cfg({
        good: ANTHROPIC(),
        bad: { provider: "nonsense-provider", model: "m", apiKey: "k" },
      }),
    );
  }, "a bad communicator must not throw when no onError is supplied");

  assert.equal(lib.has("bad"), false, "bad one is skipped");
  assert.equal(lib.get("bad"), undefined);
  assert.equal(lib.has("good"), true, "good one still loads");
  assert.deepEqual(lib.list(), ["good"]);
});

test("resilience: WITHOUT onError, multiple bad communicators are all skipped, all good ones load", () => {
  let lib!: CommunicatorLibrary;
  assert.doesNotThrow(() => {
    lib = createCommunicatorLibrary(
      cfg({
        chatter: ANTHROPIC(),
        ranker: COHERE(),
        bad1: { provider: "???", model: "m", apiKey: "k" },
        bad2: { provider: "anthropic", model: "m" }, // missing key
      }),
    );
  });
  assert.deepEqual([...lib.list()].sort(), ["chatter", "ranker"]);
  assert.equal(lib.has("bad1"), false);
  assert.equal(lib.has("bad2"), false);
});

test("resilience: a good communicator skipped-alongside-bad is fully functional (chat still works)", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      good: ANTHROPIC(),
      bad: { provider: "nope", model: "m", apiKey: "k" },
    }),
    { onError: () => {} },
  );
  const c = lib.get("good")!;
  assert.ok(c.chat, "the surviving good communicator must expose chat");
  cannedBody = anthropicOK("still working");
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "still working");
});

// ===========================================================================
// 11. TRANSPORT ERRORS — a non-2xx response rejects the called op
// ===========================================================================

test("transport: a 500 response makes chat() reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedStatus = 500;
  cannedBody = { error: { message: "boom" } };

  await assert.rejects(
    () => c.chat!({ messages: [{ role: "user", content: "hi" }] }),
    "a 500 response must reject",
  );
});

test("transport: a 401 response makes chat() reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedStatus = 401;
  cannedBody = { error: { message: "bad key" } };

  await assert.rejects(() => c.chat!({ messages: [{ role: "user", content: "hi" }] }));
});

test("transport: a non-2xx response makes embed() reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ e: OPENAI({ capabilities: ["embed"] }) }));
  const c = lib.get("e")!;
  cannedStatus = 500;
  cannedBody = { error: { message: "boom" } };

  await assert.rejects(() => c.embed!({ input: ["a"] }), "embed must reject on non-2xx");
});

test("transport: a non-2xx response makes rerank() reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ r: COHERE() }));
  const c = lib.get("r")!;
  cannedStatus = 429;
  cannedBody = { error: { message: "slow down" } };

  await assert.rejects(
    () => c.rerank!({ query: "q", documents: ["d0", "d1"] }),
    "rerank must reject on non-2xx",
  );
});

test("transport: after a rejected call the same communicator recovers on the next success", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;

  cannedStatus = 500;
  cannedBody = { error: { message: "boom" } };
  await assert.rejects(() => c.chat!({ messages: [{ role: "user", content: "hi" }] }));

  cannedStatus = 200;
  cannedBody = anthropicOK("recovered");
  const res = await c.chat!({ messages: [{ role: "user", content: "hi again" }] });
  assert.equal(res.content, "recovered");
});

// ===========================================================================
// 12. stopReason NORMALIZATION — provider-native -> named vocabulary
//     ("stop" | "length" | "tool_use" | "content_filter")
// ===========================================================================

test("stopReason (anthropic): end_turn normalizes to 'stop'", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.stopReason, "stop", "anthropic end_turn -> 'stop'");
});

test("stopReason (anthropic): max_tokens normalizes to 'length'", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.stopReason, "length", "anthropic max_tokens -> 'length'");
});

test("stopReason (anthropic): tool_use stays 'tool_use'", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = {
    content: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.stopReason, "tool_use", "anthropic tool_use stays 'tool_use'");
});

test("stopReason (openai chat): stop -> 'stop'", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.stopReason, "stop", "openai stop -> 'stop'");
});

test("stopReason (openai chat): length -> 'length'", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = {
    choices: [{ message: { content: "ok" }, finish_reason: "length" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.stopReason, "length", "openai length -> 'length'");
});

test("stopReason (openai chat): content_filter -> 'content_filter'", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = {
    choices: [{ message: { content: "ok" }, finish_reason: "content_filter" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
  const res = await c.chat!({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.stopReason, "content_filter", "openai content_filter stays 'content_filter'");
});

// ===========================================================================
// 13. ANTHROPIC SYSTEM HANDLING — req.system + hoisted role:"system" messages
// ===========================================================================

test("anthropic system: req.system 'sys' goes to body.system and never into body.messages", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }], system: "sys" });

  const body = sentBody(lastCall!.init);
  assert.equal(body.system, "sys", "req.system must populate body.system");
  const hasSystemMsg = body.messages.some((m: any) => m.role === "system");
  assert.equal(
    hasSystemMsg,
    false,
    `no system role may appear inside body.messages: ${JSON.stringify(body.messages)}`,
  );
});

test("anthropic system: a messages[] entry with role 'system' is HOISTED into body.system", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({
    messages: [
      { role: "system", content: "hoisted-sys" },
      { role: "user", content: "hi" },
    ],
  });

  const body = sentBody(lastCall!.init);
  assert.ok(
    typeof body.system === "string" && body.system.includes("hoisted-sys"),
    `system message must be hoisted into body.system, got: ${JSON.stringify(body.system)}`,
  );
  for (const m of body.messages) {
    assert.ok(
      ["user", "assistant", "tool"].includes(m.role),
      `body.messages must contain only user/assistant/tool roles, saw role '${m.role}'`,
    );
  }
});

test("anthropic system: req.system + a role 'system' message are concatenated into body.system", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({
    messages: [
      { role: "system", content: "from-message" },
      { role: "user", content: "hi" },
    ],
    system: "from-request",
  });

  const body = sentBody(lastCall!.init);
  assert.equal(typeof body.system, "string", "body.system must be a string");
  assert.ok(
    body.system.includes("from-request") && body.system.includes("from-message"),
    `both system sources must be concatenated into body.system, got: ${JSON.stringify(body.system)}`,
  );
  assert.ok(
    !body.messages.some((m: any) => m.role === "system"),
    "no system role may remain inside body.messages",
  );
});

// ===========================================================================
// 14. ASSISTANT toolCalls REPLAY — Message.toolCalls -> provider-native form
// ===========================================================================

test("toolCalls replay (anthropic): assistant toolCalls -> a tool_use content block", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", arguments: { x: 1 } }] },
      { role: "tool", toolCallId: "t1", content: "result" },
    ],
  });

  const body = sentBody(lastCall!.init);
  const assistant = body.messages.find((m: any) => m.role === "assistant");
  assert.ok(assistant, "an assistant message must be present");
  assert.ok(Array.isArray(assistant.content), "assistant content must be a content-block array");
  const toolUse = assistant.content.find((b: any) => b.type === "tool_use");
  assert.ok(toolUse, `a tool_use block must be present: ${JSON.stringify(assistant.content)}`);
  assert.equal(toolUse.id, "t1");
  assert.equal(toolUse.name, "f");
  assert.deepEqual(toolUse.input, { x: 1 });
});

test("toolCalls replay (openai chat): assistant toolCalls -> tool_calls[].function with JSON-string arguments", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", arguments: { x: 1 } }] },
      { role: "tool", toolCallId: "t1", content: "result" },
    ],
  });

  const body = sentBody(lastCall!.init);
  const assistant = body.messages.find(
    (m: any) => m.role === "assistant" && Array.isArray(m.tool_calls),
  );
  assert.ok(assistant, `an assistant message with tool_calls must be present: ${JSON.stringify(body.messages)}`);
  assert.equal(assistant.tool_calls.length, 1);
  const tc = assistant.tool_calls[0];
  assert.equal(tc.function.name, "f", "function name must be replayed");
  assert.equal(typeof tc.function.arguments, "string", "openai function.arguments must be a JSON STRING");
  assert.deepEqual(JSON.parse(tc.function.arguments), { x: 1 }, "the JSON string must parse to the arguments");
});

// ===========================================================================
// 15. OPENAI CHAT AUDIO — ContentPart audio wire mapping
// ===========================================================================

test("openai chat audio: mime audio/mpeg + base64 data -> input_audio format 'mp3'", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI({ input: ["text", "audio"] }) }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({
    messages: [
      { role: "user", content: [{ type: "audio", audio: { data: "QUJD", mime: "audio/mpeg" } }] },
    ],
  });

  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  assert.ok(Array.isArray(user.content), "user content must be a parts array");
  const audioPart = user.content.find((p: any) => p.type === "input_audio");
  assert.ok(audioPart, `an input_audio part must be present: ${JSON.stringify(user.content)}`);
  assert.equal(audioPart.input_audio.format, "mp3", "audio/mpeg must map to format 'mp3'");
  assert.equal(audioPart.input_audio.data, "QUJD", "the base64 data must be carried");
});

test("openai chat audio: mime audio/wav -> input_audio format 'wav'", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI({ input: ["text", "audio"] }) }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({
    messages: [
      { role: "user", content: [{ type: "audio", audio: { data: "QUJD", mime: "audio/wav" } }] },
    ],
  });

  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  const audioPart = user.content.find((p: any) => p.type === "input_audio");
  assert.ok(audioPart, "an input_audio part must be present");
  assert.equal(audioPart.input_audio.format, "wav", "audio/wav must map to format 'wav'");
});

test("openai chat audio: a URL-only audio part (no data) degrades to a text placeholder, never input_audio with undefined data", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI({ input: ["text", "audio"] }) }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({
    messages: [
      { role: "user", content: [{ type: "audio", audio: { url: "http://x/a.mp3" } }] },
    ],
  });

  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  assert.ok(Array.isArray(user.content), "user content must be a parts array");
  const badAudio = user.content.find(
    (p: any) => p.type === "input_audio" && (!p.input_audio || p.input_audio.data === undefined),
  );
  assert.equal(
    badAudio,
    undefined,
    `a URL-only audio part must NOT produce an input_audio part with undefined data: ${JSON.stringify(user.content)}`,
  );
  const hasText = user.content.some((p: any) => p.type === "text");
  assert.ok(hasText, `the URL-only audio must degrade to a text placeholder part: ${JSON.stringify(user.content)}`);
});

// ===========================================================================
// 16. OPENAI CHAT INLINE DOCUMENT — base64 document -> a file part
// ===========================================================================

test("openai chat document: inline base64 document (no url) -> a file part with a data: URI and a filename", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI({ input: ["text", "document"] }) }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({
    messages: [
      {
        role: "user",
        content: [{ type: "document", document: { data: "REFUQQ==", mime: "application/pdf" } }],
      },
    ],
  });

  const raw = sentBodyRaw(lastCall!.init);
  assert.ok(
    !raw.includes("[unsupported document content]"),
    "inline base64 documents must no longer be dropped as unsupported",
  );

  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  assert.ok(Array.isArray(user.content), "user content must be a parts array");
  const filePart = user.content.find((p: any) => p.type === "file");
  assert.ok(filePart, `a file part must be present: ${JSON.stringify(user.content)}`);
  assert.ok(filePart.file, "the file part must carry a file object");
  assert.ok(
    typeof filePart.file.file_data === "string" && filePart.file.file_data.startsWith("data:"),
    `file_data must be a data: URI, got: ${JSON.stringify(filePart.file.file_data)}`,
  );
  assert.ok(
    filePart.file.file_data.includes("REFUQQ=="),
    "the data: URI must embed the original base64",
  );
  assert.ok(filePart.file.filename, "a filename must be present");
});

// ===========================================================================
// 17. MULTIMODAL CHAT INPUT — image wire shapes per provider
// ===========================================================================

test("multimodal (anthropic): [text, image{url}] emits an image source url block", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC({ input: ["text", "image"] }) }));
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

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
  const user = body.messages.find((m: any) => m.role === "user");
  assert.ok(Array.isArray(user.content), "anthropic user content must be a content-block array");
  const imgBlock = user.content.find((b: any) => b.type === "image");
  assert.ok(imgBlock, `an image block must be present: ${JSON.stringify(user.content)}`);
  const raw = sentBodyRaw(lastCall!.init);
  assert.ok(raw.includes("http://x/pic.png"), "the image url must reach the request body");
});

test("multimodal (openai chat): [text, image{url}] emits an image_url part", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI({ input: ["text", "image"] }) }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

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
  const user = body.messages.find((m: any) => m.role === "user");
  assert.ok(Array.isArray(user.content), "openai user content must be a parts array");
  const imgPart = user.content.find((p: any) => p.type === "image_url");
  assert.ok(imgPart, `an image_url part must be present: ${JSON.stringify(user.content)}`);
  const raw = sentBodyRaw(lastCall!.init);
  assert.ok(raw.includes("http://x/pic.png"), "the image url must reach the request body");
});

// ===========================================================================
// 18. EMPTY MediaRef — neither url nor data degrades to a text placeholder
// ===========================================================================

test("empty MediaRef (anthropic): an empty image ref degrades to text — no source with undefined data", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC({ input: ["text", "image"] }) }));
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({
    messages: [{ role: "user", content: [{ type: "image", image: {} }] }],
  });

  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  const blocks = Array.isArray(user.content) ? user.content : [];
  // No image block whose source carries an undefined/empty url or data.
  for (const b of blocks) {
    if (b.type === "image") {
      const src = b.source ?? {};
      assert.ok(
        src.data !== undefined && src.data !== "" || src.url !== undefined && src.url !== "",
        `an empty image ref must NOT emit a source with undefined data/url: ${JSON.stringify(b)}`,
      );
    }
  }
  const hasText = blocks.some((b: any) => b.type === "text");
  assert.ok(hasText, `the empty image ref must degrade to a text placeholder: ${JSON.stringify(blocks)}`);
});

test("empty MediaRef (openai chat): an empty document ref degrades to text — no image_url with empty url", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI({ input: ["text", "image", "document"] }) }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({
    messages: [{ role: "user", content: [{ type: "document", document: {} }] }],
  });

  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  const parts = Array.isArray(user.content) ? user.content : [];
  for (const p of parts) {
    if (p.type === "image_url") {
      const url = p.image_url?.url;
      assert.ok(url !== undefined && url !== "", `no image_url with empty url allowed: ${JSON.stringify(p)}`);
    }
    if (p.type === "file") {
      assert.ok(
        p.file && p.file.file_data !== undefined && p.file.file_data !== "",
        `no file part with empty file_data allowed: ${JSON.stringify(p)}`,
      );
    }
  }
  const hasText = parts.some((p: any) => p.type === "text");
  assert.ok(hasText, `the empty document ref must degrade to a text placeholder: ${JSON.stringify(parts)}`);
});

// ===========================================================================
// 19. RERANK — topN truncation (after score-desc sort) + echoed-document preference
// ===========================================================================

test("rerank: more results than topN are truncated to topN (after score-desc sort)", async () => {
  const lib = createCommunicatorLibrary(cfg({ r: COHERE() }));
  const c = lib.get("r")!;
  // Provider returns 3 results (out of order); req.topN = 2 -> expect the top-2 by score.
  cannedBody = {
    results: [
      { index: 0, relevance_score: 0.2 },
      { index: 2, relevance_score: 0.95 },
      { index: 1, relevance_score: 0.5 },
    ],
  };

  const res = await c.rerank!({ query: "q", documents: ["d0", "d1", "d2"], topN: 2 });
  assert.equal(res.results.length, 2, "results must be truncated to topN");
  assert.equal(res.results[0].index, 2, "highest score first");
  assert.equal(res.results[0].score, 0.95);
  assert.equal(res.results[1].index, 1, "second-highest score second");
  assert.equal(res.results[1].score, 0.5);
});

test("rerank: an echoed `document` field is preferred over indexing into req.documents", async () => {
  const lib = createCommunicatorLibrary(cfg({ r: COHERE() }));
  const c = lib.get("r")!;
  cannedBody = {
    results: [{ index: 0, relevance_score: 0.9, document: "ECHOED-TEXT" }],
  };

  const res = await c.rerank!({ query: "q", documents: ["original-d0"] });
  assert.equal(res.results.length, 1);
  assert.equal(
    res.results[0].document,
    "ECHOED-TEXT",
    "the provider-echoed document must win over req.documents[index]",
  );
});

// ===========================================================================
// 20. OCR via ANTHROPIC — document vs image source block typing
// ===========================================================================

test("ocr (anthropic): a document/pdf source sends a content block of type 'document', not 'image'", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ a: ANTHROPIC({ capabilities: ["ocr"], input: ["document"] }) }),
  );
  const c = lib.get("a")!;
  assert.ok(c.ocr, "ocr must be present");
  cannedBody = anthropicOK("EXTRACTED");

  await c.ocr!({ source: { data: "JVBERi0=", mime: "application/pdf" } });

  assert.ok(lastCall!.url.endsWith("/v1/messages"), `ocr via anthropic must hit /v1/messages, got: ${lastCall!.url}`);
  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  const blocks = Array.isArray(user.content) ? user.content : [];
  const docBlock = blocks.find((b: any) => b.type === "document");
  assert.ok(docBlock, `a 'document' content block must be present: ${JSON.stringify(blocks)}`);
  const imgBlock = blocks.find((b: any) => b.type === "image");
  assert.equal(imgBlock, undefined, "a pdf OCR source must NOT be sent as an 'image' block");
});

test("ocr (anthropic): an image/png source still sends a content block of type 'image'", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ a: ANTHROPIC({ capabilities: ["ocr"], input: ["image"] }) }),
  );
  const c = lib.get("a")!;
  cannedBody = anthropicOK("EXTRACTED");

  await c.ocr!({ source: { data: "iVBORw0=", mime: "image/png" } });

  const body = sentBody(lastCall!.init);
  const user = body.messages.find((m: any) => m.role === "user");
  const blocks = Array.isArray(user.content) ? user.content : [];
  const imgBlock = blocks.find((b: any) => b.type === "image");
  assert.ok(imgBlock, `an 'image' content block must be present for an image source: ${JSON.stringify(blocks)}`);
});

// ===========================================================================
// 21. GATEWAY GUARD — malformed config does not throw, yields empty library
// ===========================================================================

test("gateway guard: createCommunicatorLibrary({}) does not throw and yields an empty library", () => {
  let lib!: CommunicatorLibrary;
  assert.doesNotThrow(() => {
    lib = createCommunicatorLibrary({} as any);
  }, "an empty config object must not throw");
  assert.deepEqual(lib.list(), [], "no communicators expected");
});

test("gateway guard: createCommunicatorLibrary({default:'claude'}) (no communicators) yields an empty library", () => {
  let lib!: CommunicatorLibrary;
  assert.doesNotThrow(() => {
    lib = createCommunicatorLibrary({ default: "claude" } as any);
  }, "a config with only a default and no communicators must not throw");
  assert.deepEqual(lib.list(), [], "no communicators expected");
  assert.equal(lib.has("claude"), false, "the dangling default must not resolve to a communicator");
});

// ===========================================================================
// 22. PER-COMMUNICATOR TUNING FIELDS — topP / stop / reasoningEffort wire mapping
//     (present only when set; mirrors temperature/maxTokens conditionality)
// ===========================================================================

test("tuning (anthropic): topP -> top_p and stop -> stop_sequences appear when configured", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      a: {
        provider: "anthropic",
        model: "claude-x",
        apiKey: "k",
        topP: 0.7,
        stop: ["END", "STOP"],
      },
    }),
  );
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal(body.top_p, 0.7, "configured topP must wire to body.top_p");
  assert.deepEqual(body.stop_sequences, ["END", "STOP"], "configured stop must wire to body.stop_sequences");
});

test("tuning (anthropic): reasoning_effort is NEVER sent (Anthropic uses a thinking budget, not an effort enum)", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      a: {
        provider: "anthropic",
        model: "claude-x",
        apiKey: "k",
        reasoningEffort: "high",
        topP: 0.5,
      },
    }),
  );
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal(
    "reasoning_effort" in body,
    false,
    "Anthropic must not carry reasoning_effort even when configured",
  );
  // topP still wires through — only reasoningEffort is deliberately dropped.
  assert.equal(body.top_p, 0.5);
});

test("tuning (anthropic): with none set, top_p / stop_sequences / reasoning_effort are all ABSENT", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = anthropicOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal("top_p" in body, false, "top_p must be absent when topP is unset");
  assert.equal("stop_sequences" in body, false, "stop_sequences must be absent when stop is unset");
  assert.equal("reasoning_effort" in body, false, "reasoning_effort must never be sent to anthropic");
});

test("tuning (openai chat): topP -> top_p, stop -> stop, reasoningEffort -> reasoning_effort all appear when set", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      o: {
        provider: "openai-completion",
        model: "gpt-x",
        apiKey: "k",
        baseURL: "https://api.openai.com/v1",
        topP: 0.3,
        stop: ["\n\n"],
        reasoningEffort: "low",
      },
    }),
  );
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal(body.top_p, 0.3, "configured topP must wire to body.top_p");
  assert.deepEqual(body.stop, ["\n\n"], "configured stop must wire to body.stop");
  assert.equal(body.reasoning_effort, "low", "configured reasoningEffort must wire to body.reasoning_effort");
});

test("tuning (openai chat): with none set, top_p / stop / reasoning_effort are all ABSENT", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = openaiOK("ok");

  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const body = sentBody(lastCall!.init);
  assert.equal("top_p" in body, false, "top_p must be absent when topP is unset");
  assert.equal("stop" in body, false, "stop must be absent when stop is unset");
  assert.equal("reasoning_effort" in body, false, "reasoning_effort must be absent when unset");
});

test("tuning: contextLength is METADATA only — exposed on the communicator, never on the wire", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      a: { provider: "anthropic", model: "claude-x", apiKey: "k", contextLength: 200000 },
    }),
  );
  const c = lib.get("a")!;
  assert.equal(c.contextLength, 200000, "contextLength must be surfaced as read-only metadata");

  cannedBody = anthropicOK("ok");
  await c.chat!({ messages: [{ role: "user", content: "hi" }] });

  const raw = sentBodyRaw(lastCall!.init);
  assert.ok(
    !raw.includes("contextLength") && !raw.includes("context_length"),
    `contextLength must never appear in the request body: ${raw}`,
  );
});

test("tuning: a communicator without contextLength does not expose the property", () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  assert.equal(c.contextLength, undefined, "contextLength must be undefined when not configured");
});
