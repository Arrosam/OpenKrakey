/* ============================================================================
   app.js — Inspector debug console (STATIC DESIGN MOCK, vanilla JS).

   This is a DESIGN ARTIFACT. There is NO bus, no SSE, no token gate — every
   record below is FAKE seed data, hand-authored to look like a real session so a
   human can review the cockpit re-skin before any real node work.

   What it faithfully reproduces from public_plugin/inspector:
     - the four panels (Prompts / Event stream / Per-beat / Logs)
     - Overview = 2×2 grid; each panel has one dedicated expand button (top-right
       of its header) that expands it full-screen, then reads "Return" to collapse
       back (main[data-view] toggle — no tab bar, no hover hint)
     - the Prompts readable⇄raw segmented toggle, wired to actually switch
     - the log level + pluginId filters + a Logs auto-follow toggle (new)
     - the event-stream auto-follow checkbox, wired to actually pin-to-bottom
     - the Lock + landing states (toggle via the dev strip or ?state= query param)
     - record SHAPES preserved verbatim from page.format.ts / page.script.ts so the
       eventual implementation can port the look 1:1 (see README).

   The icon helper + SVG paths are copied from config-web/static/app.js; a few
   extra line-icons (tick / send / receive / wrench / clock) are added in the SAME
   stroke style (currentColor, 24×24, stroke 1.7).
   ============================================================================ */
(() => {

/* ── helpers ───────────────────────────────────────────────────────────────*/
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n, w) => { n = String(n); while (n.length < (w || 2)) n = "0" + n; return n; };
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3);
}
const pretty = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch (e) { return String(v); } };

/* ── Inline SVG icon set (config-web paths + same-style additions) ──────────*/
const ICONS = {
  // — copied verbatim from config-web/static/app.js —
  grid: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  stars: `<path d="M12 3c.4 3.6 1.4 4.6 5 5-3.6.4-4.6 1.4-5 5-.4-3.6-1.4-4.6-5-5 3.6-.4 4.6-1.4 5-5z"/><path d="M18.5 13.5c.2 1.7.6 2.1 2 2.3-1.4.2-1.8.6-2 2.3-.2-1.7-.6-2.1-2-2.3 1.4-.2 1.8-.6 2-2.3z"/>`,
  server: `<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><path d="M6.5 7.5h2.5M6.5 16.5h2.5"/><path d="M16.8 7.5h.01M16.8 16.5h.01"/>`,
  robot: `<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4.6"/><circle cx="12" cy="3.4" r="1.2"/><circle cx="9.2" cy="13.5" r="1.3"/><circle cx="14.8" cy="13.5" r="1.3"/><path d="M9.5 17h5"/><path d="M2 12.5v3M22 12.5v3"/>`,
  cpu: `<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx="0.6"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>`,
  terminal: `<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>`,
  chat: `<path d="M20.5 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 20.5 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>`,
  code: `<path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>`,
  search: `<circle cx="10.5" cy="10.5" r="6"/><path d="M19.5 19.5l-4.7-4.7"/>`,
  globe: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 2.4 14.5 0 17M12 3.5c-2.4 2.5-2.4 14.5 0 17"/>`,
  activity: `<path d="M3 12h3.5l2.5-7 4.5 14 2.5-7H21"/>`,
  journal: `<rect x="5.5" y="3" width="13" height="18" rx="2"/><path d="M9 7.5h6M9 11.5h6M9 15.5h4"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7"/>`,
  chevronDown: `<path d="M6 9.5l6 6 6-6"/>`,
  chevronRight: `<path d="M9.5 6l6 6-6 6"/>`,
  arrowRight: `<path d="M4 12h15M13 6l6 6-6 6"/>`,
  arrowLeft: `<path d="M20 12H5M11 6l-6 6 6 6"/>`,
  x: `<path d="M6 6l12 12M18 6 6 18"/>`,
  expand: `<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>`,
  minimize: `<path d="M4.5 9H9V4.5M19.5 9H15V4.5M4.5 15H9v4.5M19.5 15H15v4.5"/>`,
  box: `<rect x="4" y="4" width="16" height="16" rx="2.5"/>`,
  alert: `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16h.01"/>`,
  // — new line-icons, SAME stroke style (currentColor, 24×24, stroke 1.7) —
  lock: `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 15v2"/>`,
  tick: `<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 1.7"/>`,
  send: `<path d="M5 12h13M12 6l6 6-6 6"/><path d="M3.5 12h.01"/>`,
  receive: `<path d="M19 12H6M12 6l-6 6 6 6"/><path d="M20.5 12h.01"/>`,
  wrench: `<path d="M15.5 7.5a4 4 0 0 1-5.2 5.2L5 18l1 1 5.3-5.3a4 4 0 0 0 5.2-5.2l-2.3 2.3-2-2 2.3-2.3z"/>`,
  layers: `<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>`,
};
function icon(name, cls) {
  const p = ICONS[name];
  if (!p) return "";
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// One dedicated, ALWAYS-visible expand⇄return button, last in each panel header's
// right cluster. It is ICON-ONLY in BOTH states and occupies fixed square space so
// nothing shifts on hover or on the state switch, and it never overlaps the panel's
// own controls. In the Overview grid it is an Expand control (maximize glyph); in
// the expanded single-panel view the SAME button becomes a Return control (minimize
// glyph). No visible text label — the tooltip (title) and aria-label carry meaning.
// Its icon/aria/tooltip are flipped in syncPanelToggles(); wirePanelExpand() wires
// the click.
const panelToggle = () => `<button class="pexp" type="button" title="Expand" aria-label="Expand panel">${icon("expand", "pexp-ico")}</button>`;

/* ============================================================================
   page.format.ts — formatRequest(), ported VERBATIM (readable ⇄ raw).
   The eventual implementation already ships this exact function; the mock reuses
   it so the readable/raw rendering matches 1:1.
   ============================================================================ */
function formatRequest(payload, mode) {
  var p = (payload && typeof payload === "object") ? payload : {};
  var d = (p.data && typeof p.data === "object") ? p.data : {};
  var req;
  if (d.request && typeof d.request === "object") {
    req = d.request;
  } else {
    req = { system: (d.context && typeof d.context.text === "string") ? d.context.text : undefined, messages: d.messages };
  }
  if (mode === "raw") return JSON.stringify(req, null, 2);
  var parts = [];
  var sys = (typeof req.system === "string") ? req.system : "";
  if (sys) parts.push(sys);
  var msgs = req.messages;
  if (Array.isArray(msgs) && msgs.length) {
    var lines = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = (msgs[i] && typeof msgs[i] === "object") ? msgs[i] : {};
      var head = m.role ? String(m.role) : "?";
      if (typeof m.name === "string" && m.name) head += " (" + m.name + ")";
      var body;
      if (typeof m.content === "string") body = m.content;
      else if (m.content == null) body = "";
      else body = JSON.stringify(m.content);
      var line = head + ": " + body;
      if (typeof m.toolCallId === "string") line += "  [toolCallId=" + m.toolCallId + "]";
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) line += "\n    toolCalls: " + JSON.stringify(m.toolCalls);
      lines.push(line);
    }
    parts.push("— messages (" + msgs.length + ") —\n" + lines.join("\n"));
  }
  var tools = req.tools;
  if (Array.isArray(tools) && tools.length) {
    var names = [];
    for (var j = 0; j < tools.length; j++) { var t = tools[j]; names.push((t && typeof t.name === "string") ? t.name : "?"); }
    parts.push("— tools (" + tools.length + ") —\n" + names.join(", "));
  }
  var pp = [];
  if (typeof req.temperature === "number") pp.push("temperature=" + req.temperature);
  if (typeof req.maxTokens === "number") pp.push("maxTokens=" + req.maxTokens);
  if (typeof req.model === "string") pp.push("model=" + req.model);
  if (pp.length) parts.push("params: " + pp.join(" · "));
  return parts.join("\n\n");
}

