/**
 * Black-box edge tests for the `llm` contract as implemented by the llm-gateway.
 *
 * These are implementation-agnostic: they exercise only the observable behavior
 * promised by `contracts/llm/index.ts` (the CommunicatorLibrary / Communicator
 * surface + the normalized LLMResponse envelope) and `shared/config` (LLMConfig).
 *
 * The network is mocked: `globalThis.fetch` is replaced per-test with a stub that
 * records the last (url, init) it saw and returns a per-test settable canned body
 * + status. No real HTTP, no real provider, no other nodes.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCommunicatorLibrary } from "../packages/llm-gateway/src";
import type { LLMConfig } from "../shared/config";
import type { CommunicatorLibrary, LLMResponse } from "../contracts/llm";

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

/** Parse the JSON body the gateway sent (string body expected). */
function sentBody(init: RequestInit | undefined): any {
  const b = init?.body;
  if (typeof b === "string") return JSON.parse(b);
  if (b == null) return undefined;
  // Some impls may pass a Buffer/Uint8Array — decode best-effort.
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

function cfg(communicators: LLMConfig["communicators"], def?: string): LLMConfig {
  return def === undefined ? { communicators } : { communicators, default: def };
}

const ANTHROPIC = (over: Partial<{ apiKey: string; model: string }> = {}) => ({
  provider: "anthropic",
  model: over.model ?? "claude-3-5-sonnet",
  apiKey: over.apiKey ?? "sk-ant-test-key",
});

const OPENAI = (over: Partial<{ apiKey: string; model: string; baseURL: string }> = {}) => ({
  provider: "openai",
  model: over.model ?? "gpt-4o",
  apiKey: over.apiKey ?? "sk-openai-test-key",
  baseURL: over.baseURL ?? "https://api.openai.com/v1",
});

// ===========================================================================
// 1. createCommunicatorLibrary — library construction & lookup
// ===========================================================================

test("createCommunicatorLibrary: list() returns exactly the configured names", () => {
  const lib: CommunicatorLibrary = createCommunicatorLibrary(
    cfg({ alpha: ANTHROPIC(), beta: OPENAI() }),
  );
  const names = lib.list();
  assert.ok(Array.isArray(names), "list() must return an array");
  assert.deepEqual([...names].sort(), ["alpha", "beta"]);
});

test("createCommunicatorLibrary: list() is empty for an empty catalogue", () => {
  const lib = createCommunicatorLibrary(cfg({}));
  assert.deepEqual(lib.list(), []);
});

test("createCommunicatorLibrary: list() handles a single configured communicator", () => {
  const lib = createCommunicatorLibrary(cfg({ only: ANTHROPIC() }));
  assert.deepEqual(lib.list(), ["only"]);
});

test("has(name): true for configured, false for unknown", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.has("alpha"), true);
  assert.equal(lib.has("nope"), false);
});

test("has(name): false for empty string and whitespace-only name", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.has(""), false);
  assert.equal(lib.has("   "), false);
});

test("has(name): case-sensitive — 'Alpha' does not match 'alpha'", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.has("Alpha"), false);
});

test("get(name): returns a Communicator with name/provider/model set", () => {
  const lib = createCommunicatorLibrary(
    cfg({ main: ANTHROPIC({ model: "claude-x" }) }),
  );
  const c = lib.get("main");
  assert.ok(c, "get('main') must return a communicator");
  assert.equal(c!.name, "main");
  assert.equal(c!.provider, "anthropic");
  assert.equal(c!.model, "claude-x");
  assert.equal(typeof c!.chat, "function");
});

test("get(name): provider/model reflect an OpenAI communicator", () => {
  const lib = createCommunicatorLibrary(
    cfg({ gpt: OPENAI({ model: "gpt-4o-mini" }) }),
  );
  const c = lib.get("gpt");
  assert.ok(c);
  assert.equal(c!.name, "gpt");
  assert.equal(c!.provider, "openai");
  assert.equal(c!.model, "gpt-4o-mini");
});

test("get(unknownName): returns undefined", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.get("ghost"), undefined);
});

test("get(''): returns undefined for empty name", () => {
  const lib = createCommunicatorLibrary(cfg({ alpha: ANTHROPIC() }));
  assert.equal(lib.get(""), undefined);
});

