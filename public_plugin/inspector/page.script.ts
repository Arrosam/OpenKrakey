/**
 * inspector/page.script.ts — the dashboard client script, split out of page.ts (SRP).
 *
 * Holds exactly the content of the page's <script>…</script> block. It is a
 * dependency-free IIFE that token-gates its fetches, lists agents, backfills via
 * /snapshot then live-streams /stream over SSE, and renders the four panels.
 * page.ts re-wraps it in the <script> tags so the assembled PAGE is byte-identical.
 */
import { formatRequest, chooseSent } from "./page.format";

export const SCRIPT = `
(function () {
  "use strict";

  var qs = new URLSearchParams(location.search);
  var token = qs.get("token") || "";
  var tokenQS = token ? ("?token=" + encodeURIComponent(token)) : "";

  var \$ = function (id) { return document.getElementById(id); };
  var statusEl = \$("status");
  var agentSel = \$("agentSel");
  var landingEl = document.getElementById("landing");
  var agentListEl = document.getElementById("agentList");
  var tabsNav = document.querySelector(".tabs");
  var agentPicker = document.getElementById("agentPicker");

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status-bar" + (cls ? " " + cls : "");
  }
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

  // ---- token-gated fetch ----
  function api(path) {
    var headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetch(path, { headers: headers });
  }

  // ---- per-selection state ----
  var state = null; // { id, lastSeq, records, es, prompts, ... }
  var promptView = "readable";

  function freshState(id) {
    return {
      id: id,
      lastSeq: -1,      // monotonic high-water mark for dedup (seq is server-monotonic)
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
    "conversation": "k-conversation",
    "log": "k-log"
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
      case "agent.start": return get(p, ["data", "agentId"]) || "";
      case "conversation": { var msgs = get(p, ["data", "messages"]); return (Array.isArray(msgs) ? msgs.length : 0) + " turns"; }
      default: return "";
    }
  }

  // ---- caps: bound retained state + DOM so a long session never degrades ----
  var CAP_EVENTS = 600;   // event-stream rows (records[] and DOM .row nodes)
  var CAP_PROMPTS = 200;  // prompt pairs (promptOrder + prompts map)
  var CAP_LOGS = 600;     // log records
  var CAP_BEATS = 200;    // beat groups

  // ---- panel 2: event stream (explicit auto-follow toggle is the master) ----
  var eventsBody = \$("events");
  var autoFollow = \$("autoFollow");
  // Our own programmatic scrolls (backfill/append/tab-show) fire a scroll event
  // too; this flag lets the listener ignore them so auto-follow isn't spuriously
  // unchecked while we're snapping to the bottom.
  var programmaticScroll = false;
  function pinToBottom() {
    programmaticScroll = true;
    eventsBody.scrollTop = eventsBody.scrollHeight;
  }
  // The checkbox is the source of truth. Manually scrolling up is a nicety that
  // unchecks it; checking it again snaps back to the latest.
  eventsBody.addEventListener("scroll", function () {
    if (programmaticScroll) { programmaticScroll = false; return; }
    var atBottom = (eventsBody.scrollHeight - eventsBody.scrollTop - eventsBody.clientHeight) < 24;
    if (!atBottom && autoFollow.checked) autoFollow.checked = false;
  });
  autoFollow.addEventListener("change", function () {
    if (autoFollow.checked) pinToBottom();
  });
  function makeEventRow(rec) {
    var div = document.createElement("div");
    div.className = "row";
    var cls = KIND_CLASS[rec.kind] || "";
    div.innerHTML = '<span class="seq">#' + rec.seq + '</span> '
      + '<span class="time">' + fmtTime(rec.at) + '</span>'
      + '<span class="kind ' + cls + '">' + esc(rec.kind) + '</span>'
      + esc(summarize(rec));
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
    if (autoFollow.checked) pinToBottom();
  }
  // Cheap incremental append for a single LIVE record; trims oldest DOM rows.
  function appendEventRow(rec) {
    var emptyEv = eventsBody.querySelector(".empty");
    if (emptyEv) emptyEv.remove();
    eventsBody.appendChild(makeEventRow(rec));
    var rows = eventsBody.querySelectorAll(".row");
    while (rows.length > CAP_EVENTS) {
      rows[0].remove();
      rows = eventsBody.querySelectorAll(".row");
    }
    if (autoFollow.checked) pinToBottom();
  }

  // ---- panel 1: prompts ----
  var promptsBody = \$("prompts");
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

      var sentText;
      if (!pr.sent) sentText = "(no request captured)";
      else if (pr.sent.payload && pr.sent.payload.__truncated) sentText = "⚠ truncated (" + pr.sent.payload.bytes + " bytes)";
      else sentText = formatRequest(pr.sent.payload, promptView);
      var recvBlock = "(awaiting response…)";
      if (pr.received) {
        var rp = pr.received.payload;
        if (rp && rp.__truncated) {
          recvBlock = "⚠ truncated (" + rp.bytes + " bytes)";
        } else if (rp && rp.ok === false) {
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
  var logsBody = \$("logs");
  var logLevel = \$("logLevel");
  var logPid = \$("logPid");
  logLevel.addEventListener("change", function () { renderLogs(state); });
  logPid.addEventListener("input", function () { renderLogs(state); });
  function renderLogs(s) {
    if (!s) return;
    logsBody.innerHTML = "";
    var lvl = logLevel.value;
    var pidF = logPid.value.trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < s.logs.length; i++) {
      var lp = s.logs[i].payload;
      var row = document.createElement("div");
      row.className = "log";
      if (lp && lp.__truncated) {
        // Truncated: level/pid are gone, so it can't be filtered — surface it raw.
        if (lvl || pidF) continue;
        row.innerHTML = '<span class="lvl">?</span><span class="pid">?</span>'
          + '<span class="txt">⚠ truncated (' + lp.bytes + ' bytes)</span>';
        logsBody.appendChild(row);
        shown++;
        continue;
      }
      var d = get(lp, ["data"]) || {};
      if (lvl && d.level !== lvl) continue;
      if (pidF && String(d.pluginId || "").toLowerCase().indexOf(pidF) === -1) continue;
      row.innerHTML = '<span class="lvl ' + esc(d.level || "") + '">' + esc(d.level || "?") + '</span>'
        + '<span class="pid">' + esc(d.pluginId || "?") + '</span>'
        + '<span class="txt">' + esc(d.text || "") + '</span>';
      logsBody.appendChild(row);
      shown++;
    }
    if (!shown) logsBody.innerHTML = '<div class="empty">No matching logs.</div>';
  }

  // ---- panel 4: per-beat timeline ----
  var beatsBody = \$("beats");
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

  // ---- record routing: STATE ONLY (never touches the DOM) ----
  // Updates records/prompts/promptOrder/logs/beats and enforces the caps.
  // Returns true if the record was new (false if it was a dedup'd duplicate), so
  // callers can decide whether a re-render is warranted.
  function applyRecord(s, rec) {
    // seq is a monotonic per-agent server counter and the snapshot is an ordered
    // prefix with no stream replay, so a high-water mark dedupes in O(1) memory.
    if (rec.seq <= s.lastSeq) return false;
    s.lastSeq = rec.seq;

    s.records.push(rec);
    if (s.records.length > CAP_EVENTS) s.records.shift();

    // prompts pairing
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

    // beats: a new beat opens at tick/gather; everything else joins the current
    // beat (records before the first boundary form an implicit pre-beat).
    if (rec.kind === "tick" || rec.kind === "gather") {
      s.beats.push({ seq: rec.seq, at: rec.at,
        label: rec.kind + " " + (get(rec.payload, ["data", "seq"])), records: [rec] });
    } else {
      if (!s.beats.length) s.beats.push({ seq: rec.seq, at: rec.at, label: "pre-beat", records: [] });
      s.beats[s.beats.length - 1].records.push(rec);
    }
    if (s.beats.length > CAP_BEATS) s.beats.shift();

    return true;
  }

  // Refresh the four count badges from current (capped) state.
  function renderCounts(s) {
    \$("cEvents").textContent = s.records.length;
    \$("cPrompts").textContent = s.promptOrder.length;
    \$("cLogs").textContent = s.logs.length;
    \$("cBeats").textContent = s.beats.length;
  }

  // ---- live render coalescer: bound panel re-renders to once-per-frame -------
  // The event stream stays incremental (appendEventRow). The other three panels
  // are full-rebuilds, so a burst of live records would rebuild them N times per
  // frame. Instead, mark the affected panel dirty and flush at most once per rAF,
  // re-rendering only panels that are dirty AND currently visible. Hidden panels
  // keep their dirty flag and are flushed when their tab is activated.
  var dirty = { prompts: false, logs: false, beats: false };
  var rafHandle = 0;
  var raf = (typeof window !== "undefined" && window.requestAnimationFrame)
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(cb, 16); };

  // A panel is visible if its own tab is active OR the overview shows all four.
  function panelVisible(panel) {
    var view = document.getElementById("main").getAttribute("data-view");
    return view === "overview" || view === panel;
  }

  function flushDirty() {
    rafHandle = 0;
    var s = state;
    if (!s) { dirty.prompts = dirty.logs = dirty.beats = false; return; }
    if (dirty.prompts && panelVisible("prompts")) { renderPrompts(s); dirty.prompts = false; }
    if (dirty.logs && panelVisible("logs")) { renderLogs(s); dirty.logs = false; }
    if (dirty.beats && panelVisible("beats")) { renderBeats(s); dirty.beats = false; }
    renderCounts(s); // cheap (4 text writes); keep header badges fresh regardless
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
    renderBeats(s);
    renderCounts(s);
    dirty.prompts = dirty.logs = dirty.beats = false; // just rendered everything
  }

  // LIVE (SSE): one record. The event stream appends incrementally; the prompt,
  // log and beat panels are marked dirty and coalesced into one rAF flush.
  function ingestLive(s, rec) {
    if (!applyRecord(s, rec)) return;
    appendEventRow(rec);
    if ((rec.kind === "prompt.sent" || rec.kind === "prompt.received") && rec.corrId) dirty.prompts = true;
    if (rec.kind === "log") dirty.logs = true;
    dirty.beats = true; // every record joins (or opens) a beat
    scheduleFlush();
  }

  function resetPanels() {
    // Drop any pending coalesced flush + dirty flags so a stale re-render can't
    // paint the previous agent's data into the freshly-cleared panels.
    if (rafHandle && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    dirty.prompts = dirty.logs = dirty.beats = false;
    promptsBody.innerHTML = '<div class="empty">No prompts yet.</div>';
    eventsBody.innerHTML = '<div class="empty">No events yet.</div>';
    logsBody.innerHTML = '<div class="empty">No logs yet.</div>';
    beatsBody.innerHTML = '<div class="empty">No beats yet.</div>';
    \$("cPrompts").textContent = "0";
    \$("cEvents").textContent = "0";
    \$("cLogs").textContent = "0";
    \$("cBeats").textContent = "0";
  }

  // ---- selection / connection ----
  function disconnect() {
    if (state && state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
  }

  // ---- landing screen (shown whenever no agent is selected) ----
  function renderAgentList(ids) {
    agentListEl.innerHTML = "";
    if (!ids.length) {
      agentListEl.innerHTML = '<div class="empty">Waiting for agents…</div>';
      return;
    }
    for (var i = 0; i < ids.length; i++) {
      (function (id) {
        var btn = document.createElement("button");
        btn.className = "agent-card";
        btn.setAttribute("data-id", id);
        btn.innerHTML = '<span class="dot"></span><span class="id">' + esc(id) + '</span>';
        btn.addEventListener("click", function () { select(id); });
        agentListEl.appendChild(btn);
      })(ids[i]);
    }
  }

  function showLanding() {
    document.getElementById("main").style.display = "none";
    document.getElementById("lock").style.display = "none";
    landingEl.style.display = "flex";
    if (tabsNav) tabsNav.style.display = "none";
    if (agentPicker) agentPicker.style.display = "none";
    setStatus("select an agent");
  }
  function showDashboard() {
    landingEl.style.display = "none";
    document.getElementById("main").style.display = "";
    if (tabsNav) tabsNav.style.display = "";
    if (agentPicker) agentPicker.style.display = "";
  }

  function select(id) {
    disconnect();
    resetPanels();
    if (!id) {
      state = null;
      agentSel.value = "";
      showLanding();
      return;
    }
    showDashboard();
    state = freshState(id);
    agentSel.value = id;
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
        // Batch the whole snapshot: state first, then render each panel ONCE.
        ingestSnapshot(state, recs);
        if (data && data.dropped) {
          var d = document.createElement("div");
          d.className = "dropped";
          d.textContent = "⚠ " + data.dropped + " older records were dropped (ring full).";
          eventsBody.insertBefore(d, eventsBody.firstChild);
        }
        openStream(id);
      })
      .catch(function (e) {
        if (String(e.message) === "401") return; // showLock() already handled it
        setStatus("error: " + e.message, "err");
        // A non-401 (e.g. snapshot 404 because the agent vanished) leaves a blank
        // dashboard; fall back to the landing — but only if THIS selection is
        // still current (don't yank the user off a newer pick made mid-flight).
        if (!state || state.id === id) {
          state = null;
          agentSel.value = "";
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

  function showLock() {
    document.getElementById("main").style.display = "none";
    landingEl.style.display = "none";
    document.getElementById("lock").style.display = "block";
    setStatus("locked", "err");
  }

  agentSel.addEventListener("change", function () { select(agentSel.value); });

  // ---- tab switching: pure CSS toggle via main[data-view] ----
  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b === btn); });
      document.getElementById("main").setAttribute("data-view", btn.getAttribute("data-view"));
      // A panel that fell dirty while hidden now becomes visible — render it now.
      flushDirty();
      // re-pin the event stream to bottom when (re)showing it under auto-follow
      if (typeof eventsBody !== "undefined" && document.getElementById("autoFollow") && document.getElementById("autoFollow").checked) {
        pinToBottom();
      }
    });
  });

  var pvToggle = document.getElementById("pvToggle");
  if (pvToggle) {
    pvToggle.addEventListener("click", function (e) {
      var btn = e.target;
      if (!btn || typeof btn.getAttribute !== "function") return;
      var pv = btn.getAttribute("data-pv");
      if (!pv || pv === promptView) return;
      promptView = pv;
      var bs = pvToggle.querySelectorAll(".pv-btn");
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("active", bs[i].getAttribute("data-pv") === pv);
      if (state) renderPrompts(state);
    });
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
        var existing = {};
        for (var i = 0; i < agentSel.options.length; i++) existing[agentSel.options[i].value] = true;
        for (var j = 0; j < ids.length; j++) {
          if (!existing[ids[j]]) {
            var o = document.createElement("option");
            o.value = ids[j]; o.textContent = ids[j];
            agentSel.appendChild(o);
          }
        }
        // landing cards mirror the live agent list
        renderAgentList(ids);
        // no agent selected → keep (or refresh) the landing screen on screen
        if (!state) showLanding();
      })
      .catch(function (e) {
        if (String(e.message) !== "401") setStatus("error: " + e.message, "err");
      });
  }

  // Open on the landing screen (no agent selected); loadAgents() refreshes it.
  showLanding();
  loadAgents();
  setInterval(loadAgents, 5000);
})();
`;