/* ============================================================================
   FAKE BUS DATA — two agents, each a believable session of beats.
   Record shape mirrors the inspector's wire records exactly:
     { seq, at, kind, corrId?, payload }
   kinds:  agent.start · tick · gather · prompt.sent · prompt.received · input ·
           output · tool.result · log · conversation
   ============================================================================ */

// The assembled request that the real `llm.request.sent` carries under
// payload.data.request — system prompt blocks composed by priority, a messages
// array, a couple of tools, and params. This is the load-bearing shape the real
// Prompts panel must surface.
function assembledRequest(persona, userMsg, assistantTurns) {
  const systemBlocks = [
    "[persona · prio 10000]\nYou are Krakey, an autonomous agent running on a heartbeat. Be concise, candid, and act with intent. " + persona,
    "[system-prompt · prio 9000]\nThe current time is " + new Date().toISOString() + ". You wake every 30s; if there is nothing to do, return a short monologue and stop.",
    "[web-chat.guidance · prio 500]\nWeb search is available via the `web_search` tool. Prefer primary sources. Cite URLs inline. Never fabricate a result you did not fetch.",
  ].join("\n\n");
  const messages = [{ role: "user", content: userMsg }];
  for (const t of (assistantTurns || [])) messages.push(t);
  return {
    model: "claude-sonnet-4-6",
    system: systemBlocks,
    messages,
    tools: [
      { name: "web_search", description: "Search the web and return ranked results." },
      { name: "fetch_url", description: "Fetch a URL and return readable text." },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  };
}

function buildKrakeySession() {
  const t0 = Date.now() - 7 * 60 * 1000;
  let seq = 0, t = t0;
  const recs = [];
  const push = (kind, payload, corrId, dt) => { t += (dt != null ? dt : 0); recs.push({ seq: seq++, at: t, kind, corrId, payload }); };

  push("agent.start", { data: { agentId: "krakey" } }, undefined, 0);
  push("log", { data: { level: "info", pluginId: "core:loader", text: "registered 5 plugins: persona, system-prompt, llm-core, web, krakeycode" } }, undefined, 40);
  push("log", { data: { level: "info", pluginId: "core:orchestrator", text: "context-buffer initialized · 3 fixed blocks" } }, undefined, 30);

  // ---- BEAT 1: a plain heartbeat with a web search tool call ----
  const c1 = "req_a1f09c";
  push("tick", { data: { seq: 1 } }, undefined, 1200);
  push("gather", { data: { seq: 1 } }, undefined, 60);
  push("log", { data: { level: "info", pluginId: "system-prompt", text: "composed 3 context blocks (10000, 9000, 500)" } }, undefined, 25);
  push("prompt.sent", { data: { request: assembledRequest("Your operator is Samuel.", "What launched on Hacker News in the last hour worth my attention?", []) } }, c1, 120);
  push("input", { data: { text: "What launched on Hacker News in the last hour worth my attention?" } }, c1, 5);
  push("prompt.received", { ok: true, data: {
    content: "Let me check the front page right now.",
    toolCalls: [{ id: "tc_1", name: "web_search", input: { query: "Hacker News new launches past hour", recency: "1h" } }],
    stopReason: "tool_use", usage: { inputTokens: 1184, outputTokens: 64 },
  } }, c1, 940);
  push("tool.result", { name: "web_search", ok: true, data: { results: 8, top: "Show HN: a local-first sync engine" } }, c1, 1300);
  push("prompt.sent", { data: { request: assembledRequest("Your operator is Samuel.",
    "What launched on Hacker News in the last hour worth my attention?",
    [
      { role: "assistant", content: "Let me check the front page right now.", toolCalls: [{ id: "tc_1", name: "web_search" }] },
      { role: "tool", name: "web_search", toolCallId: "tc_1", content: "8 results · top: Show HN: a local-first sync engine (142 pts)" },
    ]) } }, c1, 80);
  push("prompt.received", { ok: true, data: {
    content: "One stands out: \"Show HN: a local-first sync engine\" (142 pts, 1h old). It does CRDT merge over a tiny WASM core — relevant to the offline-first ideas you flagged last week. Two others are AI-wrapper launches I'd skip.",
    toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1342, outputTokens: 88 },
  } }, c1, 1080);
  push("output", { data: { text: "One stands out: \"Show HN: a local-first sync engine\" (142 pts) — CRDT merge over a tiny WASM core, relevant to your offline-first ideas." } }, c1, 8);
  push("conversation", { data: { messages: [1, 2, 3, 4] } }, undefined, 6);

  // ---- BEAT 2: idle beat, nothing to do, short monologue ----
  const c2 = "req_b733e1";
  push("tick", { data: { seq: 2 } }, undefined, 30000);
  push("gather", { data: { seq: 2 } }, undefined, 55);
  push("prompt.sent", { data: { request: assembledRequest("Operator is away (idle).", "(heartbeat — nothing queued)", []) } }, c2, 110);
  push("prompt.received", { ok: true, data: {
    content: "Nothing queued and no new signals since the last beat. Standing by.",
    toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1090, outputTokens: 16 },
  } }, c2, 760);
  push("output", { data: { text: "Nothing queued and no new signals since the last beat. Standing by." } }, c2, 7);

  // ---- BEAT 3: a code task — two tool calls, a warn log ----
  const c3 = "req_c8810a";
  push("tick", { data: { seq: 3 } }, undefined, 30000);
  push("gather", { data: { seq: 3 } }, undefined, 50);
  push("input", { data: { text: "Patch the flaky retry in fetch_url — it doesn't back off." } }, c3, 40);
  push("prompt.sent", { data: { request: assembledRequest("Operator is Samuel.", "Patch the flaky retry in fetch_url — it doesn't back off.", []) } }, c3, 120);
  push("prompt.received", { ok: true, data: {
    content: "I'll read the current implementation first.",
    toolCalls: [{ id: "tc_2", name: "read_file", input: { path: "packages/web/src/fetch.ts" } }],
    stopReason: "tool_use", usage: { inputTokens: 1210, outputTokens: 42 },
  } }, c3, 880);
  push("tool.result", { name: "read_file", ok: true, data: { bytes: 2204 } }, c3, 240);
  push("log", { data: { level: "warn", pluginId: "krakeycode", text: "edit target has no test coverage — proceeding but flagging" } }, undefined, 30);
  push("prompt.sent", { data: { request: assembledRequest("Operator is Samuel.", "Patch the flaky retry in fetch_url — it doesn't back off.",
    [
      { role: "assistant", content: "I'll read the current implementation first.", toolCalls: [{ id: "tc_2", name: "read_file" }] },
      { role: "tool", name: "read_file", toolCallId: "tc_2", content: "<2204 bytes of fetch.ts>" },
    ]) } }, c3, 70);
  push("prompt.received", { ok: true, data: {
    content: "Found it — the retry loop sleeps a constant 200ms. I'll switch it to exponential backoff with jitter.",
    toolCalls: [{ id: "tc_3", name: "edit_file", input: { path: "packages/web/src/fetch.ts" } }],
    stopReason: "tool_use", usage: { inputTokens: 1455, outputTokens: 96 },
  } }, c3, 1240);
  push("tool.result", { name: "edit_file", ok: true, data: { applied: true } }, c3, 180);
  push("output", { data: { text: "Patched fetch_url: constant 200ms sleep → exponential backoff (200ms × 2^n) with ±20% jitter, capped at 5s. No test covered it; flagged that above." } }, c3, 9);

  // ---- BEAT 4: a FAILED request (provider 529) ----
  const c4 = "req_d1f44b";
  push("tick", { data: { seq: 4 } }, undefined, 30000);
  push("gather", { data: { seq: 4 } }, undefined, 60);
  push("prompt.sent", { data: { request: assembledRequest("Operator is Samuel.", "Summarize today's commits.", []) } }, c4, 130);
  push("log", { data: { level: "error", pluginId: "core:llm-gateway", text: "provider returned 529 (overloaded) — request req_d1f44b not retried (max attempts)" } }, undefined, 900);
  push("prompt.received", { ok: false, error: "provider overloaded (529) after 3 attempts" }, c4, 20);

  // ---- BEAT 5: recovered, conversation turn ----
  const c5 = "req_e90c27";
  push("tick", { data: { seq: 5 } }, undefined, 12000);
  push("gather", { data: { seq: 5 } }, undefined, 55);
  push("input", { data: { text: "Try the commit summary again." } }, c5, 30);
  push("prompt.sent", { data: { request: assembledRequest("Operator is Samuel.", "Try the commit summary again.", []) } }, c5, 110);
  push("prompt.received", { ok: true, data: {
    content: "Today: 4 commits. Two re-skin the inspector to the cockpit theme, one fixes the fetch_url backoff, one bumps the heartbeat default to 30s. Nothing touched core.",
    toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1276, outputTokens: 71 },
  } }, c5, 1020);
  push("output", { data: { text: "Today: 4 commits — 2 inspector re-skin, 1 fetch_url backoff, 1 heartbeat default. Core untouched." } }, c5, 8);
  push("log", { data: { level: "print", pluginId: "krakeycode", text: "summary delivered to web chat channel" } }, undefined, 12);

  return recs;
}

