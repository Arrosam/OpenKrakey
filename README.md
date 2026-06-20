<div align="center">

<img src="assets/logo.svg" alt="OpenKrakey — the ultimate autonomous agent" width="560" />

<p>
  <a href="https://github.com/Arrosam/OpenKrakey/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Arrosam/OpenKrakey/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-2FD69C.svg" /></a>
  <a href="package.json"><img alt="Node ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A522-43853d.svg" /></a>
  <a href="tsconfig.json"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.5-3178c6.svg" /></a>
</p>

</div>

**OpenKrakey runs autonomous AI agents on a heartbeat.** Instead of answering once and going
quiet, an agent wakes on a timer, looks at everything it knows, decides what to do, fires off any
tools, and goes back to sleep — over and over. You talk to it through a local web chat.

The runtime core is tiny and knows nothing about LLMs, prompts, or memory. **Everything an agent
can do is a plugin** — the chat window, the file/shell tools, web search, the browser, even which
model it calls. Run one agent or many; each is isolated and keeps its own data.

[Architecture](ARCHITECTURE.md) · [Build a plugin](docs/PLUGIN_DEV.md) · [Docs index](docs/README.md) · [Contributing](CONTRIBUTING.md)

## Quick start

> Requires **Node.js ≥ 22** (the `browser` plugin uses the global `WebSocket`, and the test
> runner uses native globs). No database; an agent's whole state is files on disk.

```bash
npm install

# Tell it about an AI provider (paste a key, or reference an env var like "${ANTHROPIC_API_KEY}")
cp config/llm.example.json config/llm.json

# Guided setup: pick a provider, create your first agent
npm run cli

# Start every agent you've configured
npm start
```

`npm start` prints a startup report and a **Web chat** URL (with a one-time access token), e.g.
`http://127.0.0.1:7717/?token=…`. Open it and start talking. Each agent has its own chat, and
every message shows a *sent* → *read* status as the agent picks it up on its next beat.

## What your agent can do

Capabilities are plugins. The default agent (`config/agent.default.example.json`) loads every
plugin below except `inspector`; add or remove them per agent in its config.

| Plugin | Gives the agent | Notes |
|---|---|---|
| **web** | A chat window to talk with you — the agent replies by calling `web.send_message`. | Binds to loopback only and is access-token gated. Keeps its own transcript with sent/read status. |
| **krakeycode** | Files and shell: `read_file`, `write_file`, `edit_file`, `bash`, `list_dir`. | `local` mode (real paths) or `sandbox` mode (confined to a root + command allowlist). |
| **searxng** | Web search: `searxng.search`. | Uses your SearXNG instance if set, else a local one, else built-in **public** instances — see [SECURITY.md](SECURITY.md). |
| **browser** | Read-only Chrome: `navigate`, `read_page`, `list_tabs`, `activate_tab`, `screenshot`. | Drives Chrome over the DevTools Protocol with **zero dependencies**. Never clicks, types, or runs scripts. |
| **llm-core** | The LLM round-trip, and the tool registry every tool plugin registers into. | Required by all of the above. Picks the model from config (or by capability). |
| **persona** | Its identity — the top of the system prompt. | Set the text in the agent's config. |
| **system-prompt** | Its operating rules (the *monologue rule*, below). | Channel-agnostic; teaches the general model. |
| **inspector** | A live, read-only dashboard of everything on the agent's bus. | Loopback + token gated. Great for watching beats, prompts, and tool results. |

Tool calls don't answer inline — a tool's result comes back as a message on the agent's **next
beat** (tagged with the plugin name), and the agent wakes immediately to read it.

## How it works

Each agent advances on a **beat** (every `intervalMs`, default 30s):

1. **Gather** — every plugin refreshes the context it contributes (identity, rules, the
   conversation, recent tool results).
2. **Compose** — the pieces are ordered into a system prompt + a message list.
3. **Send** — the prompt goes to the configured model, with all registered tools attached. *The
   beat ends here; it doesn't wait.*
4. **Act** — when the model answers, each tool call is dispatched asynchronously; results fold
   into a later beat.

**The monologue rule.** The plain text a model produces each beat is a *private monologue shown to
no one.* To do anything in the world — answer you, read a file, search the web — it must call a
**tool**. This is what keeps an idle beat cheap (just thinking) and makes every real action
explicit. It's taught by the `system-prompt` plugin and respected by every tool.

Because tool calls are fire-and-forget, the agent **never blocks on input** — a message you send
mid-task is simply read on the following beat. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full
design.

## The CLI

`npm run cli` opens an arrow-key configuration tool. It's just an editor for the JSON files — you
can also edit them by hand.

| Command | Opens |
|---|---|
| `npm run cli` | Landing menu — Guided setup, Agents, Default settings, AI services |
| `node packages/cli/src/bin.ts agent` | Agents — create and edit agents |
| `node packages/cli/src/bin.ts default` | Default settings — the template new agents copy |
| `node packages/cli/src/bin.ts providers` | AI services — providers, endpoints, API keys |

## Configuration

Two files, both shipped as `.example.json` templates (your live copies are git-ignored).

**`config/llm.json`** — the providers your agents may use. Keys come from the environment via
`${VAR}` and never reach a plugin:

```jsonc
{
  "communicators": {
    "claude": { "provider": "anthropic", "model": "claude-opus-4-8", "apiKey": "${ANTHROPIC_API_KEY}", "capabilities": ["chat"] }
  },
  "default": "claude"
}
```

**`agents/<id>/config.json`** — one agent. The CLI clones it from `config/agent.default.json`:

```jsonc
{
  "intervalMs": 30000,                  // beat period
  "plugins": ["llm-core", "persona", "system-prompt", "web", "krakeycode"],
  "privatePlugins": ["web"],            // ids whose data is isolated to this agent
  "config": {
    "persona": { "text": "You are Krakey, an autonomous agent. Be concise and helpful." },
    "web": { "port": 7717 }
  }
}
```

`boot` starts an agent for every `agents/<id>/config.json` it finds.

## Development

```bash
npm test          # contract-derived edge tests (run via tsx)
npm run typecheck # tsc over contracts/ + packages/ + shared/
npm run build     # compile
```

The codebase is a tiny kernel (`packages/`) over a set of typed contracts (`contracts/`), with all
capabilities as plugins (`public_plugin/`). To add a capability, write a plugin — start with
[docs/PLUGIN_DEV.md](docs/PLUGIN_DEV.md). Contributions welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Samuel
