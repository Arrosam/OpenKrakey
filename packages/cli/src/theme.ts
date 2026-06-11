/**
 * cli — the Krakey look. One place for the brand color (#2FD69C, the logo
 * mint), the star glyph, text painters, and pre-themed @inquirer/prompts
 * wrappers so every prompt in the shell renders on-brand: a mint ✦ prefix,
 * mint highlight on the active choice, mint answers.
 *
 * Pages import { select, input, … } from HERE instead of "@inquirer/prompts";
 * the wrappers keep the exact upstream signatures and only inject `theme`.
 * Everything degrades to plain text when stdout is not a TTY or NO_COLOR is
 * set (same rule as the logo).
 */
import {
  checkbox as iCheckbox,
  confirm as iConfirm,
  input as iInput,
  password as iPassword,
  select as iSelect,
} from "@inquirer/prompts";

const useColor =
  process.env.NO_COLOR === undefined && process.stdout?.isTTY === true;

const wrap = (code: string) => (text: string) =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

/** Brand mint #2FD69C — the same tone the logo gradient passes through. */
export const mint = wrap("38;2;47;214;156");
export const dim = wrap("2");
export const bold = wrap("1");
const redText = wrap("38;2;255;107;107");
const mintBold = (text: string) => mint(bold(text));

/** The brand glyph — a simple star, no emoji. */
export const STAR = "✦";

/** A section heading: mint star + bold title, dim one-line subtitle below. */
export const heading = (title: string, subtitle?: string): string =>
  mintBold(`${STAR} ${title}`) + (subtitle ? "\n" + dim("  " + subtitle) : "");

/** A wizard step marker. */
export const step = (label: string): string => "\n" + mintBold(`${STAR} ${label}`);

/** A confirmation line: mint check + message. */
export const success = (msg: string): string => mint("✔ ") + msg;

/** An expected-failure line: soft-red cross + message. */
export const failure = (msg: string): string => redText("✖ " + msg);

// ---------------------------------------------------------------------------
// Pre-themed prompt wrappers (same signatures as @inquirer/prompts).
// ---------------------------------------------------------------------------

const styles = {
  answer: (text: string) => mint(text),
  highlight: (text: string) => mintBold(text),
  help: (text: string) => dim(text),
};

/** Theme for line prompts (input / password / confirm). */
const BASE_THEME = { prefix: mint(STAR), style: styles };

/** Theme for list prompts (select / checkbox) — adds the cursor/check glyphs. */
const LIST_THEME = {
  ...BASE_THEME,
  icon: { cursor: "❯", checked: mint("◉"), unchecked: dim("◯") },
};

export function select<Value>(config: Parameters<typeof iSelect<Value>>[0]) {
  return iSelect<Value>({ theme: LIST_THEME, ...config });
}

export function checkbox<Value>(config: Parameters<typeof iCheckbox<Value>>[0]) {
  return iCheckbox<Value>({ theme: LIST_THEME, ...config });
}

export function input(config: Parameters<typeof iInput>[0]) {
  return iInput({ theme: BASE_THEME, ...config });
}

export function password(config: Parameters<typeof iPassword>[0]) {
  return iPassword({ theme: BASE_THEME, ...config });
}

export function confirm(config: Parameters<typeof iConfirm>[0]) {
  return iConfirm({ theme: BASE_THEME, ...config });
}