function buildScoutSession() {
  const t0 = Date.now() - 3 * 60 * 1000;
  let seq = 0, t = t0;
  const recs = [];
  const push = (kind, payload, corrId, dt) => { t += (dt != null ? dt : 0); recs.push({ seq: seq++, at: t, kind, corrId, payload }); };
  push("agent.start", { data: { agentId: "scout" } }, undefined, 0);
  push("log", { data: { level: "info", pluginId: "core:loader", text: "registered 3 plugins: persona, system-prompt, llm-core" } }, undefined, 40);
  const s1 = "req_f01122";
  push("tick", { data: { seq: 1 } }, undefined, 800);
  push("gather", { data: { seq: 1 } }, undefined, 50);
  push("prompt.sent", { data: { request: {
    model: "gpt-4o-mini",
    system: "[persona · prio 10000]\nYou are Scout, a minimal monitoring agent. Report anomalies tersely.",
    messages: [{ role: "user", content: "Any anomalies in the last window?" }],
    temperature: 0.2, maxTokens: 512,
  } } }, s1, 90);
  push("prompt.received", { ok: true, data: {
    content: "No anomalies. CPU 12%, queue depth 0.", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 220, outputTokens: 12 },
  } }, s1, 420);
  push("output", { data: { text: "No anomalies. CPU 12%, queue depth 0." } }, s1, 6);
  return recs;
}

