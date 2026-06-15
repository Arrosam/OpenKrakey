/**
 * inspector/page.style.ts — the dashboard CSS, split out of page.ts (SRP).
 *
 * Holds exactly the content of the page's <style>…</style> block (the leading
 * newline + the CSS rules). page.ts re-wraps it in the <style> tags, so the
 * assembled PAGE stays byte-identical. No logic — a single exported string.
 */
export const STYLE = `
  :root {
    --bg: #0d1210;
    --panel: #171e1a;
    --panel-2: #1c2521;
    --border: #28322c;
    --text: #e7ece9;
    --muted: #7b847e;
    --cyan: #2fd69c;
    --green: #7ec77e;
    --yellow: #e8c060;
    --magenta: #5cc8b0;
    --red: #d27575;
    --mono: ui-monospace, "Consolas", "Cascadia Code", monospace;
  }
  * { box-sizing: border-box; }
  * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--cyan); }
  ::-webkit-scrollbar-corner { background: transparent; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.5 var(--mono);
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }

  /* ---- header: brand + tabs + agent selector + status ---- */
  header {
    display: flex; align-items: center; gap: 16px;
    padding: 6px 12px; border-bottom: 1px solid var(--border);
    background: var(--panel); flex: 0 0 auto;
  }
  .brand {
    display: flex; align-items: center; gap: 8px;
  }
  .brand-name { font-size: 13px; font-weight: 700; }
  .brand-tag { font-size: 10px; color: var(--muted); }
  .tabs { display: flex; gap: 4px; flex: 1; }
  .tab-btn {
    background: transparent; border: 1px solid transparent; color: var(--muted);
    padding: 6px 14px; border-radius: 4px; cursor: pointer;
    font: 13px var(--mono);
  }
  .tab-btn:hover { color: var(--text); background: var(--panel-2); }
  .tab-btn.active { color: var(--text); background: var(--panel-2); border-color: var(--border); }
  header select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 8px; font: inherit;
  }
  .status-bar {
    font-size: 11px; color: var(--muted);
    padding: 4px 8px; background: var(--panel-2);
    border: 1px solid var(--border); border-radius: 4px;
  }
  .status-bar.live { color: var(--green); }
  .status-bar.err { color: var(--red); }

  #lock {
    margin: auto; max-width: 420px; text-align: center; padding: 40px;
    color: var(--muted);
  }
  #lock h2 { color: var(--red); }

  /* ---- landing: shown whenever no agent is selected ---- */
  #landing { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; overflow: auto; }
  .landing-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 24px 28px; max-width: 560px; width: 100%;
  }
  .landing-card h2 { margin: 0 0 4px; font-size: 16px; color: var(--text); }
  .landing-hint { margin: 0 0 16px; font-size: 12px; color: var(--muted); }
  .agent-list { display: flex; flex-direction: column; gap: 8px; }
  .agent-card {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; color: var(--text); font: 13px var(--mono); text-align: left;
  }
  .agent-card:hover { border-color: var(--cyan); color: var(--cyan); }
  .agent-card .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: 0 0 auto; }
  .agent-card .id { font-weight: bold; }

  /* ---- main: tabbed views via data-view (single render targets) ---- */
  main {
    flex: 1; overflow: hidden; padding: 12px;
    display: grid; gap: 12px; min-height: 0;
  }
  main[data-view="overview"] {
    grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
  }
  main:not([data-view="overview"]) {
    grid-template-columns: 1fr; grid-template-rows: 1fr;
  }
  main:not([data-view="overview"]) .panel { display: none; }
  main[data-view="prompts"] .panel--prompts,
  main[data-view="events"] .panel--events,
  main[data-view="beats"] .panel--beats,
  main[data-view="logs"] .panel--logs { display: flex; }

  .panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    display: flex; flex-direction: column; overflow: hidden; min-height: 0;
  }
  .panel.cyan { border-color: var(--cyan); }
  .panel.magenta { border-color: var(--magenta); }
  .panel.green { border-color: var(--green); }
  .panel.yellow { border-color: var(--yellow); }
  .panel.red { border-color: var(--red); }

  /* uniform title bar — identical height/structure across all four panels */
  .panel h3 {
    margin: 0; padding: 6px 10px; font-size: 12px; color: var(--muted);
    background: var(--panel-2); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  }
  .panel h3 .count { color: var(--cyan); font-weight: 400; }
  .panel.cyan h3 { color: var(--cyan); }
  .panel.magenta h3 { color: var(--magenta); }
  .panel.green h3 { color: var(--green); }
  .panel.yellow h3 { color: var(--yellow); }
  .panel.red h3 { color: var(--red); }

  /* segmented Readable|Raw toggle in the Prompts panel header */
  .pv-toggle { display: inline-flex; margin-left: auto; gap: 0; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .pv-btn {
    background: var(--panel); color: var(--muted); border: none; cursor: pointer;
    padding: 2px 8px; font: 10px var(--mono);
  }
  .pv-btn:hover { color: var(--text); background: var(--bg); }
  .pv-btn + .pv-btn { border-left: 1px solid var(--border); }
  .pv-btn.active { background: var(--cyan); color: var(--bg); }

  .toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 10px; border-bottom: 1px solid var(--border);
    background: var(--panel); flex: 0 0 auto; font-size: 11px;
  }
  .toolbar label { display: flex; align-items: center; gap: 4px; color: var(--muted); }
  .toolbar select, .toolbar input {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 2px 6px; font: 11px var(--mono);
  }
  .body { flex: 1; overflow: auto; padding: 8px 10px; min-height: 0; }

  .row { font: 12px var(--mono); padding: 2px 4px; border-radius: 4px;
    white-space: pre-wrap; word-break: break-word; }
  .row .seq { color: var(--muted); }
  .row .time { color: var(--muted); }
  .row .kind { font-weight: 600; margin: 0 6px; }
  .k-tick { color: var(--muted); }
  .k-gather { color: var(--magenta); }
  .k-prompt-sent { color: var(--cyan); }
  .k-prompt-received { color: var(--green); }
  .k-input { color: var(--yellow); }
  .k-output { color: var(--green); }
  .k-tool { color: var(--magenta); }
  .k-conversation { color: var(--cyan); }
  .k-log { color: var(--muted); }
  .k-start { color: var(--green); }

  .pair { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px;
    overflow: hidden; }
  .pair .ph { padding: 6px 10px; font: 11px var(--mono); background: var(--panel-2);
    color: var(--muted); display: flex; gap: 8px; align-items: center; }
  .pair .ph .corr { color: var(--cyan); }
  .pair .ph .badge { margin-left: auto; font-size: 10px; padding: 1px 7px;
    border-radius: 10px; }
  .pair .ph .badge.ok { background: rgba(126,199,126,.15); color: var(--green); }
  .pair .ph .badge.err { background: rgba(210,117,117,.15); color: var(--red); }
  .pair .ph .badge.pending { background: rgba(232,192,96,.15); color: var(--yellow); }
  .pair pre { margin: 0; padding: 8px 10px; font: 11px var(--mono);
    white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; }
  .pair pre + pre { border-top: 1px solid var(--border); }
  .pair .lbl { color: var(--muted); }

  .log { font: 12px var(--mono); padding: 2px 4px; display: flex; gap: 8px; }
  .log .lvl { flex: 0 0 auto; width: 48px; }
  .log .lvl.info { color: var(--cyan); }
  .log .lvl.warn { color: var(--yellow); }
  .log .lvl.error { color: var(--red); }
  .log .lvl.print { color: var(--green); }
  .log .pid { color: var(--magenta); flex: 0 0 auto; }
  .log .txt { white-space: pre-wrap; word-break: break-word; }

  .beat { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; }
  .beat .bh { padding: 6px 10px; background: var(--panel-2); font: 11px var(--mono);
    color: var(--magenta); border-bottom: 1px solid var(--border); }
  .beat .step { padding: 3px 10px; font: 11px var(--mono); display: flex; gap: 8px; }
  .beat .step .arrow { color: var(--muted); }

  .empty { color: var(--muted); font-style: italic; padding: 12px 4px; }
  .dropped { color: var(--yellow); font: 11px var(--mono); padding: 4px; }
`;