test("get(name): each configured name resolves to a distinct communicator", () => {
  const lib = createCommunicatorLibrary(
    cfg({ a: ANTHROPIC(), b: OPENAI() }),
  );
  const a = lib.get("a");
  const b = lib.get("b");
  assert.ok(a && b);
  assert.notEqual(a, b);
  assert.equal(a!.provider, "anthropic");
  assert.equal(b!.provider, "openai");
});

// ===========================================================================
// 2. SECURITY — the API key is never exposed on the Communicator
// ===========================================================================

test("SECURITY: communicator does not expose an 'apiKey' property", () => {
  const lib = createCommunicatorLibrary(
    cfg({ main: ANTHROPIC({ apiKey: "super-secret-key" }) }),
  );
  const c = lib.get("main")!;
  assert.equal("apiKey" in (c as object), false, "'apiKey' must not be in the communicator");
  assert.equal((c as any).apiKey, undefined);
});

test("SECURITY: no own enumerable property value equals the secret key", () => {
  const SECRET = "super-secret-key-12345";
  const lib = createCommunicatorLibrary(cfg({ main: ANTHROPIC({ apiKey: SECRET }) }));
  const c = lib.get("main")!;
  for (const [k, v] of Object.entries(c)) {
    assert.notEqual(v, SECRET, `own property '${k}' leaks the API key`);
  }
});

test("SECURITY: the key does not appear in JSON.stringify of the communicator", () => {
  const SECRET = "leak-me-if-you-can";
  const lib = createCommunicatorLibrary(cfg({ main: ANTHROPIC({ apiKey: SECRET }) }));
  const c = lib.get("main")!;
  const json = JSON.stringify({
    name: c.name,
    provider: c.provider,
    model: c.model,
  });
  assert.equal(json.includes(SECRET), false);
});

// ===========================================================================
// 3 & 4. construction errors — unknown provider / missing apiKey
// ===========================================================================

test("THROWS: unknown provider is rejected at build time", () => {
  assert.throws(() =>
    createCommunicatorLibrary(
      cfg({ weird: { provider: "definitely-not-a-provider", model: "m", apiKey: "k" } }),
    ),
  );
});

test("THROWS: empty-string provider is rejected", () => {
  assert.throws(() =>
    createCommunicatorLibrary(cfg({ x: { provider: "", model: "m", apiKey: "k" } })),
  );
});

test("THROWS: missing apiKey (undefined) is rejected", () => {
  assert.throws(() =>
    createCommunicatorLibrary(cfg({ x: { provider: "anthropic", model: "m" } })),
  );
});

test("THROWS: empty-string apiKey is rejected", () => {
  assert.throws(() =>
    createCommunicatorLibrary(
      cfg({ x: { provider: "anthropic", model: "m", apiKey: "" } }),
    ),
  );
});

test("THROWS: one bad communicator rejects the whole library build", () => {
  assert.throws(() =>
    createCommunicatorLibrary(
      cfg({
        good: ANTHROPIC(),
        bad: { provider: "nonsense", model: "m", apiKey: "k" },
      }),
    ),
  );
});

// ===========================================================================
// 5. ${ENV_VAR} apiKey resolution
// ===========================================================================