const AGENTS = {
  krakey: { id: "krakey", sub: "5 plugins · every 30s · live", model: "claude-sonnet-4-6", records: buildKrakeySession() },
  scout:  { id: "scout",  sub: "3 plugins · every 60s · live", model: "gpt-4o-mini",      records: buildScoutSession() },
};

/* ============================================================================
   STATE MACHINE over the fake records — mirrors page.script.ts applyRecord().
   ============================================================================ */
function freshState(id) {
  return { id, records: [], prompts: {}, promptOrder: [], beats: [], logs: [] };
}
const KIND_CLASS = {
  "agent.start": "k-start", "tick": "k-tick", "gather": "k-gather",
  "prompt.sent": "k-sent", "prompt.received": "k-recv", "input": "k-input",
  "output": "k-output", "tool.result": "k-tool", "conversation": "k-conv", "log": "k-log",
};
const KIND_ICON = {
  "agent.start": "stars", "tick": "tick", "gather": "layers", "prompt.sent": "send",
  "prompt.received": "receive", "input": "chat", "output": "chat", "tool.result": "wrench",
  "conversation": "journal", "log": "terminal",
};
function get(obj, path) { let cur = obj; for (const k of path) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[k]; } return cur; }

function summarize(rec) {
  const p = rec.payload;
  switch (rec.kind) {
    case "prompt.sent": {
      const rq = get(p, ["data", "request"]);
      if (rq) { const mc = Array.isArray(rq.messages) ? rq.messages.length : 0; const tc = Array.isArray(rq.tools) ? rq.tools.length : 0; return "messages=" + mc + (tc ? (", tools=" + tc) : ""); }
      return "(context)";
    }
    case "prompt.received": {
      if (p && p.ok === false) return "error: " + (p.error || "?");
      const d = p && p.data; const calls = d && d.toolCalls ? d.toolCalls.length : 0; const clen = d && typeof d.content === "string" ? d.content.length : 0;
      return "content len=" + clen + (calls ? (", toolCalls=" + calls) : "");
    }
    case "input": return JSON.stringify(get(p, ["data", "text"]) || "");
    case "output": return JSON.stringify(get(p, ["data", "text"]) || "");
    case "tool.result": { const nm = p && p.name ? p.name : "?"; return nm + (p && p.ok === false ? " (error)" : " ok"); }
    case "log": return (get(p, ["data", "level"]) || "?") + " " + (get(p, ["data", "pluginId"]) || "?") + ": " + (get(p, ["data", "text"]) || "");
    case "tick": return "seq=" + get(p, ["data", "seq"]);
    case "gather": return "seq=" + get(p, ["data", "seq"]);
    case "agent.start": return get(p, ["data", "agentId"]) || "";
    case "conversation": { const m = get(p, ["data", "messages"]); return (Array.isArray(m) ? m.length : 0) + " turns"; }
    default: return "";
  }
}

function applyRecord(s, rec) {
  s.records.push(rec);
  if ((rec.kind === "prompt.sent" || rec.kind === "prompt.received") && rec.corrId) {
    if (!s.prompts[rec.corrId]) { s.prompts[rec.corrId] = {}; s.promptOrder.push(rec.corrId); }
    if (rec.kind === "prompt.sent") {
      // chooseSent: prefer the assembled request (payload.data.request) — mirrors page.format.ts
      const cur = s.prompts[rec.corrId].sent;
      if (!cur) s.prompts[rec.corrId].sent = rec;
      else if (get(rec.payload, ["data", "request"])) s.prompts[rec.corrId].sent = rec;
      else if (!get(cur.payload, ["data", "request"])) s.prompts[rec.corrId].sent = rec;
    } else s.prompts[rec.corrId].received = rec;
  }
  if (rec.kind === "log") s.logs.push(rec);
  if (rec.kind === "tick" || rec.kind === "gather") {
    s.beats.push({ seq: rec.seq, at: rec.at, label: rec.kind + " " + get(rec.payload, ["data", "seq"]), records: [rec] });
  } else {
    if (!s.beats.length) s.beats.push({ seq: rec.seq, at: rec.at, label: "pre-beat", records: [] });
    s.beats[s.beats.length - 1].records.push(rec);
  }
}

/* ============================================================================
   RENDERERS  — one per panel.
   ============================================================================ */
let promptView = "readable";

function renderCounts(s) {
  setText("#cEvents", s.records.length);
  setText("#cPrompts", s.promptOrder.length);
  setText("#cLogs", s.logs.length);
  setText("#cBeats", s.beats.length);
}
const setText = (sel, v) => { const n = $(sel); if (n) n.textContent = v; };

function renderEvents(s) {
  const body = $("#events"); body.innerHTML = "";
  if (!s.records.length) { body.innerHTML = '<div class="empty">No events yet.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (const rec of s.records) {
    const cls = KIND_CLASS[rec.kind] || "";
    const ico = KIND_ICON[rec.kind] || "box";
    const row = el("div", "ev " + cls);
    row.innerHTML =
      `<span class="seq">#${rec.seq}</span><span class="time">${fmtTime(rec.at)}</span>` +
      `<span class="ico">${icon(ico)}</span>` +
      `<span class="kind">${esc(rec.kind)}</span>` +
      `<span class="sum">${esc(summarize(rec))}</span>`;
    frag.appendChild(row);
  }
  body.appendChild(frag);
  if ($("#autoFollow").classList.contains("on")) body.scrollTop = body.scrollHeight;
}

