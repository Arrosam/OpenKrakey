/**
 * inspector/page.style.ts — the dashboard CSS, split out of page.ts (SRP).
 *
 * Holds exactly the content of the page's <style>…</style> block. page.ts
 * re-wraps it in the <style> tags. No logic — a single exported string.
 *
 * This is the "mission-control cockpit" re-skin ported from the approved design
 * mock (design/inspector-mock/styles.css): the config-web :root tokens + fonts,
 * the dot-grid + glow backdrop, a LEFT SIDEBAR shell (brand + agent roster +
 * status + dev controls), the four per-panel accent colors (mint/azure/violet/
 * gold), panel cards in a 2×2 grid that expand to a single full-screen panel,
 * segmented controls, beat lanes, log rows, the status pill, and the `.embedded`
 * rules that hide the surface's own brand when iframed into the Console.
 *
 * The data plumbing (token gate, /snapshot, /stream SSE, seq-dedup, record
 * routing) is unchanged — only the markup (page.ts) and CSS (here) re-skin.
 */
export const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');

:root {
  --mint:        #2FD69C;
  --mint-bright: #5cffc4;
  --mint-deep:   #1c8f68;
  --mint-glow:   rgba(47, 214, 156, 0.16);

  --ink:    #070b0a;
  --panel:  #0d1413;
  --panel2: #111a18;
  --panel3: #16211e;
  --line:   #1d2b27;
  --line2:  #294039;

  --text:   #dce8e3;
  --muted:  #7e948c;
  --faint:  #54655f;

  --danger: #ff6b6b;
  --amber:  #ffcb6b;

  --violet: #9d8cff;
  --sky:    #6bd4ff;

  --azure:      #4ea3f0;
  --azure-deep: #2f6fab;
  --azure-glow: rgba(78,163,240,0.14);

  --gold:       #f4b53a;
  --gold-deep:  #9c6f17;
  --gold-glow:  rgba(244,181,58,0.13);

  --mono: 'JetBrains Mono', ui-monospace, monospace;
  --sans: 'Hanken Grotesk', system-ui, sans-serif;

  --r-sm: 7px;
  --r:    11px;
  --r-lg: 16px;

  --shadow: 0 18px 50px -20px rgba(0,0,0,0.8);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; }

body {
  font-family: var(--sans);
  background: var(--ink);
  color: var(--text);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  height: 100vh;
  overflow: hidden;
  background-image:
    radial-gradient(circle at 14% 8%, var(--mint-glow), transparent 42%),
    radial-gradient(circle at 92% 96%, rgba(47,214,156,0.07), transparent 46%),
    radial-gradient(rgba(255,255,255,0.018) 1px, transparent 1px);
  background-size: auto, auto, 22px 22px;
  background-attachment: fixed;
}

::selection { background: var(--mint); color: var(--ink); }

/* inline SVG icons */
.ic { width: 1.15em; height: 1.15em; flex: none; display: inline-block; vertical-align: -0.18em; }
.brand-mark .ic { width: 24px; height: 24px; }
.brand-mark { color: var(--mint); display: grid; place-items: center; filter: drop-shadow(0 0 12px rgba(47,214,156,0.5)); }
.h-ic { color: var(--mint); display: inline-flex; vertical-align: -2px; }
.h-ic .ic { width: 15px; height: 15px; }

/* scrollbars */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 20px; border: 3px solid var(--ink); }
::-webkit-scrollbar-thumb:hover { background: var(--mint-deep); }
* { scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }

/* buttons / pills */
.btn {
  font-family: var(--sans); font-size: 13.5px; font-weight: 600;
  border-radius: var(--r-sm); padding: 9px 16px; cursor: pointer;
  border: 1px solid var(--line2); background: var(--panel2); color: var(--text);
  transition: all .15s ease; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap;
}
.btn:hover { border-color: var(--mint-deep); background: var(--panel3); }
.btn.primary {
  background: var(--mint); color: var(--ink); border-color: var(--mint);
  box-shadow: 0 8px 24px -10px var(--mint);
}
.btn.primary:hover { background: var(--mint-bright); box-shadow: 0 10px 30px -8px var(--mint); }
.btn.ghost { background: none; border-color: transparent; color: var(--muted); }
.btn.ghost:hover { color: var(--text); background: var(--panel2); }
.btn .btn-ic { width: 15px; height: 15px; }