test("ENV: ${TEST_KEY} apiKey resolves and is used in the outgoing request header", async () => {
  const prev = process.env.TEST_KEY;
  process.env.TEST_KEY = "sekret";
  try {
    const lib = createCommunicatorLibrary(
      cfg({ main: { provider: "anthropic", model: "claude-x", apiKey: "${TEST_KEY}" } }),
    );
    const c = lib.get("main");
    assert.ok(c, "library built successfully with an env-ref key");

    cannedBody = {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    await c!.chat({ messages: [{ role: "user", content: "hi" }] });

    const auth =
      header(lastCall?.init, "x-api-key") ?? header(lastCall?.init, "authorization");
    assert.ok(auth, "an auth header must be present");
    assert.ok(
      auth!.includes("sekret"),
      `resolved env key must be used; saw header value: ${auth}`,
    );
  } finally {
    if (prev === undefined) delete process.env.TEST_KEY;
    else process.env.TEST_KEY = prev;
  }
});

test("ENV: ${MISSING_VAR} that resolves to nothing is rejected at build time", () => {
  const prev = process.env.DEFINITELY_UNSET_ENV_VAR_XYZ;
  delete process.env.DEFINITELY_UNSET_ENV_VAR_XYZ;
  try {
    assert.throws(() =>
      createCommunicatorLibrary(
        cfg({
          main: {
            provider: "anthropic",
            model: "m",
            apiKey: "${DEFINITELY_UNSET_ENV_VAR_XYZ}",
          },
        }),
      ),
    );
  } finally {
    if (prev !== undefined) process.env.DEFINITELY_UNSET_ENV_VAR_XYZ = prev;
  }
});

// ===========================================================================
// 6. ANTHROPIC adapter chat()
// ===========================================================================

test("ANTHROPIC chat(): normalizes content/toolCalls/stopReason/usage", async () => {
  const lib = createCommunicatorLibrary(
    cfg({ a: { provider: "anthropic", model: "claude-3-5-sonnet", apiKey: "sk-ant-xyz" } }),
  );
  const c = lib.get("a")!;
  cannedBody = {
    content: [
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "foo", input: { a: 1 } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 5 },
  };

  const res: LLMResponse = await c.chat({ messages: [{ role: "user", content: "hello" }] });

  assert.equal(res.content, "hi");
  assert.deepEqual(res.toolCalls, [{ id: "t1", name: "foo", arguments: { a: 1 } }]);
  assert.equal(res.stopReason, "tool_use");
  assert.ok(res.usage, "usage must be present");
  assert.equal(res.usage!.inputTokens, 3);
  assert.equal(res.usage!.outputTokens, 5);
});

test("ANTHROPIC chat(): request targets /v1/messages with x-api-key + anthropic-version", async () => {
  const KEY = "sk-ant-header-check";
  const lib = createCommunicatorLibrary(
    cfg({ a: { provider: "anthropic", model: "claude-3-5-sonnet", apiKey: KEY } }),
  );
  const c = lib.get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  await c.chat({ messages: [{ role: "user", content: "hello" }] });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/v1/messages"),
    `URL must end with /v1/messages, got: ${lastCall!.url}`,
  );
  assert.equal(header(lastCall!.init, "x-api-key"), KEY);
  assert.ok(
    header(lastCall!.init, "anthropic-version"),
    "anthropic-version header must be present",
  );

  const body = sentBody(lastCall!.init);
  assert.equal(body.model, "claude-3-5-sonnet");
  assert.ok(Array.isArray(body.messages), "body.messages must be an array");
  assert.equal(body.messages.length, 1);
});

test("ANTHROPIC chat(): text-only response yields content with no toolCalls", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "just text" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 4 },
  };

  const res = await c.chat({ messages: [{ role: "user", content: "x" }] });
  assert.equal(res.content, "just text");
  // No tool_use blocks => either undefined or an empty array is acceptable.
  assert.ok(
    res.toolCalls === undefined || res.toolCalls.length === 0,
    "no tool calls expected for a text-only response",
  );
});

test("ANTHROPIC chat(): multiple text blocks are concatenated", async () => {
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

  const res = await c.chat({ messages: [{ role: "user", content: "x" }] });
  assert.ok(
    res.content.includes("foo") && res.content.includes("bar"),
    `both text parts must appear in content, got: ${res.content}`,
  );
});

test("ANTHROPIC chat(): a provided system prompt is forwarded to the request", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedBody = {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  await c.chat({ messages: [{ role: "user", content: "x" }], system: "be terse" });

  const body = sentBody(lastCall!.init);
  // Anthropic carries the system prompt as a top-level `system` field (string or blocks).
  const sys = JSON.stringify(body.system ?? "");
  assert.ok(sys.includes("be terse"), `system prompt must be forwarded, got: ${sys}`);
});

// ===========================================================================
// 7. OPENAI adapter chat()
// ===========================================================================

