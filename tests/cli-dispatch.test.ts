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
 * These tests NEVER exercise the destructive/lifecycle bin behaviors (run, start,
 * stop, dashboard, uninstall, update) — they only assert how those verbs PARSE.
 *
 * Contract (the full behavior table — argv[0] is the verb):
 *   []                        -> { kind:"help" }                         // bare → help (CHANGED)
 *   ["help"]|["--help"]|["-h"]   -> { kind:"help" }
 *   ["setup"]                 -> { kind:"setup",     page:"landing" }
 *   ["agent"]                 -> { kind:"setup",     page:"agents" }     // verb "agent" -> page "agents"
 *   ["default"]               -> { kind:"setup",     page:"default" }
 *   ["providers"]             -> { kind:"setup",     page:"providers" }
 *   ["run"]                   -> { kind:"run" }
 *   ["start"]                 -> { kind:"start" }
 *   ["stop"]                  -> { kind:"stop" }
 *   ["dashboard"]             -> { kind:"dashboard", port:undefined }
 *   ["dashboard","7716"]      -> { kind:"dashboard", port:"7716" }       // raw string, NO numeric validation
 *   ["uninstall"]             -> { kind:"uninstall", yes:false }
 *   ["uninstall","--yes"]     -> { kind:"uninstall", yes:true }          // --yes / -y anywhere → yes:true
 *   ["update"]                -> { kind:"update" }
 *   ["version"]|["--version"]|["-v"] -> { kind:"version" }
 *   [<anything else>]         -> { kind:"unknown",   token:<that arg0> }
 *
 * Sections below are grouped by technique:
 *   1. Positive / equivalence partitioning — one assertion per recognized command.
 *   2. Boundary / alias equivalence — all aliases of help/version collapse; agent->agents.
 *   3. State / argument handling — dashboard's raw port; uninstall's --yes/-y; trailing args ignored.
 *   4. Error guessing / negative — unknown tokens; case-sensitivity; empty-string arg0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, type ParsedCommand } from "../packages/cli/src/dispatcher";

// ===========================================================================
// 1. Positive / equivalence partitioning — every recognized command shape, once.
//    Each recognized "verb" is its own equivalence class; empty argv is the
//    implicit-help class. Full-object deepStrictEqual pins kind + payload.
// ===========================================================================

test("positive: empty argv -> help (the bare-command landing, CHANGED from setup)", () => {
  const expected: ParsedCommand = { kind: "help" };
  assert.deepStrictEqual(parseCommand([]), expected);
});

test('positive: ["help"] -> help (no payload)', () => {
  const expected: ParsedCommand = { kind: "help" };
  assert.deepStrictEqual(parseCommand(["help"]), expected);
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

test('positive: ["run"] -> run (no payload)', () => {
  const expected: ParsedCommand = { kind: "run" };
  assert.deepStrictEqual(parseCommand(["run"]), expected);
});

test('positive: ["start"] -> start (no payload)', () => {
  const expected: ParsedCommand = { kind: "start" };
  assert.deepStrictEqual(parseCommand(["start"]), expected);
});

test('positive: ["stop"] -> stop (no payload)', () => {
  const expected: ParsedCommand = { kind: "stop" };
  assert.deepStrictEqual(parseCommand(["stop"]), expected);
});

test('positive: ["dashboard"] (no port) -> dashboard with port:undefined', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: undefined };
  assert.deepStrictEqual(parseCommand(["dashboard"]), expected);
});

test('positive: ["uninstall"] (no flag) -> uninstall with yes:false', () => {
  const expected: ParsedCommand = { kind: "uninstall", yes: false };
  assert.deepStrictEqual(parseCommand(["uninstall"]), expected);
});

test('positive: ["update"] -> update (no payload)', () => {
  const expected: ParsedCommand = { kind: "update" };
  assert.deepStrictEqual(parseCommand(["update"]), expected);
});

test('positive: ["version"] -> version (no payload)', () => {
  const expected: ParsedCommand = { kind: "version" };
  assert.deepStrictEqual(parseCommand(["version"]), expected);
});

// ===========================================================================
// 2. Boundary / alias equivalence — every alias of a verb must collapse to the
//    SAME result. These are the easy-to-drift rows (flag spellings + the
//    deliberately-irregular agent->agents mapping + bare-argv == help).
// ===========================================================================

// --- help: long-word, GNU long-flag, short-flag, AND the bare command all mean help ---

test('alias: ["--help"] -> help', () => {
  assert.deepStrictEqual(parseCommand(["--help"]), { kind: "help" } as ParsedCommand);
});

test('alias: ["-h"] -> help', () => {
  assert.deepStrictEqual(parseCommand(["-h"]), { kind: "help" } as ParsedCommand);
});