.pill {
  font-family: var(--mono); font-size: 11px; padding: 2px 9px; border-radius: 20px;
  background: var(--panel3); color: var(--muted); border: 1px solid var(--line);
}
.pill.mint { color: var(--mint); border-color: var(--mint-deep); background: rgba(47,214,156,0.08); }
.pill.warn { color: var(--amber); border-color: rgba(255,203,107,0.3); background: rgba(255,203,107,0.06); }
.pill.danger { color: var(--danger); border-color: rgba(255,107,107,0.3); background: rgba(255,107,107,0.06); }

/* ── APP SHELL: LEFT SIDEBAR + main ──────────────────────────────────────── */
.app { display: grid; grid-template-columns: 264px 1fr; height: 100vh; }

.sidebar {
  border-right: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(13,20,19,0.9), rgba(7,11,10,0.6));
  backdrop-filter: blur(6px);
  display: flex; flex-direction: column;
  padding: 26px 18px;
  min-height: 0;
}

.brand { display: flex; align-items: center; gap: 11px; padding: 0 6px 4px; }
.brand .mark {
  font-family: var(--mono); font-weight: 700; font-size: 16.5px; letter-spacing: 1px;
  color: var(--mint); white-space: nowrap;
  text-shadow: 0 0 22px rgba(47,214,156,0.4);
}
.brand .mark .b { color: var(--muted); font-weight: 500; }
.brand .tag {
  display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--mono); font-size: 8px; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--faint); margin-top: 3px; white-space: nowrap;
  background: var(--panel3); border: 1px solid var(--line2); border-radius: 20px;
  padding: 4px 6px 4px 12px;
}

/* EMBEDDED mode — hide our own brand when iframed in the Console */
.embedded .sidebar .brand { display: none; }
.embedded .sidebar { padding-top: 18px; }
.embedded .sidebar .roster-label { padding-top: 0; }

.roster-label {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--faint); padding: 24px 12px 9px;
}

