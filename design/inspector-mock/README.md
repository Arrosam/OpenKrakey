# Inspector debug console — STATIC DESIGN MOCK

This is a **static design mock** with **fake bus data**, built for visual review
**before any real node work**. It is **not wired to any bus** — there is no SSE,
no `/snapshot`, no token gate. Every record you see is hand-authored seed data in
`app.js`.

It re-skins OpenKrakey's read-only inspector debug dashboard
(`public_plugin/inspector/`) to match the **config console** (`packages/config-web`)
— the dark "mission-control cockpit" aesthetic that is the design north-star.

It uses a **LEFT SIDEBAR + main** layout — the *same shell* as the sibling Config
and Chat mocks — so all three surfaces read as one product, and so the inspector
shows **no second top bar** when it is embedded inside the unified **Console**
(`design/dashboard-mock`), which already carries the top nav-bar. (Earlier this
mock had its own horizontal top header, which double-stacked with the Console's
nav-bar; that header is now the left sidebar.)

## How to open it

Just open `index.html` in a browser. No build, no server, no install. (The only
network request is the Google Fonts import — the same one config-web uses.)
`standalone.html` is the same page with the CSS + JS inlined; it is what the
Console's `<iframe>` loads, so keep it in sync with `styles.css` / `app.js`.

Preview the other states with a query param (or the **mock states** controls in
the sidebar footer):

- `index.html` — the rich dashboard for agent **krakey** (default)
- `index.html?agent=scout` — the second fake agent
- `index.html?state=landing` — the "Select an agent to inspect" screen
- `index.html?state=lock` — the "a valid access token is required" lock screen

## What's wired for real (interactions actually work)

