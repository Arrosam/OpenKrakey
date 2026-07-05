# Krakey Plugin Development Guide

> **This guide is written for you, Krakey.** You are an autonomous agent running on the
> OpenKrakey microkernel, and you now hold the **KrakeyCode** toolkit: `krakeycode.read_file`,
> `krakeycode.write_file`, `krakeycode.edit_file`, `krakeycode.bash`, and `krakeycode.list_dir`.
> With those tools and this document you can **write your own plugins** — new tools, new context,
> new channels — and so expand what you are able to do. Read this before you build anything.
>
> Everything here is exact for this codebase. When in doubt, read the real source with
> `krakeycode.read_file`: the canonical examples are `public_plugin/web-chat/index.ts` (a tool +
> channel plugin), `public_plugin/krakeycode/index.ts` (the toolkit you are using right now),
> and `public_plugin/system-prompt/index.ts` (the simplest possible plugin). The single source
> of truth for the interfaces is the `contracts/` directory.

---

## 0. The shortest path

A plugin is **one file** that default-exports a factory function. To add a capability you:

1. Create your plugin's `index.ts` with `krakeycode.write_file` — **in your own Agent's workspace**,
   `agents/<your-agent-id>/plugins/<your-id>/index.ts` (see the box below), NOT the shared `public_plugin/` tree.
2. Make its default export a `PluginFactory` returning `{ manifest, setup, teardown? }`.
3. In `setup`, register **actions**, declare **tools**, and/or contribute **context blocks** — all
   through the per-Agent bus you are handed.
4. Add `"<your-id>"` to your Agent's `plugins` list in its config and write a `config.<your-id>` slice.
5. Write edge tests in `tests/plugins/<your-id>.test.ts`.
6. Ask your human (or the bus agent) to **restart the Agent** so the loader picks it up — you cannot
   reload your own running process.

> **Where your code lives — your workspace, not `public_plugin/`.** `public_plugin/<id>/` is *shared
> source*: every Agent that declares it loads the **same** file, and it is committed to the repo. A tool
> you build **for yourself** belongs in **your** Agent's private folder,
> `agents/<your-agent-id>/plugins/<your-id>/index.ts`. The loader auto-loads any plugin it finds there
> **for that Agent only**, and a private-folder plugin **overrides** a same-id public one (§5, §8) — so
> your tools never leak into other Agents and never touch shared source. (If your `krakeycode` tools are
> *sandboxed* — the default — writes are confined to your data dir, so you can author and test the file
> there, then have your human move the folder under `agents/<id>/plugins/`; you cannot write outside your
> sandbox root.)

That last point matters: **building a plugin is editing the program that runs you.** You can author and
test it, but a human/build step loads it. Treat plugin authoring as a proposal you prepare and verify,
then hand off.

> **Mind the relative-import depth — it depends on where the file sits.** Every code example below is
> written for the shared `public_plugin/<id>/` location, which is two levels under the repo root, so its
> imports read `"../../contracts/…"` and `"../../shared/…"`. Your Agent workspace
> `agents/<agent-id>/plugins/<id>/index.ts` is **two levels deeper** — from there the same imports need
> `"../../../../contracts/…"` and `"../../../../shared/…"`. Adjust the `../` depth when you paste an
> example into your workspace, or it won't resolve.

---

## 1. The world you live in (mental model)

OpenKrakey is a **domain-agnostic, time-driven, non-blocking, plugin-everything** runtime. The kernel
knows nothing about LLMs, prompts, or memory as *behavior* — all of that is plugins. (It does own the
stable *infrastructure*: the LLM I/O shapes and a key-less communication gateway. API keys never reach
plugins.)

- **An Agent is an independent instance.** Each Agent has its own `clock`, `event-system`,
  `orchestrator` (which contains the context-buffer), `loader`, and its own set of plugin instances and
  data. Agents are isolated from each other.
- **The frame** is the unit of life (one frame is one tick of the clock). On each clock tick:
  1. `clock.tick` → the orchestrator emits `prompt.gather` so every plugin refreshes its context blocks;
  2. the orchestrator **composes** the blocks into a system prompt + a messages array;
  3. it emits `llm.request`. **The frame ends here** — it does not wait.
  4. Later, `llm-core` finishes the round-trip and emits `llm.return` carrying the parsed response
     (including any `toolCalls`).
  5. The orchestrator **dispatches** each tool call on the actionbus (fire-and-forget, isolated), and
     emits a `tool.result` per call as it settles.