.roster { display: flex; flex-direction: column; gap: 3px; overflow-y: auto; min-height: 0; }
.agent {
  display: flex; align-items: center; gap: 11px;
  width: 100%; text-align: left;
  font-family: var(--sans); font-size: 14px; font-weight: 500;
  color: var(--muted);
  background: none; border: 1px solid transparent; border-radius: var(--r-sm);
  padding: 9px 11px; cursor: pointer;
  transition: all .16s ease;
}
.agent:hover { background: var(--panel2); color: var(--text); }
.agent.sel {
  background: linear-gradient(90deg, var(--mint-glow), transparent);
  border-color: var(--line2);
  color: var(--text);
}
.agent .av {
  position: relative; width: 30px; height: 30px; flex: none;
  border-radius: 50%; background: rgba(47,214,156,0.14); border: 1px solid var(--line2);
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--mint); font-family: var(--mono); font-weight: 600; font-size: 13px; text-transform: uppercase;
}
.agent .av .pres {
  position: absolute; right: -1px; bottom: -1px;
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--mint); border: 2px solid var(--ink); box-shadow: 0 0 8px var(--mint);
}
.agent .at { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.agent .at .an { display: block; max-width: 100%; font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent.sel .at .an { color: var(--text); }
.agent .at .as { display: block; max-width: 100%; font-family: var(--mono); font-size: 10.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.roster .empty { color: var(--faint); font-style: italic; font-family: var(--sans); font-size: 12.5px; padding: 8px 11px; }

/* status pill */
.sb-status {
  margin-top: 14px; padding: 14px 6px 0; border-top: 1px solid var(--line);
  display: flex; align-items: center;
}
.status {
  font-family: var(--mono); font-size: 11.5px; color: var(--muted);
  padding: 6px 11px; background: var(--panel2); border: 1px solid var(--line);
  border-radius: 20px; display: inline-flex; align-items: center; gap: 7px; flex: none; white-space: nowrap;
}
.status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.status.live { color: var(--mint); border-color: var(--mint-deep); background: rgba(47,214,156,0.08); }
.status.live .dot { background: var(--mint); box-shadow: 0 0 10px var(--mint); animation: pulse 1.8s ease-in-out infinite; }
.status.err { color: var(--amber); border-color: rgba(255,203,107,0.3); background: rgba(255,203,107,0.06); }
.status.err .dot { background: var(--amber); box-shadow: 0 0 10px var(--amber); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

/* dev controls (sidebar footer) */
.sidebar .foot { margin-top: auto; padding: 14px 8px 0; border-top: 1px solid var(--line); }
.dev-strip {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 10.5px; color: var(--faint); letter-spacing: 0.4px;
}
.dev-strip .dl { width: 100%; text-transform: uppercase; letter-spacing: 1.4px; color: var(--amber); margin-bottom: 2px; }
.dev-strip button {
  font-family: var(--mono); font-size: 10.5px; color: var(--muted);
  background: var(--panel2); border: 1px solid var(--line); border-radius: 5px;
  padding: 3px 9px; cursor: pointer; transition: all .14s;
}
.dev-strip button:hover { color: var(--text); border-color: var(--line2); }
.dev-strip button.on { color: var(--mint); border-color: var(--mint-deep); background: rgba(47,214,156,0.08); }
.sidebar .foot .note { font-family: var(--mono); font-size: 10px; color: var(--faint); line-height: 1.7; margin-top: 12px; }
.sidebar .foot .note .d { color: var(--mint); }

/* ── SURFACE ─────────────────────────────────────────────────────────────── */
.surface { display: flex; flex-direction: column; min-width: 0; height: 100vh; overflow: hidden; }

/* ── STATE SCREENS: lock + landing ───────────────────────────────────────── */
.screen { flex: 1; display: none; align-items: center; justify-content: center; padding: 32px; overflow: auto; }
.screen.show { display: flex; }

.lock-card {
  max-width: 460px; text-align: center;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 40px 38px; box-shadow: var(--shadow);
}
.lock-card .lk-ic { color: var(--danger); display: inline-flex; filter: drop-shadow(0 0 14px rgba(255,107,107,0.4)); margin-bottom: 14px; }
.lock-card .lk-ic .ic { width: 34px; height: 34px; }
.lock-card h2 { font-size: 22px; font-weight: 800; letter-spacing: -0.4px; color: var(--text); }
.lock-card p { color: var(--muted); font-size: 14px; margin-top: 12px; }
.lock-card code {
  font-family: var(--mono); font-size: 12.5px; color: var(--mint);
  background: var(--ink); border: 1px solid var(--line2); border-radius: 5px; padding: 2px 7px;
}

.landing-card {
  max-width: 580px; width: 100%;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 34px 36px; box-shadow: var(--shadow); animation: fade .35s ease;
}
.landing-card .lc-head { display: flex; align-items: center; gap: 13px; margin-bottom: 6px; }
.landing-card .lc-head .g { color: var(--mint); display: inline-flex; filter: drop-shadow(0 0 12px rgba(47,214,156,0.45)); }
.landing-card .lc-head .g .ic { width: 26px; height: 26px; }
.landing-card h2 { font-size: 22px; font-weight: 800; letter-spacing: -0.4px; }
.landing-card .lc-hint { color: var(--muted); font-size: 14px; margin: 4px 0 22px; }
.agent-list { display: flex; flex-direction: column; gap: 9px; }
.agent-card {
  display: flex; align-items: center; gap: 13px; padding: 14px 16px;
  background: var(--panel2); border: 1px solid var(--line); border-radius: var(--r);
  cursor: pointer; text-align: left; transition: all .15s ease; width: 100%;
}
.agent-card:hover { border-color: var(--line2); background: var(--panel3); transform: translateY(-1px); }
.agent-card .g { color: var(--mint); display: inline-flex; }
.agent-card .g .ic { width: 22px; height: 22px; }
.agent-card .ac-t { flex: 1; min-width: 0; }
.agent-card .ac-t .id { font-family: var(--mono); font-weight: 700; font-size: 15px; color: var(--text); }
.agent-card .ac-t .sub { font-family: var(--mono); font-size: 11.5px; color: var(--faint); margin-top: 3px; }
.agent-card .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 10px var(--mint); flex: none; }
.agent-card:hover .arrow { color: var(--mint); transform: translateX(3px); }
.agent-card .arrow { color: var(--faint); transition: transform .16s, color .16s; display: inline-flex; }
.agent-card .arrow .ic { width: 19px; height: 19px; }
.agent-list .empty { color: var(--faint); font-style: italic; font-family: var(--sans); font-size: 13px; padding: 8px 4px; }

/* ── DASHBOARD: 2×2 grid / full-screen single panel ──────────────────────── */
.dash { flex: 1; min-height: 0; padding: 16px; display: none; gap: 16px; }
.dash.show { display: grid; }
.dash[data-view="overview"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.dash:not([data-view="overview"]) { grid-template-columns: 1fr; grid-template-rows: 1fr; }
.dash:not([data-view="overview"]) .panel { display: none; }
.dash[data-view="prompts"] .panel--prompts,
.dash[data-view="events"]  .panel--events,
.dash[data-view="beats"]   .panel--beats,
.dash[data-view="logs"]    .panel--logs { display: flex; }
.dash.view-enter { animation: viewIn .3s cubic-bezier(.2,.8,.2,1) both; }

.panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r);
  display: flex; flex-direction: column; overflow: hidden; min-height: 0;
}
.panel--prompts { border-color: var(--mint-deep); }
.panel--events  { border-color: var(--azure-deep); box-shadow: 0 0 0 1px var(--azure-glow); }
.panel--beats   { border-color: rgba(157,140,255,0.35); }
.panel--logs    { border-color: var(--gold-deep); box-shadow: 0 0 0 1px var(--gold-glow); }

.panel > header {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 11px 15px; border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel2), rgba(13,20,19,0.4));
}
.panel > header .g { color: var(--mint); display: inline-flex; }
.panel > header .g .ic { width: 18px; height: 18px; }
.panel--events > header .g { color: var(--azure); }
.panel--beats  > header .g { color: var(--violet); }
.panel--logs   > header .g { color: var(--gold); }
.panel > header h3 { font-size: 14.5px; font-weight: 700; letter-spacing: -0.2px; }
.panel > header .count {
  font-family: var(--mono); font-size: 11px; color: var(--mint);
  background: rgba(47,214,156,0.08); border: 1px solid var(--mint-deep);
  border-radius: 20px; padding: 1px 8px;
}
.panel--events > header .count { color: var(--azure); border-color: var(--azure-deep); background: var(--azure-glow); }
.panel--beats  > header .count { color: var(--violet); border-color: rgba(157,140,255,0.4); background: rgba(157,140,255,0.08); }
.panel--logs   > header .count { color: var(--gold); border-color: var(--gold-deep); background: var(--gold-glow); }
.panel > header .hc { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }

