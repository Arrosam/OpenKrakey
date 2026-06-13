/**
 * inspector/page.ts — the static dashboard HTML (mirrors web's page.ts split).
 *
 * A dependency-free, single-page debug dashboard for the read-only inspector
 * plugin. It picks up the access token from `location.search` (?token=…), lists
 * the registered agents (GET /api/agents), and for the selected agent backfills
 * from /snapshot then live-streams /stream over SSE. Records are deduped by
 * `seq` and routed into four panels: Prompts, Event stream, Logs, and a
 * Per-beat timeline. No external CDN is required.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Krakey Inspector</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel2: #1c2330;
    --border: #2b3340;
    --fg: #e6edf3;
    --dim: #8b949e;
    --mint: #2fd69c;
    --blue: #58a6ff;
    --amber: #e3b341;
    --red: #ff6b6b;
    --violet: #bc8cff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: var(--panel); flex: 0 0 auto;
  }
  header .star { color: var(--mint); font-size: 18px; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  header .grow { flex: 1 1 auto; }
  header select {
    background: var(--panel2); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 9px; font: inherit;
  }
  header .status { color: var(--dim); font-size: 12px; min-width: 90px; text-align: right; }
  header .status.live { color: var(--mint); }
  header .status.err { color: var(--red); }

  #lock {
    margin: auto; max-width: 420px; text-align: center; padding: 40px;
    color: var(--dim);
  }
  #lock h2 { color: var(--red); }

  main { flex: 1 1 auto; display: grid; grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr; gap: 1px; background: var(--border);
    overflow: hidden; }
  .panel { background: var(--panel); display: flex; flex-direction: column;
    overflow: hidden; min-height: 0; }
  .panel > h2 {
    margin: 0; padding: 8px 12px; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .6px; color: var(--dim);
    border-bottom: 1px solid var(--border); background: var(--panel2);
    display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  }
  .panel > h2 .count { color: var(--mint); font-weight: 400; }
  .panel > h2 .controls { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .panel > h2 select, .panel > h2 input {
    background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 5px; padding: 2px 6px; font: 11px var(--mono);
  }
  .body { flex: 1 1 auto; overflow: auto; padding: 8px 10px; }

  .row { font: 12px var(--mono); padding: 2px 4px; border-radius: 4px;
    white-space: pre-wrap; word-break: break-word; }
  .row .seq { color: var(--dim); }
  .row .time { color: var(--dim); }
  .row .kind { font-weight: 600; margin: 0 6px; }
  .k-tick { color: var(--dim); }
  .k-gather { color: var(--violet); }
  .k-prompt-sent { color: var(--blue); }
  .k-prompt-received { color: var(--mint); }
  .k-input { color: var(--amber); }
  .k-output { color: var(--mint); }
  .k-tool { color: var(--violet); }
  .k-log { color: var(--dim); }
  .k-start { color: var(--mint); }

  .pair { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px;
    overflow: hidden; }
  .pair .ph { padding: 6px 10px; font: 11px var(--mono); background: var(--panel2);
    color: var(--dim); display: flex; gap: 8px; align-items: center; }
  .pair .ph .corr { color: var(--blue); }
  .pair .ph .badge { margin-left: auto; font-size: 10px; padding: 1px 7px;
    border-radius: 10px; }
  .pair .ph .badge.ok { background: rgba(47,214,156,.15); color: var(--mint); }
  .pair .ph .badge.err { background: rgba(255,107,107,.15); color: var(--red); }
  .pair .ph .badge.pending { background: rgba(227,179,65,.15); color: var(--amber); }
  .pair pre { margin: 0; padding: 8px 10px; font: 11px var(--mono);
    white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; }
  .pair pre + pre { border-top: 1px solid var(--border); }
  .pair .lbl { color: var(--dim); }

  .log { font: 12px var(--mono); padding: 2px 4px; display: flex; gap: 8px; }
  .log .lvl { flex: 0 0 auto; width: 48px; }
  .log .lvl.info { color: var(--blue); }
  .log .lvl.warn { color: var(--amber); }
  .log .lvl.error { color: var(--red); }
  .log .lvl.print { color: var(--mint); }
  .log .pid { color: var(--violet); flex: 0 0 auto; }
  .log .txt { white-space: pre-wrap; word-break: break-word; }

  .beat { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; }
  .beat .bh { padding: 6px 10px; background: var(--panel2); font: 11px var(--mono);
    color: var(--violet); border-bottom: 1px solid var(--border); }
  .beat .step { padding: 3px 10px; font: 11px var(--mono); display: flex; gap: 8px; }
  .beat .step .arrow { color: var(--dim); }

  .empty { color: var(--dim); font-style: italic; padding: 12px 4px; }
  .dropped { color: var(--amber); font: 11px var(--mono); padding: 4px; }
</style>
</head>
<body>
<header>
  <span class="star">✦</span>
  <h1>Krakey Inspector</h1>
  <label style="color:var(--dim);font-size:12px;">agent
    <select id="agentSel"><option value="">— none —</option></select>
  </label>
  <span class="grow"></span>
  <span class="status" id="status">idle</span>
</header>

<div id="lock" style="display:none">
  <h2>Locked</h2>
  <p>A valid access token is required. Append <code>?token=…</code> to the URL
  (the inspector printed the full URL on startup).</p>
</div>

<main id="main">
  <section class="panel">
    <h2>Prompts <span class="count" id="cPrompts">0</span></h2>
    <div class="body" id="prompts"><div class="empty">No prompts yet.</div></div>
  </section>

  <section class="panel">
    <h2>Event stream <span class="count" id="cEvents">0</span></h2>
    <div class="body" id="events"><div class="empty">No events yet.</div></div>
  </section>

  <section class="panel">
    <h2>Logs <span class="count" id="cLogs">0</span>
      <span class="controls">
        <select id="logLevel">
          <option value="">all levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="print">print</option>
        </select>
        <input id="logPid" placeholder="pluginId…" size="10" />
      </span>
    </h2>
    <div class="body" id="logs"><div class="empty">No logs yet.</div></div>
  </section>

  <section class="panel">
    <h2>Per-beat timeline <span class="count" id="cBeats">0</span></h2>
    <div class="body" id="beats"><div class="empty">No beats yet.</div></div>
  </section>
</main>

<script>
(function () {
  "use strict";

  var qs = new URLSearchParams(location.search);
  var token = qs.get("token") || "";
  var tokenQS = token ? ("?token=" + encodeURIComponent(token)) : "";

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $("status");
  var agentSel = $("agentSel");

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }
  function fmtTime(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    var p = function (n, w) { n = String(n); while (n.length < (w||2)) n = "0" + n; return n; };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
      + "." + p(d.getMilliseconds(), 3);
  }
  function pretty(v) {
    try { return typeof v === "string" ? v : JSON.stringify(v, null, 2); }
    catch (e) { return String(v); }
  }
  function get(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }

  // ---- token-gated fetch ----
  function api(path) {
    var headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetch(path, { headers: headers });
  }

  // ---- per-selection state ----
  var state = null; // { id, seen, records, es, prompts, ... }

  function freshState(id) {
    return {
      id: id,
      seen: Object.create(null),
      records: [],
      es: null,
      prompts: {},      // corrId -> { sent, received }
      promptOrder: [],  // corrIds in arrival order
      beats: [],        // [{ seq, at, label, records:[] }]
      logs: []
    };
  }

  var KIND_CLASS = {
    "agent.start": "k-start",
    "tick": "k-tick",
    "gather": "k-gather",
    "prompt.sent": "k-prompt-sent",
    "prompt.received": "k-prompt-received",
    "input": "k-input",
    "output": "k-output",
    "tool.result": "k-tool",
    "log": "k-log"
  };

  function summarize(rec) {
    var p = rec.payload;
    switch (rec.kind) {
      case "prompt.sent": {
        var t = get(p, ["data", "context", "text"]);
        return t != null ? ("len=" + String(t).length) : "(context)";
      }
      case "prompt.received": {
        if (p && p.ok === false) return "error: " + (p.error || "?");
        var d = p && p.data;
        var calls = d && d.toolCalls ? d.toolCalls.length : 0;
        var clen = d && typeof d.content === "string" ? d.content.length : 0;
        return "content len=" + clen + (calls ? (", toolCalls=" + calls) : "");
      }
      case "input": return JSON.stringify(get(p, ["data", "text"]) || "");
      case "output": return JSON.stringify(get(p, ["data", "text"]) || "");
      case "tool.result": {
        var nm = p && p.name ? p.name : "?";
        return nm + (p && p.ok === false ? " (error)" : " ok");
      }
      case "log": {
        return (get(p, ["data", "level"]) || "?") + " "
          + (get(p, ["data", "pluginId"]) || "?") + ": "
          + (get(p, ["data", "text"]) || "");
      }
      case "tick": return "seq=" + (get(p, ["data", "seq"]));
      case "gather": return "seq=" + (get(p, ["data", "seq"]));
      case "agent.start": return get(p, ["data", "agentId"]) || "";
      default: return "";
    }
  }

  // ---- panel 2: event stream (auto-scroll, pause on scroll up) ----
  var eventsBody = $("events");
  var pinned = true;
  eventsBody.addEventListener("scroll", function () {
    pinned = (eventsBody.scrollHeight - eventsBody.scrollTop - eventsBody.clientHeight) < 24;
  });
  function renderEventRow(rec) {
    var div = document.createElement("div");
    div.className = "row";
    var cls = KIND_CLASS[rec.kind] || "";
    div.innerHTML = '<span class="seq">#' + rec.seq + '</span> '
      + '<span class="time">' + fmtTime(rec.at) + '</span>'
      + '<span class="kind ' + cls + '">' + esc(rec.kind) + '</span>'
      + esc(summarize(rec));
    return div;
  }

  // ---- panel 1: prompts ----
  var promptsBody = $("prompts");
  function renderPrompts(s) {
    promptsBody.innerHTML = "";
    if (!s.promptOrder.length) {
      promptsBody.innerHTML = '<div class="empty">No prompts yet.</div>';
      return;
    }
    for (var i = 0; i < s.promptOrder.length; i++) {
      var cid = s.promptOrder[i];
      var pr = s.prompts[cid];
      var div = document.createElement("div");
      div.className = "pair";
      var badge, bcls;
      if (!pr.received) { badge = "pending"; bcls = "pending"; }
      else if (pr.received.payload && pr.received.payload.ok === false) { badge = "error"; bcls = "err"; }
      else { badge = "ok"; bcls = "ok"; }

      var sentText = pr.sent ? (get(pr.sent.payload, ["data", "context", "text"]) || "") : "(no request captured)";
      var recvBlock = "(awaiting response…)";
      if (pr.received) {
        var rp = pr.received.payload;
        if (rp && rp.ok === false) {
          recvBlock = "error: " + (rp.error || "?");
        } else {
          var d = rp && rp.data;
          recvBlock = pretty({
            content: d && d.content,
            toolCalls: d && d.toolCalls,
            stopReason: d && d.stopReason,
            usage: d && d.usage
          });
        }
      }
      div.innerHTML =
        '<div class="ph">corr <span class="corr">' + esc(cid) + '</span>'
        + '<span class="badge ' + bcls + '">' + badge + '</span></div>'
        + '<pre><span class="lbl">request →</span>\\n' + esc(sentText) + '</pre>'
        + '<pre><span class="lbl">← response</span>\\n' + esc(recvBlock) + '</pre>';
      promptsBody.appendChild(div);
    }
  }

  // ---- panel 3: logs (filtered) ----
  var logsBody = $("logs");
  var logLevel = $("logLevel");
  var logPid = $("logPid");
  logLevel.addEventListener("change", function () { renderLogs(state); });
  logPid.addEventListener("input", function () { renderLogs(state); });
  function renderLogs(s) {
    if (!s) return;
    logsBody.innerHTML = "";
    var lvl = logLevel.value;
    var pidF = logPid.value.trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < s.logs.length; i++) {
      var d = get(s.logs[i].payload, ["data"]) || {};
      if (lvl && d.level !== lvl) continue;
      if (pidF && String(d.pluginId || "").toLowerCase().indexOf(pidF) === -1) continue;
      var row = document.createElement("div");
      row.className = "log";
      row.innerHTML = '<span class="lvl ' + esc(d.level || "") + '">' + esc(d.level || "?") + '</span>'
        + '<span class="pid">' + esc(d.pluginId || "?") + '</span>'
        + '<span class="txt">' + esc(d.text || "") + '</span>';
      logsBody.appendChild(row);
      shown++;
    }
    if (!shown) logsBody.innerHTML = '<div class="empty">No matching logs.</div>';
  }

  // ---- panel 4: per-beat timeline ----
  var beatsBody = $("beats");
  function renderBeats(s) {
    beatsBody.innerHTML = "";
    if (!s.beats.length) {
      beatsBody.innerHTML = '<div class="empty">No beats yet.</div>';
      return;
    }
    for (var i = 0; i < s.beats.length; i++) {
      var b = s.beats[i];
      var div = document.createElement("div");
      div.className = "beat";
      var html = '<div class="bh">beat — ' + esc(b.label || ("#" + b.seq)) + ' · '
        + fmtTime(b.at) + ' · ' + b.records.length + ' events</div>';
      // order: sent -> received -> output/tool.result, surfacing corrId links
      for (var j = 0; j < b.records.length; j++) {
        var r = b.records[j];
        var cls = KIND_CLASS[r.kind] || "";
        var corr = r.corrId ? (' <span class="arrow">·</span> corr ' + esc(r.corrId)) : "";
        html += '<div class="step"><span class="kind ' + cls + '">' + esc(r.kind)
          + '</span><span class="arrow">→</span>' + esc(summarize(r)) + corr + '</div>';
      }
      div.innerHTML = html;
      beatsBody.appendChild(div);
    }
  }

  // ---- record routing ----
  function ingest(s, rec) {
    var key = rec.seq;
    if (s.seen[key]) return;
    s.seen[key] = true;
    s.records.push(rec);

    // event stream
    var emptyEv = eventsBody.querySelector(".empty");
    if (emptyEv) emptyEv.remove();
    eventsBody.appendChild(renderEventRow(rec));
    if (pinned) eventsBody.scrollTop = eventsBody.scrollHeight;
    $("cEvents").textContent = s.records.length;

    // prompts pairing
    if ((rec.kind === "prompt.sent" || rec.kind === "prompt.received") && rec.corrId) {
      if (!s.prompts[rec.corrId]) { s.prompts[rec.corrId] = {}; s.promptOrder.push(rec.corrId); }
      if (rec.kind === "prompt.sent") s.prompts[rec.corrId].sent = rec;
      else s.prompts[rec.corrId].received = rec;
      renderPrompts(s);
      $("cPrompts").textContent = s.promptOrder.length;
    }

    // logs
    if (rec.kind === "log") {
      s.logs.push(rec);
      renderLogs(s);
      $("cLogs").textContent = s.logs.length;
    }

    // beats: a new beat opens at tick/gather; everything else joins the current
    // beat (records before the first boundary form an implicit pre-beat).
    if (rec.kind === "tick" || rec.kind === "gather") {
      s.beats.push({ seq: rec.seq, at: rec.at,
        label: rec.kind + " " + (get(rec.payload, ["data", "seq"])), records: [rec] });
    } else {
      if (!s.beats.length) s.beats.push({ seq: rec.seq, at: rec.at, label: "pre-beat", records: [] });
      s.beats[s.beats.length - 1].records.push(rec);
    }
    renderBeats(s);
    $("cBeats").textContent = s.beats.length;
  }

  function resetPanels() {
    promptsBody.innerHTML = '<div class="empty">No prompts yet.</div>';
    eventsBody.innerHTML = '<div class="empty">No events yet.</div>';
    logsBody.innerHTML = '<div class="empty">No logs yet.</div>';
    beatsBody.innerHTML = '<div class="empty">No beats yet.</div>';
    $("cPrompts").textContent = "0";
    $("cEvents").textContent = "0";
    $("cLogs").textContent = "0";
    $("cBeats").textContent = "0";
  }

  // ---- selection / connection ----
  function disconnect() {
    if (state && state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
  }

  function select(id) {
    disconnect();
    resetPanels();
    if (!id) { state = null; setStatus("idle"); return; }
    state = freshState(id);
    setStatus("loading…");

    // 1) backfill via snapshot, THEN open the live stream (no replay overlap)
    api("/api/agents/" + encodeURIComponent(id) + "/snapshot" + tokenQS)
      .then(function (r) {
        if (r.status === 401) { showLock(); throw new Error("401"); }
        if (!r.ok) throw new Error("snapshot " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!state || state.id !== id) return; // selection changed mid-flight
        var recs = (data && data.records) || [];
        for (var i = 0; i < recs.length; i++) ingest(state, recs[i]);
        if (data && data.dropped) {
          var d = document.createElement("div");
          d.className = "dropped";
          d.textContent = "⚠ " + data.dropped + " older records were dropped (ring full).";
          eventsBody.insertBefore(d, eventsBody.firstChild);
        }
        openStream(id);
      })
      .catch(function (e) {
        if (String(e.message) !== "401") setStatus("error: " + e.message, "err");
      });
  }

  function openStream(id) {
    // EventSource cannot set an Authorization header; the token rides as a query
    // param (the server also accepts the inspector_token cookie set by GET /).
    var url = "/api/agents/" + encodeURIComponent(id) + "/stream" + tokenQS;
    var es = new EventSource(url);
    state.es = es;
    es.onopen = function () { setStatus("live", "live"); };
    es.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg && msg.type === "record" && state && msg.record) ingest(state, msg.record);
      } catch (e) {}
    };
    es.onerror = function () {
      // EventSource auto-reconnects; surface state without tearing down.
      setStatus("reconnecting…", "err");
    };
  }

  function showLock() {
    document.getElementById("main").style.display = "none";
    document.getElementById("lock").style.display = "block";
    setStatus("locked", "err");
  }

  agentSel.addEventListener("change", function () { select(agentSel.value); });

  // ---- agent list (poll lightly so new agents appear) ----
  function loadAgents() {
    api("/api/agents" + tokenQS)
      .then(function (r) {
        if (r.status === 401) { showLock(); throw new Error("401"); }
        if (!r.ok) throw new Error("agents " + r.status);
        return r.json();
      })
      .then(function (data) {
        var ids = (data && data.agents) || [];
        var cur = agentSel.value;
        var existing = {};
        for (var i = 0; i < agentSel.options.length; i++) existing[agentSel.options[i].value] = true;
        for (var j = 0; j < ids.length; j++) {
          if (!existing[ids[j]]) {
            var o = document.createElement("option");
            o.value = ids[j]; o.textContent = ids[j];
            agentSel.appendChild(o);
          }
        }
        if (!cur && ids.length === 1) { agentSel.value = ids[0]; select(ids[0]); }
      })
      .catch(function (e) {
        if (String(e.message) !== "401") setStatus("error: " + e.message, "err");
      });
  }

  loadAgents();
  setInterval(loadAgents, 5000);
})();
</script>
</body>
</html>`;
