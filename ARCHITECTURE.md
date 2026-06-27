# OpenKrakey — Architecture

> **Status:** design finalized (v1.0, the starting point of a full clean-room rewrite).
> **Stack:** TypeScript + Node.js (npm; tests run via tsx). **License:** MIT.
> **Predecessor:** [`Arrosam/KrakeyBot`](https://github.com/Arrosam/KrakeyBot) (Python) — which,
> for lack of up-front planning, had its abstractions re-cut repeatedly until it decayed.
> OpenKrakey rebuilds from zero.

---

## 0. Thesis

> **The kernel is a domain-agnostic "time-driven + non-blocking + plugin-everything" runtime.
> An *Agent* is an independent instance whose behavior emerges from a set of plugins running on
> a frame loop.** The kernel contains none of the *behavior* of LLMs, prompts, or memory — how a
> prompt is built, which model is called, how memory works all live in plugins. It does,
> however, know the general *data shapes* of LLM I/O, and it ships a single **LLM communication
> gateway** (commodity, settled infrastructure; keys confined to the core).

---

## 1. Design principles

| # | Principle | Meaning |
|---|---|---|
| **P1** | **Time-driven · non-blocking** | Each Agent has its own frame loop; tool calls are fired asynchronously and never block input; new messages and tool results fold into the next frame. |
| **P2** | **Everything is a plugin** | LLM, memory, prompt/context blocks, tools, channels — all plugins. |
| **P3** | **An Agent is an independent instance** | Each Agent owns its clock / event-system / orchestrator / loader / plugins / data, mutually isolated; many may run concurrently. |
| **P4** | **Minimal coupling** | Modules and plugins communicate **only** through the event-system (events + actions); they never import one another's implementations. |
| **P5** | **Single responsibility** | See §3 — each module does exactly one thing, with sharp boundaries. *This is the reason the project exists.* |
| **P6** | **Drift-resistant** | The contracts (L1) are the only shared vocabulary; a set of test-enforced invariants (§9) pins the boundaries shut. |

---

## 2. Module structure

```
┌──────────────────────────── Global (one per process) ─────────────────────────────┐
│  boot  — startup only: read each Agent's config file → bring the Agent up           │
│  cli   — an independent config-file management tool (UI): create/edit Agent configs  │
│          and Default settings by the correct schema (users may also edit by hand;    │
│          displays the Krakey logo)                                                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
            │ creates per config at startup
            ▼
┌──────────── Agent instance (one set each, mutually isolated, wrapped by agent_instance) ┐
│                                                                                          │
│   agent_instance — wraps one Agent: holds and wires the four below; exposes start/stop   │
│                                                                                          │
│   ┌── event-system ──(independent hub: eventbus + actionbus)──┐                          │
│   │      ▲          ▲              ▲           ▲               │                          │
│   │   clock      loader       orchestrator   plugins…         │                          │
│   │  (emit tick) (register)  (subscribe/compose/dispatch)     │                          │
│   └────────────────────────────────────────────────────────────┘                        │
│                                                                                          │
│   orchestrator internally contains the context-buffer (ordered context blocks)          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| Scope | Module | One line |
|---|---|---|
| Global | **boot** | Startup launcher (also builds the global LLM library) |
| Global | **cli** | Config-file management UI (independent tool) |
| Global | **llm-gateway** | LLM communication gateway: builds a key-less communicator library from `config/llm.json` |
| Per-Agent | **agent_instance** | Wraps one Agent (façade / container) |
| Per-Agent | **orchestrator** | The conductor (contains the context-buffer) |
| Per-Agent | **event-system** | Independent central bus (events + actions) |
| Per-Agent | **clock** | Dumb timer |
| Per-Agent | **loader** | Plugin install / register |

> **Nomenclature.** The runtime wrapper module is `agent_instance`; the word *Agent* denotes
> the conceptual instance. The `context-buffer` is **not** a module — it lives *inside* the
> orchestrator. There is no "host" module.

---

## 3. Module responsibilities

### Global

**boot** — **startup only.** Reads the configuration file in each Agent's personal folder
(`agents/<id>/config.json`) and, for each, constructs and starts one `agent_instance`. Nothing
more (it performs no run-time management).

**cli** — an **independent config-file management tool** (a user interface). An
[`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) arrow-key interface: a landing
page leading to **Agents / Default / Providers (the LLM catalogue)**, each of which
creates/edits/removes Agent configuration, the **Default plugin settings**, and the communicator
definitions in `config/llm.json` by the correct schema. A new Agent is cloned from Default as a
template. `krakey` enters the landing page; `krakey agent` / `krakey default` / `krakey providers`
deep-link directly. It is **decoupled from the runtime** — a user may edit the files by hand
instead. It displays the Krakey ASCII logo on launch.