/* expand⇄return button */
.pexp {
  margin-left: 2px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--panel2); border: 1px solid var(--line2); border-radius: var(--r-sm);
  width: 30px; height: 28px; padding: 0;
  cursor: pointer; transition: border-color .15s ease, background .15s ease, color .15s ease;
}
.pexp:hover { border-color: var(--mint-deep); background: var(--panel3); color: var(--text); }
.pexp:focus-visible { outline: none; border-color: var(--mint); box-shadow: 0 0 0 3px var(--mint-glow); }
.pexp .pexp-ico { width: 15px; height: 15px; color: var(--mint); flex: none; }

.panel .body { flex: 1; overflow: auto; padding: 10px 12px; min-height: 0; }
.panel .empty { color: var(--faint); font-style: italic; font-family: var(--sans); font-size: 13px; padding: 14px 4px; }

/* segmented Readable ⇄ Raw control */
.seg { display: inline-flex; border: 1px solid var(--line2); border-radius: var(--r-sm); overflow: hidden; background: var(--ink); }
.seg button {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.3px;
  color: var(--muted); background: none; border: none; cursor: pointer;
  padding: 4px 11px; transition: all .14s;
}
.seg button:hover { color: var(--text); }
.seg button + button { border-left: 1px solid var(--line2); }
.seg button.active { background: var(--mint); color: var(--ink); font-weight: 700; }