test("alias: help === --help === -h === [] (all produce an identical help object)", () => {
  const a = parseCommand(["help"]);
  const b = parseCommand(["--help"]);
  const c = parseCommand(["-h"]);
  const d = parseCommand([]);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
  assert.deepStrictEqual(c, d);
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

// ===========================================================================
// 3. State / argument handling — argv handling for `dashboard` (raw port) and
//    `uninstall` (--yes / -y flag), plus the rule that any args BEYOND the ones
//    a verb reads are silently ignored (never an error, never changes the kind).
// ===========================================================================

// --- dashboard reads argv[1] as a RAW string with no numeric validation ---

test('arg: ["dashboard","7716"] -> dashboard with the raw port string "7716"', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: "7716" };
  assert.deepStrictEqual(parseCommand(["dashboard", "7716"]), expected);
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

test('arg: ["dashboard","7716","extra"] -> trailing arg ignored beyond port, port stays "7716"', () => {
  const expected: ParsedCommand = { kind: "dashboard", port: "7716" };
  assert.deepStrictEqual(parseCommand(["dashboard", "7716", "extra"]), expected);
});

// --- uninstall reads --yes / -y as a confirmation pre-answer (anywhere in argv) ---

test('arg: ["uninstall","--yes"] -> uninstall with yes:true', () => {
  const expected: ParsedCommand = { kind: "uninstall", yes: true };
  assert.deepStrictEqual(parseCommand(["uninstall", "--yes"]), expected);
});

test('arg: ["uninstall","-y"] -> uninstall with yes:true (short flag)', () => {
  const expected: ParsedCommand = { kind: "uninstall", yes: true };
  assert.deepStrictEqual(parseCommand(["uninstall", "-y"]), expected);
});

test('arg: ["uninstall","junk"] -> uninstall stays yes:false (only --yes/-y flip it)', () => {
  const expected: ParsedCommand = { kind: "uninstall", yes: false };
  assert.deepStrictEqual(parseCommand(["uninstall", "junk"]), expected);
});

test('arg: ["uninstall","junk","--yes"] -> --yes is recognized anywhere in argv', () => {
  const expected: ParsedCommand = { kind: "uninstall", yes: true };
  assert.deepStrictEqual(parseCommand(["uninstall", "junk", "--yes"]), expected);
});

// --- trailing extra args are silently ignored across the payload-free verbs ---

test('arg: ["run","x","y"] -> trailing args ignored, still plain run', () => {
  const expected: ParsedCommand = { kind: "run" };
  assert.deepStrictEqual(parseCommand(["run", "x", "y"]), expected);
});

test('arg: ["start","x","y"] -> trailing args ignored, still plain start', () => {
  const expected: ParsedCommand = { kind: "start" };
  assert.deepStrictEqual(parseCommand(["start", "x", "y"]), expected);
});

test('arg: ["stop","x","y"] -> trailing args ignored, still plain stop', () => {
  const expected: ParsedCommand = { kind: "stop" };
  assert.deepStrictEqual(parseCommand(["stop", "x", "y"]), expected);
});

test('arg: ["update","x","y"] -> trailing args ignored, still plain update', () => {
  const expected: ParsedCommand = { kind: "update" };
  assert.deepStrictEqual(parseCommand(["update", "x", "y"]), expected);
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

test('negative: ["frobnicate"] -> unknown with token "frobnicate" (exact arg0 echoed back)', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "frobnicate" };
  assert.deepStrictEqual(parseCommand(["frobnicate"]), expected);
});

test('negative: ["Start"] -> unknown — recognition is CASE-SENSITIVE, so it is NOT start', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "Start" };
  assert.deepStrictEqual(parseCommand(["Start"]), expected);
});

test('negative: ["HELP"] -> unknown — uppercased alias is NOT help (case-sensitive)', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "HELP" };
  assert.deepStrictEqual(parseCommand(["HELP"]), expected);
});

test('negative: ["STOP"] -> unknown — uppercased verb is NOT stop (case-sensitive)', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "STOP" };
  assert.deepStrictEqual(parseCommand(["STOP"]), expected);
});

test('negative: ["-V"] -> unknown — short flags are case-sensitive ("-V" != "-v")', () => {
  const expected: ParsedCommand = { kind: "unknown", token: "-V" };
  assert.deepStrictEqual(parseCommand(["-V"]), expected);
});

test('negative: [""] -> unknown with token "" (arg0 is PRESENT but matches no verb)', () => {
  // The empty argv (length 0) is help; an argv whose first element is the empty
  // string is a present-but-unrecognized token, hence unknown with token "".
  const expected: ParsedCommand = { kind: "unknown", token: "" };
  assert.deepStrictEqual(parseCommand([""]), expected);
});

test('negative: empty argv ([]) and [""] are DISTINCT — help vs unknown', () => {
  // Guards the off-by-one between "no token at all" and "an empty-string token".
  assert.deepStrictEqual(parseCommand([]), { kind: "help" } as ParsedCommand);
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
