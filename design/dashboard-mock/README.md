# Krakey Console — dashboard mock

A **static design mock** (no build step) of the unified **Krakey Console**: one
persistent **top nav-bar** plus a Dashboard landing that switches the main area
between the three product surfaces — **Config**, **Chat**, and **Inspector**.

This is a design artifact for review only. It ships no real logic — the stats,
agents, and activity rows are fabricated. Open `index.html` (served from the
`design/` root — see below) and click around.

It reuses the **config-web cockpit design system** verbatim (the `:root` tokens,
Hanken Grotesk + JetBrains Mono, the dot-grid + mint-glow backdrop, the nav-tab
styling, the `.btn` / `.pill` / `.card` vocabulary, and the `icon()` helper +
ICONS map from `packages/config-web/static/`), so the dashboard reads as the
*same product* as the Chat and Inspector mocks.

## The concept: one shell, the nav switches pages

- **Persistent top nav-bar** — always visible, spanning the full width. It lays
  out horizontally: the Krakey brand block (mark + tagline) on the left, the four
  nav items as horizontal tabs each with an inline-SVG icon, label, and
  active/hover states (**Dashboard**, **Config**, **Chat**, **Inspector**) in the
  center, and a condensed global status indicator on the right ("all systems
  nominal" with a pulsing mint dot). Selecting a tab swaps the full-width content
  area below in place — the page never navigates away.

  The brand sits in a **fixed 264px-wide left column** — exactly the width of each
  embedded surface's own left sidebar (`grid-template-columns: 264px 1fr`) — with
  the same 18px horizontal padding and a right border in the cockpit `--line`
  colour. That border lands at **x = 264**, so it lines up pixel-for-pixel with
  the sidebar right border of whatever surface is open, forming **one continuous
  vertical line** from the top of the page down through the surface. The nav tabs
  begin to the right of that column. Below 920px (where the surfaces collapse
  their sidebar into a row) the brand column relaxes back to a compact auto-width
  block, so the bar stays a single tidy row.

  The nav is a **top bar at every breakpoint** (never a left column): on narrow
  widths the tabs scroll horizontally and the verbose status line drops out, but
  the bar stays a single horizontal row. This matters because the embedded Config
  and Inspector surfaces have their *own* left sidebars — keeping the Console nav
  on top means an embedded surface's sidebar is the **only** sidebar on screen,
  with no stacked double-sidebar.

- **Dashboard (home)** — a brand hero ("One cockpit for your autonomous agents"),
  a stat strip, three large **surface cards** (Config / Chat / Inspector — each
  with its icon, a one-line description, representative stat pills, and an "Open
  …" affordance), and a tasteful **recent activity** list to make it feel like a
  real hub. Clicking a card opens that surface, exactly like its nav item.

## How surface-switching works

Selecting **any** surface (via the nav OR the dashboard card) swaps the main
area to an **`<iframe>`** that loads the existing sibling mock — this is the
clearest demonstration of "one shell, nav switches pages":

| Surface   | Behaviour                                                              |
|-----------|-----------------------------------------------------------------------|
| Config    | `<iframe src="/config-ui-mock/">`                                    |
| Chat      | `<iframe src="/chat-mock/standalone.html">`                           |
| Inspector | `<iframe src="/inspector-mock/standalone.html">`                      |

Implementation notes:

- All three iframe surfaces are **built once and kept alive** across switches
  (hidden, not destroyed), so a loaded surface keeps its state when you tab away
  and back.
- Each iframe's real `src` is assigned **lazily on first open**, so a sibling
  mock doesn't load until you actually visit its surface.
- The iframe area is full-**width** and full-height with no border and the
  cockpit background — it sits **directly below the top nav-bar** (no left
  column, no surface sub-header) and fills the entire remaining height, so the
  embedded surface's own sidebar is the only one on screen.

### Config embeds inline too

`config-ui-mock` is a fully self-contained static console (fake data, no
backend — it renders on its own), so the Config surface embeds it inline as an
`<iframe src="/config-ui-mock/">`, exactly like Chat and Inspector.

In the **real product** the live Config console runs as **its own app** on a
loopback origin (`http://127.0.0.1:7700`) with an HTTP API that reads and writes
your real config files. It would be embedded / cross-linked into this shell the
same way — opening inline alongside Chat and Inspector behind one unified
console — which is exactly the layout this mock stands in for.

## Running it

All three surface iframes use **absolute paths** (`/config-ui-mock/`,
`/chat-mock/…`, `/inspector-mock/…`), so they only resolve when the page is
served from the **`design/` root**, not from inside `dashboard-mock/`.

Use the `design-root` launch config (already in `.claude/launch.json`), which
serves the `design/` directory on **port 8232**:

```
# via the preview harness: start the "design-root" server, then open:
http://localhost:8232/dashboard-mock/

# or by hand, from the repo root:
npx --yes http-server design -p 8232 -c-1
# then open http://localhost:8232/dashboard-mock/
```

Opening `index.html` directly off the filesystem (or serving only
`dashboard-mock/`) will render the shell and dashboard fine, but the Config,
Chat, and Inspector iframes will 404 because their absolute paths won't resolve.

## Files

- `index.html` — the whole self-contained mock: embedded cockpit CSS (tokens
  ported verbatim from config-web) plus an inline script that builds the top
  nav-bar, the Dashboard, and the surface viewports. No external assets except
  the same Google Fonts import config-web uses.
- `README.md` — this file.

## Mapping to a real implementation

In production this becomes a **shared app shell**: one persistent nav/landing
component that hosts (or cross-links) the three surfaces behind a single origin.
Config, Chat, and Inspector would each mount as a route/panel inside that shell
rather than as static iframes, with the global status indicator and dashboard
stats fed from live data. The mock's structure — persistent nav, a Dashboard
hub, and per-surface viewports — is exactly that layout, with iframes and fake
data standing in for the real wiring.
