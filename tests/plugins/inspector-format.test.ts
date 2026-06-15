/**
 * Black-box EDGE tests for the inspector dashboard's request-block formatter —
 * the pure function `formatRequest(data)` exported from
 * `public_plugin/inspector/page.format.ts`.
 *
 * Contract surface under test (derived ONLY from the development spec — NO
 * implementation read; the module does NOT exist yet, so until it is written
 * EVERY scenario fails on import. That red state is the intended TDD baseline):
 *
 *   export function formatRequest(data: unknown): string
 *
 *   Renders the "request ->" block of the inspector dashboard (the full prompt
 *   the orchestrator sends) from an `llm.request` payload's `data` object,
 *   shaped `{ context?: { text?: string }, messages?: Message[] }`.
 *   `Message` = { role, content, toolCallId?, name?, toolCalls? } where `content`
 *   is a string OR an array of content parts. The point is to render the
 *   CONVERSATION (`messages`), which previously was not shown.
 *
 *   Exact observable behavior:
 *     - sys = (typeof data.context.text === "string") ? data.context.text : ""
 *     - msgs = data.messages. If msgs is NOT an array, or is an empty array
 *       -> return `sys` unchanged (back-compat: no conversation => just context).
 *     - Otherwise one block per message, joined by "\n":
 *         head = String(role) or "?" if role missing/falsy.
 *         if message has a non-empty string `name` -> head = role + " (" + name + ")".
 *         body = content (if string); "" if content null/undefined; else
 *                JSON.stringify(content).
 *         line = head + ": " + body.
 *         if `toolCallId` is a string -> append "  [toolCallId=" + toolCallId + "]".
 *         if `toolCalls` is a non-empty array ->
 *            append "\n    toolCalls: " + JSON.stringify(toolCalls).
 *     - header = "— messages (" + msgs.length + ") —".
 *     - sys non-empty -> sys + "\n\n" + header + "\n" + <blocks>.
 *     - sys empty     -> header + "\n" + <blocks>.
 *
 * Tests are deterministic: exact-string `assert.equal` everywhere the output is
 * fully determined. Where the spec delegates to JSON.stringify, the expectation
 * is built with the same JSON.stringify call so the test pins behavior without
 * guessing the serializer's exact output. No DOM, no timers, no I/O.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRequest } from "../../public_plugin/inspector/page.format";

const HEADER = (n: number) => `— messages (${n}) —`;

// ---------------------------------------------------------------------------
// positive - valid inputs (equivalence partitioning over the documented cases)
// ---------------------------------------------------------------------------

test("positive: system + one user turn with name (spec case 5)", () => {
  const out = formatRequest({
    context: { text: "SYS" },
    messages: [{ role: "user", content: "hi", name: "web" }],
  });
  assert.equal(out, "SYS\n\n— messages (1) —\nuser (web): hi");
});

test("positive: no system, one user turn with name (spec case 6)", () => {
  const out = formatRequest({
    messages: [{ role: "user", content: "hi", name: "web" }],
  });
  assert.equal(out, "— messages (1) —\nuser (web): hi");
});

test("positive: assistant turn WITH toolCalls, no system (spec case 7)", () => {
  const toolCalls = [{ id: "T1", name: "notes", arguments: {} }];
  const out = formatRequest({
    messages: [{ role: "assistant", content: "", toolCalls }],
  });
  const expectedLine =
    "assistant: " + "\n    toolCalls: " + JSON.stringify(toolCalls);
  assert.equal(out, HEADER(1) + "\n" + expectedLine);
});

test("positive: tool turn with toolCallId + name, no system (spec case 8)", () => {
  const out = formatRequest({
    messages: [
      { role: "tool", content: '{"ok":true}', toolCallId: "T1", name: "notes" },
    ],
  });
  assert.equal(out, '— messages (1) —\ntool (notes): {"ok":true}  [toolCallId=T1]');
});

test("positive: assistant plain text turn, no name/toolCalls/toolCallId", () => {
  const out = formatRequest({
    context: { text: "SYS" },
    messages: [{ role: "assistant", content: "Hello there" }],
  });
  assert.equal(out, "SYS\n\n— messages (1) —\nassistant: Hello there");
});

// ---------------------------------------------------------------------------
// boundary value analysis — back-compat short-circuits & string/array edges
// ---------------------------------------------------------------------------

test("BVA: undefined -> empty string (spec case 1)", () => {
  assert.equal(formatRequest(undefined), "");
});

test("BVA: null -> empty string (spec case 1)", () => {
  assert.equal(formatRequest(null), "");
});

test("BVA: context only, no messages key -> sys unchanged (spec case 2)", () => {
  assert.equal(formatRequest({ context: { text: "SYS" } }), "SYS");
});

test("BVA: empty messages array -> sys unchanged (spec case 3)", () => {
  assert.equal(formatRequest({ context: { text: "SYS" }, messages: [] }), "SYS");
});

test("BVA: empty messages array AND no system -> empty string", () => {
  // sys is "" and msgs is empty => return sys unchanged.
  assert.equal(formatRequest({ messages: [] }), "");
});

test("BVA: single-element messages array -> header count is 1", () => {
  const out = formatRequest({ messages: [{ role: "user", content: "x" }] });
  assert.equal(out, "— messages (1) —\nuser: x");
});

test("BVA: empty-string content is still a string -> body is empty", () => {
  const out = formatRequest({ messages: [{ role: "user", content: "" }] });
  assert.equal(out, "— messages (1) —\nuser: ");
});

test("BVA: empty system string behaves like absent system", () => {
  const out = formatRequest({
    context: { text: "" },
    messages: [{ role: "user", content: "hi" }],
  });
  // sys === "" => header-only form, no leading "\n\n".
  assert.equal(out, "— messages (1) —\nuser: hi");
});

test("BVA: many-message conversation -> header count matches length", () => {
  const messages = Array.from({ length: 5 }, (_v, i) => ({
    role: "user",
    content: `m${i}`,
  }));
  const out = formatRequest({ messages });
  const blocks = ["user: m0", "user: m1", "user: m2", "user: m3", "user: m4"].join("\n");
  assert.equal(out, "— messages (5) —\n" + blocks);
});

// ---------------------------------------------------------------------------
// content typing — string vs array vs null/undefined vs non-string scalars
// ---------------------------------------------------------------------------

test("content: array of parts -> body is JSON.stringify(content) (spec case 9)", () => {
  const content = [
    { type: "text", text: "hello" },
    { type: "image", url: "http://x/y.png" },
  ];
  const out = formatRequest({ messages: [{ role: "user", content }] });
  assert.equal(out, "— messages (1) —\nuser: " + JSON.stringify(content));
});

test("content: null content -> body is empty string", () => {
  const out = formatRequest({ messages: [{ role: "assistant", content: null }] });
  assert.equal(out, "— messages (1) —\nassistant: ");
});

test("content: missing content (undefined) -> body is empty string", () => {
  const out = formatRequest({ messages: [{ role: "assistant" }] });
  assert.equal(out, "— messages (1) —\nassistant: ");
});

test("content: numeric content (non-string, non-null) -> JSON.stringify", () => {
  const out = formatRequest({ messages: [{ role: "user", content: 42 }] });
  assert.equal(out, "— messages (1) —\nuser: " + JSON.stringify(42)); // "42"
});

test("content: object content -> JSON.stringify", () => {
  const content = { foo: "bar", n: 1 };
  const out = formatRequest({ messages: [{ role: "tool", content }] });
  assert.equal(out, "— messages (1) —\ntool: " + JSON.stringify(content));
});

// ---------------------------------------------------------------------------
// head construction — role + optional name
// ---------------------------------------------------------------------------

test("head: missing role -> '?' (spec case 10)", () => {
  const out = formatRequest({ messages: [{ content: "x" }] });
  assert.equal(out, "— messages (1) —\n?: x");
});

test("head: empty-string role is falsy -> '?'", () => {
  const out = formatRequest({ messages: [{ role: "", content: "x" }] });
  assert.equal(out, "— messages (1) —\n?: x");
});

test("head: empty-string name is NOT appended (non-empty rule)", () => {
  const out = formatRequest({ messages: [{ role: "user", content: "x", name: "" }] });
  assert.equal(out, "— messages (1) —\nuser: x");
});

test("head: name present -> 'role (name)'", () => {
  const out = formatRequest({
    messages: [{ role: "user", content: "hi", name: "alice" }],
  });
  assert.equal(out, "— messages (1) —\nuser (alice): hi");
});

test("head: missing role but present name -> '? (name)'", () => {
  // role falsy => head "?"; non-empty string name still wraps it.
  const out = formatRequest({ messages: [{ content: "x", name: "web" }] });
  assert.equal(out, "— messages (1) —\n? (web): x");
});

// ---------------------------------------------------------------------------
// toolCallId / toolCalls suffix rules (negative-shaped: present vs absent/wrong type)
// ---------------------------------------------------------------------------

test("toolCallId: non-string toolCallId is NOT appended", () => {
  // toolCallId must be a string to trigger the suffix; a number is ignored.
  const out = formatRequest({
    messages: [{ role: "tool", content: "ok", toolCallId: 123 }],
  });
  assert.equal(out, "— messages (1) —\ntool: ok");
});

test("toolCalls: empty toolCalls array is NOT appended", () => {
  const out = formatRequest({
    messages: [{ role: "assistant", content: "done", toolCalls: [] }],
  });
  assert.equal(out, "— messages (1) —\nassistant: done");
});

test("toolCalls: non-array toolCalls is NOT appended", () => {
  const out = formatRequest({
    messages: [{ role: "assistant", content: "done", toolCalls: "nope" }],
  });
  assert.equal(out, "— messages (1) —\nassistant: done");
});

test("suffix order: toolCallId then toolCalls both append on one line", () => {
  // toolCallId suffix is appended to `line` first; toolCalls block second.
  const toolCalls = [{ id: "T9", name: "notes", arguments: { a: 1 } }];
  const out = formatRequest({
    messages: [
      { role: "assistant", content: "c", toolCallId: "T9", toolCalls },
    ],
  });
  const expectedLine =
    "assistant: c" +
    "  [toolCallId=T9]" +
    "\n    toolCalls: " +
    JSON.stringify(toolCalls);
  assert.equal(out, HEADER(1) + "\n" + expectedLine);
});

// ---------------------------------------------------------------------------
// negative - messages not an array => return sys unchanged (spec case 4)
// ---------------------------------------------------------------------------

test("negative: messages is a string, no system -> '' (spec case 4)", () => {
  assert.equal(formatRequest({ messages: "nope" }), "");
});

test("negative: messages is a string, with system -> sys unchanged (spec case 4)", () => {
  assert.equal(formatRequest({ context: { text: "S" }, messages: "x" }), "S");
});

test("negative: messages is an object (not array) -> sys unchanged", () => {
  assert.equal(formatRequest({ context: { text: "S" }, messages: { 0: "a" } }), "S");
});

test("negative: messages is a number -> sys unchanged", () => {
  assert.equal(formatRequest({ context: { text: "S" }, messages: 7 }), "S");
});

test("negative: messages is null -> sys unchanged", () => {
  assert.equal(formatRequest({ context: { text: "S" }, messages: null }), "S");
});

// ---------------------------------------------------------------------------
// negative / robustness - context typing
// ---------------------------------------------------------------------------

test("negative: non-string context.text -> sys is '' (number)", () => {
  // typeof text !== "string" => sys "". With no messages, result is "".
  assert.equal(formatRequest({ context: { text: 5 } }), "");
});

test("negative: non-string context.text but valid messages -> header-only form", () => {
  const out = formatRequest({
    context: { text: 5 },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out, "— messages (1) —\nuser: hi");
});

test("negative: context present without text -> sys '' (with messages, header-only)", () => {
  const out = formatRequest({
    context: {},
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out, "— messages (1) —\nuser: hi");
});

// ---------------------------------------------------------------------------
// integration of rules - a full multi-turn conversation (spec case 11)
// ---------------------------------------------------------------------------

test("multi-turn: user, assistant(+toolCalls), tool joined by '\\n' in order (spec case 11)", () => {
  const toolCalls = [{ id: "T1", name: "notes", arguments: { q: "x" } }];
  const out = formatRequest({
    context: { text: "SYS" },
    messages: [
      { role: "user", content: "do it", name: "web" },
      { role: "assistant", content: "", toolCalls },
      { role: "tool", content: '{"ok":true}', toolCallId: "T1", name: "notes" },
    ],
  });

  const userBlock = "user (web): do it";
  const assistantBlock = "assistant: " + "\n    toolCalls: " + JSON.stringify(toolCalls);
  const toolBlock = 'tool (notes): {"ok":true}  [toolCallId=T1]';
  const blocks = [userBlock, assistantBlock, toolBlock].join("\n");

  assert.equal(out, "SYS\n\n— messages (3) —\n" + blocks);
});

test("multi-turn: same conversation WITHOUT system -> header-only prefix", () => {
  const toolCalls = [{ id: "T1", name: "notes", arguments: { q: "x" } }];
  const out = formatRequest({
    messages: [
      { role: "user", content: "do it", name: "web" },
      { role: "assistant", content: "", toolCalls },
      { role: "tool", content: '{"ok":true}', toolCallId: "T1", name: "notes" },
    ],
  });

  const blocks = [
    "user (web): do it",
    "assistant: " + "\n    toolCalls: " + JSON.stringify(toolCalls),
    'tool (notes): {"ok":true}  [toolCallId=T1]',
  ].join("\n");

  assert.equal(out, "— messages (3) —\n" + blocks);
});
