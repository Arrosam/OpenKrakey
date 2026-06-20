# Security Policy

OpenKrakey runs autonomous agents that hold credentials, execute tools, and (optionally) reach
the public internet. This document states the security model and how to report a vulnerability.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Instead, use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/Arrosam/OpenKrakey/security/advisories/new)**
(Security → Advisories → *Report a vulnerability*). If that is unavailable, contact the
maintainer ([@Arrosam](https://github.com/Arrosam)) privately.

Please include a description, affected version/commit, reproduction steps, and impact. You can
expect an acknowledgement and a coordinated disclosure timeline.

## Security model

### Credentials are confined to the core (R1)

API keys are read from `config/llm.json` by the **llm-gateway** and held inside a closure. Plugins
receive only a **key-less** `CommunicatorLibrary`: they call a communicator *by name* and never
see the key or the request wire-format. Never log, echo, or persist a key from a plugin — you do
not have it, and you should not reconstruct it.

Reference keys via environment variables (`"apiKey": "${ANTHROPIC_API_KEY}"`) rather than writing
secrets into the file. Your live `config/llm.json` is git-ignored.

### Treat inbound channel input as untrusted

A channel plugin (e.g. `web`) relays messages from outside the process. Treat that text as
**untrusted input**: it may attempt prompt injection to make the Agent misuse a tool. Tool
plugins should validate their parameters and fail safely; the `system-prompt` plugin's
monologue rule keeps the model's plain output from acting on its own — only an explicit tool call
has effect.

### Tool plugins — specific notes

- **`krakeycode`** grants the Agent computer access (read/write/edit files, run shell, list
  directories). It supports **local** and **sandbox** modes; run untrusted or experimental Agents
  in sandbox mode, and scope the working directory deliberately.
- **`searxng`** searches a SearXNG instance. **Endpoint policy:** if `instanceUrl` is set it is
  used; otherwise the plugin tries a local instance, and **otherwise falls back to a set of
  built-in public SearXNG instances.** This means that *by default, with no local instance, your
  queries are sent to third-party public services.* To keep search private, point `instanceUrl`
  at your own instance or set `usePublicFallback: false`.
- **`browser`** drives a managed Chrome over the DevTools Protocol. It is **read-only and
  non-interactive**: it navigates, reads pages, lists/activates tabs, and screenshots — it never
  clicks, types, or executes scripts. Still, navigation reaches arbitrary URLs; treat any content
  it returns as untrusted.

### Per-Agent isolation (R6)

One Agent's plugins, data, and events do not leak into another. The single explicit exception is
the **shared data of a public plugin**, which is shared by design across the Agents that load it.

## Supported versions

OpenKrakey is at an early (MVP) stage; security fixes are applied to the `main` branch. Pin to a
commit you have reviewed if you deploy it.