// Readable view: render the assembled request as discrete blocks; raw view: JSON.
function renderRequestReadable(req) {
  if (!req) return '<div class="respmono">(no request captured)</div>';
  let html = '<div class="rdblock">';
  // system blocks — split the composed system string back into priority blocks
  if (typeof req.system === "string" && req.system) {
    html += '<div class="blk"><div class="blk-h">system prompt <span class="bn">· composed by priority</span></div>';
    const blocks = req.system.split("\n\n");
    for (const b of blocks) {
      const m = b.match(/^\[(.+?)\]\n?([\s\S]*)$/);
      if (m) html += `<div class="sysblk"><span class="prio">${esc(m[1])}</span>${esc(m[2].trim())}</div>`;
      else html += `<div class="sysblk">${esc(b)}</div>`;
    }
    html += '</div>';
  }
  // messages
  if (Array.isArray(req.messages) && req.messages.length) {
    html += `<div class="blk"><div class="blk-h">messages <span class="bn">· ${req.messages.length}</span></div>`;
    for (const m of req.messages) {
      const role = m.role || "?";
      let body = typeof m.content === "string" ? m.content : (m.content == null ? "" : JSON.stringify(m.content));
      let extra = "";
      if (m.toolCallId) extra += ` <span class="tcid">[toolCallId=${esc(m.toolCallId)}]</span>`;
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) extra += ` <span class="tcid">→ calls ${esc(m.toolCalls.map((c) => c.name).join(", "))}</span>`;
      const nm = m.name ? ` (${esc(m.name)})` : "";
      html += `<div class="msg"><span class="role ${esc(role)}">${esc(role)}${nm}</span><span class="mc">${esc(body)}${extra}</span></div>`;
    }
    html += '</div>';
  }
  // tools
  if (Array.isArray(req.tools) && req.tools.length) {
    html += `<div class="blk"><div class="blk-h">tools <span class="bn">· ${req.tools.length}</span></div><div class="toolchips">`;
    html += req.tools.map((t) => `<span class="toolchip">${esc(t.name || "?")}</span>`).join("");
    html += '</div></div>';
  }
  // params
  const pp = [];
  if (typeof req.model === "number" || typeof req.model === "string") pp.push(["model", req.model]);
  if (typeof req.temperature === "number") pp.push(["temperature", req.temperature]);
  if (typeof req.maxTokens === "number") pp.push(["maxTokens", req.maxTokens]);
  if (pp.length) {
    html += '<div class="blk"><div class="blk-h">params</div><div class="params">';
    html += pp.map(([k, v]) => `<span><b>${esc(k)}</b> <span class="pv">${esc(v)}</span></span>`).join("");
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

function renderPrompts(s) {
  const body = $("#prompts"); body.innerHTML = "";
  if (!s.promptOrder.length) { body.innerHTML = '<div class="empty">No prompts yet.</div>'; return; }
  // Index corrId → beat number for a friendly correlation crumb.
  const beatOf = {};
  s.beats.forEach((b, i) => { for (const r of b.records) if (r.corrId) beatOf[r.corrId] = i; });

  for (const cid of s.promptOrder) {
    const pr = s.prompts[cid];
    let badge, bcls;
    if (!pr.received) { badge = "pending"; bcls = "pending"; }
    else if (pr.received.payload && pr.received.payload.ok === false) { badge = "error"; bcls = "err"; }
    else { badge = "ok"; bcls = "ok"; }

    const req = pr.sent ? get(pr.sent.payload, ["data", "request"]) : null;
    const div = el("div", "pair");
    let inner = `<div class="ph">corr <span class="corr">${esc(cid)}</span>` +
      (beatOf[cid] != null ? `<span class="beatno">· beat #${beatOf[cid]}</span>` : "") +
      `<span class="badge ${bcls}">${badge}</span></div>`;

    // request block — readable vs raw
    inner += '<div class="seclabel req">request</div>';
    if (promptView === "raw") {
      inner += `<pre>${esc(formatRequest(pr.sent ? pr.sent.payload : {}, "raw"))}</pre>`;
    } else {
      inner += renderRequestReadable(req);
    }

    // response block
    inner += '<div class="seclabel resp">response</div>';
    if (!pr.received) {
      inner += '<div class="respmono">(awaiting response…)</div>';
    } else {
      const rp = pr.received.payload;
      if (rp && rp.ok === false) {
        inner += `<div class="respmono" style="color:var(--danger)">error: ${esc(rp.error || "?")}</div>`;
      } else if (promptView === "raw") {
        const d = rp && rp.data;
        inner += `<pre>${esc(pretty({ content: d && d.content, toolCalls: d && d.toolCalls, stopReason: d && d.stopReason, usage: d && d.usage }))}</pre>`;
      } else {
        const d = rp && rp.data;
        let r = `<div class="respmono">`;
        if (d && d.content) r += `<div style="margin-bottom:8px">${esc(d.content)}</div>`;
        if (d && Array.isArray(d.toolCalls) && d.toolCalls.length) {
          r += `<div class="toolchips" style="margin-bottom:8px">` + d.toolCalls.map((c) => `<span class="toolchip">${esc(c.name)}()</span>`).join("") + `</div>`;
        }
        const meta = [];
        if (d && d.stopReason) meta.push(`<span class="mono-key">stop</span> ${esc(d.stopReason)}`);
        if (d && d.usage) meta.push(`<span class="mono-key">tokens</span> ${esc(d.usage.inputTokens)}→${esc(d.usage.outputTokens)}`);
        if (meta.length) r += `<div class="params">${meta.map((m) => `<span>${m}</span>`).join("")}</div>`;
        r += `</div>`;
        inner += r;
      }
    }
    div.innerHTML = inner;
    body.appendChild(div);
  }
}

function renderLogs(s) {
  const body = $("#logs"); if (!body) return;
  body.innerHTML = "";
  const lvl = currentLevel;
  const pidF = $("#logPid").value.trim().toLowerCase();
  let shown = 0;
  for (const rec of s.logs) {
    const d = get(rec.payload, ["data"]) || {};
    if (lvl && d.level !== lvl) continue;
    if (pidF && String(d.pluginId || "").toLowerCase().indexOf(pidF) === -1) continue;
    const isCore = String(d.pluginId || "").startsWith("core:");
    const row = el("div", "log lvl-" + esc(d.level || ""));
    row.innerHTML =
      `<span class="lvl ${esc(d.level || "")}">${esc(d.level || "?")}</span>` +
      `<span class="pid${isCore ? " core" : ""}">${esc(d.pluginId || "?")}</span>` +
      `<span class="txt">${esc(d.text || "")}</span>`;
    body.appendChild(row);
    shown++;
  }
  if (!shown) body.innerHTML = '<div class="empty">No matching logs.</div>';
  const lf = $("#logFollow");
  if (lf && lf.classList.contains("on")) body.scrollTop = body.scrollHeight;
}

// Map a record to a lifecycle stage label + class for the beat lane.
const STAGE = {
  "tick": ["heartbeat", "s-gather"], "gather": ["gather", "s-gather"],
  "prompt.sent": ["request →", "s-sent"], "prompt.received": ["← return", "s-recv"],
  "tool.result": ["tool", "s-tool"], "input": ["input", "s-gather"],
  "output": ["output", "s-output"], "conversation": ["conversation", "s-output"],
  "log": ["log", ""], "agent.start": ["start", "s-output"],
};
function renderBeats(s) {
  const body = $("#beats"); body.innerHTML = "";
  if (!s.beats.length) { body.innerHTML = '<div class="empty">No beats yet.</div>'; return; }
  for (const b of s.beats) {
    const div = el("div", "beat");
    const last = b.records[b.records.length - 1];
    const dur = last ? (last.at - b.at) : 0;
    let html = `<div class="bh"><span class="bdot"></span>beat — ${esc(b.label)} <span class="bmeta">· ${fmtTime(b.at)} · ${b.records.length} events</span>` +
      `<span class="bdur">⏱ <b>${dur}ms</b></span></div><div class="lane">`;
    for (const r of b.records) {
      const [label, scls] = STAGE[r.kind] || [r.kind, ""];
      const corr = r.corrId ? ` <span class="corr">· ${esc(r.corrId)}</span>` : "";
      const dt = r.at - b.at;
      html += `<div class="step ${scls}"><span class="stage">${esc(label)}</span><span class="sd">${esc(summarize(r))}${corr}</span><span class="t">+${dt}ms</span></div>`;
    }
    html += '</div>';
    div.innerHTML = html;
    body.appendChild(div);
  }
}

/* ============================================================================
   SHELL  — LEFT SIDEBAR (brand + agent roster + status + mock-state dev controls)
   and a full-width SURFACE (lock/landing screens + the dashboard grid). No top
   bar of its own: when embedded in the Console it shows only its own sidebar. No
   tab bar either — the Overview grid is home; each panel carries one dedicated
   expand⇄return button at the far right of its header (see wirePanelExpand).
   ============================================================================ */
let state = null;
let currentLevel = "";  // log level filter
let currentView = "overview";

function buildShell() {
  const root = el("div", "app");
  root.innerHTML = `
    <!-- LEFT SIDEBAR — brand + agent roster + status + mock-state dev controls.
         Mirrors config-web / chat so all three surfaces match; replaces the old
         top header so the inspector shows no double top bar inside the Console. -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">${icon("stars")}</span>
        <div>
          <div class="mark">KRAKEY <span class="b">Inspector</span></div>
          <div class="tag">ultimate autonomous agent</div>
        </div>
      </div>

      <div class="roster-label">Agents</div>
      <div class="roster" id="roster"></div>

      <div class="sb-status">
        <span class="status" id="status"><span class="dot"></span><span class="st-text">idle</span></span>
      </div>

      <div class="foot">
        <div class="dev-strip">
          <span class="dl">mock states</span>
          <button data-state="dashboard" class="on">Dashboard</button>
          <button data-state="landing">Landing</button>
          <button data-state="lock">Lock</button>
        </div>
        <p class="note"><span class="d">●</span> static design mock<br>fake bus data</p>
      </div>
    </aside>

    <!-- SURFACE — full-width, NO top bar: lock/landing screens + the 2×2 grid -->
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
          <div class="agent-list" id="agentList"></div>
        </div>
      </div>

      <!-- DASHBOARD: the four panels -->
      <main class="dash main" id="main" data-view="overview">
        <section class="panel panel--prompts" data-view="prompts">
          <header>
            <span class="g">${icon("send")}</span><h3>Prompts</h3><span class="count" id="cPrompts">0</span>
            <div class="hc">
              <div class="seg" id="pvToggle">
                <button data-pv="readable" class="active">Readable</button>
                <button data-pv="raw">Raw</button>
              </div>
              ${panelToggle()}
            </div>
          </header>
          <div class="body" id="prompts"><div class="empty">No prompts yet.</div></div>
        </section>

        <section class="panel panel--events" data-view="events">
          <header>
            <span class="g">${icon("activity")}</span><h3>Event stream</h3><span class="count" id="cEvents">0</span>
            <div class="hc">${panelToggle()}</div>
          </header>
          <div class="toolbar">
            <label class="chk on" id="autoFollow"><span class="box">${icon("check")}</span><span class="lbl">auto-follow</span></label>
          </div>
          <div class="body" id="events"><div class="empty">No events yet.</div></div>
        </section>

        <section class="panel panel--beats" data-view="beats">
          <header>
            <span class="g">${icon("layers")}</span><h3>Per-beat timeline</h3><span class="count" id="cBeats">0</span>
            <div class="hc">${panelToggle()}</div>
          </header>
          <div class="body" id="beats"><div class="empty">No beats yet.</div></div>
        </section>

        <section class="panel panel--logs" data-view="logs">
          <header>
            <span class="g">${icon("terminal")}</span><h3>Logs</h3><span class="count" id="cLogs">0</span>
            <div class="hc">${panelToggle()}</div>
          </header>
          <div class="toolbar">
            <label class="chk on" id="logFollow"><span class="box">${icon("check")}</span><span class="lbl">auto-follow</span></label>
            <div class="levelseg" id="logLevel">
              <button data-lvl="" class="active">all</button>
              <button data-lvl="info">info</button>
              <button data-lvl="warn">warn</button>
              <button data-lvl="error">error</button>
              <button data-lvl="print">print</button>
            </div>
            <span class="filter-ico">${icon("search")}</span>
            <input class="tin" id="logPid" placeholder="pluginId…" />
          </div>
          <div class="body" id="logs"><div class="empty">No logs yet.</div></div>
        </section>
      </main>
    </div>`;
  document.body.appendChild(root);

  wirePanelExpand();
  wireAgentRoster();
  wirePromptToggle();
  wireLogFilters();
  wireAutoFollow();
  wireLogFollow();
  wireDevStrip();
}

function setStatus(text, cls) {
  const s = $("#status");
  s.className = "status" + (cls ? " " + cls : "");
  $(".st-text", s).textContent = text;
}

function showScreen(which) {
  $("#lock").classList.toggle("show", which === "lock");
  $("#landing").classList.toggle("show", which === "landing");
  $("#main").classList.toggle("show", which === "dashboard");
  // leaving the dashboard collapses any expanded panel back to the grid
  if (which !== "dashboard") collapsePanels();
  // when locked there is no agent to inspect — dim the roster so it reads inert.
  const roster = $("#roster");
  if (roster) roster.style.opacity = which === "lock" ? "0.4" : "";
  if (which === "lock") setStatus("locked", "err");
  else if (which === "landing") setStatus("select an agent");
}

/* ── expand⇄return panels: pure CSS toggle via main[data-view] ─────────────
   Overview (2×2 grid) is the home view. Each panel carries ONE dedicated,
   always-visible button (`.pexp`) at the far right of its header. In the grid it
   is an Expand control; clicking it expands THAT panel to the full-screen
   single-panel layout the tabs used to drive. In the expanded view the SAME
   button becomes a Return control (minimize glyph, icon-only — tooltip + aria
   carry the meaning) that returns to the grid. The button stops propagation;
   the panel header is no longer a
   click target, so the panel's own controls (Readable⇄Raw seg, filters,
   auto-follow) are untouched.                                                  */

// Reflect the current view onto every panel's toggle button: Expand in the grid,
// Return when expanded. Swaps ONLY the icon, the tooltip, and the aria-label so the
// single icon-only button reads correctly in both states (no on-screen text).
function syncPanelToggles() {
  const expanded = currentView !== "overview";
  $$(".pexp").forEach((btn) => {
    const ico = $(".pexp-ico", btn);
    // ICON-ONLY in both states: only the glyph + tooltip + aria-label change.
    if (expanded) {
      btn.classList.add("is-return");
      btn.title = "Return to overview";
      btn.setAttribute("aria-label", "Return to overview");
      if (ico) ico.outerHTML = icon("minimize", "pexp-ico");
    } else {
      btn.classList.remove("is-return");
      btn.title = "Expand";
      btn.setAttribute("aria-label", "Expand panel");
      if (ico) ico.outerHTML = icon("expand", "pexp-ico");
    }
  });
}
function expandPanel(view) {
  currentView = view;
  const main = $("#main");
  main.setAttribute("data-view", view);
  main.classList.remove("view-enter"); void main.offsetWidth; main.classList.add("view-enter");
  syncPanelToggles();
  // pin auto-followed streams to the bottom once the expanded layout settles
  pinFollowed();
}
function collapsePanels() {
  currentView = "overview";
  const main = $("#main");
  if (!main) return;
  main.setAttribute("data-view", "overview");
  main.classList.remove("view-enter"); void main.offsetWidth; main.classList.add("view-enter");
  syncPanelToggles();
  pinFollowed();
}
// re-pin any auto-followed body to the bottom (event stream + logs)
function pinFollowed() {
  const ev = $("#events"); if (ev && $("#autoFollow").classList.contains("on")) ev.scrollTop = ev.scrollHeight;
  const lg = $("#logs"); if (lg && $("#logFollow").classList.contains("on")) lg.scrollTop = lg.scrollHeight;
}
function wirePanelExpand() {
  $$(".panel").forEach((panel) => {
    const view = panel.getAttribute("data-view");
    const btn = $(".pexp", panel);
    if (!btn) return;
    // The dedicated button is the ONLY trigger. stopPropagation keeps it from
    // disturbing the panel's other controls. In the grid it expands this panel;
    // when already expanded it returns to the grid.
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if ($("#main").getAttribute("data-view") === "overview") expandPanel(view);
      else collapsePanels();
    });
  });
  syncPanelToggles();
}

