/**
 * Black-box EDGE tests for the inspector dashboard's request-block formatter —
 * the pure function `formatRequest(payload, mode)` exported from
 * `public_plugin/inspector/page.format.ts`.
 *
 * Contract surface under test (derived ONLY from the development spec — NO
 * implementation read; the new two-arg signature does NOT exist yet, so until
 * it is written EVERY scenario fails on import/typecheck. That red state is the
 * intended TDD baseline):
 *
 *   export function formatRequest(
 *     payload: unknown,
 *     mode: "readable" | "raw",
 *   ): string
 *
 *   Renders the inspector "request ->" block from a captured "sent" record's
 *   `payload`. The payload is one of:
 *     - llm.request.sent: { data: { request: <LLMRequest> } } where the request
 *       is { system?, messages?, tools?, temperature?, maxTokens?, model? }.
 *     - fallback (llm.request): { data: { context: { text? }, messages? } }.
 *
 *   NORMALIZE payload -> req:
 *     - d = payload.data (object, else {}).
 *     - if d.request is an object -> req = d.request.
 *     - else -> req = { system: (typeof d.context.text === "string"
 *         ? d.context.text : undefined), messages: d.messages }.
 *
 *   mode === "raw":      return JSON.stringify(req, null, 2).
 *   mode === "readable": build SECTIONS joined by "\n\n":
 *     - system (non-empty string)  -> section = that system text.
 *     - messages (non-empty array) -> "— messages (N) —\n" + <lines>, each line
 *         head + ": " + body, where
 *           head = String(role) or "?"; non-empty string name -> role+" ("+name+")".
 *           body = content if string; "" if null/undefined; else JSON.stringify.
 *           append "  [toolCallId=" + id + "]" if toolCallId is a string.
 *           append "\n    toolCalls: " + JSON.stringify(toolCalls) if toolCalls is
 *             a non-empty array. Lines joined by "\n".
 *     - tools (non-empty array)    -> "— tools (M) —\n" + names joined by ", ",
 *         each name = tools[j].name (string) or "?".
 *     - params: collect "temperature="+v (number), "maxTokens="+v (number),
 *         "model="+v (string); if any -> "params: " + parts.join(" · ").
 *     - return sections.join("\n\n") ("" if no sections).
 *
 * Tests are deterministic: exact-string `assert.equal` where output is fully
 * determined. Where the spec delegates to JSON.stringify (raw mode; array/object
 * content; toolCalls), the expectation is built with the SAME JSON.stringify call
 * so the test pins behavior without guessing the serializer's exact output.
 * No DOM, no timers, no I/O.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRequest } from "../../public_plugin/inspector/page.format";

const MSG_HEADER = (n: number) => `— messages (${n}) —`;
const TOOL_HEADER = (n: number) => `— tools (${n}) —`;

// ===========================================================================
// RAW mode — return JSON.stringify(normalized req, null, 2)
// ===========================================================================

// --- positive: assembled (d.request present) ------------------------------

test("raw: assembled request is JSON.stringify(req, null, 2) verbatim (req 1)", () => {
  const request = {
    system: "S",
    messages: [{ role: "user", content: "hi", name: "web" }],
    tools: [{ name: "t1" }],
    temperature: 0.5,
    maxTokens: 100,
  };
  const out = formatRequest({ data: { request } }, "raw");
  // Raw mode echoes the NORMALIZED req (== d.request) pretty-printed.
  assert.equal(out, JSON.stringify(request, null, 2));
});

// --- positive: fallback (no d.request) ------------------------------------

test("raw: fallback normalizes to { system, messages } then stringifies (req 2)", () => {
  const out = formatRequest(
    { data: { context: { text: "S" }, messages: [{ role: "user", content: "hi" }] } },
    "raw",
  );
  const expectedReq = { system: "S", messages: [{ role: "user", content: "hi" }] };
  assert.equal(out, JSON.stringify(expectedReq, null, 2));
});

// --- BVA / robustness: degenerate payloads in raw mode --------------------

test("raw: undefined payload -> d={} -> fallback req {system:undefined, messages:undefined} (req 10)", () => {
  // d = {} (payload not an object). No d.request -> fallback. d.context is
  // absent so context.text is not a string -> system undefined; d.messages
  // absent -> messages undefined. JSON.stringify drops undefined props => "{}".
  const out = formatRequest(undefined, "raw");
  assert.equal(out, JSON.stringify({ system: undefined, messages: undefined }, null, 2));
  assert.equal(out, "{}");
});

test("raw: null payload -> '{}' (req 10)", () => {
  const out = formatRequest(null, "raw");
  assert.equal(out, JSON.stringify({ system: undefined, messages: undefined }, null, 2));
  assert.equal(out, "{}");
});

test("raw: empty object payload (no data) -> '{}'", () => {
  // payload.data is absent -> d = {}; same fallback as null/undefined.
  const out = formatRequest({}, "raw");
  assert.equal(out, "{}");
});

test("raw: data present but empty (no request, no context, no messages) -> '{}'", () => {
  const out = formatRequest({ data: {} }, "raw");
  assert.equal(out, "{}");
});

test("raw: empty request object -> '{}' (req is the empty request verbatim)", () => {
  // d.request is an object (even if empty) -> req = d.request = {}.
  const out = formatRequest({ data: { request: {} } }, "raw");
  assert.equal(out, JSON.stringify({}, null, 2));
  assert.equal(out, "{}");
});

test("raw: fallback with non-string context.text -> system omitted, messages echoed", () => {
  // typeof text !== "string" => system undefined (dropped by stringify).
  const messages = [{ role: "user", content: "hi" }];
  const out = formatRequest({ data: { context: { text: 5 }, messages } }, "raw");
  assert.equal(out, JSON.stringify({ system: undefined, messages }, null, 2));
});

test("raw: request takes precedence over context/messages siblings", () => {
  // When d.request is an object it wins; sibling context/messages are ignored.
  const request = { system: "FROM_REQUEST", model: "m1" };
  const out = formatRequest(
    { data: { request, context: { text: "IGNORED" }, messages: [{ role: "user", content: "x" }] } },
    "raw",
  );
  assert.equal(out, JSON.stringify(request, null, 2));
});

// ===========================================================================
// READABLE mode — sections joined by "\n\n"
// ===========================================================================

// --- positive: full assembled record (req 3) ------------------------------

test("readable: full assembled record renders all four sections in order (req 3)", () => {
  const out = formatRequest(
    {
      data: {
        request: {
          system: "S",
          messages: [
            { role: "user", content: "hi", name: "web" },
            { role: "assistant", content: "hey" },
          ],
          tools: [{ name: "time.now" }, { name: "note.save" }],
          temperature: 0.7,
          maxTokens: 1024,
        },
      },
    },
    "readable",
  );
  assert.equal(
    out,
    "S\n\n— messages (2) —\nuser (web): hi\nassistant: hey\n\n— tools (2) —\ntime.now, note.save\n\nparams: temperature=0.7 · maxTokens=1024",
  );
});

// --- positive: section omission (req 4) -----------------------------------

test("readable: no system -> first section omitted, no leading blank lines (req 4)", () => {
  const out = formatRequest(
    {
      data: {
        request: {
          messages: [
            { role: "user", content: "hi", name: "web" },
            { role: "assistant", content: "hey" },
          ],
          tools: [{ name: "time.now" }, { name: "note.save" }],
          temperature: 0.7,
          maxTokens: 1024,
        },
      },
    },
    "readable",
  );
  // Identical to req 3 EXCEPT the leading "S\n\n" is gone.
  assert.equal(
    out,
    "— messages (2) —\nuser (web): hi\nassistant: hey\n\n— tools (2) —\ntime.now, note.save\n\nparams: temperature=0.7 · maxTokens=1024",
  );
});

// --- positive: messages-only (req 5) --------------------------------------

test("readable: messages only (no system/tools/params) -> just the messages section (req 5)", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "hi" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: hi");
});

// --- positive: assistant turn with toolCalls (req 6) ----------------------

test("readable: assistant turn with toolCalls appends the toolCalls block (req 6)", () => {
  const toolCalls = [{ id: "T1", name: "notes", arguments: { q: "x" } }];
  const out = formatRequest(
    { data: { request: { messages: [{ role: "assistant", content: "", toolCalls }] } } },
    "readable",
  );
  const expectedLine = "assistant: " + "\n    toolCalls: " + JSON.stringify(toolCalls);
  assert.equal(out, MSG_HEADER(1) + "\n" + expectedLine);
});

// --- positive: tool turn with toolCallId + name (req 7) -------------------

test("readable: tool turn renders 'tool (name): body  [toolCallId=ID]' (req 7)", () => {
  const out = formatRequest(
    {
      data: {
        request: {
          messages: [
            { role: "tool", content: '{"ok":true}', toolCallId: "T1", name: "notes" },
          ],
        },
      },
    },
    "readable",
  );
  assert.equal(out, '— messages (1) —\ntool (notes): {"ok":true}  [toolCallId=T1]');
});

// --- positive: fallback normalization renders in readable (req 8) ---------

test("readable: fallback payload renders system + messages (req 8)", () => {
  const out = formatRequest(
    {
      data: {
        context: { text: "S" },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "yo" },
        ],
      },
    },
    "readable",
  );
  assert.equal(out, "S\n\n— messages (2) —\nuser: hi\nassistant: yo");
});

test("readable: fallback with only context.text (no messages) -> just system section", () => {
  // req = { system: "S", messages: undefined }. messages not an array -> no msg
  // section; system non-empty -> one section.
  const out = formatRequest({ data: { context: { text: "S" } } }, "readable");
  assert.equal(out, "S");
});

// --- non-array tools / non-array messages are ignored (req 9) -------------

test("readable: non-array messages is ignored (no messages section) (req 9)", () => {
  // messages is a string -> not a non-empty array -> section omitted; system
  // is the only section.
  const out = formatRequest(
    { data: { request: { system: "S", messages: "nope" } } },
    "readable",
  );
  assert.equal(out, "S");
});

test("readable: non-array tools is ignored (no tools section) (req 9)", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "hi" }], tools: "nope" } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: hi");
});

test("readable: object-shaped tools (not array) is ignored (req 9)", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "hi" }], tools: { 0: { name: "x" } } } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: hi");
});

test("readable: object-shaped messages (not array) is ignored (req 9)", () => {
  const out = formatRequest(
    { data: { request: { system: "S", messages: { 0: { role: "user", content: "x" } } } } },
    "readable",
  );
  assert.equal(out, "S");
});

// ===========================================================================
// READABLE mode — section BVA / emptiness
// ===========================================================================

test("readable: empty request -> no sections -> '' ", () => {
  assert.equal(formatRequest({ data: { request: {} } }, "readable"), "");
});

test("readable: undefined payload -> no sections -> '' (req 10)", () => {
  assert.equal(formatRequest(undefined, "readable"), "");
});

test("readable: null payload -> '' ", () => {
  assert.equal(formatRequest(null, "readable"), "");
});

test("readable: empty system string is NOT a section (empty -> omitted)", () => {
  const out = formatRequest(
    { data: { request: { system: "", messages: [{ role: "user", content: "hi" }] } } },
    "readable",
  );
  // system "" is not a non-empty string => no system section; messages only.
  assert.equal(out, "— messages (1) —\nuser: hi");
});

test("readable: non-string system is ignored (number)", () => {
  const out = formatRequest(
    { data: { request: { system: 5, messages: [{ role: "user", content: "hi" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: hi");
});

test("readable: empty messages array is NOT a section", () => {
  const out = formatRequest(
    { data: { request: { system: "S", messages: [] } } },
    "readable",
  );
  assert.equal(out, "S");
});

test("readable: empty tools array is NOT a section", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "hi" }], tools: [] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: hi");
});

test("readable: single message -> header count is 1", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x");
});

test("readable: many messages -> header count matches length, lines joined by \\n", () => {
  const messages = Array.from({ length: 5 }, (_v, i) => ({ role: "user", content: `m${i}` }));
  const out = formatRequest({ data: { request: { messages } } }, "readable");
  const lines = ["user: m0", "user: m1", "user: m2", "user: m3", "user: m4"].join("\n");
  assert.equal(out, MSG_HEADER(5) + "\n" + lines);
});

test("readable: single tool -> header count is 1", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], tools: [{ name: "only" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x\n\n— tools (1) —\nonly");
});

test("readable: many tools -> names joined by ', '", () => {
  const tools = [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }];
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], tools } } },
    "readable",
  );
  assert.equal(out, MSG_HEADER(1) + "\nuser: x\n\n" + TOOL_HEADER(4) + "\na, b, c, d");
});

// ===========================================================================
// READABLE mode — message line: head construction (role + optional name)
// ===========================================================================

test("readable head: missing role -> '?'", () => {
  const out = formatRequest({ data: { request: { messages: [{ content: "x" }] } } }, "readable");
  assert.equal(out, "— messages (1) —\n?: x");
});

test("readable head: empty-string role is falsy -> '?'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "", content: "x" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\n?: x");
});

test("readable head: name present -> 'role (name)'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "hi", name: "alice" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser (alice): hi");
});

test("readable head: empty-string name is NOT appended (non-empty rule)", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x", name: "" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x");
});

test("readable head: missing role but present name -> '? (name)'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ content: "x", name: "web" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\n? (web): x");
});

test("readable head: non-string name (number) is NOT appended", () => {
  // The spec gates the name suffix on a non-empty STRING name.
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x", name: 7 }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x");
});

// ===========================================================================
// READABLE mode — message line: body typing (string / null / undefined / other)
// ===========================================================================

test("readable body: string content is used verbatim", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "plain text" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: plain text");
});

test("readable body: empty-string content -> empty body", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: ");
});

test("readable body: null content -> empty body", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "assistant", content: null }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nassistant: ");
});

test("readable body: missing content (undefined) -> empty body", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "assistant" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nassistant: ");
});

test("readable body: array content -> JSON.stringify(content)", () => {
  const content = [
    { type: "text", text: "hello" },
    { type: "image", url: "http://x/y.png" },
  ];
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: " + JSON.stringify(content));
});

test("readable body: object content -> JSON.stringify(content)", () => {
  const content = { foo: "bar", n: 1 };
  const out = formatRequest(
    { data: { request: { messages: [{ role: "tool", content }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\ntool: " + JSON.stringify(content));
});

test("readable body: numeric content -> JSON.stringify(content)", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: 42 }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: " + JSON.stringify(42)); // "42"
});

// ===========================================================================
// READABLE mode — message line: toolCallId / toolCalls suffixes
// ===========================================================================

test("readable suffix: non-string toolCallId is NOT appended", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "tool", content: "ok", toolCallId: 123 }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\ntool: ok");
});

test("readable suffix: empty toolCalls array is NOT appended", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "assistant", content: "done", toolCalls: [] }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nassistant: done");
});

test("readable suffix: non-array toolCalls is NOT appended", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "assistant", content: "done", toolCalls: "nope" }] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nassistant: done");
});

test("readable suffix: toolCallId then toolCalls both append on one line, in order", () => {
  const toolCalls = [{ id: "T9", name: "notes", arguments: { a: 1 } }];
  const out = formatRequest(
    {
      data: {
        request: { messages: [{ role: "assistant", content: "c", toolCallId: "T9", toolCalls }] },
      },
    },
    "readable",
  );
  const expectedLine =
    "assistant: c" + "  [toolCallId=T9]" + "\n    toolCalls: " + JSON.stringify(toolCalls);
  assert.equal(out, MSG_HEADER(1) + "\n" + expectedLine);
});

// ===========================================================================
// READABLE mode — tools section: name fallback
// ===========================================================================

test("readable tools: missing name -> '?'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], tools: [{}] } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x\n\n— tools (1) —\n?");
});

test("readable tools: non-string name -> '?'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], tools: [{ name: 5 }, { name: "ok" }] } } },
    "readable",
  );
  assert.equal(out, MSG_HEADER(1) + "\nuser: x\n\n" + TOOL_HEADER(2) + "\n?, ok");
});

// ===========================================================================
// READABLE mode — params section: number/string gating & assembly
// ===========================================================================

test("readable params: only temperature (number) -> 'params: temperature=v'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], temperature: 0 } } },
    "readable",
  );
  // temperature=0 is a number -> included (0 is not skipped by the typeof gate).
  assert.equal(out, "— messages (1) —\nuser: x\n\nparams: temperature=0");
});

test("readable params: only maxTokens (number) -> 'params: maxTokens=v'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], maxTokens: 256 } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x\n\nparams: maxTokens=256");
});

test("readable params: only model (string) -> 'params: model=v'", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], model: "claude-x" } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x\n\nparams: model=claude-x");
});

test("readable params: all three present -> joined by ' · ' in temperature/maxTokens/model order", () => {
  const out = formatRequest(
    {
      data: {
        request: {
          messages: [{ role: "user", content: "x" }],
          temperature: 0.2,
          maxTokens: 512,
          model: "m9",
        },
      },
    },
    "readable",
  );
  assert.equal(
    out,
    "— messages (1) —\nuser: x\n\nparams: temperature=0.2 · maxTokens=512 · model=m9",
  );
});

test("readable params: non-number temperature is ignored", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], temperature: "hot" } } },
    "readable",
  );
  // No numeric/string params survive the gate -> no params section.
  assert.equal(out, "— messages (1) —\nuser: x");
});

test("readable params: non-number maxTokens is ignored", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], maxTokens: "lots" } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x");
});

test("readable params: non-string model (number) is ignored", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], model: 7 } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x");
});

test("readable params: a params-only request (no system/messages/tools) -> just params section", () => {
  const out = formatRequest(
    { data: { request: { temperature: 0.9 } } },
    "readable",
  );
  assert.equal(out, "params: temperature=0.9");
});

test("readable params: mixed valid+invalid -> only valid parts included", () => {
  const out = formatRequest(
    {
      data: {
        request: {
          messages: [{ role: "user", content: "x" }],
          temperature: "no", // ignored
          maxTokens: 128, // kept
          model: 42, // ignored
        },
      },
    },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x\n\nparams: maxTokens=128");
});

// ===========================================================================
// READABLE mode — section ordering with partial sections present
// ===========================================================================

test("readable order: system + tools (no messages) -> system, then tools section", () => {
  const out = formatRequest(
    { data: { request: { system: "S", tools: [{ name: "t1" }] } } },
    "readable",
  );
  assert.equal(out, "S\n\n— tools (1) —\nt1");
});

test("readable order: messages + params (no system, no tools)", () => {
  const out = formatRequest(
    { data: { request: { messages: [{ role: "user", content: "x" }], model: "m1" } } },
    "readable",
  );
  assert.equal(out, "— messages (1) —\nuser: x\n\nparams: model=m1");
});

test("readable order: system + params only (no messages, no tools)", () => {
  const out = formatRequest(
    { data: { request: { system: "S", maxTokens: 64 } } },
    "readable",
  );
  assert.equal(out, "S\n\nparams: maxTokens=64");
});

// ===========================================================================
// Normalization precedence across both modes
// ===========================================================================

test("normalize: d.request present -> readable uses request, ignores sibling context/messages", () => {
  const out = formatRequest(
    {
      data: {
        request: { system: "FROM_REQUEST", messages: [{ role: "user", content: "R" }] },
        context: { text: "FROM_CONTEXT" },
        messages: [{ role: "user", content: "C" }],
      },
    },
    "readable",
  );
  assert.equal(out, "FROM_REQUEST\n\n— messages (1) —\nuser: R");
});

test("normalize: payload.data not an object (string) -> d={} -> fallback empty", () => {
  // d must be an object; a string data falls back to {} per spec.
  assert.equal(formatRequest({ data: "nope" }, "readable"), "");
  assert.equal(formatRequest({ data: "nope" }, "raw"), "{}");
});