- **Expand⇄return button (icon-only, no tab bar, no hover hint)** — the Overview
  2×2 grid is the permanent home view. There is **no top tab nav** and **no
  hover-revealed hint** — nothing in a header shifts on hover. Every panel header
  carries **one dedicated button at the far top-right** (the **last** element in
  its right cluster, after the panel's own controls), **always visible** in both
  states and occupying a fixed **30×28 square** so it never causes layout shift. It
  is **icon-only in BOTH states** — there is no on-screen text label; the
  **tooltip** (`title`) and **`aria-label`** carry the meaning. In the grid it's an
  **Expand** control (a maximize / out-arrows glyph, `title="Expand"`,
  `aria-label="Expand panel"`); clicking it expands THAT panel to the full-screen
  single-panel layout (still driven by `main[data-view]`, the same mechanism the
  tabs used). In the expanded view the **same button** becomes a **Return** control
  (a minimize glyph, `title="Return to overview"`, `aria-label="Return to
  overview"`) that collapses back to the 2×2 grid. Because only the glyph swaps and
  the box size is fixed, there is **zero width change** between states. The header
  itself is **not** a click target; the button stops propagation, so the panel's
  own controls (Readable⇄Raw seg, Logs filters, auto-follow) keep working and never
  move when you use the button.
- **Prompts: Readable ⇄ Raw** — the segmented toggle actually switches between a
  readable block rendering and a raw JSON dump.
- **Logs: level + pluginId filters + auto-follow** — the level segmented control
  and the pluginId text input filter the visible log lines, and a new
  **auto-follow** toggle (styled/behaving exactly like the event stream's) pins
  the Logs panel to the bottom as new lines arrive; scrolling up unchecks it.
- **Event stream: auto-follow** — the checkbox actually pins the stream to the
  bottom; scrolling up unchecks it.
- **Agent selector (sidebar roster)** — the **left-sidebar agent roster** (chat's
  roster vocabulary — one row per agent: a small mint avatar with a live presence
  dot, the agent id, and a mono sub line `plugins · interval · live`) switches
  between two fake agents; the selected row gets the mint `.sel` highlight.
  Switching to a **different** agent plays a short **slide-up + fade** transition
  on the panel bodies (config-web's `viewIn` feel, ~0.28s, with a small per-panel
  stagger so the four cascade). It re-triggers on every agent switch — in both the
  2×2 overview and the expanded single-panel view, and from the landing screen's
  agent cards — but **not** on a minor re-render (toggling a Logs filter, the
  Readable⇄Raw seg, or either auto-follow re-renders in place with no motion). The
  trigger lives only in `selectAgent()` (`animateAgentSwitch()`), never in the
  `render*` functions, and honors `prefers-reduced-motion: reduce`.

## Design system — what was reused from config-web (so it reads as ONE product)

Ported **verbatim** from `packages/config-web/static/styles.css` /`app.js`:

- the `:root` tokens (mint `#2FD69C`, `--ink/--panel/--panel2/--panel3/--line/
  --line2`, `--text/--muted/--faint`, `--danger/--amber`, radii, `--shadow`)
- the Google Fonts import (`Hanken Grotesk` + `JetBrains Mono`) and the
  Mono-for-values / Sans-for-prose partition
- the layered body backdrop (dot-grid + two mint glows), thin custom scrollbars
- the **left-sidebar shell** — `.app` grid (`grid-template-columns: 264px 1fr`),
  `.sidebar` (sticky, blurred gradient, right border) and the `.brand` block; plus
  the chat mock's **agent roster** rows (avatar + presence dot + id + sub) — so all
  three surfaces share one shell
- the **brand block, replicated pixel-for-pixel from config**: a 24×24 `stars`
  brand-mark (mint, `drop-shadow 0 0 12px`), `KRAKEY <span class="b">Inspector</span>`
  at 16.5px / 700 / `letter-spacing 1px` / mint with `text-shadow 0 0 22px`, and a
  **pill-style tagline** — config's general `.tag` chip surface (`background:
  var(--panel3)`, `border: 1px solid var(--line2)`, `border-radius: 20px`, padding
  `4px 6px 4px 12px`, `inline-flex`, 8px uppercase mono `--faint`). Computed
  `.brand .tag` / `.brand .mark` / `.brand-mark` styles were verified to match
  config-ui-mock exactly (only the surface word — "Inspector" — differs). The
  brand shows **only when opened standalone**: when embedded in the Console
  iframe, `app.js` detects `window.self !== window.top`, adds `.embedded` to
  `<html>`, and `.embedded .sidebar .brand { display: none }` hides it (with the
  roster label's top padding zeroed) — so the Console's single global "KRAKEY
  Console" brand isn't doubled by the inspector's own.
- `.btn`, `.pill` (+ `.mint`/`.warn`/`.danger`), and the inline-SVG `.ic` icon
  helper + its 24×24 stroke-1.7 paths

### Tasteful extensions (cockpit kit doesn't cover a dense observability surface)

These were added in the **same idiom** (palette-only, same stroke style):

- **Left sidebar** (matching Config + Chat) holding, top to bottom: the brand
  block, an **agent roster**, a **live/idle status pill**, and a footer with the
  **MOCK STATES** dev controls (Dashboard / Landing / Lock previews) + the "static
  design mock · fake bus data" note. There is **no top bar** — a per-panel expand
  button drives the view, and the full-width main hosts only the panel grid. This
  is what removes the "double top bar" when the inspector is embedded in the
  Console (which carries its own top nav-bar).
- **2×2 panel grid → full-screen single panel** with **sticky panel headers**
  (icon + title + count pill + controls), expanded by a **dedicated icon-only
  expand button** at the far right of each header and collapsed by that **same
  button** (which swaps to a minimize glyph).
- **Per-panel accent colors** — each of the four panels has its **own** accent,
  applied identically (header icon glyph + count pill + panel border, with a
  low-alpha glow ring on the two newest). The four make a balanced, harmonious
  spread **green → blue → violet → warm**:
  - **Prompts → mint `#2FD69C`** (`--mint`, border `--mint-deep`)
  - **Event stream → azure `#4ea3f0`** (`--azure`, border `--azure-deep #2f6fab`,
    `--azure-glow` ring) — bluer than the Prompts mint so a live "stream" reads as
    blue at a glance.
  - **Per-beat → violet `#9d8cff`** (`--violet`)
  - **Logs → gold `#f4b53a`** (`--gold`, border `--gold-deep #9c6f17`, `--gold-glow`
    ring) — a deeper, more saturated, lower-hue warm tone than the in-body
    **warn-amber** (`--amber #ffcb6b`) and **error-red** (`--danger #ff6b6b`) used
    on log rows, so the header accent never reads like a warning.
- **Segmented Readable⇄Raw control** and a **segmented log-level filter** — small
  segmented controls built from the kit's surfaces.
- **Per-category event accents**: a left border + colored kind on each event row,
  drawn only from the palette (mint / amber / danger / muted) plus two derived
  cool tints (`--violet` for tool dispatch, `--sky` for gather/compose).
- **Beat lanes** with a gutter rail + stage dots and per-step `+Δms` timing.
- A handful of **new line-icons** (`tick`, `send`, `receive`, `wrench`, `layers`,
  `lock`, plus `expand` / `minimize` — the maximize ⇄ minimize glyphs the per-panel
  expand⇄return button swaps between) in the config-web stroke style.
- An **agent-switch transition** that reuses config-web's `viewIn` / `fade` /
  `stagger` animation feel — a short slide-up + fade on the panel bodies, with a
  per-panel stagger, fired only on an actual agent switch (see above).

## Map: mock element → real inspector surface

The eventual implementation should port the **look** from here onto the existing
behavior in `public_plugin/inspector/`. The data plumbing already exists; only the
markup/CSS changes.

| Mock (`design/inspector-mock`)            | Real inspector (`public_plugin/inspector`) |
| ----------------------------------------- | ------------------------------------------- |
| left `.sidebar` — brand + agent roster (`#roster`) + status (`#status`) + mock-state dev controls (no tabs, no top bar) | `page.ts` `<header>` → a left sidebar (brand / `#agentSel` → a roster list / `#status`); the `.tabs` nav is dropped |
| four `.panel` cards in `main[data-view]`, expanded by a per-panel `.pexp` button | `page.ts` four `<section class="panel">`, `page.style.ts` `main[data-view]` grid toggle, now driven by a dedicated per-panel expand⇄return button instead of the tab bar |
| Prompts `.pair` + Readable⇄Raw `seg`      | `page.script.ts` `renderPrompts()` + `#pvToggle`; uses `page.format.ts` `formatRequest()` |
| Event stream `.ev` rows + auto-follow     | `page.script.ts` `makeEventRow()` / `renderEvents()` / `#autoFollow` |
| Per-beat `.beat` lanes                    | `page.script.ts` `renderBeats()` (beats correlated by `corrId`, opened at tick/gather) |
| Logs `.log` rows + level/pid filters + auto-follow | `page.script.ts` `renderLogs()` + `#logLevel` / `#logPid` + a new `#logFollow` pin-to-bottom toggle (mirror of `#autoFollow`) |
| Lock screen                               | `page.ts` `#lock` + `showLock()` |
| Landing screen + agent cards              | `page.ts` `#landing` + `renderAgentList()` / `showLanding()` |

### Behavior + record shapes the real implementation MUST preserve

These were reproduced faithfully in the mock and are the load-bearing parts:

1. **Prompts panel shows the real assembled request.** Each prompt record is one
   beat's `llm.request.sent`, whose payload carries the assembled request under
   `payload.data.request` — `{ system, messages[], tools[], temperature, maxTokens,
   model }`. The mock's readable view splits the composed `system` string back into
   its priority blocks, renders the `messages[]` array with role colors, lists
   `tools[]` as chips, and shows params; the **raw** view is the verbatim
   `formatRequest(payload, "raw")` JSON. The real `formatRequest` (in
   `page.format.ts`) is reused **verbatim** in the mock so the raw output matches.
   Keep the readable⇄raw toggle.

2. **Per-beat correlation by request id.** Beats open at `tick`/`gather` and every
   later record joins the current beat; `prompt.sent` / `prompt.received` are paired
   by `corrId` (request id). The mock shows the lifecycle gather → request → return
   → tool calls → output per beat, with per-step timing. Preserve the `corrId`
   pairing and the `chooseSent` rule (prefer the assembled `payload.data.request`
   over a plain `llm.request` sharing the same corrId).

3. **Logs include `core:*` lines** and are filtered by level + pluginId substring;
   `core:*` plugin ids are visually distinguished. Levels color as: info muted,
   warn amber, error danger, print sky. The Logs panel now also has its own
   **auto-follow** toggle that pins the panel to the bottom as new lines arrive —
   it must use the **same** pin-on-render / uncheck-on-scroll-up logic as the
   event stream's `#autoFollow` (in the mock: `renderLogs()` pins when `#logFollow`
   is on; a manual scroll-up clears it).

4. **Truncation + dropped-record affordances** exist in the real page
   (`payload.__truncated`, the snapshot `dropped` banner). The mock does not seed
   these, but the real re-skin must keep styling them (amber, dashed).

5. **Interaction model: no tab bar — one expand⇄return button per panel.** The
   Overview 2×2 grid is the home view; there is no top tab nav and no hover-gated
   affordance (nothing in a header shifts on hover). Each panel header carries a
   single dedicated button as the last element of its right cluster, always
   visible and occupying fixed space. In the grid it's an **Expand** control; it
   expands that panel to the full-screen `main[data-view]` layout (the same layout
   the tabs used to drive). In the expanded view the same button becomes a
   **Return** control (minimize glyph + "Return" label) that collapses back. The
   real re-skin should keep the existing `main[data-view]` single-panel layout but
   switch its trigger from the tab buttons to this per-panel button. The button
   stops click propagation and the header is no longer a click target, so the
   panel's own controls (Readable⇄Raw, Logs filters, auto-follow) are unaffected.
