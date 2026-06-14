/**
 * Black-box tests for shared/http-auth — the session-token primitives shared by
 * the loopback HTTP plugins (web, inspector). These pin the two behavioural knobs
 * that differ per plugin (`openWhenUnset`, `decode`) plus the security-critical
 * fail-closed paths, so the shared module can never silently change either
 * plugin's auth policy.
 *
 * Resolved defensively: a missing module/export turns RED on an assertion, never
 * an import crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const auth: any = await import("../shared/http-auth").catch(() => ({}));

/** Minimal IncomingMessage stand-in: the extractors only read `.headers`. */
function req(headers: Record<string, string>): any {
  return { headers };
}

test("tokenOk: equal tokens compare true", () => {
  assert.equal(typeof auth.tokenOk, "function", "http-auth.tokenOk not implemented yet");
  assert.equal(auth.tokenOk("s3cr3t-token-value", "s3cr3t-token-value"), true);
});

test("tokenOk: same-length mismatch is false (constant-time path)", () => {
  assert.equal(auth.tokenOk("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"), false);
});

test("tokenOk: length mismatch and non-string provided fail closed", () => {
  assert.equal(auth.tokenOk("short", "a-much-longer-token"), false);
  assert.equal(auth.tokenOk(undefined, "expected"), false);
});

test("tokenOk: unset expected honours openWhenUnset (web open / inspector closed)", () => {
  // web passes openWhenUnset:true → open when no token configured
  assert.equal(auth.tokenOk(undefined, "", { openWhenUnset: true }), true);
  assert.equal(auth.tokenOk("anything", "", { openWhenUnset: true }), true);
  // inspector passes nothing → closed when no token configured
  assert.equal(auth.tokenOk("anything", ""), false);
  assert.equal(auth.tokenOk("anything", "", { openWhenUnset: false }), false);
});

test("bearerToken: extracts a Bearer header, else undefined", () => {
  assert.equal(auth.bearerToken(req({ authorization: "Bearer abc123" })), "abc123");
  assert.equal(auth.bearerToken(req({ authorization: "Basic abc123" })), undefined);
  assert.equal(auth.bearerToken(req({})), undefined);
});

test("queryToken: reads ?token=", () => {
  assert.equal(auth.queryToken(new URLSearchParams("token=xyz&a=1")), "xyz");
  assert.equal(auth.queryToken(new URLSearchParams("a=1")), undefined);
});

test("cookieToken: picks the named cookie (decoded by default)", () => {
  const r = req({ cookie: "other=1; krakey_token=ab%20cd; z=2" });
  assert.equal(auth.cookieToken(r, "krakey_token"), "ab cd"); // %20 decoded
  assert.equal(auth.cookieToken(r, "missing"), undefined);
});

test("cookieToken: decode:false reads the value verbatim (web's raw cookie)", () => {
  const r = req({ cookie: "krakey_token=ab%20cd" });
  assert.equal(auth.cookieToken(r, "krakey_token", { decode: false }), "ab%20cd");
});

test("cookieToken: malformed %-escape fails closed when decoding (no crash)", () => {
  const r = req({ cookie: "inspector_token=%E0%A4%A" }); // truncated escape
  assert.equal(auth.cookieToken(r, "inspector_token"), undefined);
  // but verbatim read still returns the raw bytes without throwing
  assert.equal(auth.cookieToken(r, "inspector_token", { decode: false }), "%E0%A4%A");
});

test("cookieToken: no cookie header → undefined", () => {
  assert.equal(auth.cookieToken(req({}), "krakey_token"), undefined);
});
