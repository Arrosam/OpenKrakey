# OpenKrakey — Web Chat (design mock)

A **static design mock** of the web chat page, re-skinned to match the **Config
console** (`packages/config-web`) — the "mission-control cockpit" aesthetic.
**Fake data only.** No backend, no build step, no framework. This exists so a
human can review the look & feel before any real node work on
`public_plugin/web`.

## Run it

Just open `design/chat-mock/index.html` in a browser. Or serve it:

```bash
npx http-server design/chat-mock -p 4322 -c-1   # or: python -m http.server -d design/chat-mock 4322
# then open http://localhost:4322
```

## What it demonstrates

The same product surface as today's chat page, on the cockpit design system:

- **One design system.** Color tokens, fonts (Hanken Grotesk + JetBrains Mono),
  inline-SVG line icons, thin scrollbars, the sidebar/brand shell, buttons/pills
  and the dot-grid + mint-glow backdrop are all ported **verbatim** from
  `config-web/static/styles.css` — so chat and config feel like one app.
- **Live-feeling chat.** Selecting an agent loads a canned transcript. Typing +
  Send appends a user bubble with a **"sent"** tick, shows a brief **typing
  indicator**, then (~heartbeat later) flips the tick to **"read"** (mint
  double-check) and lands a canned agent reply. Auto-scrolls to the bottom.
