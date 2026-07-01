/**
 * inspector/page.ts — the static dashboard HTML (mirrors web's page.ts split).
 *
 * A dependency-free, single-page debug dashboard for the read-only inspector
 * plugin. It picks up the access token from `location.search` (?token=…), lists
 * the registered agents (GET /api/agents), and for the selected agent backfills
 * from /snapshot then live-streams /stream over SSE. Records are deduped by
 * `seq` and routed into four panels: Prompts, Event stream, Logs, and a
 * Per-frame timeline. No external CDN is required (other than the optional Google
 * Fonts import in the CSS).
 *
 * Shell layout is the "mission-control cockpit" re-skin (ported from the approved
 * design mock design/inspector-mock/): a LEFT SIDEBAR (brand + agent roster +
 * status pill + dev/state controls) and a full-width surface that hosts the
 * lock/landing screens and the four panels. The four panels live in a 2×2 grid
 * (`.dash[data-view="overview"]`) and each can expand to a full-screen single
 * panel via a dedicated per-panel expand⇄return button — there is NO top tab bar.
 * The single-panel toggle is a pure CSS switch driven by `.dash[data-view]`; the
 * data/render logic is unchanged from the prior implementation.
 *
 * The page is assembled here from a static HTML skeleton plus two extracted
 * fragments — STYLE (the CSS) and SCRIPT (the client logic) — kept in sibling
 * files for single-responsibility.
 */
import { STYLE } from "./page.style";
import { SCRIPT } from "./page.script";