/* toolbar */
.toolbar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel2);
}
.toolbar .chk { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.toolbar .chk .box {
  width: 17px; height: 17px; border: 1.5px solid var(--line2); border-radius: 5px; background: var(--ink);
  display: grid; place-items: center; color: transparent; transition: all .15s;
}
.toolbar .chk .box .ic { width: 12px; height: 12px; }
.toolbar .chk.on .box { background: var(--mint); border-color: var(--mint); color: var(--ink); box-shadow: 0 0 12px -2px var(--mint); }
.toolbar .chk .lbl { font-family: var(--sans); font-size: 12.5px; color: var(--muted); }
.toolbar .chk.on .lbl { color: var(--text); }
.toolbar .filter-ico { color: var(--faint); display: inline-flex; margin-left: 2px; }
.toolbar .filter-ico .ic { width: 14px; height: 14px; }
.toolbar input.tin {
  font-family: var(--mono); font-size: 11.5px; color: var(--text);
  background: var(--ink); border: 1px solid var(--line2); border-radius: var(--r-sm);
  padding: 5px 9px; outline: none; width: 130px; transition: all .15s;
}
.toolbar input.tin::placeholder { color: var(--faint); }
.toolbar input.tin:focus { border-color: var(--mint); box-shadow: 0 0 0 3px var(--mint-glow); }
.levelseg { display: inline-flex; border: 1px solid var(--line2); border-radius: var(--r-sm); overflow: hidden; background: var(--ink); }
.levelseg button {
  font-family: var(--mono); font-size: 10.5px; color: var(--muted); background: none; border: none;
  cursor: pointer; padding: 4px 9px; transition: all .14s;
}
.levelseg button + button { border-left: 1px solid var(--line2); }
.levelseg button:hover { color: var(--text); }
.levelseg button.active { background: var(--panel3); color: var(--text); }
.levelseg button.active[data-lvl="info"]  { color: var(--mint); }
.levelseg button.active[data-lvl="warn"]  { color: var(--amber); }
.levelseg button.active[data-lvl="error"] { color: var(--danger); }
.levelseg button.active[data-lvl="print"] { color: var(--sky); }

/* ── EVENT STREAM rows ───────────────────────────────────────────────────── */
.ev {
  font-family: var(--mono); font-size: 11.5px; line-height: 1.7;
  padding: 3px 8px; border-radius: 6px; display: flex; align-items: baseline; gap: 9px;
  white-space: pre-wrap; word-break: break-word; transition: background .12s;
  border-left: 2px solid transparent;
}
.ev:hover { background: var(--panel2); }
.ev .seq { color: var(--faint); flex: none; }
.ev .time { color: var(--faint); flex: none; }
.ev .kind { font-weight: 700; flex: none; }
.ev .ico { display: inline-flex; flex: none; opacity: 0.85; }
.ev .ico .ic { width: 13px; height: 13px; vertical-align: -1px; }
.ev .sum { color: var(--muted); min-width: 0; }
.ev.k-start   { border-left-color: var(--mint); }      .ev.k-start   .kind, .ev.k-start   .ico { color: var(--mint); }
.ev.k-tick    { border-left-color: var(--line2); }     .ev.k-tick    .kind, .ev.k-tick    .ico { color: var(--faint); }
.ev.k-gather  { border-left-color: var(--sky); }       .ev.k-gather  .kind, .ev.k-gather  .ico { color: var(--sky); }
.ev.k-sent    { border-left-color: var(--mint); }      .ev.k-sent    .kind, .ev.k-sent    .ico { color: var(--mint); }
.ev.k-recv    { border-left-color: var(--mint-deep); } .ev.k-recv    .kind, .ev.k-recv    .ico { color: var(--mint-bright); }
.ev.k-tool    { border-left-color: var(--violet); }    .ev.k-tool    .kind, .ev.k-tool    .ico { color: var(--violet); }
.ev.k-input   { border-left-color: var(--amber); }     .ev.k-input   .kind, .ev.k-input   .ico { color: var(--amber); }
.ev.k-output  { border-left-color: var(--mint-deep); } .ev.k-output  .kind, .ev.k-output  .ico { color: var(--mint-bright); }
.ev.k-log     { border-left-color: var(--line2); }     .ev.k-log     .kind, .ev.k-log     .ico { color: var(--muted); }
.ev.k-conv    { border-left-color: var(--sky); }       .ev.k-conv    .kind, .ev.k-conv    .ico { color: var(--sky); }

.dropped {
  color: var(--amber); font-family: var(--mono); font-size: 11px;
  padding: 6px 8px; margin-bottom: 6px; border: 1px dashed rgba(255,203,107,0.35);
  border-radius: 6px; background: rgba(255,203,107,0.05);
}

/* ── PROMPTS pairs ───────────────────────────────────────────────────────── */
.pair {
  border: 1px solid var(--line); border-radius: var(--r); margin-bottom: 12px;
  overflow: hidden; background: var(--panel2);
}
.pair .ph {
  display: flex; align-items: center; gap: 9px; padding: 8px 12px;
  font-family: var(--mono); font-size: 11px; color: var(--muted);
  background: var(--panel3); border-bottom: 1px solid var(--line);
}
.pair .ph .corr { color: var(--mint); }
.pair .ph .beatno { color: var(--faint); }
.pair .ph .badge {
  margin-left: auto; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.5px;
  padding: 2px 9px; border-radius: 20px; text-transform: uppercase;
}
.pair .ph .badge.ok      { background: rgba(47,214,156,0.1); color: var(--mint); border: 1px solid var(--mint-deep); }
.pair .ph .badge.err     { background: rgba(255,107,107,0.1); color: var(--danger); border: 1px solid rgba(255,107,107,0.4); }
.pair .ph .badge.pending { background: rgba(255,203,107,0.1); color: var(--amber); border: 1px solid rgba(255,203,107,0.4); }
.pair .seclabel {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--faint); padding: 8px 12px 4px; display: flex; align-items: center; gap: 7px;
}
.pair .seclabel.req::before  { content: "→"; color: var(--mint); }
.pair .seclabel.resp::before { content: "←"; color: var(--mint-bright); }
.pair pre {
  margin: 0; padding: 4px 14px 12px; font-family: var(--mono); font-size: 11px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; color: var(--text);
}
.pair .rdblock { padding: 4px 12px 12px; }
.pair .blk { margin-bottom: 12px; }
.pair .blk:last-child { margin-bottom: 4px; }
.pair .blk-h {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--mint-deep); margin-bottom: 5px; display: flex; align-items: center; gap: 7px;
}
.pair .blk-h .bn { color: var(--faint); }
.pair .sysblk {
  font-family: var(--mono); font-size: 11px; line-height: 1.6; color: var(--text);
  background: var(--ink); border: 1px solid var(--line); border-radius: 6px;
  padding: 8px 11px; white-space: pre-wrap; word-break: break-word;
}
.pair .sysblk .prio { color: var(--faint); float: right; }
.pair .msg { display: flex; gap: 9px; padding: 4px 0; font-family: var(--mono); font-size: 11px; line-height: 1.6; }
.pair .msg .role {
  flex: none; font-weight: 700; min-width: 64px;
}
.pair .msg .role.user      { color: var(--amber); }
.pair .msg .role.assistant { color: var(--mint); }
.pair .msg .role.tool      { color: var(--violet); }
.pair .msg .role.system    { color: var(--sky); }
.pair .msg .mc { color: var(--text); min-width: 0; word-break: break-word; }
.pair .msg .mc .tcid { color: var(--faint); }
.pair .toolchips { display: flex; flex-wrap: wrap; gap: 6px; }
.pair .toolchip {
  font-family: var(--mono); font-size: 10.5px; color: var(--violet);
  background: rgba(157,140,255,0.08); border: 1px solid rgba(157,140,255,0.3);
  border-radius: 20px; padding: 2px 10px;
}
.pair .params {
  font-family: var(--mono); font-size: 10.5px; color: var(--faint);
  display: flex; flex-wrap: wrap; gap: 5px 14px;
}
.pair .params b { color: var(--muted); font-weight: 400; }
.pair .params .pv { color: var(--mint); }
.pair .resp pre { color: var(--text); }
.pair .respmono {
  padding: 4px 14px 12px; font-family: var(--mono); font-size: 11px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word; color: var(--text);
}
.pair .respmono .mono-key { color: var(--muted); }

