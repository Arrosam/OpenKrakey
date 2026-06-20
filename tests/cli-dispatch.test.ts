/**
 * Black-box edge tests for the `cli` node's PURE argv parser (`parseCommand`).
 *
 * Scope: ONLY the side-effect-free dispatcher exported from
 * `packages/cli/src/dispatcher.ts`. `parseCommand` receives `process.argv.slice(2)`
 * (i.e. the user-supplied tokens only) and maps it to a discriminated
 * `ParsedCommand`. It performs NO I/O, NO spawning, and NO process access — it is a
 * pure function of its argv array, so every case here is a single `deepStrictEqual`
 * against the FULL expected object (pinning the discriminant + payload together).
 *
 * Contract (the full behavior table — argv[0] is the verb; for `dashboard`,
 * argv[1] is the RAW port string; any further trailing args are SILENTLY IGNORED):
 *   []                    -> { kind:"setup",     page:"landing" }
 *   ["setup"]             -> { kind:"setup",     page:"landing" }
 *   ["agent"]             -> { kind:"setup",     page:"agents" }     // verb "agent" -> page "agents"
 *   ["default"]           -> { kind:"setup",     page:"default" }
 *   ["providers"]         -> { kind:"setup",     page:"providers" }
 *   ["start"]             -> { kind:"start" }
 *   ["dashboard"]         -> { kind:"dashboard", port:undefined }
 *   ["dashboard","7700"]  -> { kind:"dashboard", port:"7700" }       // raw string, NO numeric validation
 *   ["dashboard","oops"]  -> { kind:"dashboard", port:"oops" }       // still raw
 *   ["help"]|["--help"]|["-h"]       -> { kind:"help" }
 *   ["version"]|["--version"]|["-v"] -> { kind:"version" }
 *   [<anything else>]     -> { kind:"unknown",   token:<that arg0> }
 *
 * This is TEST-FIRST: the implementation does not exist yet, so this whole file is
 * EXPECTED to be red (the import resolves to nothing) until `parseCommand` lands.
 * That is the intended state — the tests define the acceptance criteria.
 *
 * Sections below are grouped by technique:
 *   1. Positive / equivalence partitioning — one assertion per recognized command.
 *   2. Boundary / alias equivalence — all aliases of help/version collapse; agent->agents.
 *   3. State / argument handling — dashboard's raw port; trailing extra args ignored.
 *   4. Error guessing / negative — unknown tokens; case-sensitivity; empty-string arg0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, type ParsedCommand } from "../packages/cli/src/dispatcher";

// ===========================================================================
// 1. Positive / equivalence partitioning — every recognized command shape, once.
//    Each recognized "verb" is its own equivalence class; empty argv is the
//    implicit-setup class. Full-object deepStrictEqual pins kind + payload.
// ===========================================================================

test("positive: empty argv -> setup/landing (the implicit default page)", () => {
  const expected: ParsedCommand = { kind: "setup", page: "landing" };
  assert.deepStrictEqual(parseCommand([]), expected);
});

test('positive: ["setup"] -> setup/landing', () => {
  const expected: ParsedCommand = { kind: "setup", page: "landing" };
  assert.deepStrictEqual(parseCommand(["setup"]), expected);
});

test('positive: ["agent"] -> setup/agents (verb singular, page plural)', () => {
  const expected: ParsedCommand = { kind: "setup", page: "agents" };
  assert.deepStrictEqual(parseCommand(["agent"]), expected);
});

test('positive: ["default"] -> setup/default', () => {
  const expected: ParsedCommand = { kind: "setup", page: "default" };
  assert.deepStrictEqual(parseCommand(["default"]), expected);
});

test('positive: ["providers"] -> setup/providers', () => {
  const expected: ParsedCommand = { kind: "setup", page: "providers" };
  assert.deepStrictEqual(parseCommand(["providers"]), expected);
});

test('positive: ["start"] -> start (no payload)', () => {
  const expected: ParsedCommand = { kind: "start" };
  assert.deepStrictEqual(parseCommand(["start"]), expected);
});

test('positive: ["dashboard"] (no port) -> dashboard with port:undefined', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: undefined };
  assert.deepStrictEqual(parseCommand(["dashboard"]), expected);
});

test('positive: ["help"] -> help (no payload)', () => {
  const expected: ParsedCommand = { kind: "help" };
  assert.deepStrictEqual(parseCommand(["help"]), expected);
});

test('positive: ["version"] -> version (no payload)', () => {
  const expected: ParsedCommand = { kind: "version" };
  assert.deepStrictEqual(parseCommand(["version"]), expected);
});

// ===========================================================================
// 2. Boundary / alias equivalence — every alias of a verb must collapse to the
//    SAME result. These are the easy-to-drift rows (flag spellings + the
//    deliberately-irregular agent->agents mapping).
// ===========================================================================

// --- help: long-word, GNU long-flag, and short-flag all mean help ---

test('alias: ["--help"] -> help', () => {
  assert.deepStrictEqual(parseCommand(["--help"]), { kind: "help" } as ParsedCommand);
});

test('alias: ["-h"] -> help', () => {
  assert.deepStrictEqual(parseCommand(["-h"]), { kind: "help" } as ParsedCommand);
});

test("alias: help === --help === -h (all three produce an identical object)", () => {
  const a = parseCommand(["help"]);
  const b = parseCommand(["--help"]);
  const c = parseCommand(["-h"]);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
  assert.deepStrictEqual(a, { kind: "help" } as ParsedCommand);
});

// --- version: long-word, GNU long-flag, and short-flag all mean version ---

test('alias: ["--version"] -> version', () => {
  assert.deepStrictEqual(parseCommand(["--version"]), { kind: "version" } as ParsedCommand);
});

test('alias: ["-v"] -> version', () => {
  assert.deepStrictEqual(parseCommand(["-v"]), { kind: "version" } as ParsedCommand);
});

test("alias: version === --version === -v (all three produce an identical object)", () => {
  const a = parseCommand(["version"]);
  const b = parseCommand(["--version"]);
  const c = parseCommand(["-v"]);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
  assert.deepStrictEqual(a, { kind: "version" } as ParsedCommand);
});

// --- the irregular mapping, pinned on its own (verb "agent" -> page "agents") ---

test('alias: verb "agent" maps to page "agents" (NOT "agent")', () => {
  const got = parseCommand(["agent"]);
  assert.deepStrictEqual(got, { kind: "setup", page: "agents" } as ParsedCommand);
  // Belt-and-suspenders: prove the page is the plural form specifically.
  assert.strictEqual((got as { page: string }).page, "agents");
});

// --- the empty-vs-explicit-setup boundary: both land on the SAME landing page ---

test('alias: [] and ["setup"] both resolve to setup/landing (identical objects)', () => {
  assert.deepStrictEqual(parseCommand([]), parseCommand(["setup"]));
  assert.deepStrictEqual(parseCommand([]), { kind: "setup", page: "landing" } as ParsedCommand);
});

// ===========================================================================
// 3. State / argument handling — argv[1] handling for `dashboard`, plus the rule
//    that any args BEYOND the ones a verb reads are silently ignored (never an
//    error, never changes the result).
// ===========================================================================

// --- dashboard reads argv[1] as a RAW string with no numeric validation ---

test('arg: ["dashboard","7700"] -> dashboard with the raw port string "7700"', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: "7700" };
  assert.deepStrictEqual(parseCommand(["dashboard", "7700"]), expected);
});

test('arg: ["dashboard","oops"] -> dashboard passes a NON-numeric port through raw (no validation)', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: "oops" };
  assert.deepStrictEqual(parseCommand(["dashboard", "oops"]), expected);
});

test('arg: ["dashboard","0"] -> dashboard keeps "0" as a raw string (not coerced to a number/falsey)', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: "0" };
  assert.deepStrictEqual(parseCommand(["dashboard", "0"]), expected);
});

test('arg: ["dashboard",""] -> an EMPTY-string argv[1] is still passed through as port ""', () => {
  // argv[1] is present (the empty string), so it is the raw port — distinct from
  // the absent case which yields undefined.
  const expected: ParsedCommand = { kind: "dashboard", port: "" };
  assert.deepStrictEqual(parseCommand(["dashboard", ""]), expected);
});

// --- trailing extra args are silently ignored across verbs ---

test('arg: ["dashboard","7700","extra"] -> trailing arg ignored, port stays "7700"', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: "7700" };
  assert.deepStrictEqual(parseCommand(["dashboard", "7700", "extra"]), expected);
});

test('arg: ["start","x","y"] -> trailing args ignored, still plain start', () => {
  const expected: ParsedCommand = { kind: "start" };
  assert.deepStrictEqual(parseCommand(["start", "x", "y"]), expected);
});

test('arg: ["agent","junk"] -> trailing arg ignored, still setup/agents', () => {
  const expected: ParsedCommand = { kind: "setup", page: "agents" };
  assert.deepStrictEqual(parseCommand(["agent", "junk"]), expected);
});

test('arg: ["setup","junk"] -> trailing arg ignored, still setup/landing', () => {
  const expected: ParsedCommand = { kind: "setup", page: "landing" };
  assert.deepStrictEqual(parseCommand(["setup", "junk"]), expected);
});

test('arg: ["help","--version"] -> only argv[0] is examined, so this is help (not version)', () => {
  // Pins "examine argv[0] only": a later token that looks like another verb must
  // not change the dispatch.
  const expected: ParsedCommand = { kind: "help" };
  assert.deepStrictEqual(parseCommand(["help", "--version"]), expected);
});

// ===========================================================================
// 4. Error guessing / negative — anything that is not a recognized argv[0] verb
//    becomes { kind:"unknown", token:<exact arg0> }. Recognition is
//    CASE-SENSITIVE, and an empty-string arg0 is a present-but-unmatched token.
// ===========================================================================

test('negative: ["stop"] -> unknown with token "stop" (exact arg0 echoed back)', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "stop" };
  assert.deepStrictEqual(parseCommand(["stop"]), expected);
});

test('negative: ["STOP"] -> unknown with token "STOP" (a different distinct unknown)', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "STOP" };
  assert.deepStrictEqual(parseCommand(["STOP"]), expected);
});

test('negative: ["Start"] -> unknown — recognition is CASE-SENSITIVE, so it is NOT start', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "Start" };
  assert.deepStrictEqual(parseCommand(["Start"]), expected);
});

test('negative: ["HELP"] -> unknown — uppercased alias is NOT help (case-sensitive)', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "HELP" };
  assert.deepStrictEqual(parseCommand(["HELP"]), expected);
});

test('negative: ["-V"] -> unknown — short flags are case-sensitive ("-V" != "-v")', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "-V" };
  assert.deepStrictEqual(parseCommand(["-V"]), expected);
});

test('negative: [""] -> unknown with token "" (arg0 is PRESENT but matches no verb)', () => {
  // The empty argv (length 0) is setup/landing; an argv whose first element is the
  // empty string is a present-but-unrecognized token, hence unknown with token "".
  const expected: ParsedCommand = { kind: "unknown", token: "" };
  assert.deepStrictEqual(parseCommand([""]), expected);
});

test('negative: empty argv ([]) and [""] are DISTINCT — landing vs unknown', () => {
  // Guards the off-by-one between "no token at all" and "an empty-string token".
  assert.deepStrictEqual(parseCommand([]), { kind: "setup", page: "landing" } as ParsedCommand);
  assert.deepStrictEqual(parseCommand([""]), { kind: "unknown", token: "" } as ParsedCommand);
  assert.notDeepStrictEqual(parseCommand([]), parseCommand([""]));
});

test('negative: unknown token echoes arg0 VERBATIM, ignoring trailing args', () => {
  // "examine argv[0] only" holds on the unknown path too: token is exactly arg0.
  const expected: ParsedCommand = { kind: "unknown", token: "frobnicate" };
  assert.deepStrictEqual(parseCommand(["frobnicate", "deploy", "now"]), expected);
});

test('negative: a leading-space token "  start" -> unknown (no trimming/normalization)', () => {
  // The parser does not trim verbs; whitespace makes it a distinct unknown token.
  const expected: ParsedCommand = { kind: "unknown", token: "  start" };
  assert.deepStrictEqual(parseCommand(["  start"]), expected);
});
