/**
 * inspector/page.ts — the static dashboard HTML (mirrors web's page.ts split).
 *
 * A dependency-free, single-page debug dashboard for the read-only inspector
 * plugin. It picks up the access token from `location.search` (?token=…), lists
 * the registered agents (GET /api/agents), and for the selected agent backfills
 * from /snapshot then live-streams /stream over SSE. Records are deduped by
 * `seq` and routed into four panels: Prompts, Event stream, Logs, and a
 * Per-beat timeline. No external CDN is required.
 *
 * Shell layout follows the "KrakeyBot dashboard" pattern: a tabbed single-page
 * console where each panel can be viewed full-screen, or an "Overview" tab shows
 * all four panels in a 2×2 grid (the default). Tab switching is a pure CSS toggle
 * driven by `main[data-view]`; the data/render logic is unchanged.
 *
 * The page is assembled here from a static HTML skeleton plus two extracted
 * fragments — STYLE (the CSS) and SCRIPT (the client logic) — kept in sibling
 * files for single-responsibility. (The split itself was byte-preserving; the page
 * has since evolved with features, so no fixed length is asserted.)
 */
import { STYLE } from "./page.style";
import { SCRIPT } from "./page.script";

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Krakey Inspector</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="brand-text"><div class="brand-name">Krakey Inspector</div><div class="brand-tag">debug console</div></div>
  </div>
  <nav class="tabs">
    <button class="tab-btn active" data-view="overview">Overview</button>
    <button class="tab-btn" data-view="prompts">Prompts</button>
    <button class="tab-btn" data-view="events">Event stream</button>
    <button class="tab-btn" data-view="beats">Per-beat</button>
    <button class="tab-btn" data-view="logs">Logs</button>
  </nav>
  <label id="agentPicker" style="color:var(--muted);font-size:12px;">agent <select id="agentSel"><option value="">— none —</option></select></label>
  <span class="status-bar" id="status">idle</span>
</header>

<div id="lock" style="display:none">
  <h2>Locked</h2>
  <p>A valid access token is required. Append <code>?token=…</code> to the URL
  (the inspector printed the full URL on startup).</p>
</div>

<div id="landing" style="display:none">
  <div class="landing-card">
    <h2>Select an agent to inspect</h2>
    <p class="landing-hint">Choose which running Agent's bus to observe.</p>
    <div id="agentList" class="agent-list"><div class="empty">Waiting for agents…</div></div>
  </div>
</div>

<main id="main" data-view="overview">
  <section class="panel panel--prompts cyan">
    <h3>Prompts <span class="count" id="cPrompts">0</span><div class="pv-toggle" id="pvToggle"><button type="button" class="pv-btn active" data-pv="readable">Readable</button><button type="button" class="pv-btn" data-pv="raw">Raw</button></div></h3>
    <div class="body" id="prompts"><div class="empty">No prompts yet.</div></div>
  </section>

  <section class="panel panel--events">
    <h3>Event stream <span class="count" id="cEvents">0</span></h3>
    <div class="toolbar"><label><input type="checkbox" id="autoFollow" checked> auto-follow</label></div>
    <div class="body" id="events"><div class="empty">No events yet.</div></div>
  </section>

  <section class="panel panel--beats magenta">
    <h3>Per-beat timeline <span class="count" id="cBeats">0</span></h3>
    <div class="body" id="beats"><div class="empty">No beats yet.</div></div>
  </section>

  <section class="panel panel--logs">
    <h3>Logs <span class="count" id="cLogs">0</span></h3>
    <div class="toolbar">
      <select id="logLevel"><option value="">all levels</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option><option value="print">print</option></select>
      <input id="logPid" placeholder="pluginId…" size="10" />
    </div>
    <div class="body" id="logs"><div class="empty">No logs yet.</div></div>
  </section>
</main>

<script>${SCRIPT}</script>
</body>
</html>`;