/* ── LOGS ────────────────────────────────────────────────────────────────── */
.log {
  display: flex; gap: 11px; padding: 3px 8px; border-radius: 5px;
  font-family: var(--mono); font-size: 11.5px; line-height: 1.7; transition: background .12s;
}
.log:hover { background: var(--panel2); }
.log .lvl { flex: 0 0 auto; width: 46px; font-weight: 700; }
.log .lvl.info  { color: var(--muted); }
.log .lvl.warn  { color: var(--amber); }
.log .lvl.error { color: var(--danger); }
.log .lvl.print { color: var(--sky); }
.log .pid { flex: 0 0 auto; color: var(--violet); }
.log .pid.core { color: var(--mint-deep); }
.log .txt { color: var(--text); white-space: pre-wrap; word-break: break-word; min-width: 0; }
.log.lvl-warn  { background: rgba(255,203,107,0.03); }
.log.lvl-error { background: rgba(255,107,107,0.04); }

/* ── PER-BEAT TIMELINE ───────────────────────────────────────────────────── */
.beat {
  border: 1px solid var(--line); border-radius: var(--r); margin-bottom: 12px;
  overflow: hidden; background: var(--panel2);
}
.beat .bh {
  display: flex; align-items: center; gap: 9px; padding: 8px 12px;
  font-family: var(--mono); font-size: 11px; color: var(--violet);
  background: var(--panel3); border-bottom: 1px solid var(--line);
}
.beat .bh .bdot { width: 7px; height: 7px; border-radius: 50%; background: var(--violet); box-shadow: 0 0 8px var(--violet); flex: none; }
.beat .bh .bmeta { color: var(--faint); }
.beat .bh .bdur { margin-left: auto; color: var(--muted); }
.beat .bh .bdur b { color: var(--mint); font-weight: 700; }
.beat .lane { padding: 6px 12px 10px; position: relative; }
.beat .step {
  display: flex; align-items: baseline; gap: 10px; padding: 3px 0;
  font-family: var(--mono); font-size: 11px; position: relative; padding-left: 20px;
}
.beat .step::before {
  content: ""; position: absolute; left: 5px; top: 8px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--line2);
}
.beat .step.s-gather::before { background: var(--sky); }
.beat .step.s-compose::before { background: var(--sky); }
.beat .step.s-sent::before   { background: var(--mint); box-shadow: 0 0 8px var(--mint); }
.beat .step.s-recv::before   { background: var(--mint-bright); }
.beat .step.s-tool::before   { background: var(--violet); box-shadow: 0 0 8px var(--violet); }
.beat .step.s-output::before { background: var(--mint-bright); }
.beat .lane::before {
  content: ""; position: absolute; left: 19.5px; top: 12px; bottom: 14px;
  width: 1px; background: var(--line);
}
.beat .step .stage { flex: none; font-weight: 700; min-width: 78px; }
.beat .step.s-gather .stage, .beat .step.s-compose .stage { color: var(--sky); }
.beat .step.s-sent .stage    { color: var(--mint); }
.beat .step.s-recv .stage    { color: var(--mint-bright); }
.beat .step.s-tool .stage    { color: var(--violet); }
.beat .step.s-output .stage  { color: var(--mint-bright); }
.beat .step .sd { color: var(--muted); min-width: 0; word-break: break-word; }
.beat .step .sd .corr { color: var(--faint); }
.beat .step .t { margin-left: auto; flex: none; color: var(--faint); font-size: 10px; }

@keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes viewIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

/* ── agent-switch transition ─────────────────────────────────────────────── */
.panel .body.agent-in { animation: viewIn .28s cubic-bezier(.2,.8,.2,1) both; }
.panel--prompts .body.agent-in { animation-delay: .00s; }
.panel--events  .body.agent-in { animation-delay: .05s; }
.panel--beats   .body.agent-in { animation-delay: .10s; }
.panel--logs    .body.agent-in { animation-delay: .15s; }
@media (prefers-reduced-motion: reduce) {
  .panel .body.agent-in { animation: none; }
}

/* ── responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 920px) {
  body { height: auto; min-height: 100vh; overflow: auto; }
  .app { grid-template-columns: 1fr; height: auto; min-height: 100vh; }
  .sidebar { border-right: none; border-bottom: 1px solid var(--line); padding: 16px 16px 12px; }
  .roster { max-height: 34vh; }
  .surface { height: auto; min-height: 60vh; }
  .dash[data-view="overview"] { grid-template-columns: 1fr; grid-template-rows: none; overflow: auto; }
  .dash[data-view="overview"] .panel { min-height: 280px; }
}
`;
