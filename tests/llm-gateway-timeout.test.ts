/**
 * Edge tests for the llm-gateway REQUEST TIMEOUT (robustness on a hung endpoint).
 *
 * Behavior pinned (observed only through the public CommunicatorLibrary seam):
 *  - A request that never answers is ABORTED after `timeoutMs` and surfaces as a
 *    clean "request timed out" Error (so it lands as a failed llm.return → retry).
 *  - A response that arrives in time is NOT aborted.
 *  - `timeoutMs: 0` disables the deadline — the request carries NO abort signal.
 *  - Omitting `timeoutMs` applies a default deadline — the request DOES carry a signal.
 *
 * The network is mocked: a per-test `globalThis.fetch` either hangs (and honours
 * the AbortSignal) or answers immediately while recording the init it received.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCommunicatorLibrary } from "../packages/llm-gateway/src";

let originalFetch: typeof globalThis.fetch;
let lastInit: RequestInit | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastInit = undefined;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build an openai-completion chat() with an optional per-communicator timeoutMs. */
function buildChat(timeoutMs?: number) {
  const def: Record<string, unknown> = {
    provider: "openai-completion",
    model: "m",
    apiKey: "k",
    baseURL: "http://endpoint.test/v1",
  };
  if (timeoutMs !== undefined) def.timeoutMs = timeoutMs;
  const lib = createCommunicatorLibrary({ communicators: { c: def } } as any);
  const chat = lib.get("c")!.chat!;
  return chat;
}

/** A fetch that never answers but honours abort (a black-hole endpoint). */
function installHungFetch() {
  globalThis.fetch = ((_url: any, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      if (sig) {
        if (sig.aborted) reject(new DOMException("aborted", "AbortError"));
        else sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }
    })) as unknown as typeof globalThis.fetch;
}

/** A fetch that answers immediately with a valid chat completion, recording init. */
function installFastFetch() {
  globalThis.fetch = ((_url: any, init?: RequestInit) => {
    lastInit = init;
    return Promise.resolve(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as unknown as typeof globalThis.fetch;
}

test("timeout: a hung request aborts after timeoutMs and rejects with a 'timed out' error", async () => {
  installHungFetch();
  const chat = buildChat(50);
  await assert.rejects(
    () => chat({ messages: [{ role: "user", content: "hi" }] }),
    /timed out after 50ms/i,
  );
});

test("timeout: the timeout error is a plain Error, NOT a raw AbortError", async () => {
  installHungFetch();
  const chat = buildChat(50);
  await chat({ messages: [{ role: "user", content: "hi" }] }).then(
    () => assert.fail("should have rejected"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(String(err.name ?? ""), /AbortError/i);
      assert.match(String(err.message), /timed out/i);
    },
  );
});

test("timeout: a response that arrives in time is NOT aborted (resolves normally)", async () => {
  installFastFetch();
  const chat = buildChat(50);
  const res = await chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "hi");
});

test("timeout: timeoutMs:0 disables the deadline — the request carries NO abort signal", async () => {
  installFastFetch();
  const chat = buildChat(0);
  const res = await chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.content, "hi");
  assert.equal(lastInit?.signal, undefined, "disabled timeout must not attach a signal");
});

test("timeout: omitting timeoutMs applies a default deadline — the request DOES carry a signal", async () => {
  installFastFetch();
  const chat = buildChat(); // no timeoutMs → gateway default
  await chat({ messages: [{ role: "user", content: "hi" }] });
  assert.ok(lastInit?.signal instanceof AbortSignal, "default timeout must attach an AbortSignal");
});