**llm-gateway** — the **LLM communication gateway** (global infrastructure). It reads
`config/llm.json` (which contains API keys), selects a provider adapter per communicator
(e.g. `anthropic`, `openai-completion`, `jina`; native `fetch`), and produces a **key-less**
`CommunicatorLibrary`: each `Communicator` internally builds the request, sends it, and parses
the response / tool calls into a normalized `LLMResponse`. **Keys are held in the closure and are
never exposed to plugins**; a plugin only calls a communicator by name. This confines the
"commodity, no-room-for-extension" LLM request/parse logic to the core (permitted by R1: this is
infrastructure, not policy). `boot` builds one global library and injects it through
`agent_instance` → `loader` into every `PluginContext.llm`.

### Within each Agent instance

**agent_instance** — **wraps one Agent** (a façade). Holds and wires this Agent's clock +
event-system + orchestrator + loader, and exposes `start` / `stop` (plus input/output). `start()`
has the loader install plugins, then has the orchestrator begin conducting; `stop()` halts the
clock and has the loader tear down. It contains no business logic of its own.

**orchestrator** — **the conductor** (per-Agent; **the context-buffer lives inside it**). Five
responsibilities:

1. **Compose** by each context block's **target** and **priority** (numeric, larger → earlier):
   `system` blocks concatenate into the system prompt (highest first, each wrapped in `<label>`);
   `messages` blocks each render a `Message[]` group concatenated into the messages array
   (ordered across blocks by priority; order *within* a group preserved).
2. **Expose the eventbus** via the event-system: plugins register and, on specific events, modify
   context blocks — blocks are addressed **by id**, and any plugin may modify *another* plugin's
   block (e.g. A modifies B's `BBB`).
3. **Dispatch** the instructions parsed from the LLM (tool calls) **asynchronously and
   non-blockingly**.
4. **Maintain the actionbus** via the event-system, so plugins can be invoked.
5. **Coordinate the clock's cadence:** during startup it registers `clock.set_interval` /
   `clock.set_default_interval` / `clock.fire_now` on the actionbus (see `shared/actions`
   `Actions.CLOCK_*`); plugins may adjust the cadence at any time; these are unregistered on stop.

> **A frame** (event-driven; one frame is one tick of the clock): `clock` emits a tick (`clock.tick`) → the orchestrator emits
> `prompt.gather` (plugins refresh their blocks) → compose (split by target into a system prompt
> + a messages array) → emit `llm.request` (carrying `{context, messages}`; **does not wait** —
> the frame ends here). The LLM plugin listens for `llm.request`, completes the round-trip, and
> emits `llm.return` (`Reply<LLMResponse>`, with parsed `toolCalls`) → the orchestrator
> dispatches each tool call (asynchronous, isolated). Composition is fault-isolated per block: a
> block whose `render` fails degrades to empty text and never drags down the frame.

**event-system** — the **independent central bus**: an `eventbus` (`emit` / `on`) plus an
`actionbus` (`register` / `invoke`). The clock, loader, orchestrator, and every plugin **all
connect here** to exchange events and register callable actions. It stays independent precisely
because so many things connect to it.

**clock** — a **dumb timer**: it counts down on its own and, on expiry, only *activates* (emits a
tick via the event-system). It does not schedule and does not decide content; its cadence may be
adjusted by the orchestrator (`setInterval` / `fireNow`).

**loader** — **plugin install / register** (startup + registration only):

- at build time, copies plugins declared in the config's `privatePlugins` from `public_plugin/`
  into the Agent's `agents/<id>/plugins/` (never overwriting an existing one, preserving its
  private data);
- at load time, the Agent's private folder `agents/<id>/plugins/` is **loaded wholesale and
  overrides** same-named public plugins, plus the public plugins declared in the config;