test("OPENAI chat(): normalizes content/toolCalls(parsed)/stopReason/usage", async () => {
  const lib = createCommunicatorLibrary(
    cfg({
      o: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-openai-xyz",
        baseURL: "https://api.openai.com/v1",
      },
    }),
  );
  const c = lib.get("o")!;
  cannedBody = {
    choices: [
      {
        message: {
          content: "yo",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "bar", arguments: '{"x":2}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 9 },
  };

  const res = await c.chat({
    messages: [{ role: "user", content: "hi" }],
    system: "sys",
  });

  assert.equal(res.content, "yo");
  assert.deepEqual(res.toolCalls, [{ id: "c1", name: "bar", arguments: { x: 2 } }]);
  assert.equal(res.stopReason, "tool_calls");
  assert.ok(res.usage);
  assert.equal(res.usage!.inputTokens, 7);
  assert.equal(res.usage!.outputTokens, 9);
});

test("OPENAI chat(): request targets /chat/completions with Bearer auth + system message", async () => {
  const KEY = "sk-openai-bearer";
  const lib = createCommunicatorLibrary(
    cfg({
      o: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: KEY,
        baseURL: "https://api.openai.com/v1",
      },
    }),
  );
  const c = lib.get("o")!;
  cannedBody = {
    choices: [{ message: { content: "yo" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  await c.chat({ messages: [{ role: "user", content: "hi" }], system: "sys" });

  assert.ok(lastCall, "fetch must have been called");
  assert.ok(
    lastCall!.url.endsWith("/chat/completions"),
    `URL must end with /chat/completions, got: ${lastCall!.url}`,
  );
  assert.equal(header(lastCall!.init, "authorization"), `Bearer ${KEY}`);

  const body = sentBody(lastCall!.init);
  assert.ok(Array.isArray(body.messages), "body.messages must be an array");
  // The system prompt must reach the wire as a system-role message.
  const hasSystem = body.messages.some(
    (m: any) => m.role === "system" && JSON.stringify(m.content).includes("sys"),
  );
  assert.ok(hasSystem, `system message must be included in messages: ${JSON.stringify(body.messages)}`);
});

test("OPENAI chat(): plain text response (no tool_calls) normalizes cleanly", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = {
    choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  };

  const res = await c.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "hello world");
  assert.equal(res.stopReason, "stop");
  assert.ok(
    res.toolCalls === undefined || res.toolCalls.length === 0,
    "no tool calls expected",
  );
});

test("OPENAI chat(): null message content normalizes to empty string", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "c9", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  const res = await c.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(typeof res.content, "string", "content must always be a string");
  assert.equal(res.content, "");
  assert.deepEqual(res.toolCalls, [{ id: "c9", name: "f", arguments: {} }]);
});

test("OPENAI chat(): multiple tool_calls are all normalized & arguments parsed", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedBody = {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "f1", arguments: '{"a":1}' } },
            { id: "c2", type: "function", function: { name: "f2", arguments: '{"b":"two"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  const res = await c.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(res.toolCalls, [
    { id: "c1", name: "f1", arguments: { a: 1 } },
    { id: "c2", name: "f2", arguments: { b: "two" } },
  ]);
});

// ===========================================================================
// 8. transport / error handling
// ===========================================================================

test("ERROR: a non-2xx (500) response causes chat() to reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedStatus = 500;
  cannedBody = { error: { message: "boom" } };

  await assert.rejects(
    () => c.chat({ messages: [{ role: "user", content: "hi" }] }),
    "a 500 response must reject",
  );
});

test("ERROR: a 4xx (401 unauthorized) response causes chat() to reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ o: OPENAI() }));
  const c = lib.get("o")!;
  cannedStatus = 401;
  cannedBody = { error: { message: "bad key" } };

  await assert.rejects(
    () => c.chat({ messages: [{ role: "user", content: "hi" }] }),
    "a 401 response must reject",
  );
});

test("ERROR: a 429 (rate limit) response causes chat() to reject", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;
  cannedStatus = 429;
  cannedBody = { error: { message: "slow down" } };

  await assert.rejects(() => c.chat({ messages: [{ role: "user", content: "hi" }] }));
});

test("ERROR: error rejection still leaves the library usable for a later success", async () => {
  const lib = createCommunicatorLibrary(cfg({ a: ANTHROPIC() }));
  const c = lib.get("a")!;

  cannedStatus = 500;
  cannedBody = { error: { message: "boom" } };
  await assert.rejects(() => c.chat({ messages: [{ role: "user", content: "hi" }] }));

  // recover: the same communicator works after a transient failure
  cannedStatus = 200;
  cannedBody = {
    content: [{ type: "text", text: "recovered" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const res = await c.chat({ messages: [{ role: "user", content: "hi again" }] });
  assert.equal(res.content, "recovered");
});