/* ── agent roster (sidebar, chat-mock vocabulary) ──────────────────────────
   Replaces the header dropdown with a sidebar list — one row per agent: a small
   mint avatar (initial + live presence dot), the agent id, and a mono sub line
   (plugins · interval · live). Selecting a row inspects that agent's bus.
   reflectRoster(curId) just moves the .sel highlight (used after selectAgent). */
function wireAgentRoster() {
  const roster = $("#roster");
  const ids = Object.keys(AGENTS);
  roster.innerHTML = ids.map((id) => {
    const a = AGENTS[id];
    return `<button class="agent" type="button" data-id="${esc(id)}" title="${esc(id)} — ${esc(a.sub)}">` +
      `<span class="av">${esc(id.slice(0, 1))}<span class="pres"></span></span>` +
      `<span class="at"><span class="an" title="${esc(id)}">${esc(id)}</span>` +
      `<span class="as" title="${esc(a.sub)}">${esc(a.sub)}</span></span></button>`;
  }).join("");
  $$(".agent", roster).forEach((row) => {
    row.onclick = () => selectAgent(row.getAttribute("data-id"));
  });
}

// Move the .sel highlight onto the row for `curId` (called from selectAgent).
function reflectRoster(curId) {
  $$("#roster .agent").forEach((row) => row.classList.toggle("sel", row.getAttribute("data-id") === curId));
}