- sets each plugin's `dataDir`, builds the `PluginContext`, and calls `setup` to **register the
  plugin into this Agent's event-system** (actions / listeners / context blocks);
- tears each down on `stop`.

---

## 4. Data flow of one frame (within a single Agent)

```
   plugin ──emit──▶ event-system (eventbus) ──▶ plugin adds/modifies/removes a context block by id
     ▲                                                          │   (in the orchestrator's buffer)
     │                                          clock counts down → emit tick
     │                                                          ▼
     │     orchestrator: emit prompt.gather → compose full context → emit "llm.request" ─▶ LLM plugin
     │                                                          │ (in flight; non-blocking; frame ends)
     │                                                          ▼
     │           LLM plugin finishes round-trip + parse → emit "llm.return" (Reply<LLMResponse>, toolCalls)
     └──invoke◀── event-system (actionbus) ◀── orchestrator dispatches each tool call (fired async)
```

**Temporal parallelism = non-blocking.** Tool calls run asynchronously; a new input arriving
mid-flight, and any message the Agent explicitly sends through a channel, are recorded by the
channel plugin into its own conversation and carried along at the **next** frame's composition.
Each Agent runs its own loop (no cross-blocking).

---

## 5. Plugin model

**Shared code, not shared singletons** — each Agent instantiates plugins itself; whether data is
*shared or isolated* depends on where a plugin writes its files, and **the data directory follows
the code location**.

- **public plugin:** code lives in `public_plugin/<id>/`; every Agent that declares it loads from
  there → all their `dataDir`s point to the **same** `public_plugin/<id>/data/`. *Library
  example: knowledge A writes, B can read (shared data, separate instances).*
- **independent (private) plugin:** at build time the code is **copied** into
  `agents/<id>/plugins/<id>/` → its `dataDir` points to that Agent's own `data/` → the data is
  visible only to that Agent and **overrides** a same-named public plugin.
