/**
 * cli — the pure argv parser. Maps `process.argv.slice(2)` to a discriminated
 * command for bin.ts to act on. NO process / fs / spawn — a pure function of its
 * argv array, so it is unit-testable in isolation. bin.ts is the only place that
 * reads process.* and turns these commands into I/O.
 *
 * Recognition is case-sensitive with no trimming/normalization, so "Start",
 * "HELP", "-V" and "  start" are all `unknown`. The empty argv array (length 0)
 * is setup/landing, but `[""]` (argv[0] is the empty string) is unknown — hence
 * the length check happens BEFORE switching on argv[0].
 */
export type ParsedCommand =
  | { kind: "setup"; page: "landing" | "agents" | "default" | "providers" }
  | { kind: "start" }
  | { kind: "dashboard"; port: string | undefined }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; token: string };

/** Parse process.argv.slice(2) into a discriminated command. Pure. */
export function parseCommand(argv: string[]): ParsedCommand {
  if (argv.length === 0) return { kind: "setup", page: "landing" };

  const token = argv[0];
  switch (token) {
    case "setup":
      return { kind: "setup", page: "landing" };
    case "agent":
      return { kind: "setup", page: "agents" };
    case "default":
      return { kind: "setup", page: "default" };
    case "providers":
      return { kind: "setup", page: "providers" };
    case "start":
      return { kind: "start" };
    case "dashboard":
      return { kind: "dashboard", port: argv[1] };
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "version":
    case "--version":
    case "-v":
      return { kind: "version" };
    default:
      return { kind: "unknown", token };
  }
}