/* ── prompt readable/raw toggle (actually switches) ────────────────────────*/
function wirePromptToggle() {
  const seg = $("#pvToggle");
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    const pv = btn.getAttribute("data-pv");
    if (!pv || pv === promptView) return;
    promptView = pv;
    $$("button", seg).forEach((b) => b.classList.toggle("active", b.getAttribute("data-pv") === pv));
    if (state) renderPrompts(state);
  });
}

/* ── log filters (actually filter) ─────────────────────────────────────────*/
function wireLogFilters() {
  const seg = $("#logLevel");
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    currentLevel = btn.getAttribute("data-lvl");
    $$("button", seg).forEach((b) => b.classList.toggle("active", b === btn));
    if (state) renderLogs(state);
  });
  $("#logPid").addEventListener("input", () => { if (state) renderLogs(state); });
}

/* ── auto-follow (actually pins to bottom) ─────────────────────────────────*/
function wireAutoFollow() {
  const chk = $("#autoFollow");
  chk.addEventListener("click", () => {
    chk.classList.toggle("on");
    if (chk.classList.contains("on")) { const b = $("#events"); b.scrollTop = b.scrollHeight; }
  });
  // manual scroll up unchecks it (mirrors the real page behavior)
  $("#events").addEventListener("scroll", function () {
    const b = $("#events");
    const atBottom = (b.scrollHeight - b.scrollTop - b.clientHeight) < 24;
    if (!atBottom && chk.classList.contains("on")) chk.classList.remove("on");
  });
}

