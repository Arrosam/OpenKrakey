/**
 * inspector/page.script.ts — the dashboard client script, split out of page.ts (SRP).
 *
 * Holds exactly the content of the page's <script>…</script> block. It is a
 * dependency-free IIFE that token-gates its fetches, lists agents, backfills via
 * /snapshot then live-streams /stream over SSE, and renders the four panels.
 * page.ts re-wraps it in the <script> tags.
 *
 * This is the cockpit re-skin (ported from design/inspector-mock/app.js) grafted
 * ONTO the unchanged data layer. The look/interactions are new — a LEFT SIDEBAR
 * agent roster (replacing the old header dropdown), a status pill, lock/landing
 * states, four accent-colored panels in a 2×2 grid each with an icon-only
 * expand⇄return button (no tab bar), a Logs auto-follow toggle mirroring the
 * event stream's, and an agent-switch slide-up transition — but every load-bearing
 * behavior is preserved: token-gated fetch, GET /api/agents, /snapshot backfill,
 * /stream SSE, seq-dedup (lastSeq), chooseSent prompt pairing by corrId, the
 * readable⇄raw Prompts toggle (raw = formatRequest), core:* log filtering,
 * truncation + dropped-record affordances, and the ring caps.
 *
 * The page embeds page.format helpers (formatRequest, chooseSent) via `.toString()`;
 * they MUST stay flat (no nested function expressions) so the served SCRIPT
 * references no bundler `__name` helper (it would be undefined in the browser).
 */
import { formatRequest, chooseSent } from "./page.format";

