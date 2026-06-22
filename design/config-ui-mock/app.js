/* ============================================================================
   app.js — schema-driven config console (design mock, vanilla JS).

   The renderer has NO per-setting knowledge. It walks the descriptors in
   schema.js and emits the right control for each `control` kind:
     select → dropdown · multiselect → selection-pick · toggle → switch ·
     number/text/url/secret/textarea/taglist → free input.
   Add a field to schema.js and it appears here automatically — that is what
   "auto-fetch all available settings" means.
   ============================================================================ */
(() => { // IIFE — keep these locals out of the shared global scope (schema.js owns those names)
const { PROVIDERS, PLUGINS, PLUGIN_SCHEMAS, AGENT_FIELDS, communicatorFields, SEED } = window.OK;

// Embedded vs standalone: inside the unified Krakey Console iframe the top
// nav-bar already shows the global KRAKEY brand, so we hide our own brand block
// to avoid two stacked logos. `window.self !== window.top` is true whenever we
// run in a frame (works even cross-origin, where it can't read the parent).
const EMBEDDED = (() => { try { return window.self !== window.top; } catch { return true; } })();
if (EMBEDDED) document.documentElement.classList.add("embedded");

// deep clone seed so edits in the mock don't mutate the schema module
const state = JSON.parse(JSON.stringify(SEED));
let dirty = false;

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const serviceNames = () => Object.keys(state.services);

/* ── Inline SVG icon set (line icons, currentColor — no emoji/glyphs) ───────*/
const ICONS = {
  grid: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  stars: `<path d="M12 3c.4 3.6 1.4 4.6 5 5-3.6.4-4.6 1.4-5 5-.4-3.6-1.4-4.6-5-5 3.6-.4 4.6-1.4 5-5z"/><path d="M18.5 13.5c.2 1.7.6 2.1 2 2.3-1.4.2-1.8.6-2 2.3-.2-1.7-.6-2.1-2-2.3 1.4-.2 1.8-.6 2-2.3z"/>`,
  server: `<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><path d="M6.5 7.5h2.5M6.5 16.5h2.5"/><path d="M16.8 7.5h.01M16.8 16.5h.01"/>`,
  robot: `<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4.6"/><circle cx="12" cy="3.4" r="1.2"/><circle cx="9.2" cy="13.5" r="1.3"/><circle cx="14.8" cy="13.5" r="1.3"/><path d="M9.5 17h5"/><path d="M2 12.5v3M22 12.5v3"/>`,
  sliders: `<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.4" fill="var(--panel)"/><circle cx="15" cy="12" r="2.4" fill="var(--panel)"/><circle cx="11" cy="17" r="2.4" fill="var(--panel)"/>`,
  cpu: `<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx="0.6"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>`,
  person: `<circle cx="12" cy="8" r="3.6"/><path d="M5.5 19.5c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/>`,
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
  box: `<rect x="4" y="4" width="16" height="16" rx="2.5"/>`,
  alert: `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16h.01"/>`,
};
function icon(name, cls) {
  const p = ICONS[name];
  if (!p) return "";
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

function markDirty() { if (!dirty) { dirty = true; renderSaveBar(); } }
function renderSaveBar() { document.querySelectorAll(".savebar").forEach((b) => b.classList.toggle("is-dirty", dirty)); }
// kind: "success" (green, check) | "error" (red, alert) — validation hints must
// NOT look like confirmations.
function toast(msg, kind = "success") {
  // The element is created once at startup (buildShell) so its hidden baseline is
  // already painted; fall back to lazy-create just in case.
  let t = $("#toast"); if (!t) { t = el("div"); t.id = "toast"; document.body.appendChild(t); }
  t.classList.toggle("error", kind === "error");
  t.innerHTML = `<span class="g">${icon(kind === "error" ? "alert" : "check")}</span> ${esc(msg)}`;
  // Re-arm: drop .show + force a reflow to re-establish the hidden from-state,
  // then add .show on a later task so the slide-in (and later slide-out) both
  // have a baseline to animate from. setTimeout (not rAF) so it fires even when
  // the tab isn't actively rendering.
  t.classList.remove("show"); void t.offsetWidth;
  clearTimeout(t._show); clearTimeout(t._hide);
  t._show = setTimeout(() => t.classList.add("show"), 20);
  t._hide = setTimeout(() => t.classList.remove("show"), 2400);
}
/** Convenience for validation/error hints. */
const toastErr = (msg) => toast(msg, "error");

/* ── Generic control renderer ──────────────────────────────────────────────*/
// `get`/`set` read & write the live value; returns a .field element.
function renderField(field, get, set, ctx = {}) {
  // conditional visibility (e.g. sandbox-only fields)
  if (field.showIf) {
    const cur = ctx.peek ? ctx.peek(field.showIf.key) : undefined;
    if (cur !== field.showIf.equals) return null;
  }

  const wrap = el("div", "field");
  const labWrap = el("div", "flabel");
  const ln = el("div", "ln");
  ln.innerHTML = `${esc(field.label)} <span class="key">${esc(field.key)}</span>`;
  ln.appendChild(el("span", "kind-tag", controlTag(field.control)));
  labWrap.appendChild(ln);
  if (field.help) labWrap.appendChild(el("div", "fhelp", esc(field.help)));
  wrap.appendChild(labWrap);

  const ctrl = el("div", "fcontrol");
  ctrl.appendChild(buildControl(field, get, set, ctx));
  if (field.example) ctrl.appendChild(el("div", "fexample", "↳ " + esc(field.example)));
  wrap.appendChild(ctrl);
  return wrap;
}

function controlTag(c) {
  return { multiselect: "multi-pick", select: "dropdown", toggle: "toggle",
    number: "number", text: "text", url: "url", secret: "secret",
    textarea: "text", taglist: "list" }[c] || c;
}

function buildControl(field, get, set, ctx) {
  switch (field.control) {
    case "toggle":      return toggleControl(field, get, set);
    case "select":      return selectControl(field, get, set, ctx);
    case "multiselect": return pickControl(field, get, set, ctx);
    case "taglist":     return taglistControl(field, get, set);
    case "textarea":    return textareaControl(field, get, set);
    case "number":      return numberControl(field, get, set);
    case "secret":      return secretControl(field, get, set);
    default:            return textControl(field, get, set); // text / url
  }
}

function textControl(field, get, set) {
  const i = el("input", "inp");
  i.type = "text";
  if (field.placeholder) i.placeholder = field.placeholder;
  i.value = get() ?? "";
  i.oninput = () => { set(i.value === "" ? undefined : i.value); markDirty(); };
  return i;
}

function numberControl(field, get, set) {
  const wrap = el("div", "unit-wrap");
  const i = el("input", "inp num");
  i.type = "number";
  if (field.min != null) i.min = field.min;
  if (field.max != null) i.max = field.max;
  if (field.step != null) i.step = field.step;
  i.placeholder = field.placeholder ?? (field.default != null ? String(field.default) : "");
  const v = get(); i.value = v == null ? "" : v;
  i.oninput = () => { set(i.value === "" ? undefined : Number(i.value)); markDirty(); };
  wrap.appendChild(i);
  if (field.unit) wrap.appendChild(el("span", "unit", field.unit));
  return wrap;
}

function secretControl(field, get, set) {
  const wrap = el("div", "secret-wrap");
  const i = el("input", "inp");
  i.type = "password"; i.placeholder = field.placeholder ?? "•••••••••••••••";
  i.value = get() ?? "";
  i.oninput = () => { set(i.value === "" ? undefined : i.value); markDirty(); };
  const eye = el("button", "eye", "show");
  eye.onclick = () => { const p = i.type === "password"; i.type = p ? "text" : "password"; eye.textContent = p ? "hide" : "show"; };
  wrap.appendChild(i); wrap.appendChild(eye);
  return wrap;
}

function textareaControl(field, get, set) {
  // Auto-growing: the box follows its content, so there is never a scrollbar
  // (and thus no native resize handle fighting it) — resize is off by design.
  const t = el("textarea", "inp auto");
  if (field.placeholder) t.placeholder = field.placeholder;
  t.value = get() ?? "";
  const grow = () => { t.style.height = "auto"; t.style.height = Math.max(84, t.scrollHeight + 2) + "px"; };
  t.oninput = () => { set(t.value === "" ? undefined : t.value); markDirty(); grow(); };
  requestAnimationFrame(grow);
  return t;
}

function resolveOptions(field) {
  if (field.optionsFrom === "services") return [{ value: "", label: "(first chat-capable service)" }, ...serviceNames().map((n) => ({ value: n, label: n }))];
  if (field.optionsFrom === "plugins") return PLUGINS.map((p) => ({ value: p.id, label: p.name, icon: p.icon }));
  return field.options || [];
}

// Fully custom dropdown — a themed button + panel, so the open list honours the
// page theme (a native <select> can't style its popup).
function selectControl(field, get, set, ctx) {
  const options = resolveOptions(field);
  const wrap = el("div", "dd");
  const cur = () => get() ?? field.default ?? "";
  const optFor = (v) => options.find((o) => String(o.value) === String(v));
  const labelFor = (v) => { const o = optFor(v); return o ? o.label : (v === "" || v == null ? "(not set)" : String(v)); };

  const button = el("button", "dd-btn"); button.type = "button";
  const panel = el("div", "dd-panel");
  let sumEl = options.some((o) => o.summary) ? el("div", "dd-summary") : null;

  const renderButton = () => {
    const o = optFor(cur());
    button.innerHTML = `<span class="dd-val">${o && o.icon ? `<span class="dd-ico">${icon(o.icon)}</span>` : ""}${esc(labelFor(cur()))}</span>${icon("chevronDown", "dd-caret")}`;
  };
  const updateSummary = () => { if (!sumEl) return; const o = optFor(cur()); sumEl.textContent = o && o.summary ? o.summary : ""; sumEl.style.display = o && o.summary ? "" : "none"; };

  const buildPanel = () => {
    panel.innerHTML = "";
    options.forEach((o) => {
      const opt = el("div", "dd-opt" + (String(o.value) === String(cur()) ? " sel" : ""));
      opt.innerHTML =
        `<span class="dd-check">${String(o.value) === String(cur()) ? icon("check") : ""}</span>` +
        `<span class="dd-otext"><span class="dd-olabel">${o.icon ? `<span class="dd-ico">${icon(o.icon)}</span>` : ""}${esc(o.label)}</span>` +
        (o.summary ? `<span class="dd-osum">${esc(o.summary)}</span>` : "") + `</span>`;
      opt.onclick = (e) => {
        e.stopPropagation();
        set(o.value === "" ? undefined : o.value); markDirty();
        close(); renderButton(); updateSummary();
        if (ctx.onSelect) ctx.onSelect(field.key, o.value);
      };
      panel.appendChild(opt);
    });
  };

  let open = false;
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  function close() { if (!open) return; open = false; wrap.classList.remove("open"); document.removeEventListener("click", onDoc); }
  function openIt() { buildPanel(); open = true; wrap.classList.add("open"); setTimeout(() => document.addEventListener("click", onDoc), 0); }
  button.onclick = (e) => { e.stopPropagation(); open ? close() : openIt(); };

  renderButton();
  wrap.appendChild(button); wrap.appendChild(panel);
  if (sumEl) { wrap.appendChild(sumEl); updateSummary(); }
  return wrap;
}

function pickControl(field, get, set, ctx) {
  const wrap = el("div", "pick");
  let options = field.options || [];
  if (field.optionsFrom === "plugins") {
    options = PLUGINS.map((p) => ({ value: p.id, label: p.name, summary: p.tagline, required: p.required, icon: p.icon }));
  }
  const selected = () => get() || [];
  for (const o of options) {
    const opt = el("div", "opt");
    const isSel = selected().includes(o.value);
    if (isSel) opt.classList.add("sel");
    if (o.required) opt.classList.add("req");
    opt.innerHTML =
      `<span class="box">${isSel || o.required ? icon("check") : ""}</span>` +
      `<span class="ot"><span class="on">${o.icon ? `<span class="oi">${icon(o.icon)}</span>` : ""}${esc(o.label)}</span>` +
      (o.summary ? `<span class="os">${esc(o.summary)}</span>` : "") + `</span>`;
    if (!o.required) opt.onclick = () => {
      const cur = new Set(selected());
      cur.has(o.value) ? cur.delete(o.value) : cur.add(o.value);
      // keep schema order
      const ordered = options.map((x) => x.value).filter((v) => cur.has(v));
      set(ordered); markDirty();
      opt.classList.toggle("sel"); $(".box", opt).innerHTML = cur.has(o.value) ? icon("check") : "";
      if (ctx.onPick) ctx.onPick(field.key, ordered);
    };
    wrap.appendChild(opt);
  }
  return wrap;
}

function toggleControl(field, get, set) {
  const v = get() ?? field.default;
  const t = el("label", "toggle" + (v ? " on" : ""));
  t.innerHTML = `<span class="sw"></span><span class="state">${v ? "ON" : "OFF"}</span>`;
  t.onclick = () => {
    const now = !t.classList.contains("on");
    t.classList.toggle("on", now); $(".state", t).textContent = now ? "ON" : "OFF";
    set(now); markDirty();
  };
  return t;
}

function taglistControl(field, get, set) {
  const wrap = el("div", "taglist");
  const draw = () => {
    wrap.innerHTML = "";
    const tags = get() || [];
    if (tags.length === 0) wrap.appendChild(el("span", "empty", "none — "));
    tags.forEach((tg, i) => {
      const t = el("span", "tag", `${esc(tg)}<span class="x">${icon("x")}</span>`);
      $(".x", t).onclick = () => { const n = [...tags]; n.splice(i, 1); set(n); markDirty(); draw(); };
      wrap.appendChild(t);
    });
    const add = el("input", "tag-add");
    add.placeholder = field.placeholder || "add…";
    add.onkeydown = (e) => {
      if (e.key === "Enter" && add.value.trim()) {
        set([...(get() || []), add.value.trim()]); markDirty(); draw();
        requestAnimationFrame(() => $(".tag-add", wrap)?.focus());
      }
    };
    wrap.appendChild(add);
  };
  draw();
  return wrap;
}

/* ── Live-value plumbing for an object slice ───────────────────────────────*/
function slice(obj, key, fallback) {
  return {
    get: () => (obj[key] === undefined ? fallback : obj[key]),
    set: (v) => { if (v === undefined) delete obj[key]; else obj[key] = v; },
  };
}

/* ── Views ─────────────────────────────────────────────────────────────────*/
const views = {};
let current = "overview";

function refreshCounts() {
  const s = document.querySelector('.nav button[data-view="services"] .count');
  const a = document.querySelector('.nav button[data-view="agents"] .count');
  if (s) s.textContent = serviceNames().length;
  if (a) a.textContent = Object.keys(state.agents).length;
}

// Re-trigger the view-enter animation on the main column (issue: settings pages
// appeared with no transition).
function animateIn() {
  const m = $("#main");
  m.classList.remove("view-enter"); void m.offsetWidth; m.classList.add("view-enter");
}

function setView(name, arg) {
  current = name;
  refreshCounts();
  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const main = $("#main");
  main.innerHTML = "";
  dirty = false;
  views[name](main, arg);
  main.scrollTop = 0; window.scrollTo(0, 0);
  animateIn();
}

function topbar(main, crumbs, title, subtitle, actions) {
  const tb = el("div", "topbar");
  const left = el("div");
  const cr = el("div", "crumb");
  cr.innerHTML = crumbs.map((c, i) => i === crumbs.length - 1 ? `<b>${esc(c)}</b>` : esc(c)).join('<span class="sep">/</span>');
  left.appendChild(cr);
  left.appendChild(el("h1", "title", title));
  if (subtitle) left.appendChild(el("p", "subtitle", subtitle));
  tb.appendChild(left);
  if (actions) { const a = el("div"); a.style.display = "flex"; a.style.gap = "10px"; actions.forEach((x) => a.appendChild(x)); tb.appendChild(a); }
  main.appendChild(tb);
}

function btn(label, cls, onclick) { const b = el("button", "btn " + (cls || ""), label); b.onclick = onclick; return b; }

/* Overview / landing */
views.overview = (main) => {
  topbar(main, ["OpenKrakey", "Console"], 'Config <span class="accent">console</span>',
    "Configure every agent, AI service and plugin — the same files the CLI edits, rendered as a UI. Each control is generated straight from the live settings schema.");

  const banner = el("div", "banner");
  banner.innerHTML = `<span class="g">${icon("stars")}</span><div class="bt"><b>Design mock.</b> <span>Every control below is auto-generated from <code>schema.js</code>, which mirrors the real OpenKrakey settings. Multi-choice → selection-pick · single-select → dropdown · boolean → toggle · free values → input.</span></div>`;
  main.appendChild(banner);

  const grid = el("div", "grid cols-3 stagger");
  const cards = [
    { v: "wizard", g: "stars", t: "Guided setup", d: "Connect a service and stand up your first agent — now covering every plugin & tool.", meta: ["onboarding"] },
    { v: "services", g: "server", t: "AI services", d: "LLM providers, endpoints & API keys. Provider type drives the rest of the form.", meta: [`${serviceNames().length} service`] },
    { v: "agents", g: "robot", t: "Agents", d: "Per-agent heartbeat, plugins and every plugin's own settings.", meta: [`${Object.keys(state.agents).length} agents`] },
    { v: "default", g: "sliders", t: "Default settings", d: "The template each new agent copies. Same editor, no id.", meta: ["template"] },
  ];
  for (const c of cards) {
    const card = el("div", "card click");
    card.innerHTML = `<div class="ch"><span class="g">${icon(c.g)}</span><h3>${c.t}</h3><span class="arrow">${icon("arrowRight")}</span></div>` +
      `<p class="desc">${c.d}</p><div class="meta">${c.meta.map((m) => `<span class="pill">${esc(m)}</span>`).join("")}</div>`;
    card.onclick = () => setView(c.v);
    grid.appendChild(card);
  }
  main.appendChild(grid);

  // schema coverage strip
  const lab = el("div", "group-label", "What the console auto-discovers");
  main.appendChild(lab);
  const cov = el("div", "grid cols-3 stagger");
  PLUGINS.forEach((p) => {
    const n = (PLUGIN_SCHEMAS[p.id] || []).length;
    const card = el("div", "card");
    card.innerHTML = `<div class="ch"><span class="g">${icon(p.icon)}</span><h3>${esc(p.name)}</h3></div>` +
      `<p class="desc">${esc(p.tagline)}</p>` +
      `<div class="meta"><span class="pill mint">${n} setting${n === 1 ? "" : "s"}</span>${p.dataCarrier ? '<span class="pill">private data</span>' : ""}${p.required ? '<span class="pill warn">required</span>' : ""}</div>`;
    cov.appendChild(card);
  });
  main.appendChild(cov);
};

/* AI services list */
views.services = (main) => {
  topbar(main, ["OpenKrakey", "AI services"], 'AI <span class="accent">services</span>',
    "The LLM connections your agents can use. config/llm.json — gitignored, holds keys.",
    [btn('<span class="k">+</span> Add service', "primary", () => editService(null))]);
  const list = el("div", "grid stagger");
  for (const name of serviceNames()) {
    const s = state.services[name];
    const prov = PROVIDERS.find((p) => p.id === s.provider);
    const row = el("div", "row");
    row.innerHTML = `<span class="g">${icon("server")}</span><div class="rt"><div class="name"><span class="id">${esc(name)}</span></div>` +
      `<div class="sub">${esc(prov ? prov.label : s.provider)} · ${esc(s.model || "(no model)")} · ${(s.capabilities || []).join(", ")}</div></div>` +
      (state.default.name === name ? `<span class="pill mint">default</span>` : "") + `<span class="arrow">${icon("arrowRight")}</span>`;
    row.onclick = () => editService(name);
    list.appendChild(row);
  }
  const add = el("button", "add-row", "<span>+</span> Add a new AI service");
  add.onclick = () => editService(null);
  list.appendChild(add);
  main.appendChild(list);
};

/* AI service editor — provider-reactive */
function editService(name) {
  const isNew = name === null;
  const working = isNew ? { provider: "anthropic" } : JSON.parse(JSON.stringify(state.services[name]));
  let workingName = isNew ? "" : name;
  const main = $("#main"); main.innerHTML = ""; dirty = false; animateIn();

  topbar(main, ["OpenKrakey", "AI services", isNew ? "new" : name],
    isNew ? 'New <span class="accent">service</span>' : `<span class="accent">${esc(name)}</span>`,
    "Pick the provider type first — it constrains models, capabilities and modalities so the gateway can never reject the config.");

  const body = el("div");
  const nameField = el("div", "field");
  nameField.innerHTML = `<div class="flabel"><div class="ln">Connection name <span class="key">key</span></div><div class="fhelp">A short name agents refer to this service by.</div></div>`;
  const nameCtrl = el("div", "fcontrol");
  const ni = el("input", "inp"); ni.placeholder = "claude · gpt · local"; ni.value = workingName;
  ni.oninput = () => { workingName = ni.value.trim(); markDirty(); };
  nameCtrl.appendChild(ni); nameField.appendChild(nameCtrl); body.appendChild(nameField);

  const fieldsHost = el("div");
  body.appendChild(fieldsHost);
  const drawFields = () => {
    fieldsHost.innerHTML = "";
    const fields = communicatorFields(working.provider);
    for (const fld of fields) {
      const sl = slice(working, fld.key, fld.default);
      const node = renderField(fld, sl.get, sl.set, {
        onSelect: (key) => { if (key === "provider") { reconcileProvider(); drawFields(); } },
      });
      if (node) fieldsHost.appendChild(node);
    }
  };
  // when provider changes, clamp capability/modality selections to the new provider
  const reconcileProvider = () => {
    const p = PROVIDERS.find((x) => x.id === working.provider);
    if (!p) return;
    working.capabilities = (working.capabilities || p.defaultCapabilities).filter((c) => p.capabilities.includes(c));
    if (!working.capabilities.length) working.capabilities = [...p.defaultCapabilities];
    working.input = (working.input || ["text"]).filter((m) => p.inputs.includes(m)); if (!working.input.length) working.input = ["text"];
    working.output = (working.output || ["text"]).filter((m) => p.outputs.includes(m)); if (!working.output.length) working.output = ["text"];
  };
  drawFields();
  main.appendChild(body);

  // default-service toggle
  const defField = el("div", "field");
  defField.innerHTML = `<div class="flabel"><div class="ln">Set as default <span class="key">llm.default</span></div><div class="fhelp">Agents with no communicator set fall back to the default service.</div></div>`;
  const dc = el("div", "fcontrol");
  let isDefault = state.default.name === workingName;
  const tg = el("label", "toggle" + (isDefault ? " on" : ""));
  tg.innerHTML = `<span class="sw"></span><span class="state">${isDefault ? "ON" : "OFF"}</span>`;
  tg.onclick = () => { isDefault = !isDefault; tg.classList.toggle("on", isDefault); $(".state", tg).textContent = isDefault ? "ON" : "OFF"; markDirty(); };
  dc.appendChild(tg); defField.appendChild(dc); main.appendChild(defField);

  const bar = el("div", "savebar");
  bar.innerHTML = `<span class="dirty"><span class="d"></span>unsaved draft</span><span class="spacer"></span>`;
  bar.appendChild(btn("Cancel", "ghost", () => setView("services")));
  if (!isNew) bar.appendChild(btn("Delete", "danger", () => { delete state.services[name]; if (state.default.name === name) state.default.name = null; setView("services"); toast(`Deleted "${name}"`); }));
  bar.appendChild(btn("Save service", "primary", () => {
    if (!workingName) { toastErr("Name the connection first"); return; }
    if (!working.model) { toastErr("Enter a model id"); return; }
    if (isNew || workingName !== name) { if (!isNew) delete state.services[name]; }
    state.services[workingName] = working;
    if (isDefault) state.default.name = workingName; else if (state.default.name === workingName) state.default.name = null;
    setView("services"); toast(`Saved "${workingName}"`);
  }));
  main.appendChild(bar);
}

/* Agents list */
views.agents = (main) => {
  topbar(main, ["OpenKrakey", "Agents"], 'Your <span class="accent">agents</span>',
    "Each agent is a personal folder under agents/. Heartbeat, plugins, and every plugin's own settings.",
    [btn('<span class="k">+</span> New agent', "primary", () => createAgent())]);
  const list = el("div", "grid stagger");
  for (const id of Object.keys(state.agents)) {
    const a = state.agents[id];
    const row = el("div", "row");
    row.innerHTML = `<span class="g">${icon("robot")}</span><div class="rt"><div class="name"><span class="id">${esc(id)}</span></div>` +
      `<div class="sub">every ${(a.intervalMs / 1000)}s · ${a.plugins.length} plugins · ${(a.privatePlugins || []).length} private</div></div>` +
      `<span class="arrow">${icon("arrowRight")}</span>`;
    row.onclick = () => editAgent(id);
    list.appendChild(row);
  }
  const add = el("button", "add-row", "<span>+</span> Create a new agent");
  add.onclick = () => createAgent();
  list.appendChild(add);
  main.appendChild(list);
};

function createAgent() {
  const id = "agent-" + (Object.keys(state.agents).length + 1);
  state.agents[id] = JSON.parse(JSON.stringify({ ...state.defaultSetting, id }));
  toast(`Created "${id}" from default`); editAgent(id);
}

/* Agent editor (and Default editor via shared core) */
views.default = (main) => settingEditor(main, state.defaultSetting, { isDefault: true });
function editAgent(id) { const main = $("#main"); main.innerHTML = ""; dirty = false; settingEditor(main, state.agents[id], { id }); animateIn(); }

function settingEditor(main, model, opts) {
  const id = opts.id;
  const crumbs = opts.isDefault ? ["OpenKrakey", "Default settings"] : ["OpenKrakey", "Agents", id];
  topbar(main, crumbs,
    opts.isDefault ? 'Default <span class="accent">settings</span>' : `<span class="accent">${esc(id)}</span>`,
    opts.isDefault ? "The template each new agent copies. config/agent.default.json." : "Live config — agents/" + id + "/config.json.");

  if (!model.config) model.config = {};

  // base fields
  main.appendChild(el("div", "group-label", "Core"));
  const base = el("div");
  for (const fld of AGENT_FIELDS) {
    const sl = slice(model, fld.key, fld.default);
    base.appendChild(renderField(fld, sl.get, sl.set, {
      onPick: (key) => { if (key === "plugins") drawPluginPanels(); },
    }));
  }
  main.appendChild(base);

  // per-plugin config panels — only for enabled plugins, auto-fetched from PLUGIN_SCHEMAS
  main.appendChild(el("div", "group-label", "Plugin settings"));
  const panelsHost = el("div");
  main.appendChild(panelsHost);

  function drawPluginPanels() {
    panelsHost.innerHTML = "";
    const enabled = model.plugins || [];
    if (!enabled.length) { panelsHost.appendChild(emptyPanelsHint()); return; }
    for (const pid of enabled) {
      const meta = PLUGINS.find((p) => p.id === pid) || { id: pid, icon: "box", name: pid, tagline: "" };
      const schema = PLUGIN_SCHEMAS[pid] || [];
      const sec = el("div", "section");
      const open = pid === "persona" || pid === "llm-core"; // open the two most-edited by default
      if (open) sec.classList.add("open");
      const isPrivate = (model.privatePlugins || []).includes(pid);
      sec.innerHTML = `<header><span class="g">${icon(meta.icon)}</span><div class="st"><div class="name">${esc(meta.name)} ` +
        `<span style="font-family:var(--mono);font-size:11px;color:var(--faint)">${esc(pid)}</span>${isPrivate ? ' <span class="pill" style="margin-left:6px">private</span>' : ""}</div>` +
        `<div class="tagline">${esc(meta.tagline)}${schema.length === 0 ? " · no settings" : ` · ${schema.length} settings`}</div></div>` +
        `<span class="chev">${icon("chevronRight")}</span></header>`;
      const bodyEl = el("div", "body");
      if (!model.config[pid]) model.config[pid] = {};
      const cfg = model.config[pid];

      const renderPanel = () => {
        bodyEl.innerHTML = "";
        if (schema.length === 0) { bodyEl.appendChild(el("p", "subtitle", "This plugin reads no configuration — enabling it is all there is.")); return; }
        for (const fld of schema) {
          const sl = slice(cfg, fld.key, fld.default);
          const node = renderField(fld, sl.get, sl.set, {
            peek: (k) => (cfg[k] === undefined ? (schema.find((x) => x.key === k) || {}).default : cfg[k]),
            onSelect: () => renderPanel(),   // re-render so showIf fields appear/vanish
            onPick: () => renderPanel(),
          });
          if (node) bodyEl.appendChild(node);
        }
      };
      renderPanel();
      $("header", sec).onclick = () => sec.classList.toggle("open");
      sec.appendChild(bodyEl);
      panelsHost.appendChild(sec);
    }
  }
  drawPluginPanels();

  const bar = el("div", "savebar");
  bar.innerHTML = `<span class="dirty"><span class="d"></span>unsaved changes</span><span class="spacer"></span>`;
  bar.appendChild(btn("Discard", "ghost", () => setView(opts.isDefault ? "overview" : "agents")));
  if (!opts.isDefault) bar.appendChild(btn("Delete config", "danger", () => { delete state.agents[id]; setView("agents"); toast(`Removed "${id}"`); }));
  bar.appendChild(btn("Save", "primary", () => { toast(opts.isDefault ? "Saved default settings" : `Saved "${id}"`); setView(opts.isDefault ? "overview" : "agents"); }));
  main.appendChild(bar);
}

function emptyPanelsHint() {
  const h = el("div", "card");
  h.innerHTML = `<p class="desc">No plugins enabled yet. Pick some under <b>Plugins to load</b> above and their settings appear here automatically.</p>`;
  return h;
}

/* ── Onboarding wizard ─────────────────────────────────────────────────────*/
const WZ_STEPS = ["Welcome", "AI service", "Capabilities", "Agent", "Review"];
const wz = {
  step: 0,
  service: { provider: "anthropic", name: "", model: "", baseURL: undefined, apiKey: "", capabilities: ["chat"] },
  plugins: ["llm-core", "persona", "system-prompt", "web-chat", "krakeycode"],
  agent: { id: "krakey", persona: "You are Krakey, an autonomous agent. Be concise and helpful.", intervalMs: 30000 },
};

views.wizard = (main) => {
  wz.step = 0;
  // Seed the agent defaults from the Default Setting so the wizard FOLLOWS it
  // (heartbeat, plugin set, persona) rather than stale hardcoded values.
  const ds = state.defaultSetting || {};
  if (typeof ds.intervalMs === "number") wz.agent.intervalMs = ds.intervalMs;
  if (ds.config && ds.config.persona && typeof ds.config.persona.text === "string") {
    wz.agent.persona = ds.config.persona.text;
  }
  const all = [...new Set([...(ds.plugins || []), ...(ds.privatePlugins || [])])];
  if (all.length) wz.plugins = all;
  drawWizard(main);
};

function drawWizard(main) {
  main.innerHTML = "";
  const wrap = el("div", "wizard");

  // rail
  const rail = el("div", "wz-rail");
  WZ_STEPS.forEach((s, i) => {
    const step = el("div", "step" + (i === wz.step ? " active" : i < wz.step ? " done" : ""));
    step.innerHTML = `<span class="n">${i < wz.step ? "✓" : i + 1}</span><span class="nm">${esc(s)}</span>`;
    rail.appendChild(step);
    if (i < WZ_STEPS.length - 1) rail.appendChild(el("div", "bar" + (i < wz.step ? " filled" : "")));
  });
  wrap.appendChild(rail);

  const panel = el("div", "wz-panel");
  [wzWelcome, wzService, wzCapabilities, wzAgent, wzReview][wz.step](panel);
  wrap.appendChild(panel);
  main.appendChild(wrap);
}

function wzNav(panel, { back, next, nextLabel, nextPrimary = true, finish }) {
  const foot = el("div", "wz-foot");
  if (wz.step > 0) foot.appendChild(btn(`${icon("arrowLeft", "btn-ic")}Back`, "ghost", () => { wz.step--; drawWizard($("#main")); }));
  foot.appendChild(el("div", "spacer"));
  foot.appendChild(btn("Skip setup", "ghost", () => setView("overview")));
  foot.appendChild(btn(nextLabel || `Continue${icon("arrowRight", "btn-ic")}`, nextPrimary ? "primary" : "", next || (() => { if (next) next(); })));
  panel.appendChild(foot);
}

function wzWelcome(panel) {
  panel.innerHTML = `<div class="welcome-art">${icon("stars", "wa-ic")}<span>KRAKEY Config</span></div>` +
    `<h2>Let's wake up an agent.</h2>` +
    `<p class="lede">OpenKrakey runs on a <b>heartbeat</b>: every few seconds your agent wakes, composes its whole context, calls the LLM, and acts. This sets up one in two steps — an AI service, then the agent itself.</p>`;
  const feat = el("div", "feat");
  [
    ["cpu", "Any provider", "Anthropic, OpenAI-compatible, local — your key stays in core."],
    ["chat", "Browser chat", "Talk to your agent from a web page out of the box."],
    ["code", "Real tools", "Coding tools, web search and browser control, opt-in."],
    ["activity", "Observable", "An inspector panel shows every beat as it happens."],
  ].forEach(([g, t, d]) => {
    const fi = el("div", "fi");
    fi.innerHTML = `<span class="g">${icon(g)}</span><div><div class="ft">${t}</div><div class="fd">${d}</div></div>`;
    feat.appendChild(fi);
  });
  panel.appendChild(feat);
  const foot = el("div", "wz-foot");
  foot.appendChild(el("div", "spacer"));
  foot.appendChild(btn("Skip — I'll edit files", "ghost", () => setView("overview")));
  foot.appendChild(btn(`Begin setup${icon("arrowRight", "btn-ic")}`, "primary", () => { wz.step = 1; drawWizard($("#main")); }));
  panel.appendChild(foot);
}

function wzService(panel) {
  panel.innerHTML = `<span class="star">${icon("stars")}</span><h2>Connect an AI service</h2>` +
    `<p class="lede">Pick the wire format your endpoint speaks. Everything else adapts to it.</p>`;
  const body = el("div", "wz-body");
  const fields = communicatorFields(wz.service.provider).filter((f) => ["provider", "model", "baseURL", "apiKey"].includes(f.key));
  // connection name first
  const nameFld = { key: "name", label: "Connection name", control: "text", placeholder: "claude · gpt · local", help: "A short name you'll refer to this service by." };
  const allFields = [fields[0], nameFld, ...fields.slice(1)];
  const host = el("div");
  const draw = () => {
    host.innerHTML = "";
    const live = communicatorFields(wz.service.provider);
    const map = { provider: live[0], model: live[1], baseURL: live[2], apiKey: live[3] };
    [map.provider, nameFld, map.model, map.baseURL, map.apiKey].forEach((fld) => {
      const sl = slice(wz.service, fld.key, fld.default);
      const node = renderField(fld, sl.get, sl.set, { onSelect: (k) => { if (k === "provider") draw(); } });
      if (node) host.appendChild(node);
    });
  };
  draw();
  body.appendChild(host);
  panel.appendChild(body);
  const foot = el("div", "wz-foot");
  foot.appendChild(btn(`${icon("arrowLeft", "btn-ic")}Back`, "ghost", () => { wz.step = 0; drawWizard($("#main")); }));
  foot.appendChild(el("div", "spacer"));
  foot.appendChild(btn(`Continue${icon("arrowRight", "btn-ic")}`, "primary", () => {
    if (!wz.service.name) return toastErr("Name the connection");
    if (!wz.service.model) return toastErr("Enter a model id");
    wz.step = 2; drawWizard($("#main"));
  }));
  panel.appendChild(foot);
}

function wzCapabilities(panel) {
  panel.innerHTML = `<span class="star">${icon("stars")}</span><h2>Choose its capabilities</h2>` +
    `<p class="lede">Each capability is a plugin. The first three are the conversational core; the rest are real tools — turn on what you want. <b>This is the step the old CLI wizard skipped.</b></p>`;
  const body = el("div", "wz-body");
  const fld = { key: "plugins", label: "Plugins", control: "multiselect", optionsFrom: "plugins" };
  const sl = { get: () => wz.plugins, set: (v) => { wz.plugins = v; } };
  body.appendChild(buildControl(fld, sl.get, sl.set, {}));
  panel.appendChild(body);
  const foot = el("div", "wz-foot");
  foot.appendChild(btn(`${icon("arrowLeft", "btn-ic")}Back`, "ghost", () => { wz.step = 1; drawWizard($("#main")); }));
  foot.appendChild(el("div", "spacer"));
  foot.appendChild(btn(`Continue${icon("arrowRight", "btn-ic")}`, "primary", () => { wz.step = 3; drawWizard($("#main")); }));
  panel.appendChild(foot);
}

function wzAgent(panel) {
  panel.innerHTML = `<span class="star">${icon("stars")}</span><h2>Shape your agent</h2>` +
    `<p class="lede">A name, who it is, and how often it wakes on its own.</p>`;
  const body = el("div", "wz-body");
  const fields = [
    { key: "id", label: "Agent name", control: "text", placeholder: "krakey", help: "Used as its folder under agents/.", example: "letters, digits, . _ -" },
    { key: "persona", label: "Persona", control: "textarea", help: "The system prompt — who the agent is and how it behaves." },
    { key: "intervalMs", label: "Heartbeat interval", control: "number", min: 1, step: 1000, unit: "ms", help: "How often it wakes unprompted, in milliseconds (60000 = 1 minute)." },
  ];
  fields.forEach((fld) => { const sl = slice(wz.agent, fld.key, fld.default); body.appendChild(renderField(fld, sl.get, sl.set, {})); });
  panel.appendChild(body);
  const foot = el("div", "wz-foot");
  foot.appendChild(btn(`${icon("arrowLeft", "btn-ic")}Back`, "ghost", () => { wz.step = 2; drawWizard($("#main")); }));
  foot.appendChild(el("div", "spacer"));
  foot.appendChild(btn(`Review${icon("arrowRight", "btn-ic")}`, "primary", () => {
    if (!wz.agent.id) return toastErr("Name your agent");
    wz.step = 4; drawWizard($("#main"));
  }));
  panel.appendChild(foot);
}

function wzReview(panel) {
  panel.innerHTML = `<span class="star">${icon("stars")}</span><h2>Ready to launch</h2>` +
    `<p class="lede">This writes config/llm.json and agents/${esc(wz.agent.id)}/config.json — the same files the CLI and a hand-edit produce.</p>`;
  const body = el("div", "wz-body");
  const prov = PROVIDERS.find((p) => p.id === wz.service.provider);

  const svc = el("div", "review-blk");
  svc.innerHTML = `<div class="rh"><span class="rh-ic">${icon("server")}</span> AI service · ${esc(wz.service.name || "unnamed")}</div>` +
    reviewLine("Provider", prov ? prov.label : wz.service.provider) +
    reviewLine("Model", wz.service.model || "—", true) +
    reviewLine("Endpoint", wz.service.baseURL || "(provider default)") +
    reviewLine("API key", wz.service.apiKey ? "•••••••• set" : "not set", false, !!wz.service.apiKey);
  body.appendChild(svc);

  const cap = el("div", "review-blk");
  cap.innerHTML = `<div class="rh"><span class="rh-ic">${icon("grid")}</span> Capabilities · ${wz.plugins.length} plugins</div>` +
    `<div class="taglist" style="margin-top:2px">` +
    wz.plugins.map((p) => { const m = PLUGINS.find((x) => x.id === p); return `<span class="tag">${m ? `<span class="tag-ic">${icon(m.icon)}</span>` : ""}${esc(m ? m.name : p)}</span>`; }).join("") + `</div>`;
  body.appendChild(cap);

  const ag = el("div", "review-blk");
  ag.innerHTML = `<div class="rh"><span class="rh-ic">${icon("robot")}</span> Agent · ${esc(wz.agent.id)}</div>` +
    reviewLine("Wakes", "every " + (wz.agent.intervalMs / 1000) + "s", true) +
    reviewLine("Persona", (wz.agent.persona || "").slice(0, 48) + ((wz.agent.persona || "").length > 48 ? "…" : ""));
  body.appendChild(ag);

  const run = el("div", "run-card");
  run.innerHTML = `<div><span class="prompt">$</span> <span class="cmd">npm start</span></div>` +
    `<span class="cm">→ ✦ Web chat: http://localhost:7717 — open it and talk to "${esc(wz.agent.id)}"</span>`;
  body.appendChild(run);
  panel.appendChild(body);

  const foot = el("div", "wz-foot");
  foot.appendChild(btn(`${icon("arrowLeft", "btn-ic")}Back`, "ghost", () => { wz.step = 3; drawWizard($("#main")); }));
  foot.appendChild(el("div", "spacer"));
  foot.appendChild(btn("✓ Create agent", "primary", () => {
    // commit to mock state
    const svcName = wz.service.name || "service";
    const p = PROVIDERS.find((x) => x.id === wz.service.provider);
    state.services[svcName] = {
      provider: wz.service.provider, model: wz.service.model,
      baseURL: wz.service.baseURL, apiKey: wz.service.apiKey || "(set)",
      capabilities: p ? [...p.defaultCapabilities] : ["chat"], input: ["text"], output: ["text"],
    };
    const cfg = { persona: { text: wz.agent.persona }, "llm-core": { communicator: svcName } };
    state.agents[wz.agent.id] = {
      id: wz.agent.id, intervalMs: wz.agent.intervalMs,
      plugins: [...wz.plugins], privatePlugins: wz.plugins.filter((x) => x === "web-chat"), config: cfg,
    };
    toast(`Created agent "${wz.agent.id}"`);
    setView("agents");
  }));
  panel.appendChild(foot);
}

function reviewLine(k, v, mint, ok) {
  return `<div class="review-line"><span class="rk">${esc(k)}</span><span class="rv${mint ? " mint" : ""}">${esc(v)}</span></div>`;
}

/* ── Boot ──────────────────────────────────────────────────────────────────*/
function buildShell() {
  const app = el("div", "app");
  app.innerHTML = `
    <aside class="sidebar">
      <div>
        <div class="brand">
          <span class="brand-mark">${icon("stars")}</span>
          <div>
            <div class="mark">KRAKEY <span class="b">Config</span></div>
            <div class="tag">ultimate autonomous agent</div>
          </div>
        </div>
        <nav class="nav">
          <div class="label">Console</div>
          <button data-view="overview"><span class="ico">${icon("grid")}</span> Overview</button>
          <button data-view="wizard"><span class="ico">${icon("stars")}</span> Guided setup</button>
          <div class="label">Configure</div>
          <button data-view="services"><span class="ico">${icon("server")}</span> AI services <span class="count">${serviceNames().length}</span></button>
          <button data-view="agents"><span class="ico">${icon("robot")}</span> Agents <span class="count">${Object.keys(state.agents).length}</span></button>
          <button data-view="default"><span class="ico">${icon("sliders")}</span> Default settings</button>
        </nav>
      </div>
      <div class="foot">
        <p><span class="dot">●</span> design mock<br>schema-driven · ${PLUGINS.reduce((n, p) => n + (PLUGIN_SCHEMAS[p.id] || []).length, 0)} settings<br>auto-fetched from source</p>
      </div>
    </aside>
    <main class="main" id="main"></main>`;
  document.body.appendChild(app);
  app.querySelectorAll(".nav button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  // Create the toast once so its hidden (off-screen) baseline is painted from the
  // start — gives every later show/hide a clean from-state to transition.
  if (!$("#toast")) { const t = el("div"); t.id = "toast"; document.body.appendChild(t); }
}

buildShell();
// Deep-link: a #wizard / #guided-setup hash (e.g. from the Console's "Quick
// setup" button) opens the Guided-setup wizard straight away; otherwise land on
// the overview as usual.
setView(isWizardHash() ? "wizard" : "overview");

// True when the URL hash names the onboarding wizard anchor (case-insensitive).
function isWizardHash() {
  const h = (location.hash || "").replace(/^#/, "").toLowerCase();
  return h === "wizard" || h === "guided-setup";
}
})(); // end IIFE