/* ── logs auto-follow (pins the Logs panel to bottom, like the event stream) ─*/
function wireLogFollow() {
  const chk = $("#logFollow");
  chk.addEventListener("click", () => {
    chk.classList.toggle("on");
    if (chk.classList.contains("on")) { const b = $("#logs"); b.scrollTop = b.scrollHeight; }
  });
  // manual scroll up unchecks it (same behavior as the event-stream follow)
  $("#logs").addEventListener("scroll", function () {
    const b = $("#logs");
    const atBottom = (b.scrollHeight - b.scrollTop - b.clientHeight) < 24;
    if (!atBottom && chk.classList.contains("on")) chk.classList.remove("on");
  });
}

/* ── dev strip (mock-only state previews) ──────────────────────────────────*/
function wireDevStrip() {
  $$(".dev-strip button").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".dev-strip button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      showScreen(btn.getAttribute("data-state"));
    });
  });
}

/* ── landing list ──────────────────────────────────────────────────────────*/
function renderAgentList() {
  const list = $("#agentList"); list.innerHTML = "";
  for (const id of Object.keys(AGENTS)) {
    const a = AGENTS[id];
    const card = el("button", "agent-card");
    card.innerHTML =
      `<span class="g">${icon("robot")}</span>` +
      `<span class="ac-t"><span class="id">${esc(id)}</span><span class="sub">${esc(a.sub)}</span></span>` +
      `<span class="live-dot"></span><span class="arrow">${icon("arrowRight")}</span>`;
    card.onclick = () => {
      $$(".dev-strip button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-state") === "dashboard"));
      selectAgent(id);
    };
    list.appendChild(card);
  }
}

/* ── agent-switch transition ───────────────────────────────────────────────
   Re-trigger the slide-up + fade on each panel body. Called ONLY from
   selectAgent (an actual agent switch) — never from the render* functions, so a
   filter or auto-follow toggle (which re-render in place) does NOT animate.
   Removing then forcing reflow before re-adding the class restarts the CSS
   animation cleanly on every switch, in both the 2×2 overview and the expanded
   single-panel view (the hidden panels just don't paint).                     */
function animateAgentSwitch() {
  const bodies = $$(".panel .body");
  bodies.forEach((b) => {
    b.classList.remove("agent-in");
    void b.offsetWidth;              // force reflow so the animation restarts
    b.classList.add("agent-in");
  });
  // Drop the class once the longest panel (logs · 0.15s delay + 0.28s) settles.
  // A timer is used (not animationend) so the class is reliably cleared even for
  // panels hidden in the expanded view, where the animationend never composites.
  clearTimeout(animateAgentSwitch._t);
  animateAgentSwitch._t = setTimeout(() => {
    bodies.forEach((b) => b.classList.remove("agent-in"));
  }, 500);
}

/* ── select an agent → ingest its fake records → render all panels ─────────*/
function selectAgent(id) {
  const a = AGENTS[id];
  if (!a) return;
  state = freshState(id);
  for (const rec of a.records) applyRecord(state, rec);
  reflectRoster(id);
  renderEvents(state);
  renderPrompts(state);
  renderLogs(state);
  renderBeats(state);
  renderCounts(state);
  setStatus("live", "live");
  showScreen("dashboard");
  animateAgentSwitch();
}

/* ── boot ──────────────────────────────────────────────────────────────────*/
function boot() {
  // Embedded mode: when this surface runs inside the unified Krakey Console
  // iframe, the Console already shows one global "KRAKEY Console" brand in its
  // top nav-bar, so the inspector must NOT show its own brand (two KRAKEY logos
  // would stack). `window.self !== window.top` is true inside any iframe and
  // works cross-origin. Standalone (top-level) keeps the brand exactly as-is.
  let embedded = false;
  try { embedded = window.self !== window.top; } catch (_) { embedded = true; }
  if (embedded) document.documentElement.classList.add("embedded");

  buildShell();
  renderAgentList();
  // ?state= preview hook (lock / landing) — defaults to the rich dashboard
  const qs = new URLSearchParams(location.search);
  const want = qs.get("state");
  if (want === "lock") { showScreen("lock"); $$(".dev-strip button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-state") === "lock")); }
  else if (want === "landing") { showScreen("landing"); $$(".dev-strip button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-state") === "landing")); }
  else { selectAgent(qs.get("agent") && AGENTS[qs.get("agent")] ? qs.get("agent") : "krakey"); }
}

boot();
})();
