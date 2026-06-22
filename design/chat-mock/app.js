/* ============================================================================
   app.js — OpenKrakey web chat, DESIGN MOCK (vanilla JS, fake data).

   This is the real web chat page (public_plugin/web-chat) re-skinned onto the Config
   console's cockpit aesthetic. NO backend: the roster, transcripts, sent/read
   ticks and "heartbeat" replies are all simulated locally so the look & feel can
   be reviewed before any real node work.

   Behavior faithfully mirrors the real page (page.script.ts):
     · select an agent  → loads its transcript, enables the composer
     · send             → appends a USER bubble with a "sent" tick
     · ~heartbeat       → typing indicator, then the tick flips to "read" (mint)
                          and a canned AGENT reply lands
     · bell             → toggles reply notifications on/off
     · empty state      → "Pick an agent to start chatting."
   ============================================================================ */
(() => { // IIFE — keep locals out of global scope

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── Inline SVG icon set ────────────────────────────────────────────────────
   Line icons, currentColor, 24x24, stroke 1.7 — config-web conventions.
   `chat`, `robot`, `stars`, `activity`, `arrowRight`, `check`, `person`, `x`,
   `box` are copied VERBATIM from config-web/static/app.js. `bell`/`bellSlash`
   and `send` are new, drawn in the SAME stroke style (the tasteful additions
   the cockpit kit doesn't ship). `checkAll` is the read-tick (double check). */
const ICONS = {
  chat: `<path d="M20.5 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 20.5 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>`,
  robot: `<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4.6"/><circle cx="12" cy="3.4" r="1.2"/><circle cx="9.2" cy="13.5" r="1.3"/><circle cx="14.8" cy="13.5" r="1.3"/><path d="M9.5 17h5"/><path d="M2 12.5v3M22 12.5v3"/>`,
  stars: `<path d="M12 3c.4 3.6 1.4 4.6 5 5-3.6.4-4.6 1.4-5 5-.4-3.6-1.4-4.6-5-5 3.6-.4 4.6-1.4 5-5z"/><path d="M18.5 13.5c.2 1.7.6 2.1 2 2.3-1.4.2-1.8.6-2 2.3-.2-1.7-.6-2.1-2-2.3 1.4-.2 1.8-.6 2-2.3z"/>`,
  activity: `<path d="M3 12h3.5l2.5-7 4.5 14 2.5-7H21"/>`,
  arrowRight: `<path d="M4 12h15M13 6l6 6-6 6"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7"/>`,
  checkAll: `<path d="M2 12.5l4 4L13.5 9"/><path d="M11 16.5l1 .5L22 7"/>`,
  person: `<circle cx="12" cy="8" r="3.6"/><path d="M5.5 19.5c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/>`,
  x: `<path d="M6 6l12 12M18 6 6 18"/>`,
  box: `<rect x="4" y="4" width="16" height="16" rx="2.5"/>`,
  // new — same line-icon language as config-web
  bell: `<path d="M6 9a6 6 0 0 1 12 0c0 5 1.5 6.5 2.5 7.5H3.5C4.5 15.5 6 14 6 9z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>`,
  bellSlash: `<path d="M9.2 4.3A6 6 0 0 1 18 9c0 2.6.4 4.3 1 5.5M5.5 8.9C6 7 6 6.6 6 9c0 5-1.5 6.5-2.5 7.5h13"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M3.5 3.5l17 17"/>`,
  // send — a clean line-icon "arrow up", mirroring config-web's arrowRight/Left
  // vocabulary (reads as "send" far crisper than the old paper-plane at 18px).
  send: `<path d="M12 20V5M6 11l6-6 6 6"/>`,
  // copy — two offset rounded rects (clipboard-free "duplicate" glyph)
  copy: `<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V4.6A1.6 1.6 0 0 1 4.6 3h8.9A1.5 1.5 0 0 1 15 4.5V5"/>`,
  // quote — two FILLED quotation marks. The line-icon (fill:none+stroke) approach
  // produced broken open contours at this tiny size twice, so this glyph is a
  // FILLED path (`data-fill`) drawing two solid curved quote marks — closed shapes
  // that rasterize crisply. Each mark is a rounded block with a curved "tail",
  // forming a clean recognizable opening double-quote. See icon() for the fill
  // override.
  quote: `<path d="M5 7.5a3.5 3.5 0 0 0-2 3.2v4.3a1.5 1.5 0 0 0 1.5 1.5H8a1.5 1.5 0 0 0 1.5-1.5V12A1.5 1.5 0 0 0 8 10.5H6.4c.2-.9.8-1.6 1.7-2A1 1 0 0 0 7.5 6.6 5.4 5.4 0 0 0 5 7.5zM15 7.5a3.5 3.5 0 0 0-2 3.2v4.3a1.5 1.5 0 0 0 1.5 1.5H18a1.5 1.5 0 0 0 1.5-1.5V12A1.5 1.5 0 0 0 18 10.5h-1.6c.2-.9.8-1.6 1.7-2a1 1 0 0 0-.6-1.9A5.4 5.4 0 0 0 15 7.5z"/>`,
};
// glyphs that render as a FILLED shape rather than the default stroked line-icon
// (the tiny quote mark traces broken at 14px when stroked — filled is crisp).
const FILLED_ICONS = new Set(["quote"]);
function icon(name, cls) {
  const p = ICONS[name];
  if (!p) return "";
  const filled = FILLED_ICONS.has(name);
  const paint = filled
    ? `fill="currentColor" stroke="none"`
    : `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" ${paint} aria-hidden="true">${p}</svg>`;
}

/* ── Fake roster ────────────────────────────────────────────────────────────
   Believable agent personas. Each carries a canned opening transcript and a
   small pool of canned replies the "heartbeat" cycles through. `read: true` on
   a user message means its tick lands already flipped (history that the agent
   has already processed) — mirrors m.status==='read' from the real stream. */
const AGENTS = [
  {
    id: "krakey",
    name: "krakey",
    sub: "online · 30s heartbeat",
    persona: "the default autonomous agent",
    online: true,
    transcript: [
      { role: "agent", text: "Beat 412 online. I swept the repo for the morning — three PRs are green and ready for your review. Want the digest?" },
      { role: "me", text: "Yes, give me the short version.", read: true },
      { role: "agent", text: "• #210 ships the SSE reconnect fix — tests pass.\n• #211 bumps the LLM gateway timeout to 45s.\n• #212 is the docs pass for the wizard.\n\nAll three are low-risk. I can merge them on your word." },
    ],
    replies: [
      "On it. I'll fold that into the next beat and report back.",
      "Done — I queued the change and verified the edge tests still pass.",
      "Good call. I'll keep watching that and ping you if anything drifts.",
      "Noted. Nothing else is pending, so I'll idle until the next heartbeat.",
    ],
  },
  {
    id: "scout",
    name: "scout",
    sub: "online · 15s heartbeat",
    persona: "research & web-search agent",
    online: true,
    transcript: [
      { role: "agent", text: "Scout here. I finished the sweep on \"local-first sync engines\" — 14 sources, 4 worth your time. Shall I summarize the four?" },
    ],
    replies: [
      "Pulling the sources now — I'll have a cited summary on the next beat.",
      "Found two more primary sources since we last spoke. Adding them to the brief.",
      "I cross-checked that claim against three independent sources. It holds up.",
      "Indexed. I'll surface anything new on this topic automatically from now on.",
    ],
  },
  {
    id: "forge",
    name: "forge",
    sub: "idle · 60s heartbeat",
    persona: "coding & build agent",
    online: true,
    transcript: [
      { role: "agent", text: "Build agent reporting. Last beat I ran the full suite: 247 passing, 0 failing, 1 skipped. The skipped one is the flaky browser test — still quarantined." },
      { role: "me", text: "Can you un-quarantine it and see if it's stable now?", read: true },
      { role: "agent", text: "Re-enabled it and ran it 20× in a loop — green every time. The flake looks fixed by the SSE reconnect work. I'll leave it on unless it bites again." },
    ],
    replies: [
      "Compiling now — I'll report the result on the next heartbeat.",
      "Tests are green. Scoped the commit to just that node, as the bus expects.",
      "I sketched the change in an isolated worktree first; it's clean. Ready to apply.",
      "That touches a contract, so I'll escalate rather than guess. Flagging it for you.",
    ],
  },
  {
    id: "warden",
    name: "warden",
    sub: "offline · last beat 4m ago",
    persona: "ops & monitoring agent",
    online: false,
    transcript: [
      { role: "agent", text: "Warden. All services nominal at last check — gateway p95 latency 380ms, event bus depth 0. I'll wake on the next heartbeat." },
    ],
    replies: [
      "Acknowledged. I'll add that to the watch list and alert on any breach.",
      "Latency is back within budget. No action needed.",
      "I'm catching up from being offline — give me one beat to re-sync state.",
      "All clear. Nothing in the logs since we last spoke.",
    ],
  },
  {
    // deliberately long name AND long subtitle — proves the per-line ellipsis
    // truncation + hover-reveal (native title tooltip) in the roster row.
    id: "longview-quarterly-reporting-orchestrator",
    name: "longview-quarterly-reporting-orchestrator",
    sub: "online · 45s heartbeat",
    persona: "long-horizon planning, quarterly reporting & cross-team coordination agent",
    online: true,
    transcript: [
      { role: "agent", text: "Longview here. I rolled up the quarter: 9 initiatives tracked, 7 on schedule, 2 at risk. I drafted the exec summary — want me to circulate it?" },
    ],
    replies: [
      "Drafted. I'll circulate the summary and collect sign-off before the next beat.",
      "I re-forecast the two at-risk items; one recovers if we pull the dependency in.",
      "Rolled the numbers forward — the quarterly view is current as of this beat.",
      "Coordinated with the other agents; everyone's inputs are in and reconciled.",
    ],
  },
];

/* ── State ──────────────────────────────────────────────────────────────────*/
const state = {
  current: null,     // selected agent id
  notify: false,     // bell armed?
  seq: 0,            // monotonic message id (mirrors the server-issued id)
  replyIdx: {},      // per-agent canned-reply cursor
  busy: false,       // a reply cycle is in flight (avoid overlap)
  // CONNECTION state — the live SSE channel, INDEPENDENT of an agent's `online`
  // flag. true = EventSource open; false = dropped/reconnecting. The mock toggles
  // it for demo; the real page must derive it from EventSource onopen/onerror.
  connected: true,
  // QUOTE state machine: armId = a message whose GUTTER is "armed" (1st gutter
  // click landed, waiting for the 2nd); quote = the committed "replying to" ref.
  armId: null,       // bid of the row showing the "click again to quote" hint
  quote: null,       // { who, text } once committed, shown as the composer chip
};

let elRefs = {};

/* ── Helpers ────────────────────────────────────────────────────────────────*/
const agentById = (id) => AGENTS.find((a) => a.id === id);
const initial = (id) => (id || "?").slice(0, 1);
const onlineCount = () => AGENTS.filter((a) => a.online).length;
function clock() { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function scrollDown() { const l = elRefs.log; if (l) l.scrollTop = l.scrollHeight; }

/* avatar with presence dot */
function avatar(agent, extraCls) {
  return `<span class="av${extraCls ? " " + extraCls : ""}">${esc(initial(agent.id))}` +
    `<span class="pres${agent.online ? "" : " off"}"></span></span>`;
}

/* ── Roster ─────────────────────────────────────────────────────────────────*/
function renderRoster() {
  const r = elRefs.roster;
  r.innerHTML = "";
  AGENTS.forEach((a) => {
    // `.off` desaturates the whole row so an offline agent reads "inactive" —
    // the presence dot alone isn't enough of a signal.
    const b = el("button", "agent" + (a.id === state.current ? " sel" : "") + (a.online ? "" : " off"));
    // native title tooltip reveals the FULL name + subtitle when either line is
    // truncated by the per-line ellipsis (hover-reveal, requirement #3).
    b.title = a.name + " — " + a.persona;
    b.innerHTML = avatar(a) +
      `<span class="at"><span class="an" title="${esc(a.name)}">${esc(a.name)}</span>` +
      `<span class="as" title="${esc(a.persona)}">${esc(a.persona)}</span></span>`;
    b.onclick = () => select(a.id);
    r.appendChild(b);
  });
  renderConnFoot();
}

/* roster footer — agents-online count + a small "simulate disconnect" toggle.
   The footer dot mirrors the CONNECTION state (mint when live, amber when down),
   reinforcing the header pill. The toggle is the unobtrusive demo affordance. */
function renderConnFoot() {
  const n = onlineCount();
  const foot = elRefs.count;
  if (!foot) return;
  const live = state.connected
    ? `<span class="live"></span>`
    : `<span class="live" style="background:var(--amber);box-shadow:none;animation:dpulse 1.5s ease-in-out infinite"></span>`;
  foot.innerHTML =
    `${live}<p>${n} agent${n === 1 ? "" : "s"} online</p>` +
    `<button class="sim${state.connected ? "" : " down"}" id="sim" type="button" ` +
    `title="${state.connected ? "Simulate a dropped channel" : "Simulate the channel reconnecting"}">` +
    `${state.connected ? "simulate disconnect" : "reconnect"}</button>`;
  const sim = $("#sim", foot);
  if (sim) sim.onclick = toggleConnection;
}

/* ── Transcript rendering ──────────────────────────────────────────────────*/
let bubbleSeq = 0; // unique per-bubble id for the quote state machine

/* Wire a freshly-built message row:
     · the bubble gets the hover copy button — clicking the bubble does NOT arm
       quoting, so its text stays freely selectable / copyable.
     · the empty `.quote-zone` gutter beside the bubble arms the two-click quote
       flow. Leaving the ROW before the 2nd click resets it completely. */
function wireBubble(row, bubble, who, text) {
  const bid = "b" + (++bubbleSeq);
  row.dataset.bid = bid;

  // copy button — appended so it sits above the text content
  const copyBtn = el("button", "copy");
  copyBtn.type = "button";
  copyBtn.title = "Copy message";
  copyBtn.setAttribute("aria-label", "Copy message");
  copyBtn.innerHTML = icon("copy");
  copyBtn.onclick = (e) => {
    e.stopPropagation();        // copying must NOT do anything to the quote flow
    copyText(text, copyBtn);
  };
  bubble.appendChild(copyBtn);

  // two-click quote flow lives on the EMPTY GUTTER, never the bubble
  const zone = $(".quote-zone", row);
  if (zone) zone.addEventListener("click", () => onZoneClick(bid, who, text, row));
  // leaving the row before the 2nd click resets the arm completely
  row.addEventListener("mouseleave", () => { if (state.armId === bid) disarmZone(); });
}

/* the empty-gutter quote hit-area markup. ONE affordance element (`.qchip`):
   · idle  → a subtle ghosted "Quote" chip, revealed only on gutter hover.
   · armed → the SAME chip upgrades in place (adds `.armed`) to a clear mint pill
     reading "Click again to quote".
   Only ever ONE element, so the ghost label and the armed hint never stack. CSS
   positions the chip toward the bubble for each side. */
function quoteZoneHTML() {
  return `<div class="quote-zone">` +
    `<span class="qchip">${icon("quote")}<span class="qlabel">Quote</span></span></div>`;
}

function addAgentMsg(agent, text, animate = true) {
  const row = el("div", "msg agent");
  if (!animate) row.style.animation = "none";
  // agent: bubble group LEFT, quote gutter RIGHT
  row.innerHTML =
    `<div class="msg-inner">` + avatar(agent) +
    `<div class="bubble"><div class="bmeta">${esc(agent.name)} · beat</div>${esc(text)}</div></div>` +
    quoteZoneHTML();
  wireBubble(row, $(".bubble", row), agent.name, text);
  elRefs.log.appendChild(row);
  scrollDown();
}

function addMyMsg(id, text, read, animate = true) {
  const wrap = el("div", "msg me");
  if (!animate) wrap.style.animation = "none";
  const tickCls = read ? "tick read" : "tick";
  const tickIco = read ? icon("checkAll", "tk-ic") : icon("check", "tk-ic");
  const tkLabel = read ? "read" : "sent";
  // user: quote gutter LEFT, bubble group RIGHT
  wrap.innerHTML = quoteZoneHTML() +
    `<div class="msg-inner"><div class="bubble">${esc(text)}</div>` +
    `<div class="${tickCls}" data-msg="${esc(String(id))}">${tickIco}` +
    `<span class="tk-tx">${tkLabel}</span><span class="ts">${clock()}</span></div></div>`;
  wireBubble(wrap, $(".bubble", wrap), "you", text);
  elRefs.log.appendChild(wrap);
  scrollDown();
  return wrap;
}

/* ── Copy ───────────────────────────────────────────────────────────────────*/
function copyText(text, btn) {
  const done = () => flashCopied(btn);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
  } else {
    legacyCopy(text, done);
  }
}
function legacyCopy(text, done) {
  try {
    const ta = el("textarea"); ta.value = text;
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove(); done();
  } catch (_) { /* clipboard unavailable — silently no-op */ }
}
/* brief "copied" confirmation: swap the copy glyph for a check, then revert */
function flashCopied(btn) {
  btn.classList.add("copied");
  btn.innerHTML = icon("check");
  btn.title = "Copied";
  clearTimeout(btn._revert);
  btn._revert = setTimeout(() => {
    btn.classList.remove("copied");
    btn.innerHTML = icon("copy");
    btn.title = "Copy message";
  }, 1100);
}

/* ── Two-click quote flow (armed from the empty gutter, NOT the bubble) ──────*/
function onZoneClick(bid, who, text, row) {
  if (state.armId === bid) {
    // 2nd click in the SAME row's gutter → commit the quote
    disarmZone();
    setQuote(who, text);
  } else {
    // 1st click (or switching to a different row) → arm THIS row
    disarmZone();            // clear any other armed row first
    armZone(bid, row);
  }
}
function armZone(bid, row) {
  state.armId = bid;
  row.classList.add("arming");                 // mint outline on the paired bubble
  const zone = $(".quote-zone", row);
  if (!zone) return;
  zone.classList.add("armed");
  // upgrade the SAME chip in place — no second element, so nothing stacks
  const chip = $(".qchip", zone);
  if (chip) {
    chip.classList.add("armed");
    const label = $(".qlabel", chip);
    if (label) label.textContent = "Click again to quote";
  }
}
function disarmZone() {
  if (!state.armId) return;
  const row = elRefs.log.querySelector(`.msg[data-bid="${state.armId}"]`);
  if (row) {
    row.classList.remove("arming");
    const zone = $(".quote-zone", row);
    if (zone) {
      zone.classList.remove("armed");
      // reset the chip back to the idle "Quote" ghost
      const chip = $(".qchip", zone);
      if (chip) {
        chip.classList.remove("armed");
        const label = $(".qlabel", chip);
        if (label) label.textContent = "Quote";
      }
    }
  }
  state.armId = null;
}

/* ── Quote chip (composer "replying to") ────────────────────────────────────*/
function setQuote(who, text) {
  state.quote = { who, text };
  renderQuoteChip();
  if (elRefs.box && !elRefs.box.disabled) elRefs.box.focus();
}
function clearQuote() {
  state.quote = null;
  renderQuoteChip();
}
function renderQuoteChip() {
  const host = elRefs.quoteHost;
  if (!host) return;
  host.innerHTML = "";
  if (!state.quote) return;
  const snip = state.quote.text.replace(/\s+/g, " ").trim();
  const chip = el("div", "quote-chip");
  chip.innerHTML =
    `<div class="qbody"><div class="qwho">${icon("quote")}<span>replying to ${esc(state.quote.who)}</span></div>` +
    `<div class="qsnip">${esc(snip)}</div></div>` +
    `<button class="qx" type="button" title="Cancel reply" aria-label="Cancel reply">${icon("x")}</button>`;
  $(".qx", chip).onclick = clearQuote;
  host.appendChild(chip);
}

/* flip a user message's tick from "sent" → "read" (mint double-check) */
function markRead(wrap) {
  const t = wrap && wrap.querySelector(".tick");
  if (!t) return;
  t.className = "tick read";
  const ic = t.querySelector(".tk-ic");
  if (ic) ic.outerHTML = icon("checkAll", "tk-ic");
  const tx = t.querySelector(".tk-tx");
  if (tx) tx.textContent = "read";
}

/* ── Empty state ────────────────────────────────────────────────────────────*/
function renderEmpty() {
  elRefs.log.innerHTML =
    `<div class="empty"><span class="eic">${icon("chat")}</span>` +
    `<span class="et">Pick an agent to start chatting.</span>` +
    `<span class="es">your agents wake on a heartbeat — talk to them anytime</span></div>`;
}

/* ── Header (connection status + agent status + bell) ──────────────────────*/
/* The CONNECTION pill is what reflects the live channel. It is SEPARATE from the
   agent's own `online`/`sub`: a channel can be down while the agent is nominally
   "online". When connected → mint glowing dot + the agent's own status text.
   When disconnected → amber no-glow dot + "disconnected — reconnecting…".
   The pill is clickable to toggle the demo state. */
function connectionMarkup(a) {
  if (state.connected) {
    // channel is live → the dot/text reflect the AGENT's presence:
    //   online  → mint + glow (default `.conn`)
    //   offline → slate, no glow (`.conn.offline`) — distinct from amber down.
    const offCls = a.online ? "" : " offline";
    const title = a.online
      ? "Channel live · agent online · click to simulate a disconnect"
      : "Channel live · agent offline · click to simulate a disconnect";
    return `<span class="conn${offCls}" id="conn" title="${title}" role="button" tabindex="0">` +
      `<span class="cdot"></span><span class="ctext">${esc(a.sub)}</span></span>` +
      `<span class="sep">·</span>${esc(a.persona)}`;
  }
  return `<span class="conn down" id="conn" title="Channel down · click to reconnect" role="button" tabindex="0">` +
    `<span class="cdot"></span><span class="ctext">disconnected — reconnecting…</span></span>` +
    `<span class="sep">·</span>${esc(a.persona)}`;
}

function renderHeader(a) {
  elRefs.head.innerHTML =
    avatar(a, "") +
    `<div class="ht"><div class="htitle">${esc(a.name)}</div>` +
    `<div class="hsub">${connectionMarkup(a)}</div></div>` +
    `<button class="bell${state.notify ? " on" : ""}" id="bell" type="button" ` +
    `title="${state.notify ? "Reply notifications ON — click to mute" : "Reply notifications OFF — click to enable"}" ` +
    `aria-label="Toggle reply notifications" aria-pressed="${state.notify}">` +
    `${icon(state.notify ? "bell" : "bellSlash")}</button>`;
  $("#bell", elRefs.head).onclick = toggleBell;
  const conn = $("#conn", elRefs.head);
  if (conn) {
    conn.onclick = toggleConnection;
    conn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleConnection(); } };
  }
}

/* Demo-only: flip the simulated connection state and re-render the affordances.
   In the REAL page this is driven by EventSource onopen/onerror — see README. */
function toggleConnection() {
  state.connected = !state.connected;
  const a = agentById(state.current);
  if (a) renderHeader(a);
  renderConnFoot();
}

/* ── Select an agent ───────────────────────────────────────────────────────*/
function select(id) {
  const a = agentById(id);
  if (!a) return;
  state.current = id;
  state.busy = false;

  // reset the quote state machine when switching agents (transcript is rebuilt)
  state.armId = null;
  clearQuote();

  // header — rebuilt wholesale (this replaces the boot shell's #hav too)
  renderHeader(a);

  // roster selection highlight
  renderRoster();

  // transcript (history renders without entry animation, like an initial load)
  elRefs.log.innerHTML = "";
  elRefs.log.appendChild(el("div", "daybreak", "<span>today</span>"));
  a.transcript.forEach((m) => {
    if (m.role === "agent") addAgentMsg(a, m.text, false);
    else addMyMsg(++state.seq, m.text, m.read, false);
  });
  scrollDown();

  // composer
  elRefs.box.disabled = false;
  elRefs.send.disabled = false;
  elRefs.box.placeholder = "Message " + a.name + "…";
  autogrow();                 // normalise to one line for the freshly-enabled box
  elRefs.box.focus();

  // agent-switch transition — slide-up/fade the header + transcript in (config-web
  // viewIn feel). Re-triggered on every select so each switch animates.
  animateView();
}

/* Re-trigger the view-enter animation on the chat header + transcript. Mirrors
   config-web's animateIn(): remove the class, force reflow, re-add it so the
   keyframe restarts on each agent switch. */
function animateView() {
  [elRefs.head, elRefs.log].forEach((m) => {
    if (!m) return;
    m.classList.remove("view-enter");
    void m.offsetWidth;       // force reflow so the animation restarts
    m.classList.add("view-enter");
  });
}

/* ── Send + simulated heartbeat ────────────────────────────────────────────*/
function sendMessage(text) {
  const a = agentById(state.current);
  if (!a || !text || state.busy) return;
  state.busy = true;

  // 1) user bubble lands with a "sent" tick
  const id = ++state.seq;
  const wrap = addMyMsg(id, text, false);

  // 2) ~heartbeat: typing indicator appears
  setTimeout(() => {
    const typing = el("div", "typing");
    typing.innerHTML = avatar(a) + `<div class="dots"><i></i><i></i><i></i></div>`;
    elRefs.log.appendChild(typing);
    scrollDown();

    // 3) the agent's beat processes the message → tick flips to "read"
    setTimeout(() => markRead(wrap), 350);

    // 4) the canned reply lands, typing indicator removed
    setTimeout(() => {
      typing.remove();
      const i = state.replyIdx[a.id] || 0;
      const reply = a.replies[i % a.replies.length];
      state.replyIdx[a.id] = i + 1;
      addAgentMsg(a, reply, true);
      if (state.notify && document.hidden) {/* a real page would raise a Notification here */}
      state.busy = false;
    }, 900);
  }, 480);
}

/* ── Bell toggle ───────────────────────────────────────────────────────────
   The on/off state must be CRYSTAL-CLEAR: mint "on" styling + the filled bell
   glyph + an explicit ON/OFF tooltip + aria-pressed for assistive tech. */
function toggleBell() {
  state.notify = !state.notify;
  const b = $("#bell", elRefs.head);
  if (!b) return;
  b.classList.toggle("on", state.notify);
  b.innerHTML = icon(state.notify ? "bell" : "bellSlash");
  b.title = state.notify
    ? "Reply notifications ON — click to mute"
    : "Reply notifications OFF — click to enable";
  b.setAttribute("aria-pressed", String(state.notify));
}

/* ── Shell ─────────────────────────────────────────────────────────────────*/
function buildShell() {
  const app = el("div", "app");
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">${icon("stars")}</span>
        <div>
          <div class="mark">KRAKEY <span class="b">Chat</span></div>
          <div class="tag">ultimate autonomous agent</div>
        </div>
      </div>
      <div class="roster-label">Agents</div>
      <div class="roster" id="roster"></div>
      <div class="roster-foot" id="count"></div>
    </aside>
    <main class="main">
      <header class="chat-head" id="head">
        <span class="av" id="hav"></span>
        <div class="ht"><div class="htitle">&mdash;</div><div class="hsub">no agent selected</div></div>
        <button class="bell" id="bell" type="button" title="Notify me of replies" aria-label="Toggle notifications">${icon("bellSlash")}</button>
      </header>
      <div class="log" id="log"></div>
      <form class="composer" id="form">
        <div class="quote-host" id="quoteHost"></div>
        <div class="row-in">
          <textarea class="box auto" id="box" rows="1" autocomplete="off" placeholder="Select an agent…" disabled></textarea>
          <button class="send" id="send" type="submit" disabled aria-label="Send">${icon("send")}</button>
        </div>
      </form>
    </main>`;
  document.body.appendChild(app);

  elRefs = {
    roster: $("#roster", app),
    count: $("#count", app),
    head: $("#head", app),
    log: $("#log", app),
    box: $("#box", app),
    send: $("#send", app),
    form: $("#form", app),
    quoteHost: $("#quoteHost", app),
  };

  $("#bell", app).onclick = toggleBell;

  // submit = send the trimmed text, then reset the composer (value + height) and
  // clear any "replying to" quote chip. Shared by the form submit (button / Enter)
  // path below.
  function submitComposer() {
    const text = elRefs.box.value.trim();
    if (!text || !state.current) return;
    elRefs.box.value = "";
    autogrow();                 // collapse back to a single line after sending
    // sending clears any "replying to" quote chip — the reply has been composed
    clearQuote();
    sendMessage(text);
  }

  elRefs.form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitComposer();
  });

  // auto-grow the textarea as it wraps to more lines, capping at COMPOSER_MAX_H
  // (after which it scrolls internally). Mirrors config-web's textarea.inp.auto
  // grow() — measure scrollHeight against an `auto` baseline each input.
  elRefs.box.addEventListener("input", autogrow);

  // chat keyboard model: Enter sends, Shift+Enter inserts a newline. We submit on
  // a plain Enter and let the browser handle Shift+Enter natively (newline + grow).
  elRefs.box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();       // don't insert a newline — send instead
      submitComposer();
    }
  });
}

/* COMPOSER_MAX_H — the textarea grows with content up to ~6 lines, then caps and
   scrolls internally (overflow flips to auto at the cap). */
const COMPOSER_MAX_H = 160;
function autogrow() {
  const t = elRefs.box;
  if (!t) return;
  t.style.height = "auto";                          // reset so scrollHeight shrinks too
  const h = Math.min(t.scrollHeight, COMPOSER_MAX_H);
  t.style.height = h + "px";
  t.style.overflowY = t.scrollHeight > COMPOSER_MAX_H ? "auto" : "hidden";
}

/* ── Boot ──────────────────────────────────────────────────────────────────*/
/* Embedded mode: this page is iframed inside the unified Krakey Console, which
   already renders a single global "KRAKEY Console" brand in its top nav. When
   embedded we hide our own sidebar brand block so two KRAKEY logos don't stack.
   `window.self !== window.top` is true inside any iframe and works cross-origin
   (it never reads the parent — just compares the two window references). */
function detectEmbedded() {
  let embedded = false;
  try { embedded = window.self !== window.top; } catch (_) { embedded = true; }
  if (embedded) document.documentElement.classList.add("embedded");
}

function boot() {
  detectEmbedded();
  buildShell();
  renderRoster();
  renderEmpty();
  // auto-select the first agent so the page feels alive on open
  select(AGENTS[0].id);
}
boot();
})();