- **PluginContext** supplies `dataDir` (= the `data/` under the plugin's code directory), used for
  all file/DB access; and **`llm`** (the key-less `CommunicatorLibrary`) — a plugin fetches a
  communicator by name to make an LLM request without ever seeing a key or the wire format.
- A plugin provides any combination of: **context blocks** (with `priority` + `target`, addressed
  by id), **actions** (registered on the actionbus), **listeners** (subscribed on the eventbus).
- **Context blocks are shared, addressed by id:** a block is maintained by the plugin that
  registers it, but any plugin may request to add/modify/remove *another* plugin's block by id
  (e.g. A modifies B's `BBB`).
- **target + priority = destination + ordering:** each block declares a `target` — `system`
  (default) concatenates into the system prompt; `messages` renders a `Message[]` group into the
  messages array — both ordered by `priority` (larger → earlier; within a `messages` group, order
  preserved). **The conversation is not a separate mechanism — it is simply a `messages` block:**
  the `web-chat` channel renders its own chat log as a conversation fed to the LLM. **Convention:**
  give *stable* system blocks (the `persona` identity, the `system-prompt` operating model, the
  `web-chat.guidance` channel usage) **high priority on top**, so a stable prefix improves prompt-cache
  hit rates; give volatile content like the conversation a lower priority (persona 10000,
  system-prompt 9000, web-chat.guidance 8000, web-chat.conversation 5000).

In configuration: `plugins: string[]` (public plugins to load); `privatePlugins?: string[]` (those
to make independent, copied in at build time). Plugins already present in the private folder are
always auto-loaded and override same-named public ones.

---

## 6. Personal folder / configuration / cli

```
agents/<id>/                  # an Agent's "personal folder"
├─ config.json                # AgentDefinition (intervalMs / plugins / privatePlugins / config / persona…)
├─ plugins/<pid>/             # private plugin code (+ data/ private data)
└─ data/ …                    # this Agent's other data
public_plugin/<pid>/          # shared plugin code (+ data/ shared data)
config/agent.default.json     # Default plugin settings (a new Agent is templated from it)
```

- **boot** reads `agents/*/config.json` at startup and brings them all up.
- **cli** is the convenient tool for editing these files: create an Agent (clone
  `agents/<id>/config.json` from Default), edit Default, add/modify plugin declarations; a user
  may also edit by hand.

---

## 7. Repository layout

```
OpenKrakey/
├─ package.json  tsconfig.json  LICENSE  README.md  ARCHITECTURE.md
├─ contracts/          # L1 — the only shared vocabulary (pure types + well-known action/event names)
│   agent · clock · context · event-system · llm · loader · orchestrator · plugin
├─ packages/           # module implementations
│   agent_instance · boot · cli · clock · event-system · llm-gateway · loader · orchestrator
├─ public_plugin/<id>/ # shared plugins
│   llm-core · persona · system-prompt · web-chat · krakeycode · web-search · browser · inspector
├─ shared/             # cross-cutting helpers (actions, config, errors, http-auth, logging, theme)
├─ config/             # *.example.json templates (llm, agent.default)
├─ tests/              # contract-derived edge tests (run via tsx)
└─ docs/               # documentation (architecture-graph tooling under docs/scripts/)
```

> **Runtime state is git-ignored**, not source: `agents/<id>/`, `public_plugin/*/data/`, and the
> live `config/llm.json` / `config/agent.default.json` are produced at run time from the
> committed `.example.json` templates.

---

## 8. Contracts (L1, pure types)

The single shared vocabulary. Each is a pure-type definition plus well-known event/action name
constants:

- **clock** — including dual `default` / `current` intervals and this-frame-immediate
  `setInterval` / `setDefaultInterval`.
- **event-system** — `EventBus` + `ActionBus`.
- **context** — `ContextBlock` `{ id, priority, target?, render }`; `render` returns a `string`
  (system) or `Message[]` (messages), or a `ComposedContext`.
- **plugin** — `Plugin` / `PluginManifest` / `PluginContext`, including `dataDir`, the key-less
  `llm` library, and the by-id context-block add/modify/remove/query operations.
- **orchestrator** — the conductor's interface.
- **agent** — `AgentDefinition` (with `privatePlugins?`) and `AgentHandle`.
- **loader** — the install/register interface.
- **llm** — the provider-agnostic LLM I/O envelope plus the key-less `Communicator` /
  `CommunicatorLibrary` (infrastructure).

Plus the well-known event/action name constants and the `Notify` / `Request` / `Reply` event base
envelopes.

---

## 9. Invariants (anti-rot · test-enforced)

- **R1** — The core holds no domain **policy / content**: it does not construct prompts, do
  memory, decide "which model / when to call", or implement agent behavior or tools. The core
  *may* hold stable, commodity **infrastructure** — the data shapes (`llm` envelope, context
  block) and the **LLM communication execution** (send + parse, see `llm-gateway`). **API keys are
  confined to the core** and are never handed to a plugin (a plugin only receives a key-less
  `Communicator`).
- **R2** — Plugins communicate only through this Agent's event-system + the L1 contracts; they do
  not import one another, do not touch core internals, and do not cross Agents.
- **R3** — A zero-plugin Agent completes a frame without error.
- **R4** — Single responsibility: each module does only what §3 specifies (e.g. the loader does
  not run a frame; `agent_instance` does not set up plugins).
- **R5** — The contracts (L1) are the only shared vocabulary; a change is versioned.
- **R6** — Per-Agent isolation: one Agent's plugins / data / events never leak into another (the
  shared data of a public plugin is the sole, explicit exception).

---

## 10. Roadmap

- **Phase 0** — Contracts + the five per-Agent modules (clock / event-system / orchestrator
  (with context-buffer) / loader / agent_instance) + boot; a bare Agent can spin a frame with no
  plugins.
- **Phase 1** — Example plugins (`persona`, the identity block; `system-prompt`, the operating
  model block (the monologue rule + basic usage, channel-agnostic); `llm-core`, the LLM
  round-trip + `llm.register_tool`; `web-chat`, the browser channel — the `web-chat.send_message` tool +
  `web-chat.guidance` usage block + `web-chat.conversation` block, maintaining its own chat log;
  `inspector`, the debugging panel) → conversation, with memory.
- **Phase 2** — The cli configuration tool (logo + `agent` / `default` / `providers` management).
- **Phase 3** — Dependency-graph visualization (rebuilt from KrakeyBot) and self-extension via
  [`docs/PLUGIN_DEV.md`](docs/PLUGIN_DEV.md).
