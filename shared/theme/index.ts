/**
 * Shared: theme — the Krakey brand primitives every console surface shares
 * (the cli's prompts, boot's startup report): the brand color, the star glyph,
 * text painters, and the ✔/✖ verdict lines. Pure text-in/text-out.
 *
 * Everything degrades to PLAIN text (glyphs stay, ANSI codes go) when stdout
 * is not a TTY or NO_COLOR is set, so piped/CI output stays clean.
 */
const useColor =
  process.env.NO_COLOR === undefined && process.stdout?.isTTY === true;

const wrap = (code: string) => (text: string) =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

/** Brand mint #2FD69C — the same tone the logo gradient passes through. */
export const mint = wrap("38;2;47;214;156");
export const dim = wrap("2");
export const bold = wrap("1");
/** Soft red — destructive actions and failures. */
export const red = wrap("38;2;255;107;107");
export const mintBold = (text: string): string => mint(bold(text));

/** The brand glyph — a simple star, no emoji. */
export const STAR = "✦";

/** A confirmation line: mint check + message. */
export const success = (msg: string): string => mint("✔ ") + msg;

/** A failure line: soft-red cross + message. */
export const failure = (msg: string): string => red("✖ " + msg);
