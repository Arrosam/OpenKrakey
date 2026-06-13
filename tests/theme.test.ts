/**
 * Black-box tests for shared/theme — the Krakey brand primitives shared by the
 * CLI prompts and boot's startup report: the STAR glyph, the color painters
 * (mint / dim / bold / red), and the verdict line builders (success / failure).
 *
 * Pinned behavior: in a NON-TTY process (node:test runs each file with piped
 * stdout, so this runner is one) every painter degrades to PLAIN text — no ANSI
 * escapes — keeping piped/CI output clean. The glyphs themselves remain.
 *
 * Resolved defensively: a missing module/export turns RED on an assertion,
 * never an import crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const theme: any = await import("../shared/theme").catch(() => ({}));

test("shared/theme: exports the brand glyph STAR = '✦'", () => {
  assert.equal(theme.STAR, "✦", "shared/theme.STAR not implemented yet");
});

test("shared/theme: mint/dim/bold/red are painters that pass text through (plain in non-TTY)", () => {
  for (const name of ["mint", "dim", "bold", "red"] as const) {
    assert.equal(typeof theme[name], "function", `shared/theme.${name} not implemented yet`);
    assert.equal(
      theme[name]("payload-text"),
      "payload-text",
      `${name} must degrade to the plain text when stdout is not a TTY`,
    );
  }
});

test("shared/theme: success(msg) carries the check glyph and the message", () => {
  assert.equal(typeof theme.success, "function", "shared/theme.success not implemented yet");
  const line = theme.success("saved");
  assert.ok(line.includes("✔"), "success carries the check glyph: " + line);
  assert.ok(line.includes("saved"), "success carries the message: " + line);
});

test("shared/theme: failure(msg) carries the cross glyph and the message", () => {
  assert.equal(typeof theme.failure, "function", "shared/theme.failure not implemented yet");
  const line = theme.failure("broke");
  assert.ok(line.includes("✖"), "failure carries the cross glyph: " + line);
  assert.ok(line.includes("broke"), "failure carries the message: " + line);
});

test("shared/theme: the cli theme re-exports the SAME primitives (single source of truth)", async () => {
  const cliTheme: any = await import("../packages/cli/src/theme").catch(() => ({}));
  for (const name of ["STAR", "mint", "dim", "bold", "red"] as const) {
    assert.equal(
      cliTheme[name],
      theme[name],
      `cli theme.${name} must be the shared/theme binding itself (no divergent copy)`,
    );
  }
});