export const SCRIPT = `
(function () {
  "use strict";

  var qs = new URLSearchParams(location.search);
  var token = qs.get("token") || "";
  var tokenQS = token ? ("?token=" + encodeURIComponent(token)) : "";

  var \$ = function (id) { return document.getElementById(id); };
  var rosterEl = \$("roster");
  var statusEl = \$("status");
  var landingEl = \$("landing");
  var lockEl = \$("lock");
  var mainEl = \$("main");
  var agentListEl = \$("agentList");

  // EMBEDDED mode — inside the unified Console iframe the Console already shows a
  // global brand, so hide our own. window.self !== window.top is true in any
  // iframe (works cross-origin). Standalone keeps the brand as-is.
  var embedded = false;
  try { embedded = window.self !== window.top; } catch (e) { embedded = true; }
  if (embedded) document.documentElement.classList.add("embedded");

  // ---- helpers ----
  function setStatus(text, cls) {
    statusEl.className = "status" + (cls ? " " + cls : "");
    var t = statusEl.querySelector(".st-text");
    if (t) t.textContent = text;
  }
  // esc(): escape ALL of & < > " ' — it is used inside HTML ATTRIBUTES (e.g.
  // class="lvl …"), so quotes MUST be entity-encoded to prevent attribute-injection.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;"
        : c === '"' ? "&quot;" : "&#39;";
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
  var formatRequest = ${formatRequest.toString()};
  var chooseSent = ${chooseSent.toString()};

  // ---- inline SVG icon set (config-web stroke style) ----
  var ICONS = {
    stars: '<path d="M12 3c.4 3.6 1.4 4.6 5 5-3.6.4-4.6 1.4-5 5-.4-3.6-1.4-4.6-5-5 3.6-.4 4.6-1.4 5-5z"/><path d="M18.5 13.5c.2 1.7.6 2.1 2 2.3-1.4.2-1.8.6-2 2.3-.2-1.7-.6-2.1-2-2.3 1.4-.2 1.8-.6 2-2.3z"/>',
    robot: '<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4.6"/><circle cx="12" cy="3.4" r="1.2"/><circle cx="9.2" cy="13.5" r="1.3"/><circle cx="14.8" cy="13.5" r="1.3"/><path d="M9.5 17h5"/><path d="M2 12.5v3M22 12.5v3"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
    chat: '<path d="M20.5 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 20.5 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
    journal: '<rect x="5.5" y="3" width="13" height="18" rx="2"/><path d="M9 7.5h6M9 11.5h6M9 15.5h4"/>',
    arrowRight: '<path d="M4 12h15M13 6l6 6-6 6"/>',
    expand: '<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>',
    minimize: '<path d="M4.5 9H9V4.5M19.5 9H15V4.5M4.5 15H9v4.5M19.5 15H15v4.5"/>',
    box: '<rect x="4" y="4" width="16" height="16" rx="2.5"/>',
    tick: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 1.7"/>',
    send: '<path d="M5 12h13M12 6l6 6-6 6"/><path d="M3.5 12h.01"/>',
    receive: '<path d="M19 12H6M12 6l-6 6 6 6"/><path d="M20.5 12h.01"/>',
    wrench: '<path d="M15.5 7.5a4 4 0 0 1-5.2 5.2L5 18l1 1 5.3-5.3a4 4 0 0 0 5.2-5.2l-2.3 2.3-2-2 2.3-2.3z"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'
  };
  function icon(name, cls) {
    var p = ICONS[name];
    if (!p) return "";
    return '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  // ---- token-gated fetch ----
  function api(path) {
    var headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetch(path, { headers: headers });
  }

  // ---- per-selection state ----
  var state = null; // { id, lastSeq, records, es, prompts, ... }
  var promptView = "readable";
  var currentLevel = "";   // log level filter
  var currentView = "overview";

  // ---- Logs source mode (live ⇄ query) ----
  // logSource: "live" mirrors the in-memory ring (unchanged behavior); "query"
  // shows the result of GET /api/agents/:id/query and live-tails matching records.
  var logSource = "live";
  var logRange = "live";       // "live" | "all" | "<sinceMs>"
  var logTypes = {};            // kind -> true (selected). empty object = all (no type filter).

  function freshState(id) {
    return {
      id: id,
      lastSeq: -1,      // monotonic high-water mark for dedup (seq is server-monotonic)
      records: [],
      es: null,
      prompts: {},      // corrId -> { sent, received }
      promptOrder: [],  // corrIds in arrival order
      frames: [],       // [{ seq, at, label, records:[] }]
      logs: [],
      queryRecords: [], // last query result (oldest→newest), live-tailed in query mode
      queryTotal: 0,    // server-reported filtered count BEFORE the limit tail
      queryRan: false   // a query has been run for this selection
    };
  }

  // The dashboard kind values captured by the server (incl. context.full). Drives
  // the Logs type multi-select; "log" stays first so the common pick is at the top.
  var ALL_KINDS = [
    "log", "agent.start", "tick", "gather", "prompt.sent", "prompt.received",
    "input", "output", "tool.result", "context.full"
  ];

  var KIND_CLASS = {
    "agent.start": "k-start",
    "tick": "k-tick",
    "gather": "k-gather",
    "prompt.sent": "k-sent",
    "prompt.received": "k-recv",
    "input": "k-input",
    "output": "k-output",
    "tool.result": "k-tool",
    "conversation": "k-conv",
    "context.full": "k-gather",
    "log": "k-log"
  };
  var KIND_ICON = {
    "agent.start": "stars", "tick": "tick", "gather": "layers", "prompt.sent": "send",
    "prompt.received": "receive", "input": "chat", "output": "chat", "tool.result": "wrench",
    "conversation": "journal", "context.full": "layers", "log": "terminal"
  };

  function summarize(rec) {
    var p = rec.payload;
    if (p && p.__truncated) return "⚠ truncated (" + p.bytes + " bytes)";
    switch (rec.kind) {
      case "prompt.sent": {
        var rq = get(p, ["data", "request"]);
        if (rq) {
          var mc = Array.isArray(rq.messages) ? rq.messages.length : 0;
          var tc = Array.isArray(rq.tools) ? rq.tools.length : 0;
          return "messages=" + mc + (tc ? (", tools=" + tc) : "");
        }
        var ms = get(p, ["data", "messages"]);
        if (Array.isArray(ms)) return "messages=" + ms.length;
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
      case "context.full": {
        var ov = get(p, ["data", "overBy"]);
        var rd = get(p, ["data", "round"]);
        return "overBy=" + (ov != null ? ov : "?") + (rd != null ? (", round=" + rd) : "");
      }
      case "agent.start": return get(p, ["data", "agentId"]) || "";
      case "conversation": { var msgs = get(p, ["data", "messages"]); return (Array.isArray(msgs) ? msgs.length : 0) + " turns"; }
      default: return "";
    }
  }

  // ---- caps: bound retained state + DOM so a long session never degrades ----
  var CAP_EVENTS = 600;   // event-stream rows (records[] and DOM .ev nodes)
  var CAP_PROMPTS = 200;  // prompt pairs (promptOrder + prompts map)
  var CAP_LOGS = 600;     // log records
  var CAP_FRAMES = 200;   // frame groups

  // ---- panel: event stream (explicit auto-follow toggle is the master) ----
  var eventsBody = \$("events");
  var autoFollow = \$("autoFollow"); // a .chk label; ".on" class is the checked state
  // Our own programmatic scrolls (backfill/append/expand) fire a scroll event too;
  // this flag lets the listener ignore them so auto-follow isn't spuriously cleared.
  var programmaticScroll = false;
  function followOn(chk) { return chk && chk.classList.contains("on"); }
  function pinEvents() {
    programmaticScroll = true;
    eventsBody.scrollTop = eventsBody.scrollHeight;
  }
  eventsBody.addEventListener("scroll", function () {
    if (programmaticScroll) { programmaticScroll = false; return; }
    var atBottom = (eventsBody.scrollHeight - eventsBody.scrollTop - eventsBody.clientHeight) < 24;
    if (!atBottom && followOn(autoFollow)) autoFollow.classList.remove("on");
  });
  autoFollow.addEventListener("click", function () {
    autoFollow.classList.toggle("on");
    if (followOn(autoFollow)) pinEvents();
  });
  function makeEventRow(rec) {
    var div = document.createElement("div");
    var cls = KIND_CLASS[rec.kind] || "";
    div.className = "ev " + cls;
    var ico = KIND_ICON[rec.kind] || "box";
    div.innerHTML = '<span class="seq">#' + rec.seq + '</span>'
      + '<span class="time">' + fmtTime(rec.at) + '</span>'
      + '<span class="ico">' + icon(ico) + '</span>'
      + '<span class="kind">' + esc(rec.kind) + '</span>'
      + '<span class="sum">' + esc(summarize(rec)) + '</span>';
    return div;
  }
  // Full rebuild from state — used once after a backfill (NOT per record).
  function renderEvents(s) {
    eventsBody.innerHTML = "";
    if (!s.records.length) {
      eventsBody.innerHTML = '<div class="empty">No events yet.</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < s.records.length; i++) frag.appendChild(makeEventRow(s.records[i]));
    eventsBody.appendChild(frag);
    if (followOn(autoFollow)) pinEvents();
  }
  // Cheap incremental append for a single LIVE record; trims oldest DOM rows.
  function appendEventRow(rec) {
    var emptyEv = eventsBody.querySelector(".empty");
    if (emptyEv) emptyEv.remove();
    eventsBody.appendChild(makeEventRow(rec));
    var rows = eventsBody.querySelectorAll(".ev");
    while (rows.length > CAP_EVENTS) {
      rows[0].remove();
      rows = eventsBody.querySelectorAll(".ev");
    }
    if (followOn(autoFollow)) pinEvents();
  }

  // ---- panel: prompts (readable ⇄ raw) ----
  var promptsBody = \$("prompts");

  // Readable view: render the assembled request as discrete blocks. The system
  // string is split back into its priority blocks; messages render with role
  // colors; tools become chips; params are listed. The RAW view uses the real
  // formatRequest(payload, "raw") so it matches the wire 1:1.
  function renderRequestReadable(req) {
    if (!req) return '<div class="respmono">(no request captured)</div>';
    var html = '<div class="rdblock">';
    if (typeof req.system === "string" && req.system) {
      html += '<div class="blk"><div class="blk-h">system prompt <span class="bn">· composed by priority</span></div>';
      var blocks = req.system.split("\\n\\n");
      for (var bi = 0; bi < blocks.length; bi++) {
        var b = blocks[bi];
        var m = b.match(/^\\[(.+?)\\]\\n?([\\s\\S]*)\$/);
        if (m) html += '<div class="sysblk"><span class="prio">' + esc(m[1]) + '</span>' + esc(m[2].replace(/^\\s+|\\s+\$/g, "")) + '</div>';
        else html += '<div class="sysblk">' + esc(b) + '</div>';
      }
      html += '</div>';
    }
    if (Array.isArray(req.messages) && req.messages.length) {
      html += '<div class="blk"><div class="blk-h">messages <span class="bn">· ' + req.messages.length + '</span></div>';
      for (var mi = 0; mi < req.messages.length; mi++) {
        var msg = req.messages[mi] || {};
        var role = msg.role || "?";
        var body = typeof msg.content === "string" ? msg.content : (msg.content == null ? "" : JSON.stringify(msg.content));
        var extra = "";
        if (typeof msg.toolCallId === "string") extra += ' <span class="tcid">[toolCallId=' + esc(msg.toolCallId) + ']</span>';
        if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
          var names = [];
          for (var ti = 0; ti < msg.toolCalls.length; ti++) { var tc = msg.toolCalls[ti] || {}; names.push(tc.name != null ? tc.name : "?"); }
          extra += ' <span class="tcid">→ calls ' + esc(names.join(", ")) + '</span>';
        }
        var nm = (typeof msg.name === "string" && msg.name) ? (' (' + esc(msg.name) + ')') : "";
        html += '<div class="msg"><span class="role ' + esc(role) + '">' + esc(role) + nm + '</span><span class="mc">' + esc(body) + extra + '</span></div>';
      }
      html += '</div>';
    }
    if (Array.isArray(req.tools) && req.tools.length) {
      html += '<div class="blk"><div class="blk-h">tools <span class="bn">· ' + req.tools.length + '</span></div><div class="toolchips">';
      for (var oi = 0; oi < req.tools.length; oi++) { var t = req.tools[oi] || {}; html += '<span class="toolchip">' + esc(t.name != null ? t.name : "?") + '</span>'; }
      html += '</div></div>';
    }
    var pp = [];
    if (typeof req.model === "string") pp.push(["model", req.model]);
    if (typeof req.temperature === "number") pp.push(["temperature", req.temperature]);
    if (typeof req.maxTokens === "number") pp.push(["maxTokens", req.maxTokens]);
    if (pp.length) {
      html += '<div class="blk"><div class="blk-h">params</div><div class="params">';
      for (var pi = 0; pi < pp.length; pi++) html += '<span><b>' + esc(pp[pi][0]) + '</b> <span class="pv">' + esc(pp[pi][1]) + '</span></span>';
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  }

  function renderPrompts(s) {
    promptsBody.innerHTML = "";
    if (!s.promptOrder.length) {
      promptsBody.innerHTML = '<div class="empty">No prompts yet.</div>';
      return;
    }
    // Index corrId -> frame number for a friendly correlation crumb.
    var frameOf = {};
    for (var bj = 0; bj < s.frames.length; bj++) {
      var brecs = s.frames[bj].records;
      for (var rj = 0; rj < brecs.length; rj++) if (brecs[rj].corrId) frameOf[brecs[rj].corrId] = bj;
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

      var sentTrunc = pr.sent && pr.sent.payload && pr.sent.payload.__truncated;
      var req = (pr.sent && !sentTrunc) ? get(pr.sent.payload, ["data", "request"]) : null;

      var inner = '<div class="ph">corr <span class="corr">' + esc(cid) + '</span>'
        + (frameOf[cid] != null ? ('<span class="frameno">· frame #' + frameOf[cid] + '</span>') : "")
        + '<span class="badge ' + bcls + '">' + badge + '</span></div>';

      // ---- request block (readable vs raw); truncation surfaced verbatim ----
      inner += '<div class="seclabel req">request</div>';
      if (sentTrunc) {
        inner += '<div class="respmono">⚠ truncated (' + pr.sent.payload.bytes + ' bytes)</div>';
      } else if (promptView === "raw") {
        inner += '<pre>' + esc(formatRequest(pr.sent ? pr.sent.payload : {}, "raw")) + '</pre>';
      } else if (req) {
        inner += renderRequestReadable(req);
      } else {
        // No assembled data.request (e.g. plain llm.request fallback): show the
        // real readable formatter output so nothing is lost.
        inner += '<pre>' + esc(formatRequest(pr.sent ? pr.sent.payload : {}, "readable")) + '</pre>';
      }

      // ---- response block ----
      inner += '<div class="seclabel resp">response</div>';
      if (!pr.received) {
        inner += '<div class="respmono">(awaiting response…)</div>';
      } else {
        var rp = pr.received.payload;
        if (rp && rp.__truncated) {
          inner += '<div class="respmono">⚠ truncated (' + rp.bytes + ' bytes)</div>';
        } else if (rp && rp.ok === false) {
          inner += '<div class="respmono" style="color:var(--danger)">error: ' + esc(rp.error || "?") + '</div>';
        } else if (promptView === "raw") {
          var dr = rp && rp.data;
          inner += '<pre>' + esc(pretty({ content: dr && dr.content, toolCalls: dr && dr.toolCalls, stopReason: dr && dr.stopReason, usage: dr && dr.usage })) + '</pre>';
        } else {
          var d = rp && rp.data;
          var r = '<div class="respmono">';
          if (d && d.content) r += '<div style="margin-bottom:8px">' + esc(d.content) + '</div>';
          if (d && Array.isArray(d.toolCalls) && d.toolCalls.length) {
            r += '<div class="toolchips" style="margin-bottom:8px">';
            for (var ci = 0; ci < d.toolCalls.length; ci++) { var c = d.toolCalls[ci] || {}; r += '<span class="toolchip">' + esc((c.name != null ? c.name : "?")) + '()</span>'; }
            r += '</div>';
          }
          var meta = [];
          if (d && d.stopReason) meta.push('<span class="mono-key">stop</span> ' + esc(d.stopReason));
          if (d && d.usage) meta.push('<span class="mono-key">tokens</span> ' + esc(d.usage.inputTokens) + '→' + esc(d.usage.outputTokens));
          if (meta.length) { r += '<div class="params">'; for (var ki = 0; ki < meta.length; ki++) r += '<span>' + meta[ki] + '</span>'; r += '</div>'; }
          r += '</div>';
          inner += r;
        }
      }
      div.innerHTML = inner;
      promptsBody.appendChild(div);
    }
  }

  // ---- panel: logs (filtered, with its own auto-follow) ----
  var logsBody = \$("logs");
  var logLevelSeg = \$("logLevel");
  var logPid = \$("logPid");
  var logFollow = \$("logFollow");
  var logsPanel = document.querySelector(".panel--logs");
  var logSourceSeg = \$("logSource");
  var logRangeSel = \$("logRange");
  var logTypesEl = \$("logTypes");
  var logTypesBtn = \$("logTypesBtn");
  var logTypesLbl = \$("logTypesLbl");
  var logTypesPop = \$("logTypesPop");
  var logRunBtn = \$("logRunBtn");
  var logQueryMeta = \$("logQueryMeta");
  function pinLogs() { logsBody.scrollTop = logsBody.scrollHeight; }

  // The active level/pid filters as a small predicate, reused by both render paths.
  function logLevelFilter() { return currentLevel; }
  function logPidFilter() { return logPid.value.trim().toLowerCase(); }

  // Append ONE log record's row (live-mode render + query-mode log rows share this).
  // Returns true when a row was actually appended (passed level/pid filters).
  function appendLogRow(rec, lvl, pidF) {
    var lp = rec.payload;
    var row = document.createElement("div");
    if (lp && lp.__truncated) {
      // Truncated: level/pid are gone, so it can't be filtered — surface it raw.
      if (lvl || pidF) return false;
      row.className = "log";
      row.innerHTML = '<span class="lvl">?</span><span class="pid">?</span>'
        + '<span class="txt">⚠ truncated (' + lp.bytes + ' bytes)</span>';
      logsBody.appendChild(row);
      return true;
    }
    var d = get(lp, ["data"]) || {};
    if (lvl && d.level !== lvl) return false;
    if (pidF && String(d.pluginId || "").toLowerCase().indexOf(pidF) === -1) return false;
    var isCore = String(d.pluginId || "").indexOf("core:") === 0;
    row.className = "log lvl-" + esc(d.level || "");
    row.innerHTML = '<span class="lvl ' + esc(d.level || "") + '">' + esc(d.level || "?") + '</span>'
      + '<span class="pid' + (isCore ? " core" : "") + '">' + esc(d.pluginId || "?") + '</span>'
      + '<span class="txt">' + esc(d.text || "") + '</span>';
    logsBody.appendChild(row);
    return true;
  }

  // A compact row for a NON-log record returned by a query (kind + summary).
  function appendQueryEventRow(rec) {
    var row = document.createElement("div");
    row.className = "ev " + (KIND_CLASS[rec.kind] || "");
    var ico = KIND_ICON[rec.kind] || "box";
    row.innerHTML = '<span class="seq">#' + rec.seq + '</span>'
      + '<span class="time">' + fmtTime(rec.at) + '</span>'
      + '<span class="ico">' + icon(ico) + '</span>'
      + '<span class="kind">' + esc(rec.kind) + '</span>'
      + '<span class="sum">' + esc(summarize(rec)) + '</span>';
    logsBody.appendChild(row);
  }

  function renderLogs(s) {
    if (!s) return;
    logsBody.innerHTML = "";
    var lvl = logLevelFilter();
    var pidF = logPidFilter();
    var shown = 0;

    if (logSource === "query") {
      if (!s.queryRan) {
        logsBody.innerHTML = '<div class="empty">Run a query to see persisted records.</div>';
        logQueryMeta.textContent = "";
        return;
      }
      // queryRecords already passed the server (or client-mirror) type/time filter;
      // the level seg + pid input still narrow log rows further, client-side.
      for (var qi = 0; qi < s.queryRecords.length; qi++) {
        var qr = s.queryRecords[qi];
        if (qr.kind === "log") { if (appendLogRow(qr, lvl, pidF)) shown++; }
        else { appendQueryEventRow(qr); shown++; }
      }
      if (!shown) logsBody.innerHTML = '<div class="empty">No matching records.</div>';
      var total = s.queryTotal;
      logQueryMeta.textContent = "showing " + s.queryRecords.length + " of " + total
        + (s.queryRecords.length < total ? " (capped)" : "");
      if (followOn(logFollow)) pinLogs();
      return;
    }

    // LIVE mode (unchanged behavior): render from the per-agent log records.
    logQueryMeta.textContent = "";
    for (var i = 0; i < s.logs.length; i++) {
      if (appendLogRow(s.logs[i], lvl, pidF)) shown++;
    }
    if (!shown) logsBody.innerHTML = '<div class="empty">No matching logs.</div>';
    if (followOn(logFollow)) pinLogs();
  }

  logLevelSeg.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button") : null;
    if (!btn) return;
    currentLevel = btn.getAttribute("data-lvl") || "";
    var bs = logLevelSeg.querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("active", bs[i] === btn);
    if (state) renderLogs(state);
  });
  logPid.addEventListener("input", function () { if (state) renderLogs(state); });
  logFollow.addEventListener("click", function () {
    logFollow.classList.toggle("on");
    if (followOn(logFollow)) pinLogs();
  });
  logsBody.addEventListener("scroll", function () {
    var atBottom = (logsBody.scrollHeight - logsBody.scrollTop - logsBody.clientHeight) < 24;
    if (!atBottom && followOn(logFollow)) logFollow.classList.remove("on");
  });

  // ---- Logs query mode: client-side mirror of server filterRecords ----
  // Faithful reimplementation of public_plugin/inspector/query.ts so the SSE
  // live-tail decides membership EXACTLY as the /query endpoint would. Kept inline
  // (not embedded via .toString()) because the server fn references module helpers.
  var QHARD_MAX = 5000;
  function isFiniteNum(v) { return typeof v === "number" && isFinite(v); }
  function clientFilter(records, q, now) {
    if (now == null) now = Date.now();
    var types = (q.types && q.types.length) ? q.types : [];
    var levels = (q.levels && q.levels.length) ? q.levels : [];
    var hasTypes = types.length > 0;
    var hasLevels = levels.length > 0;
    var lo = -Infinity, hi = Infinity;
    if (isFiniteNum(q.fromTs) || isFiniteNum(q.untilTs)) {
      if (isFiniteNum(q.fromTs)) lo = q.fromTs;
      if (isFiniteNum(q.untilTs)) hi = q.untilTs;
    } else if (isFiniteNum(q.sinceMs) && q.sinceMs > 0) {
      lo = now - q.sinceMs;
    }
    var hasTime = lo !== -Infinity || hi !== Infinity;
    var out;
    if (!hasTime && !hasTypes && !hasLevels) {
      // NO-OP: pass every input through unchanged (incl. garbage), no inspection.
      out = records.slice();
    } else {
      out = [];
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        // A non-object record cannot satisfy any active filter → exclude (no throw).
        if (!rec || typeof rec !== "object") continue;
        var at = typeof rec.at === "number" ? rec.at : 0;
        if (at < lo || at > hi) continue;
        var isLog = rec.kind === "log";
        // levels NON-EMPTY: level gate is the sole authority for logs (independent of
        // types); a non-log is kept only if types includes its kind. levels EMPTY:
        // only the type gate applies (to all kinds incl. logs).
        if (hasLevels) {
          if (isLog) {
            var lv = get(rec.payload, ["data", "level"]);
            if (levels.indexOf(String(lv)) === -1) continue;
          } else if (!(hasTypes && types.indexOf(rec.kind) !== -1)) {
            continue;
          }
        } else if (hasTypes) {
          if (types.indexOf(rec.kind) === -1) continue;
        }
        out.push(rec);
      }
    }
    if (q.limit === undefined) {
      return out.length > QHARD_MAX ? out.slice(out.length - QHARD_MAX) : out;
    }
    var lim = Math.min(Math.max(0, Math.floor(q.limit)), QHARD_MAX);
    if (lim === 0) return [];
    return out.length > lim ? out.slice(out.length - lim) : out;
  }

  // The current query the Logs panel describes (range preset + selected types).
  // Empty types selection means all (no type filter sent / mirrored).
  function buildLogQuery() {
    var q = {};
    var sel = [];
    for (var i = 0; i < ALL_KINDS.length; i++) if (logTypes[ALL_KINDS[i]]) sel.push(ALL_KINDS[i]);
    if (sel.length) q.types = sel;
    if (logRange !== "live" && logRange !== "all") {
      var n = Number(logRange);
      if (isFinite(n) && n > 0) q.sinceMs = n;
    }
    return q;
  }
  function logQueryString(q) {
    var parts = [];
    if (token) parts.push("token=" + encodeURIComponent(token));
    if (q.sinceMs != null) parts.push("sinceMs=" + encodeURIComponent(q.sinceMs));
    if (q.fromTs != null) parts.push("fromTs=" + encodeURIComponent(q.fromTs));
    if (q.untilTs != null) parts.push("untilTs=" + encodeURIComponent(q.untilTs));
    if (q.types) for (var i = 0; i < q.types.length; i++) parts.push("type=" + encodeURIComponent(q.types[i]));
    return parts.length ? ("?" + parts.join("&")) : "";
  }
  function runLogQuery() {
    if (!state || logSource !== "query") return;
    var id = state.id;
    var q = buildLogQuery();
    logQueryMeta.textContent = "running…";
    api("/api/agents/" + encodeURIComponent(id) + "/query" + logQueryString(q))
      .then(function (r) {
        if (r.status === 401) { showLock(); throw new Error("401"); }
        if (!r.ok) throw new Error("query " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!state || state.id !== id || logSource !== "query") return;
        state.queryRecords = (data && data.records) || [];
        state.queryTotal = (data && typeof data.total === "number") ? data.total : state.queryRecords.length;
        state.queryRan = true;
        renderLogs(state);
      })
      .catch(function (e) {
        if (String(e.message) === "401") return;
        logQueryMeta.textContent = "error: " + e.message;
      });
  }

  // Live-tail: in query mode, a new SSE record joins queryRecords iff it matches
  // the active query (same predicate the server used). Caps the retained array.
  function queryTail(s, rec) {
    if (!s.queryRan) return;
    var q = buildLogQuery();
    if (clientFilter([rec], q).length === 0) return;
    s.queryRecords.push(rec);
    s.queryTotal++;
    if (s.queryRecords.length > CAP_LOGS) s.queryRecords.shift();
  }

  // Reflect the live⇄query source onto the panel (CSS reveals the query bar).
  function setLogSource(src) {
    logSource = src;
    if (logsPanel) logsPanel.setAttribute("data-src", src);
    var bs = logSourceSeg.querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("active", bs[i].getAttribute("data-src") === src);
    if (src === "query" && state && !state.queryRan) runLogQuery();
    if (state) renderLogs(state);
  }
  logSourceSeg.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button") : null;
    if (!btn) return;
    var src = btn.getAttribute("data-src");
    if (!src || src === logSource) return;
    setLogSource(src);
  });
  logRangeSel.addEventListener("change", function () {
    logRange = logRangeSel.value;
    if (state && logSource === "query") runLogQuery();
  });
  logRunBtn.addEventListener("click", function () { runLogQuery(); });

  // type multi-select (dependency-free popover with all/none actions)
  function logTypesSummary() {
    var sel = [];
    for (var i = 0; i < ALL_KINDS.length; i++) if (logTypes[ALL_KINDS[i]]) sel.push(ALL_KINDS[i]);
    if (!sel.length) return "all";
    if (sel.length === 1) return sel[0];
    return sel.length + " selected";
  }
  function buildTypesPop() {
    var html = '<div class="tms-actions"><button type="button" data-act="all">all</button>'
      + '<button type="button" data-act="none">none</button></div>';
    for (var i = 0; i < ALL_KINDS.length; i++) {
      var k = ALL_KINDS[i];
      var on = !!logTypes[k];
      html += '<label class="' + (on ? "on" : "") + '"><input type="checkbox" data-kind="' + esc(k) + '"'
        + (on ? " checked" : "") + '/>' + esc(k) + '</label>';
    }
    logTypesPop.innerHTML = html;
  }
  if (logTypesBtn) {
    logTypesBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = logTypesEl.classList.toggle("open");
      if (open) buildTypesPop();
    });
  }
  if (logTypesPop) {
    logTypesPop.addEventListener("click", function (e) {
      var act = e.target.getAttribute && e.target.getAttribute("data-act");
      if (act) {
        logTypes = {};
        if (act === "all") for (var i = 0; i < ALL_KINDS.length; i++) logTypes[ALL_KINDS[i]] = true;
        buildTypesPop();
        logTypesLbl.textContent = logTypesSummary();
        if (state && logSource === "query") runLogQuery();
        return;
      }
    });
    logTypesPop.addEventListener("change", function (e) {
      var cb = e.target;
      if (!cb || !cb.getAttribute) return;
      var k = cb.getAttribute("data-kind");
      if (!k) return;
      if (cb.checked) logTypes[k] = true; else delete logTypes[k];
      var lab = cb.closest ? cb.closest("label") : null;
      if (lab) lab.classList.toggle("on", cb.checked);
      logTypesLbl.textContent = logTypesSummary();
      if (state && logSource === "query") runLogQuery();
    });
  }
  // Close the type popover on an outside click.
  document.addEventListener("click", function (e) {
    if (logTypesEl && logTypesEl.classList.contains("open")
      && e.target.closest && !e.target.closest("#logTypes")) {
      logTypesEl.classList.remove("open");
    }
  });

  // ---- panel: per-frame timeline ----
  var framesBody = \$("frames");
  var STAGE = {
    "tick": ["frame", "s-gather"], "gather": ["gather", "s-gather"],
    "prompt.sent": ["request →", "s-sent"], "prompt.received": ["← return", "s-recv"],
    "tool.result": ["tool", "s-tool"], "input": ["input", "s-gather"],
    "output": ["output", "s-output"], "conversation": ["conversation", "s-output"],
    "log": ["log", ""], "agent.start": ["start", "s-output"]
  };
  function renderFrames(s) {
    framesBody.innerHTML = "";
    if (!s.frames.length) {
      framesBody.innerHTML = '<div class="empty">No frames yet.</div>';
      return;
    }
    for (var i = 0; i < s.frames.length; i++) {
      var b = s.frames[i];
      var div = document.createElement("div");
      div.className = "frame";
      var last = b.records[b.records.length - 1];
      var dur = last ? (last.at - b.at) : 0;
      var html = '<div class="bh"><span class="bdot"></span>frame — ' + esc(b.label || ("#" + b.seq))
        + ' <span class="bmeta">· ' + fmtTime(b.at) + ' · ' + b.records.length + ' events</span>'
        + '<span class="bdur">⏱ <b>' + dur + 'ms</b></span></div><div class="lane">';
      for (var j = 0; j < b.records.length; j++) {
        var r = b.records[j];
        var st = STAGE[r.kind] || [r.kind, ""];
        var corr = r.corrId ? (' <span class="corr">· ' + esc(r.corrId) + '</span>') : "";
        var dt = r.at - b.at;
        html += '<div class="step ' + st[1] + '"><span class="stage">' + esc(st[0]) + '</span>'
          + '<span class="sd">' + esc(summarize(r)) + corr + '</span>'
          + '<span class="t">+' + dt + 'ms</span></div>';
      }
      html += '</div>';
      div.innerHTML = html;
      framesBody.appendChild(div);
    }
  }

  // ---- record routing: STATE ONLY (never touches the DOM) ----
  // Updates records/prompts/promptOrder/logs/frames and enforces the caps.
  // Returns true if the record was new (false if it was a dedup'd duplicate).
  function applyRecord(s, rec) {
    // seq is a monotonic per-agent server counter and the snapshot is an ordered
    // prefix with no stream replay, so a high-water mark dedupes in O(1) memory.
    if (rec.seq <= s.lastSeq) return false;
    s.lastSeq = rec.seq;

    s.records.push(rec);
    if (s.records.length > CAP_EVENTS) s.records.shift();

    // prompts pairing — assembled (data.request) record wins via chooseSent.
    if ((rec.kind === "prompt.sent" || rec.kind === "prompt.received") && rec.corrId) {
      if (!s.prompts[rec.corrId]) { s.prompts[rec.corrId] = {}; s.promptOrder.push(rec.corrId); }
      if (rec.kind === "prompt.sent") s.prompts[rec.corrId].sent = chooseSent(s.prompts[rec.corrId].sent, rec);
      else s.prompts[rec.corrId].received = rec;
      while (s.promptOrder.length > CAP_PROMPTS) {
        var drop = s.promptOrder.shift();
        delete s.prompts[drop];
      }
    }

    // logs
    if (rec.kind === "log") {
      s.logs.push(rec);
      if (s.logs.length > CAP_LOGS) s.logs.shift();
    }

    // frames: a new frame opens at tick/gather; everything else joins the current
    // frame (records before the first boundary form an implicit pre-frame).
    if (rec.kind === "tick" || rec.kind === "gather") {
      s.frames.push({ seq: rec.seq, at: rec.at,
        label: rec.kind + " " + (get(rec.payload, ["data", "seq"])), records: [rec] });
    } else {
      if (!s.frames.length) s.frames.push({ seq: rec.seq, at: rec.at, label: "pre-frame", records: [] });
      s.frames[s.frames.length - 1].records.push(rec);
    }
    if (s.frames.length > CAP_FRAMES) s.frames.shift();

    return true;
  }

  // Refresh the four count badges from current (capped) state.
  function renderCounts(s) {
    \$("cEvents").textContent = s.records.length;
    \$("cPrompts").textContent = s.promptOrder.length;
    \$("cLogs").textContent = s.logs.length;
    \$("cFrames").textContent = s.frames.length;
  }

  // ---- live render coalescer: bound panel re-renders to once-per-frame ----
  var dirty = { prompts: false, logs: false, frames: false };
  var rafHandle = 0;
  var raf = (typeof window !== "undefined" && window.requestAnimationFrame)
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(cb, 16); };

  // A panel is visible if the overview shows all four OR its own panel is expanded.
  function panelVisible(panel) {
    var view = mainEl.getAttribute("data-view");
    return view === "overview" || view === panel;
  }

  function flushDirty() {
    rafHandle = 0;
    var s = state;
    if (!s) { dirty.prompts = dirty.logs = dirty.frames = false; return; }
    if (dirty.prompts && panelVisible("prompts")) { renderPrompts(s); dirty.prompts = false; }
    if (dirty.logs && panelVisible("logs")) { renderLogs(s); dirty.logs = false; }
    if (dirty.frames && panelVisible("frames")) { renderFrames(s); dirty.frames = false; }
    renderCounts(s); // cheap; keep header badges fresh regardless
  }

  function scheduleFlush() {
    if (!rafHandle) rafHandle = raf(flushDirty);
  }

  // BACKFILL: apply ALL records to state, then render every panel exactly ONCE.
  function ingestSnapshot(s, recs) {
    for (var i = 0; i < recs.length; i++) applyRecord(s, recs[i]);
    renderEvents(s);
    renderPrompts(s);
    renderLogs(s);
    renderFrames(s);
    renderCounts(s);
    dirty.prompts = dirty.logs = dirty.frames = false;
  }

  // LIVE (SSE): one record. The event stream appends incrementally; the prompt,
  // log and frame panels are marked dirty and coalesced into one rAF flush.
  function ingestLive(s, rec) {
    if (!applyRecord(s, rec)) return;
    appendEventRow(rec);
    if ((rec.kind === "prompt.sent" || rec.kind === "prompt.received") && rec.corrId) dirty.prompts = true;
    if (rec.kind === "log") dirty.logs = true;
    // Query mode live-tails: a new record matching the active query is appended to
    // the result set (client mirror of filterRecords) and the Logs panel re-renders.
    if (logSource === "query") {
      var before = s.queryRecords.length;
      queryTail(s, rec);
      if (s.queryRecords.length !== before) dirty.logs = true;
    }
    dirty.frames = true; // every record joins (or opens) a frame
    scheduleFlush();
  }

  function resetPanels() {
    if (rafHandle && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    dirty.prompts = dirty.logs = dirty.frames = false;
    promptsBody.innerHTML = '<div class="empty">No prompts yet.</div>';
    eventsBody.innerHTML = '<div class="empty">No events yet.</div>';
    logsBody.innerHTML = '<div class="empty">No logs yet.</div>';
    framesBody.innerHTML = '<div class="empty">No frames yet.</div>';
    \$("cPrompts").textContent = "0";
    \$("cEvents").textContent = "0";
    \$("cLogs").textContent = "0";
    \$("cFrames").textContent = "0";
    // Clear the Logs query result + meta on agent switch (state.queryRecords is
    // freshly recreated by freshState; this clears any stale on-screen meta).
    if (logQueryMeta) logQueryMeta.textContent = "";
  }

  // ---- selection / connection ----
  function disconnect() {
    if (state && state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
  }

  // ---- screen switching (lock / landing / dashboard) ----
  function showScreen(which) {
    lockEl.classList.toggle("show", which === "lock");
    landingEl.classList.toggle("show", which === "landing");
    mainEl.classList.toggle("show", which === "dashboard");
    if (which !== "dashboard") collapsePanels();
    if (rosterEl) rosterEl.style.opacity = which === "lock" ? "0.4" : "";
    // reflect the dev-strip (Dashboard / Landing) selection
    var dd = \$("devDashboard"), dl = \$("devLanding");
    if (dd) dd.classList.toggle("on", which === "dashboard");
    if (dl) dl.classList.toggle("on", which === "landing");
  }
  function showLanding() { showScreen("landing"); setStatus("select an agent"); }
  function showDashboard() { showScreen("dashboard"); }
  function showLock() { showScreen("lock"); setStatus("locked", "err"); }

  // ---- agent roster (sidebar; replaces the old header dropdown) ----
  // GET /api/agents returns the ONLINE agent ids; each row inspects that agent's
  // bus. The sub line reflects what we actually know from the read-only API
  // (the agent is online + which one is being inspected) — no fabricated metadata.
  function renderRoster(ids) {
    rosterEl.innerHTML = "";
    if (!ids.length) {
      rosterEl.innerHTML = '<div class="empty">Waiting for agents…</div>';
      return;
    }
    for (var i = 0; i < ids.length; i++) {
      (function (id) {
        var sel = state && state.id === id;
        var sub = sel ? "inspecting · live" : "online";
        var btn = document.createElement("button");
        btn.className = "agent" + (sel ? " sel" : "");
        btn.setAttribute("type", "button");
        btn.setAttribute("data-id", id);
        btn.setAttribute("title", id);
        btn.innerHTML = '<span class="av">' + esc(id.slice(0, 1)) + '<span class="pres"></span></span>'
          + '<span class="at"><span class="an" title="' + esc(id) + '">' + esc(id) + '</span>'
          + '<span class="as">' + esc(sub) + '</span></span>';
        btn.addEventListener("click", function () { select(id); });
        rosterEl.appendChild(btn);
      })(ids[i]);
    }
  }
  // Move the .sel highlight + refresh sub lines for the current selection.
  function reflectRoster(curId) {
    var rows = rosterEl.querySelectorAll(".agent");
    for (var i = 0; i < rows.length; i++) {
      var rid = rows[i].getAttribute("data-id");
      var sel = rid === curId;
      rows[i].classList.toggle("sel", sel);
      var as = rows[i].querySelector(".as");
      if (as) as.textContent = sel ? "inspecting · live" : "online";
    }
  }

  // ---- landing list (mirrors the live agent list) ----
  function renderAgentList(ids) {
    agentListEl.innerHTML = "";
    if (!ids.length) {
      agentListEl.innerHTML = '<div class="empty">Waiting for agents…</div>';
      return;
    }
    for (var i = 0; i < ids.length; i++) {
      (function (id) {
        var card = document.createElement("button");
        card.className = "agent-card";
        card.setAttribute("type", "button");
        card.setAttribute("data-id", id);
        card.innerHTML = '<span class="g">' + icon("robot") + '</span>'
          + '<span class="ac-t"><span class="id">' + esc(id) + '</span><span class="sub">online · click to inspect</span></span>'
          + '<span class="live-dot"></span><span class="arrow">' + icon("arrowRight") + '</span>';
        card.addEventListener("click", function () { select(id); });
        agentListEl.appendChild(card);
      })(ids[i]);
    }
  }

  // ---- agent-switch transition (fires only on a real agent switch) ----
  function animateAgentSwitch() {
    var bodies = document.querySelectorAll(".panel .body");
    for (var i = 0; i < bodies.length; i++) {
      bodies[i].classList.remove("agent-in");
      void bodies[i].offsetWidth; // force reflow so the animation restarts
      bodies[i].classList.add("agent-in");
    }
    clearTimeout(animateAgentSwitch._t);
    animateAgentSwitch._t = setTimeout(function () {
      var bs = document.querySelectorAll(".panel .body");
      for (var k = 0; k < bs.length; k++) bs[k].classList.remove("agent-in");
    }, 500);
  }

  function select(id) {
    disconnect();
    resetPanels();
    if (!id) {
      state = null;
      reflectRoster("");
      showLanding();
      return;
    }
    var switching = !state || state.id !== id;
    showDashboard();
    state = freshState(id);
    reflectRoster(id);
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
        ingestSnapshot(state, recs);
        if (data && data.dropped) {
          var d = document.createElement("div");
          d.className = "dropped";
          d.textContent = "⚠ " + data.dropped + " older records were dropped (ring full).";
          eventsBody.insertBefore(d, eventsBody.firstChild);
        }
        openStream(id);
        // If the Logs panel is in Query mode, auto-run the query for this agent so
        // a switch repopulates the result set (and re-enables the live-tail).
        if (logSource === "query") runLogQuery();
        if (switching) animateAgentSwitch();
      })
      .catch(function (e) {
        if (String(e.message) === "401") return; // showLock() already handled it
        setStatus("error: " + e.message, "err");
        // A non-401 (e.g. snapshot 404 because the agent vanished) leaves a blank
        // dashboard; fall back to the landing — but only if THIS selection is
        // still current (don't yank the user off a newer pick made mid-flight).
        if (!state || state.id === id) {
          state = null;
          reflectRoster("");
          showLanding();
        }
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
        if (msg && msg.type === "record" && state && msg.record) ingestLive(state, msg.record);
      } catch (e) {}
    };
    es.onerror = function () {
      // EventSource auto-reconnects; surface state without tearing down.
      setStatus("reconnecting…", "err");
    };
  }

  // ---- expand⇄return panels: pure CSS toggle via .dash[data-view] ----
  function syncPanelToggles() {
    var expanded = currentView !== "overview";
    var btns = document.querySelectorAll(".pexp");
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var ico = btn.querySelector(".pexp-ico");
      if (expanded) {
        btn.title = "Return to overview";
        btn.setAttribute("aria-label", "Return to overview");
        if (ico) ico.outerHTML = icon("minimize", "pexp-ico");
      } else {
        btn.title = "Expand";
        btn.setAttribute("aria-label", "Expand panel");
        if (ico) ico.outerHTML = icon("expand", "pexp-ico");
      }
    }
  }
  function pinFollowed() {
    if (followOn(autoFollow)) pinEvents();
    if (followOn(logFollow)) pinLogs();
  }
  function expandPanel(view) {
    currentView = view;
    mainEl.setAttribute("data-view", view);
    mainEl.classList.remove("view-enter"); void mainEl.offsetWidth; mainEl.classList.add("view-enter");
    syncPanelToggles();
    flushDirty(); // a panel that fell dirty while hidden now becomes visible
    pinFollowed();
  }
  function collapsePanels() {
    currentView = "overview";
    if (!mainEl) return;
    mainEl.setAttribute("data-view", "overview");
    mainEl.classList.remove("view-enter"); void mainEl.offsetWidth; mainEl.classList.add("view-enter");
    syncPanelToggles();
    flushDirty();
    pinFollowed();
  }
  function wirePanelExpand() {
    var panels = document.querySelectorAll(".panel");
    for (var i = 0; i < panels.length; i++) {
      (function (panel) {
        var view = panel.getAttribute("data-view");
        var btn = panel.querySelector(".pexp");
        if (!btn) return;
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (mainEl.getAttribute("data-view") === "overview") expandPanel(view);
          else collapsePanels();
        });
      })(panels[i]);
    }
    syncPanelToggles();
  }

  // ---- prompt readable/raw toggle ----
  var pvToggle = \$("pvToggle");
  if (pvToggle) {
    pvToggle.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button") : null;
      if (!btn) return;
      var pv = btn.getAttribute("data-pv");
      if (!pv || pv === promptView) return;
      promptView = pv;
      var bs = pvToggle.querySelectorAll("button");
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("active", bs[i].getAttribute("data-pv") === pv);
      if (state) renderPrompts(state);
    });
  }

  // ---- dev/state strip (Dashboard / Landing) ----
  function wireDevStrip() {
    var btns = document.querySelectorAll(".dev-strip button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var which = this.getAttribute("data-state");
        if (which === "dashboard") { if (state) showDashboard(); else showLanding(); }
        else if (which === "landing") { select(""); }
      });
    }
  }

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
        renderRoster(ids);
        renderAgentList(ids);
        // no agent selected → keep (or refresh) the landing screen on screen
        if (!state) showLanding();
      })
      .catch(function (e) {
        if (String(e.message) !== "401") setStatus("error: " + e.message, "err");
      });
  }

  // ---- boot ----
  wirePanelExpand();
  wireDevStrip();
  // Open on the landing screen (no agent selected); loadAgents() refreshes it.
  showLanding();
  loadAgents();
  setInterval(loadAgents, 5000);
})();
`;