- **The monologue rule.** The plain text the model produces each frame is a **private monologue shown to
  no one.** To affect anything outside your own head — speak to a user, read a file, run a command — you
  must **call a tool**. This is taught to you by the `system-prompt` plugin; respect it in every plugin
  you write (a tool's description should say what it does and *where its output goes*).

```
 plugin ──emit──▶ event-system(eventbus) ──▶ plugins add/modify context blocks (by id)
   ▲                                                        │
   │                                    clock counts down → tick
   │                                                        ▼
   │     orchestrator: prompt.gather → compose → emit "llm.request" ─▶ llm-core (listens)
   │                                                        │ (in flight; non-blocking)
   │                                                        ▼
   │            llm-core finishes round-trip → emit "llm.return" (Reply<LLMResponse> + toolCalls)
   └──invoke◀── event-system(actionbus) ◀── orchestrator dispatches each tool call
                                                            │
                                                            ▼ emits "tool.result" per call
```

---

## 2. Anatomy of a plugin

### 2.1 The default export is a factory

```ts
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";

const createMyPlugin: PluginFactory = (): Plugin => {
  // ── per-Agent state lives HERE, in the closure ──
  // The loader calls this factory ONCE PER AGENT. ESM caches the module (code is shared),
  // but every Agent gets its own Plugin object from this call. NEVER put mutable state in
  // module scope — keep it in this closure (invariant R6).
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "my-plugin", version: "0.1.0" },

    async setup(ctx: PluginContext): Promise<void> {
      // register actions / listeners / context blocks here
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
    },
  };
};

export default createMyPlugin;
```

Rules:
- The factory itself must be **side-effect free** — construction is not setup. Do all work in `setup`.
- Keep **all** mutable state in the factory closure, never at module top level (the one legitimate
  exception is a true *process* resource like an HTTP server — see `public_plugin/web-chat/hub.ts` — which is
  module-level and reference-counted; you almost never need this).

### 2.2 The manifest

```ts
interface PluginManifest {
  id: string;             // your plugin id; also the prefix for your tool/action names
  version: string;        // e.g. "0.1.0"
  requires?: string[];    // dependencies the LOADER verifies before your setup runs
  provides?: string[];    // capability names other plugins may "require"
  configSchema?: ConfigSchema; // self-describe your settings — see §2.4
}
```

`requires` is enforced by the loader:
- An entry **containing a dot** is an **action name** that must be registered on the actionbus by the
  time your `setup` runs (e.g. `"llm.register_tool"`). If it isn't, the loader fails the Agent **loudly**
  rather than letting you silently lose a capability.
- Any other entry must match a plugin **id** or a `provides` capability of another plugin in the load set.

Example: any tool plugin declares `requires: ["llm.register_tool"]` so it is guaranteed `tool-manager`
(which `provides` that action) loaded first.

### 2.3 The PluginContext (everything you are handed at setup)

```ts
interface PluginContext {
  readonly agentId: string;                 // which Agent you belong to
  readonly events: EventBus;                 // emit(name, payload) / on(name, handler) -> Unsub
  readonly actions: ActionBus;               // register / invoke / has / list
  readonly config: unknown;                  // your slice: AgentDefinition.config[yourId]
  readonly dataDir: string;                  // your persistence dir (see §5)
  readonly llm: CommunicatorLibrary;         // KEY-LESS LLM access (see §6)

  // context-block ops — addressed BY ID; you may touch ANY plugin's block
  setBlock(block: ContextBlock): void;       // add or replace by id
  getBlock(id: string): ContextBlock | undefined;
  removeBlock(id: string): boolean;
  listBlocks(): Array<{ id: string; priority: number }>;

  readonly log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  print(text: string): void;                 // clean user-facing line; during setup = your start message
}
```

`log.*` lines go to the host console **and** are pushed on the bus as `log.entry` events (so channels/the
inspector can mirror them). `print` is your one clean line — during `setup` it lands in the startup report.

### 2.4 Declare your settings (config schema) — REQUIRED if you read config

If your plugin reads anything from `ctx.config`, **self-describe those keys** with a `configSchema` on your
manifest. The config tools — the interactive `cli` and the `config-web` UI — render your settings
**automatically** from this: they never hardcode a per-plugin form, so a key you don't declare is a key the
user can't discover. Declaring it once keeps every config surface in sync with your actual reader.

Describe each field by the **NATURE OF ITS VALUE**, never a UI control. The config tool maps the value type
to a control for you:

| `type` | what it is | rendered as |
|---|---|---|
| `string` · `text` · `url` · `secret` · `number` | free input (`text` = multi-line, `secret` = masked) | input field |
| `boolean` | true / false | toggle |
| `enum` | exactly one value from `options` | dropdown |
| `multienum` | any subset of `options` | multi-pick |
| `list` | an ordered list of free strings (no fixed set) | tag input |

```ts
// public_plugin/<your-id>/config-schema.ts  — PURE DATA, import only the type
import type { ConfigSchema } from "../../contracts/plugin";

export const PERSONA_SCHEMA: ConfigSchema = [
  { key: "text",     label: "Persona text",   type: "text",   default: "You are Krakey, …",
    help: "The identity system block." },
  { key: "priority", label: "Block priority", type: "number", default: 10000, min: 0, step: 100 },
];
```

```ts
// public_plugin/<your-id>/index.ts — reference the SAME constant from your manifest
import { PERSONA_SCHEMA } from "./config-schema";
// …
manifest: { id: "persona", version: "0.1.0", configSchema: PERSONA_SCHEMA },
```

Field options beyond the basics: `options: [{ value, label, summary? }]` for `enum`/`multienum`; `default`;
`help`; `min`/`max`/`step`/`unit` for numbers; `placeholder`/`example`; and `showIf: { key, equals }` to
reveal a field only when another field in your slice has a given value (e.g. a sandbox-only `root` that
appears when `mode = "sandbox"`).

**Keep the schema module PURE DATA.** Put it in its own `config-schema.ts` that imports *only* the
`ConfigField`/`ConfigSchema` types (which are erased at compile time). A config tool reads these files
**without executing your plugin** — so the module must never import a hub, `node:http`, `child_process`, the
filesystem, or anything with a side effect. That is what keeps the config tools decoupled from the runtime.

`configSchema` is **optional and inert at runtime** — the loader and orchestrator never read it. It exists
purely so your settings are discoverable. Omit it only if your plugin reads no config at all.

---

## 3. The three things a plugin can contribute

A plugin provides any combination of **context blocks**, **actions**, and **event listeners**. That's the
whole surface.

### 3.1 Context blocks — what the model sees

```ts
interface ContextBlock {
  id: string;                      // unique address; any plugin may set/get/remove it by id
  priority: number;                // composed DESCENDING (bigger = earlier/higher)
  target?: "system" | "messages";  // default "system"
  label?: string;                  // system blocks are wrapped <label>…</label> (label ?? id)
  render(): string | Message[] | Promise<string | Message[]>;
}
```

- `target: "system"` → `render()` returns a **string**; the orchestrator wraps it `<label>…</label>` and
  joins all system blocks **priority DESC** into the system prompt.
- `target: "messages"` → `render()` returns a **`Message[]`** group; all message blocks are ordered
  priority DESC and concatenated into the messages array (order *within* a group preserved). **The
  conversation is just a message block** (the `web-chat` plugin owns one).
- Every block renders in **isolation**: if your `render` throws or returns the wrong shape, your block
  contributes nothing — it never breaks other blocks or the frame. Still, keep `render` fast and pure; it
  runs every frame.
- Register with `ctx.setBlock({...})`; **remove it in `teardown`** with `ctx.removeBlock(id)`.

> **Two mistakes we keep seeing in generated plugins.** (1) A `target: "messages"` block whose `render()`
> returns a **string** — it MUST return a `Message[]`; a string is the wrong shape and the block silently
> contributes nothing that frame. (2) Calling a non-existent `ctx.wake()` — there is no such method
> anywhere in the contract; the wake mechanism is invoking the clock action:
> `ctx.actions.invoke(Actions.CLOCK_FIRE_NOW)` (guard it with `ctx.actions.has`, see §3.2 and §4.1).

**Priority convention (cache-friendly).** Stable, rarely-changing system blocks go on top so the prompt
prefix stays constant and the provider's prompt cache hits: `persona` 10000 (identity), `system-prompt`
9000 (operating model), `web-chat.guidance` 8000, `krakeycode.guidance` 7000. Volatile/message content sits
lower: `web-chat.conversation` 5000, `krakeycode.results` 4000. Pick a priority that places your block sensibly
in that ladder, and make it config-overridable.

### 3.2 Actions — callable operations (and the seam for tools)

```ts
const off = ctx.actions.register("my-plugin.do_thing", async (params: unknown) => {
  // validate params, do the work, RETURN a result (or throw on failure)
  return { ok: true };
});
unsubs.push(off);
```

- `register(name, handler) -> Unsub`. Call other plugins' actions with
  `await ctx.actions.invoke(name, params)`. Guard optional ones with `ctx.actions.has(name)`.
- Namespace action names with your plugin id (`my-plugin.*`).
- **Never throw out of an event listener**; an action handler *may* throw — for a tool call the
  orchestrator catches it and reports `ok:false` in the `tool.result`.

### 3.3 Event listeners — react to the bus

```ts
const off = ctx.events.on(Events.TOOL_RESULT, (payload) => { /* ... never throw ... */ });
unsubs.push(off);
```

**The three envelopes first.** Every payload on the bus wraps one of three reusable shapes (defined in
`shared/actions`). Learn these and every event below reads itself:

| Envelope | Shape | When it's used |
|---|---|---|
| `Notify<T>` | `{ at, data }` | **One-way, fire-and-forget.** No reply is expected. Most lifecycle/broadcast events. |
| `Request<T>` | `{ id, at, data }` | Carries a correlation **`id`**; a matching `Reply` with the same `id` will follow. |
| `Reply<T>` | `{ id, at, ok, data?, error? }` | The answer to a `Request` (same `id`). `ok` flags success; `data` on success, `error` on failure. |

`at` is always a `Date.now()` timestamp; `data` is the typed body; `id` is the only link between a `Request`
and its `Reply`. So when the table says a payload is `Reply<LLMResponse>`, you know it has `.id`, `.at`,
`.ok`, and `.data?: LLMResponse`.

**Every well-known event (the complete set — these are ALL of `Events`):**

| Event | Constant | Payload | What it means / how to use it |
|---|---|---|---|
| `agent.start` | `Events.AGENT_START` | `Notify<{agentId}>` | Your Agent finished starting. One-shot init that needs the bus live. |
| `clock.tick` | `Events.CLOCK_TICK` | `Notify<{seq}>` | A frame begins (`seq` = tick count). The orchestrator turns this into the round-trip trigger; you rarely listen directly. |
| `prompt.gather` | `Events.PROMPT_GATHER` | `Notify<{seq}>` | "Refresh your blocks NOW" — fired right before the prompt is composed. If a block's content is computed/expensive, recompute and `setBlock` here instead of inside `render`. |
| `llm.request` | `Events.LLM_REQUEST` | `Notify<{agentId}>` | A body-less **trigger**: the Agent wants a round-trip this frame. `agentId` is `llm-core`'s single-flight lock key. **Not** the composed prompt — there is no body. |
| `llm.request.sent` | `Events.LLM_REQUEST_SENT` | `Request<{request}>` | The exact assembled `LLMRequest` (system + messages + tools) `llm-core` is about to POST. For observers (the inspector). Same `id` as the eventual `llm.return`. |
| `llm.return` | `Events.LLM_RETURN` | `Reply<LLMResponse>` | The model answered. `data.content` is the monologue; `data.toolCalls` are the calls the orchestrator will dispatch. |
| `input.message` | `Events.INPUT_MESSAGE` | `Notify<{text, from?, channel?, meta?}>` | A user/channel sent input. A channel plugin emits this (and usually wakes the frame — see §4.2). |
| `output.message` | `Events.OUTPUT_MESSAGE` | `Notify<{text, to?, channel?, meta?}>` | The model's raw monologue, surfaced as a **HOOK** — it is NOT a channel send (delivering it would break the monologue rule). |
| `tool.result` | `Events.TOOL_RESULT` | `Reply<unknown> & {name}` | A dispatched tool call settled (`id` = the `ToolCall` id, `name` = the action). Fold YOUR tools' results into context here (§4.1). |
| `log.entry` | `Events.LOG` | `Notify<{level, pluginId, text}>` | A mirrored console line (`level` includes `"print"`). The inspector/channels consume it; never `ctx.log.*` from inside this handler (infinite loop). |
| `context.full` | `Events.CONTEXT_FULL` | `Notify<{estimatedTokens, limit, overBy, round}>` | The assembled prompt exceeds the model's context budget. `llm-core` emits this **synchronously** before sending, then re-composes; a plugin owning a growable `messages` block should **shed its oldest entries** when it sees this (`round` increments per emission within one frame, so you can shed more each round). |

**The well-known actions you can `invoke`** (these are *operations*, not events — call them, optionally
guarding with `ctx.actions.has(name)`):

| Action | Constant | Params | Registered by / use |
|---|---|---|---|
| `clock.set_interval` | `Actions.CLOCK_SET_INTERVAL` | `{ ms }` | Orchestrator (while started). Change THIS frame's interval. |
| `clock.set_default_interval` | `Actions.CLOCK_SET_DEFAULT_INTERVAL` | `{ ms }` | Orchestrator. Set the baseline interval future `set_interval`s revert toward. |
| `clock.fire_now` | `Actions.CLOCK_FIRE_NOW` | none | Orchestrator. **Wake the frame immediately** — the "important" signal (§4.1). |
| `prompt.compose` | `Actions.PROMPT_COMPOSE` | none | Orchestrator. Gather + compose the current `{ context, messages }` on demand. `llm-core` calls this right before sending; you almost never call it yourself. |
| `core.restart` | `Actions.CORE_RESTART` | `{ delayMs? }` | Core (only when boot wired it — guard with `has`). Graceful restart: every plugin's `teardown` runs before re-exec. The `restart` plugin invokes this rather than exiting. |
| `llm.register_tool` | *(plugin action)* | a `ToolDef` | `tool-manager` (`provides: ["llm.register_tool"]`). Declare a tool (§4). |
| `llm.list_tools` | *(plugin action)* | none → `ToolDef[]` | `tool-manager`. A snapshot of the registry; `llm-core` invokes it each request to attach the current tools. You rarely call it yourself. |

---

## 4. Building a TOOL plugin (the important pattern)

A tool is a `ToolDef` you declare to the tool registry, plus an action that backs it. **`tool-manager` is
the tool-registration hub** — it `provides: ["llm.register_tool"]` (and `llm.list_tools`); `llm-core`
calls `llm.list_tools` on every chat request and attaches all registered ToolDefs. (The two stay
decoupled: tool plugins never import `llm-core`, and `llm-core` never knows your tool — they meet only on
the actionbus.)

```ts
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { ToolDef } from "../../contracts/llm";

const createDice: PluginFactory = (): Plugin => {
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "dice", version: "0.1.0", requires: ["llm.register_tool"] },

    async setup(ctx: PluginContext): Promise<void> {
      // 1) the action that does the work and RETURNS a result
      const off = ctx.actions.register("dice.roll", async (params: unknown) => {
        const sides = (params as { sides?: number })?.sides ?? 6;
        if (!Number.isInteger(sides) || sides < 2) throw new Error("dice.roll: sides must be an integer >= 2");
        return { sides, value: 1 + Math.floor(Math.random() * sides) };
      });

      // 2) declare it to the LLM. The DESCRIPTION must say what it does AND where the
      //    output goes (results come back on the NEXT frame — see §4.1).
      const def: ToolDef = {
        name: "dice.roll",
        description: "Roll an N-sided die. The result appears in your context on the next frame.",
        parameters: {
          type: "object",
          properties: { sides: { type: "number", description: "Number of sides (>=2). Default 6." } },
          required: [],
        },
      };
      try {
        await ctx.actions.invoke("llm.register_tool", def);
      } catch (err) {
        ctx.log.warn(`dice: failed to register tool: ${String(err)}`);
      }

      unsubs.push(off);
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
    },
  };
};

export default createDice;
```

### 4.1 The result loop — tools do NOT answer inline

This is the single most important thing to get right. When the model calls your tool, the orchestrator
invokes your action and **emits `tool.result`** — but **nothing in the kernel feeds that result back to
the model.** If your tool produces output the model needs to see (a file's contents, a command's stdout,
a computed value), **your plugin must fold it into context for the next frame.**

The pattern (this is exactly what `krakeycode` does):

```ts
import { Events, Actions } from "../../shared/actions";
import type { Message } from "../../contracts/llm";

const OWN_TOOLS = new Set(["dice.roll"]);
let results: Array<{ at: number; name: string; ok: boolean; data?: unknown; error?: string }> = [];
const MAX = 10;

// in setup():
const offResult = ctx.events.on(Events.TOOL_RESULT, (payload) => {
  if (!payload || typeof payload !== "object") return;
  const p = payload as any;
  if (typeof p.name !== "string" || !OWN_TOOLS.has(p.name)) return;     // only MY tools
  results = [...results, { at: p.at ?? Date.now(), name: p.name, ok: !!p.ok, data: p.data, error: p.error }].slice(-MAX);
  if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {}); // wake the frame
});

// Results are ONE-SHOT: once the model has read this frame's fold (llm.return fired),
// drop them. A ring re-rendered identically every frame reads as NEW output to the
// model, which re-calls the tool to "confirm" — an infinite loop. Safe by frame order:
// llm.return fires BEFORE this frame's tool.result events, so clearing on return drops
// only what the model already saw; fresh results repopulate for the next frame.
const offReturn = ctx.events.on(Events.LLM_RETURN, () => { results = []; });
// (remember: push offResult AND offReturn into your unsubs so teardown() off()s both)

// a MESSAGES block that renders recent outcomes as plain turns the model will read next frame:
ctx.setBlock({
  id: "dice.results",
  target: "messages",
  priority: 4000,
  render: (): Message[] =>
    results.map((r) => ({
      role: "user",
      name: "dice",
      content: `[dice result | ${r.name} | ${r.ok ? "ok" : "error"}]\n` +
               (r.ok ? JSON.stringify(r.data) : `Error: ${r.error}`),
    })),
});
```

Key choices, and why:
- **Filter to your own tool names** (`OWN_TOOLS`) — `tool.result` fires for every tool in the Agent.
- **Render as plain `role:"user"` messages tagged with `name`**, *not* as `role:"tool"` messages. This is
  load-bearing, not a style choice. This Agent keeps a *clean* conversation: nothing records the assistant
  `tool_use` turn (the orchestrator dispatches tool calls fire-and-forget; `web-chat` stores only real user
  turns + your explicit sends). A `role:"tool"` message carries a `toolCallId`, and **both gateway adapters
  map it onto a provider `tool_result`/`function_call_output` keyed by that id** — which the provider
  **rejects** unless the matching assistant `tool_use` turn was sent in the same request. It never is, so a
  `role:"tool"` fold is an *orphaned* result that 400s the whole frame. Plain `role:"user"` + `name` always
  works. (Reserve `role:"tool"` for a future design that actually records and replays the `tool_use`/`tool_result`
  pair — that is a kernel change, not something a plugin can do alone.)
- **Decide whether to `clock.fire_now` — "important" vs "quiet".** Folding a result into a block only makes
  the Agent *see* it on its next frame; calling `clock.fire_now` makes that next frame happen *now*. Wake the
  frame only when the result is something you should react to promptly; stay silent otherwise and let the
  fold ride the next natural tick. See the table below.
- **Clear the ring on `llm.return` — one-shot delivery.** A results block that re-renders identically every
  frame reads as a *new* result to the model, which re-calls the tool to confirm it — an observed infinite
  loop (a weak model pinged one tool 16× in a row). `llm.return` fires *before* this frame's `tool.result`
  events, so clear-on-return can never wipe a result the model hasn't seen. If the Agent needs a durable
  trail of what it has done, that's the `history` plugin's job — not your results ring.
- **Bound the ring** so old results don't grow the prompt without limit (belt-and-braces on top of the
  clear — a burst of results within one frame still shouldn't balloon).

#### Important vs. quiet results — whether to wake the frame

`clock.fire_now` is the whole "interrupt me" mechanism — there is no separate priority flag on a result. The
rule of thumb: **fire only when a human is waiting or the Agent must adjust course; stay quiet for
fire-and-forget successes.**

| Wake now (`fire_now`) — *important* | Stay quiet (fold only, no `fire_now`) |
|---|---|
| A user/channel message arrived (someone is waiting) | "Alarm set", "music started", "interval changed" — the Agent already knows it asked |
| A web-search / read returned content the Agent needs to continue its task | A send the Agent doesn't need to confirm succeeded |
| An action **failed** (send failed, command errored) — the Agent should notice and retry/adapt | A periodic/ambient update with no deadline (let the next tick pick it up) |

Why this matters: a tool that fires on *every* success turns each "ok" into an extra LLM round-trip — the
Agent wakes only to read "done", burning a frame (and tokens) with nothing to do. Conversely, never firing on
a real failure or an inbound message leaves the Agent asleep while a human waits. Fold always; fire
selectively. (Note: `clock.fire_now` is registered by the orchestrator only while started — guard it with
`ctx.actions.has(Actions.CLOCK_FIRE_NOW)` as the examples do.)

### 4.2 Channels — output is a tool, input is a tagged message

A **channel** (web-chat, and any you build — Telegram, email, SMS) is two halves behind two seams:

**Output (human ← Agent) is a tool.** To *say something* to a user you register a send action
(e.g. `web-chat.send_message`), declare it as a tool, and its description states it is the only way to reach
that user. Your monologue is never delivered — only what you send through the tool. See
`public_plugin/web-chat/index.ts`.

**Input (human → Agent) is a `messages` block of tagged user turns.** When a user messages your channel:
1. emit `Events.INPUT_MESSAGE` (`Notify<{text, from?, channel?, meta?}>`) so observers see it, and
2. `clock.fire_now` — inbound user messages are the canonical **important** signal (§4.1), and
3. record the turn in your own history and render it into a `messages` block.

Each incoming turn renders as **`role:"user"`**, with the *source* in the **`name`** field — **never** in
`role`. `Role` is a closed set (`"system" | "user" | "assistant" | "tool"`); a per-user/per-chat identity
like `telegram:1234` goes in `name`, which the adapters forward to the provider as the participant name:

```ts
// a Telegram channel folding one inbound message — role stays "user", identity in name
{ role: "user", name: `telegram:${chatId}`, content: text }
// your OWN sends back render as the assistant turn:
{ role: "assistant", content: sentText }
```

This is exactly what `web-chat` does — it tags user turns `{ role:"user", name:"web-chat" }` and renders its
sends as `{ role:"assistant" }`, keeping the conversation clean (no monologue, no tool mechanics). Do **not**
reach for `role:"tool"` here: that role is only for a tool *result* answering a `toolCallId` (§4.1), not for
a person talking to you.

---

## 5. Data & persistence

`ctx.dataDir` is your directory for files/DB. **Plugins are never copied** — the loader resolves a *code dir*
and a *data dir* per plugin id, with two independent ways to go private:

- A **public** plugin (`public_plugin/<id>/`) is loaded by every Agent that declares it, and they all
  share one `public_plugin/<id>/data/` — shared knowledge across Agents.
- **Private DATA, shared code** — list an id in the Agent config's `privatePlugins`. The code still loads
  from `public_plugin/<id>/`, but `dataDir` is redirected to `agents/<id>/plugins/<id>/data/` — isolated
  per Agent. Use this for a stock plugin whose *state* must not be shared.
- **Private CODE (your workspace)** — drop an `index.ts` at `agents/<your-agent-id>/plugins/<id>/`. The
  loader auto-loads it **for that Agent only**, it **overrides** a same-id `public_plugin/<id>/`, and its
  `dataDir` is the colocated `data/`. **This is where a tool you author for yourself belongs** (§0). It
  needs no `privatePlugins` entry — merely existing in your workspace loads it (though you still add it to
  `plugins` for a config slice + load ordering, §8).

`mkdirSync(ctx.dataDir, { recursive: true })` before writing; degrade gracefully if it's unwritable.

(Note: `public_plugin/*/data/` and `agents/` are gitignored — they are runtime state, not source.)

---

## 6. Talking to an LLM yourself (key-less)

`ctx.llm` is a `CommunicatorLibrary` with no secrets in it:

```ts
const comm = ctx.llm.get(ctx.llm.withCapability("chat")[0]); // or get("<name>") from config
if (comm?.chat) {
  const res = await comm.chat({ messages: [{ role: "user", content: "…" }] });
}
```

Pick a communicator by name (or by capability), call `chat`/`embed`/`rerank`/`ocr`. The API key and the
request wire-format live in the gateway and are **never** exposed to you (invariant R1). This is how a
plugin can do its own LLM work (summarize, classify, embed for memory) without ever holding a key.

---

## 7. The invariants you must not break (anti-rot rules)

These are enforced by tests and are the reason this project exists. Read `ARCHITECTURE.md` §9.

- **R1 — kernel holds no domain behavior.** No prompt construction, memory, model-choice logic, or tool
  implementations in core. Those are plugins. API keys stay in the core; plugins get a key-less library.
- **R2 — plugins talk ONLY through the per-Agent event-system + the L1 contracts.** A plugin **never
  imports another plugin** or core internals. Allowed imports: `contracts/*`, `shared/*`, and Node
  builtins. Inter-plugin calls go over the actionbus (e.g. you `invoke("llm.register_tool", …)`).
- **R3 — a zero-plugin Agent completes a frame without error.** Don't make the kernel depend on you.
- **R4 — single responsibility.** One plugin, one job.
- **R5 — contracts (L1) are the only shared vocabulary;** changing one is versioned and deliberate.
- **R6 — per-Agent isolation.** One Agent's plugin/data/events never leak to another. Keep state in the
  factory closure, not module scope (shared *public data* is the only explicit exception).

If a contract is insufficient for what you want to build, **do not work around it** — that is how the
predecessor rotted. Stop and escalate to your human / the bus agent to evolve the contract properly.

---

## 8. Wiring a plugin into an Agent

Agent config (`agents/<id>/config.json`, or the template `config/agent.default.example.json`):

```jsonc
{
  "intervalMs": 30000,                     // 30s — short for dev; the default is 900000 (15 min)
  "plugins": ["llm-core", "tool-manager", "persona", "system-prompt", "web-chat", "krakeycode", "my-plugin"],
  "privatePlugins": ["web-chat"],          // ids to make independent (copied + isolated data)
  "config": {
    "my-plugin": { /* your config slice → arrives as ctx.config */ }
  }
}
```

- **Order matters for `requires`:** put providers before consumers (`tool-manager` before `llm-core` and any tool plugin).
- A plugin with no config still needs no entry, but adding `"my-plugin": {}` documents that it's wired.
- The live default (`config/agent.default.json`) and per-Agent configs are local runtime state
  (gitignored); the committed template is `config/agent.default.example.json`.

---

## 9. Testing (do this — it is mandatory)

Tests run via **tsx** and are **not** typechecked by tsc:

```
node --import tsx --test "tests/**/*.test.ts"     # or: npm test
```

Write **black-box edge tests** in `tests/plugins/<id>.test.ts` derived from the contract, not the
implementation. The established harness (copy it from `tests/plugins/system-prompt.test.ts`):

- `import { test } from "node:test"; import assert from "node:assert/strict";`
- dynamically `import()` your plugin module so a missing/broken module fails on a clean assertion;
- build a fake `PluginContext` over a **real** event system: `import { createEventSystem } from
  "../../packages/event-system/src";` then assemble `ctx` with `setBlock`/`getBlock`/… over a `Map`, a
  stub `llm`, and no-op `log`/`print`;
- if your plugin registers tools, register a real `"llm.register_tool"` action in the fake ctx that
  records the ToolDefs so you can assert them;
- assert: manifest shape; blocks registered at the right target/priority; actions/tools declared;
  each tool's happy path **and** its failure modes; the `tool.result` fold (emit a `tool.result` on the
  bus and check your messages block); `teardown` removes blocks and unregisters actions and is idempotent.