// ── Inline SVG icon set (config-web stroke style: currentColor, 24×24, 1.7) ──
// Used for the static shell below. The SCRIPT carries the same set for the rows
// it renders dynamically (event stream / frames).
const I = {
  stars: `<path d="M12 3c.4 3.6 1.4 4.6 5 5-3.6.4-4.6 1.4-5 5-.4-3.6-1.4-4.6-5-5 3.6-.4 4.6-1.4 5-5z"/><path d="M18.5 13.5c.2 1.7.6 2.1 2 2.3-1.4.2-1.8.6-2 2.3-.2-1.7-.6-2.1-2-2.3 1.4-.2 1.8-.6 2-2.3z"/>`,
  robot: `<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4.6"/><circle cx="12" cy="3.4" r="1.2"/><circle cx="9.2" cy="13.5" r="1.3"/><circle cx="14.8" cy="13.5" r="1.3"/><path d="M9.5 17h5"/><path d="M2 12.5v3M22 12.5v3"/>`,
  terminal: `<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>`,
  search: `<circle cx="10.5" cy="10.5" r="6"/><path d="M19.5 19.5l-4.7-4.7"/>`,
  activity: `<path d="M3 12h3.5l2.5-7 4.5 14 2.5-7H21"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7"/>`,
  expand: `<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>`,
  lock: `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 15v2"/>`,
  send: `<path d="M5 12h13M12 6l6 6-6 6"/><path d="M3.5 12h.01"/>`,
  layers: `<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>`,
};
function icon(name: keyof typeof I, cls?: string): string {
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;
}
// One always-visible, icon-only expand⇄return button as the LAST element of each
// panel header's right cluster. Fixed 30×28 box; the SCRIPT swaps only the glyph
// + tooltip + aria-label between Expand (grid) and Return (expanded) states.
const pexp = (): string =>
  `<button class="pexp" type="button" title="Expand" aria-label="Expand panel">${icon("expand", "pexp-ico")}</button>`;

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Krakey Inspector</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <!-- LEFT SIDEBAR — brand + agent roster + status pill + dev/state controls -->
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark">${icon("stars")}</span>
      <div>
        <div class="mark">KRAKEY <span class="b">Inspector</span></div>
        <div class="tag">read-only debug console</div>
      </div>
    </div>

    <div class="roster-label">Agents</div>
    <div class="roster" id="roster"><div class="empty">Waiting for agents…</div></div>

    <div class="sb-status">
      <span class="status" id="status"><span class="dot"></span><span class="st-text">idle</span></span>
    </div>

    <div class="foot">
      <div class="dev-strip">
        <span class="dl">view</span>
        <button data-state="dashboard" class="on" id="devDashboard">Dashboard</button>
        <button data-state="landing" id="devLanding">Landing</button>
      </div>
      <p class="note"><span class="d">●</span> read-only observer<br>nothing is emitted on the bus</p>
    </div>
  </aside>

  <!-- SURFACE — full-width: lock/landing screens + the 2×2 panel grid -->
  <div class="surface">
    <!-- LOCK screen -->
    <div class="screen" id="lock">
      <div class="lock-card">
        <span class="lk-ic">${icon("lock")}</span>
        <h2>Locked</h2>
        <p>A valid access token is required. Append <code>?token=…</code> to the URL — the inspector prints the full URL on startup.</p>
      </div>
    </div>

    <!-- LANDING screen -->
    <div class="screen" id="landing">
      <div class="landing-card">
        <div class="lc-head"><span class="g">${icon("robot")}</span><h2>Select an agent to inspect</h2></div>
        <p class="lc-hint">Choose which running Agent's bus to observe.</p>
        <div class="agent-list" id="agentList"><div class="empty">Waiting for agents…</div></div>
      </div>
    </div>

    <!-- DASHBOARD: the four panels in a 2×2 grid -->
    <main class="dash" id="main" data-view="overview">
      <section class="panel panel--prompts" data-view="prompts">
        <header>
          <span class="g">${icon("send")}</span><h3>Prompts</h3><span class="count" id="cPrompts">0</span>
          <div class="hc">
            <div class="seg" id="pvToggle">
              <button type="button" data-pv="readable" class="active">Readable</button>
              <button type="button" data-pv="raw">Raw</button>
            </div>
            ${pexp()}
          </div>
        </header>
        <div class="body" id="prompts"><div class="empty">No prompts yet.</div></div>
      </section>

      <section class="panel panel--events" data-view="events">
        <header>
          <span class="g">${icon("activity")}</span><h3>Event stream</h3><span class="count" id="cEvents">0</span>
          <div class="hc">${pexp()}</div>
        </header>
        <div class="toolbar">
          <label class="chk on" id="autoFollow"><span class="box">${icon("check")}</span><span class="lbl">auto-follow</span></label>
        </div>
        <div class="body" id="events"><div class="empty">No events yet.</div></div>
      </section>

      <section class="panel panel--frames" data-view="frames">
        <header>
          <span class="g">${icon("layers")}</span><h3>Per-frame timeline</h3><span class="count" id="cFrames">0</span>
          <div class="hc">${pexp()}</div>
        </header>
        <div class="body" id="frames"><div class="empty">No frames yet.</div></div>
      </section>

      <section class="panel panel--logs" data-view="logs">
        <header>
          <span class="g">${icon("terminal")}</span><h3>Logs</h3><span class="count" id="cLogs">0</span>
          <div class="hc">${pexp()}</div>
        </header>
        <div class="toolbar">
          <div class="seg" id="logSource">
            <button type="button" data-src="live" class="active">Live</button>
            <button type="button" data-src="query">Query</button>
          </div>
          <label class="chk on" id="logFollow"><span class="box">${icon("check")}</span><span class="lbl">auto-follow</span></label>
          <div class="levelseg" id="logLevel">
            <button type="button" data-lvl="" class="active">all</button>
            <button type="button" data-lvl="info">info</button>
            <button type="button" data-lvl="warn">warn</button>
            <button type="button" data-lvl="error">error</button>
            <button type="button" data-lvl="print">print</button>
          </div>
          <span class="filter-ico">${icon("search")}</span>
          <input class="tin" id="logPid" placeholder="pluginId…" />
        </div>
        <div class="toolbar toolbar2 query-only" id="logQueryBar">
          <label class="qf-label">range</label>
          <select class="tsel" id="logRange">
            <option value="live">live (no time filter)</option>
            <option value="300000">last 5 min</option>
            <option value="900000">last 15 min</option>
            <option value="3600000">last 1 hour</option>
            <option value="21600000">last 6 hours</option>
            <option value="86400000">last 24 hours</option>
            <option value="all">all</option>
          </select>
          <div class="typems" id="logTypes">
            <button type="button" class="typems-btn" id="logTypesBtn">types: <b id="logTypesLbl">all</b></button>
            <div class="typems-pop" id="logTypesPop"></div>
          </div>
          <button type="button" class="btn ghost qf-run" id="logRunBtn">Run query</button>
          <span class="qf-meta" id="logQueryMeta"></span>
        </div>
        <div class="body" id="logs"><div class="empty">No logs yet.</div></div>
      </section>
    </main>
  </div>
</div>

<script>${SCRIPT}</script>
</body>
</html>`;
