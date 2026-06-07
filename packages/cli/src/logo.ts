/**
 * KRAKEY banner for the cli landing page.
 *
 * Wordmark brought over verbatim from the predecessor Arrosam/KrakeyBot
 * (krakey/cli/_banner.py), rendered as a vertical gradient: light at the top,
 * deep at the bottom, through #2FD69C (the brand mid-tone). Falls back to plain
 * text when stdout is not a TTY or NO_COLOR is set.
 */

const WORDMARK = "    d8b                           d8b\n    ?88                           ?88\n     88b                           88b\n     888  d88'  88bd88b d888b8b    888  d88' d8888b?88   d8P\n     888bd8P'   88P'  `d8P' ?88    888bd8P' d8b_,dPd88   88\n    d88888b    d88     88b  ,88b  d88888b   88b    ?8(  d88\n    d88' `?88b,d88'     `?88P'`88bd88' `?88b,`?888P'`?88P'?8b\n                                                          )88\n                                                          ,d8P\n                                                      `?888P'";
const TAGLINE = "        u l t i m a t e   a u t o n o m o u s   a g e n t";

/** Brand mid-tone #2FD69C — the gradient passes through this in the middle. */
const BASE: readonly [number, number, number] = [0x2f, 0xd6, 0x9c];
const TOP_MIX = 0.5; // blend toward white at the very top (lighter)
const BOTTOM_MIX = 0.5; // blend toward black at the very bottom (deeper)

const useColor =
  process.env.NO_COLOR === undefined && process.stdout?.isTTY === true;

/** Colour for vertical position t in [0,1]: 0=top (light), 0.5=BASE, 1=bottom (deep). */
function lineColor(t: number): [number, number, number] {
  const [r, g, b] = BASE;
  let R: number;
  let G: number;
  let B: number;
  if (t <= 0.5) {
    const a = TOP_MIX * (1 - t / 0.5);
    R = r + (255 - r) * a;
    G = g + (255 - g) * a;
    B = b + (255 - b) * a;
  } else {
    const a = BOTTOM_MIX * ((t - 0.5) / 0.5);
    R = r * (1 - a);
    G = g * (1 - a);
    B = b * (1 - a);
  }
  return [Math.round(R), Math.round(G), Math.round(B)];
}

function paint(text: string, rgb: readonly [number, number, number]): string {
  return "\x1b[38;2;" + rgb[0] + ";" + rgb[1] + ";" + rgb[2] + "m" + text + "\x1b[0m";
}

function render(): string {
  if (!useColor) return "\n" + WORDMARK + "\n\n" + TAGLINE + "\n";
  const rows = WORDMARK.split("\n");
  const n = rows.length;
  const body = rows
    .map((line, i) =>
      line.trim() === "" ? line : paint(line, lineColor(n <= 1 ? 0.5 : i / (n - 1))),
    )
    .join("\n");
  return "\n" + body + "\n\n" + paint(TAGLINE, BASE) + "\n";
}

/** The finished banner (ANSI gradient on a TTY, plain text otherwise). */
export const KRAKEY_LOGO = render();