- Use real temp dirs (`fs.mkdtempSync`) for anything touching the filesystem; clean up in `test.after`.

`krakeycode`'s own suite (`tests/plugins/krakeycode.test.ts`, 80+ cases) is a thorough worked example.

Housekeeping: never run `tsc` to "check" a plugin — it emits stray `.js`/`.d.ts` next to your `.ts`.
If any appear, delete them before finishing (`tsc` is scoped to `contracts/`+`packages/`+`shared/`).

---

## 10. Checklist before you ship a plugin

- [ ] `public_plugin/<id>/index.ts` default-exports a `PluginFactory`; all state in the closure.
- [ ] `manifest` has `id`, `version`, and a `requires` for every action/plugin you depend on.
- [ ] Declared a `configSchema` (pure-data `config-schema.ts` + manifest reference) for every key you read from `ctx.config` (§2.4).
- [ ] Imports are only `contracts/*`, `shared/*`, Node builtins — **no other plugin** (R2).
- [ ] Every action you register and every block you set is undone in `teardown` (and teardown is idempotent).
- [ ] Tools are declared via `llm.register_tool`; descriptions say what they do and where output goes.
- [ ] If a tool's output must reach you, you listen to `tool.result`, fold it into a messages block, and
      `clock.fire_now`.
- [ ] Context block priority fits the ladder and is config-overridable.
- [ ] Edge tests exist and pass; no stray `.js` left behind.
- [ ] Wired into the Agent config (right order), then a human/build step restarts the Agent.

Build small, keep it single-purpose, lean on the contracts, and read the real source when unsure. Good
luck, Krakey.