- **Composer.** A full-width **auto-growing `<textarea>`** (modelled on
  config-web's `textarea.inp.auto`): it starts at one line and grows with the
  draft up to ~6 lines (≈160px), after which it scrolls internally — no native
  resize handle. **Enter sends; Shift+Enter inserts a newline**, and the field
  resets to one line after sending. Beside it sits a **minimalist send button** —
  a compact rounded-square (`--r-sm`) with a soft mint tint and a clean mint
  arrow-up line-icon (no filled circle, no heavy glow), in the same line-icon
  language as the `.bell`/`.copy` buttons. It bottom-aligns with the input when
  the field grows tall, and clearly de-emphasizes when no agent is selected.
- **Three separable status signals.** Presence and connection are encoded with
  distinct, deliberately unmistakable colors — applied everywhere a status shows
  (roster presence dot, roster subtitle, and the transcript-header pill):
  - **online** → **mint** (`--mint` `#2FD69C`) with a soft glow.
  - **offline** → a desaturated **slate** (`--offline` `#5a6b74`), **no glow** —
    the offline agent's row also tints toward the slate so it reads "inactive"
    (e.g. `warden`'s dot, subtitle, and `offline · last beat 4m ago` header label).
  - **disconnected** → **amber** (`--amber` `#ffcb6b`), no glow, soft pulse, the
    `disconnected — reconnecting…` text. This is the live *channel* state, separate
    from the agent's `online` flag, and it **overrides** the offline/online dot
    (a dropped channel is the louder signal). Click the status pill (or the
    **simulate disconnect** button in the roster footer) to toggle it.
- **The bell** toggles reply-notification state with an unmistakable on/off:
  mint **filled bell** + "ON" tooltip when armed, muted **bell-slash** + "OFF"
  tooltip when off (`aria-pressed` tracks it for assistive tech).
- **Embedded vs. standalone brand.** Opened on its own, the sidebar shows its own
  **KRAKEY Chat** brand block (stars mark + tagline pill). When the page is
  **iframed inside the unified Krakey Console** — which already renders the single
  global "KRAKEY Console" brand in its top nav — that brand block is **hidden** so
  two KRAKEY logos don't stack, and the sidebar's top tightens so the **AGENTS**
  label / roster starts cleanly. Detection is `window.self !== window.top` (works
  cross-origin); embedded adds an `embedded` class to `<html>`, gated purely in CSS.
- **Per-message tools.**
  - a hover-revealed **copy** button copies that message's text and briefly
    confirms (✓ "Copied"); it never triggers the quote flow.
  - a **two-click quote** is armed from the **empty gutter beside a message**, not
    the bubble. Each message row spans the full transcript width; the bubble (+
    avatar) stays at its normal max width and the remaining space on the *opposite*
    side (right of an agent message, left of a user message) is the quote hit-area
    (`cursor: pointer`). The gutter shows **one affordance at a time** — a single
    `.qchip` element that upgrades in place, so the hover hint and the armed hint
    never stack:
    - **hover anywhere on the message row** (the bubble OR the gutter) → a subtle
      ghosted **"Quote"** chip (low-opacity pill on the `--panel2` surface, `--line`
      border, pill radius, a clean inline-SVG **quote** speech-mark icon + a mono
      micro-label) fades in, hugging the bubble edge. It never shifts the bubble.
    - **hover the quote area directly** (`.quote-zone`/`.qchip`) → the gutter gets a
      mint wash and the chip lifts to a brighter `--panel3` pill with a `--line2`
      border — the stronger **"you can click here"** highlight that the broader
      row-hover reveal deliberately omits.
    - **1st click** (in the quote area) → that same chip upgrades to a clear mint
      **pill**: `--panel` surface, `--mint-deep` border with a soft mint glow, mint
      icon, and the concise sentence-case label **"Click again to quote"** in the
      sans prose font.
    - **2nd click** → drops a **"replying to …"** chip above the composer.

    Moving the mouse off the row before the 2nd click resets the chip back to the
    idle "Quote" ghost; the composer chip has a × to dismiss, and sending clears it.
    **Clicking the bubble does nothing to the quote flow** — so the message text
    stays freely selectable and copyable (the bubble's `cursor` is `text`).

> All transcripts, replies, ticks, the "heartbeat", and the connection toggle are
> simulated in `app.js`. Nothing is wired to a backend.

## Tasteful extensions beyond config-web's kit

config-web is a forms console; a chat UI needs vocabulary it doesn't ship. Added
in the **same** visual language:

- **Message bubbles** — agent bubbles use the `--panel` card surface; user
  bubbles are mint-tinted (`--mint-deep` border) and right-aligned. Both reuse
  config-web radii and the one-corner-squared "tail" treatment.
- **Sent → read ticks** — mono micro-labels with the `check` (sent) / new
  `checkAll` (read) icons, flipping to mint, drawn in config-web's icon style.
- **Typing indicator** — three pulsing dots inside an agent-bubble shell.
- **Avatars + presence dots** — round mint-tint initials reusing config-web's
  `.av` idea, with a live/offline presence dot (mint+glow online, slate `--offline`
  no-glow offline).
- **Timestamps + a "today" day-divider** — mono, faint, cockpit-quiet.
- **Connection / presence pill** — a clickable header pill whose dot/text encode
  three separable signals: mint+glow (online), slate `--offline` no-glow
  (agent offline, channel live), amber `--amber` no-glow `reconnecting…` (channel
  down — overrides the others). `--offline` (`#5a6b74`) is a new token added beside
  config-web's `--amber`/`--danger`.
- **Per-message copy + gutter quote tools** — a hover-revealed copy button, and a
  two-click quote flow armed from the **empty gutter** beside a message (so bubble
  text stays selectable). The full-width message row constrains the bubble to a
  `.msg-inner`, leaving the opposite-side gutter (`.quote-zone`) as the hit-area.
  The gutter shows a **single `.qchip`** affordance that upgrades in place —
  a ghosted **"Quote"** chip on hover, then a clear mint **pill** ("Click again to
  quote") once armed — so the hover and armed hints never stack into two lines.
  Committing drops a `replying to …` chip (config-web's `.tag` chip idea, mint
  left-bar, `×` to dismiss) into the composer.
- **New icons** (`bell`, `bellSlash`, `send`, `copy`, `quote`) — drawn 24×24,
  `currentColor`, matching the existing `ICONS` map (replaces the Bootstrap-Icons
  CDN the real page uses today). Most are stroked line icons (stroke 1.7). The
  `quote` glyph is the **one exception**: it's a **filled** path
  (`fill:currentColor; stroke:none`, listed in `FILLED_ICONS`) drawing two solid
  curved quotation marks — closed shapes that rasterize crisply at the 14px chip
  size, where the stroked-outline attempts traced as broken open contours. `icon()`
  switches the SVG paint to filled for glyphs in that set. The `send` glyph is a
  minimal **arrow-up**, mirroring config-web's `arrowRight`/`arrowLeft` line
  vocabulary (it reads far cleaner than the earlier paper-plane at the button's
  small size).
- **Agent-switch transition** — selecting a new agent in the roster slides the
  chat header and transcript up + fades them in (config-web's `viewIn`: a short
  `cubic-bezier(.2,.8,.2,1)` slide-up/fade, re-triggered each select via a reflow
  restart, mirroring config-web's `animateIn()`). Quick and non-janky.

## Map to the real page (`public_plugin/web`)

So the eventual implementation can port faithfully:

| Mock element (`app.js` / `styles.css`)        | Real page (`page.ts` / `page.style.ts` / `page.script.ts`) |
|-----------------------------------------------|-------------------------------------------------------------|
| `#roster` + `.agent` rows                     | `#roster`, `.agent` (filled by `loadRoster()` from `/api/agents`) |
| `#count` "N agents online"                    | `#count` roster footer                                      |
| `.chat-head` (`#head`) avatar/title/sub       | `<header>` with `#hav` / `#title` / `#sub`                  |
| `#conn` pill (mint / slate / amber)           | `#sub` — **derive from `EventSource` state + the agent's `online` flag**, not a hardcoded string (see Bug 1) |
| `.agent.off` row + `.pres.off` slate dot      | roster row for an `online:false` agent (desaturated, slate presence dot) |
| `#bell` toggle (`bell` ↔ `bellSlash`)         | `#bell` (`refreshBell()` / `askNotify()`, browser `Notification`) — see Bug 2 |
| `.msg` row → `.msg-inner` (bubble) + `.quote-zone` (gutter) | `#log` rows; `.row.agent-msg` / `.me` (`addAgentMsg` / `addMyMsg`) — split each row so the bubble stays selectable and the gutter arms quoting |
| `.tick` sent → `.tick.read`                   | `.tick` → `.tick.read` (`markRead()` on a `status:read` event) |
| `.bubble .copy` per-message copy button       | *(new — no equivalent today; `navigator.clipboard.writeText`)* |
| `.quote-zone .qchip` (idle ghost ↔ armed pill) + `.quote-chip` quote flow | *(new — no equivalent today; gutter-armed, client-side composer state)*   |
| typing indicator                              | *(new — no equivalent today; optional polish)*             |
| `.empty` "Pick an agent…"                     | `.empty` initial `#log` content                            |
| `.composer` (`#form` / `#box` auto-grow `<textarea>` / `#send`) | `<form id="form">` / `#box` / `#send` (POST `/api/agents/:id/message`) — port `#box` as an auto-growing `<textarea>` with Enter-sends / Shift+Enter-newline |

## Behavior the real implementation MUST preserve

Surfaced while studying `page.script.ts` so the re-skin doesn't regress it:

1. **Per-message sent/read status is real.** A user message posts to
   `/api/agents/:id/message`, which returns an `id`; the bubble shows **"sent"**
   until a `status: read` SSE event for that `id` arrives (read fires when the
   agent's beat actually processes the message). The mock fakes the flip on a
   timer — the real flip is event-driven and **per id**. Keep the id plumbing.
2. **History replays prior read state.** On connect, the SSE `history` event
   carries messages; a user message with `status: 'read'` must render already
   flipped (mock: `read: true` in seed transcripts).
3. **First agent `output` is not a notification.** The real page sets a `greeted`
   flag so the *initial* streamed agent message doesn't raise a notification —
   only subsequent replies do. Preserve that when wiring real notifications.
4. **Notifications are opt-in and background-only.** Bell requests
   `Notification.permission`; replies only notify when `document.hidden`. The
   mock only toggles the bell's visual state — real permission flow stays.
5. **Locked / 401 state.** A `401` from `/api/agents` shows a "this tab isn't
   authorized — open the token link" state and disables the composer. Not shown
   in this mock (no auth surface), but the re-skin must keep it.
6. **Roster polls every 5s; SSE is per selected agent.** Switching agents closes
   the old `EventSource` and opens a new one. The mock has no streams, but the
   layout/behavior it depicts must map onto that model.

## Bugs in the real `web` plugin this mock's design must FIX

Found while reading `public_plugin/web/page.script.ts`. The current page ships
two states that lie to the user; the re-skin's design corrects both.

1. **Connection status always reads "online" — even when the channel is down.**
   `select()` hardcodes `subEl.innerHTML = '<span class="dot"></span>online'`
   (`page.script.ts:97`) and the `EventSource` (`es`) is created with **no
   `onopen`/`onerror` handlers** (`:101`). So if the SSE stream drops, the header
   still shows a live "online" dot forever — there is no disconnected state at all.
   **Fix:** introduce a CONNECTION state distinct from the agent's `online` flag
   and drive `#sub` from the stream — `es.onopen` → *connected* (mint dot + status),
   `es.onerror` / `es.readyState === EventSource.CLOSED` → *disconnected —
   reconnecting…* (amber, no-glow dot), exactly as `#conn` does in this mock.

2. **The bell cannot change status on click.** `refreshBell()` derives the bell's
   on/off purely from `Notification.permission` (`page.script.ts:19–24`), and
   `askNotify()` only ever *requests* permission (`:25–29`). Once permission is
   `granted` there is no way to turn replies back off, and when permission is
   `denied` or unsupported, clicking the bell does **nothing visible** — the user's
   "click to toggle" expectation is broken. **Fix:** track an explicit armed flag
   that the click toggles (gated on permission), and reflect it unmistakably —
   mint filled-bell / muted bell-slash + an ON/OFF tooltip + `aria-pressed`, as the
   mock's `#bell` does.
