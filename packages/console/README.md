# console

The unified **Krakey Console** — one cockpit for your autonomous agents. It's a
standalone static loopback web server that serves a single shell: a persistent
top nav-bar plus a Dashboard landing that embeds the three Krakey web surfaces —
**Config** (config-web), **Chat** (the web chat channel), and **Inspector** —
each in an `<iframe>` by URL. Like `config-web`, it is fully decoupled from the
runtime.

The console holds **no secrets** and has **no API/token** — it serves only a
non-secret shell. It does not talk to your agents itself; it just frames the
surfaces that do.

## Run it

```bash
npm run console
```

Then open the URL printed on startup:

```
✦ Krakey Console: http://127.0.0.1:7716/
```

The surfaces must be running **separately** — the console only embeds them:

- **Config** — `npm run config:web` (defaults to `http://127.0.0.1:7717`).
- **Chat** and **Inspector** — these come up when the runtime boots agents that
  load those plugins (`npm start`); the web chat channel and the inspector each
  serve their own loopback port. Point the console at those ports via the env
  vars below.

An embedded surface whose app isn't running will simply show a blank/failed
iframe — that's expected. The console's own shell still loads.

### Environment

| Variable         | Default                 | Meaning                                                   |
| ---------------- | ----------------------- | -------------------------------------------------------- |
| `CONSOLE_PORT`   | `7716`                  | Port to bind (also `argv[2]`; `0` = ephemeral port)      |
| `CONSOLE_HOST`   | `127.0.0.1`             | Bind host (loopback by default)                          |
| `CONFIG_WEB_URL` | `http://127.0.0.1:7717` | URL of the **Config** surface (config-web)              |
| `WEB_CHAT_URL`   | `http://127.0.0.1:7718` | URL of the **Chat** surface (the web chat channel)      |
| `INSPECTOR_URL`  | `http://127.0.0.1:7719` | URL of the **Inspector** surface                         |

The server injects the three surface URLs into the served `index.html` as
`window.__SURFACES__ = { config, chat, inspector }`, and the shell points its
iframes at exactly those URLs — nothing is hardcoded.

### Config is token-gated

`config-web` is **token-gated**: it serves its shell to anyone on loopback, but
its `/api/*` calls require the session token. So embedding the bare
`http://127.0.0.1:7717` loads the Config shell but its API won't authenticate.
To use the embedded Config **fully**, set `CONFIG_WEB_URL` to include the token
that `config:web` printed, e.g.:

```bash
CONFIG_WEB_URL="http://127.0.0.1:7717/?token=<token>" npm run console
```

(Run `config:web` with a fixed `CONFIG_WEB_TOKEN` if you want a stable URL across
restarts.) Chat and Inspector follow their own auth rules — pass their tokens the
same way if they require one.

## Security

Loopback-bound by default. The console serves only a static shell that holds no
secrets, so there is no API or token on the console itself. Any tokens you put in
the surface URLs are only as exposed as those surfaces already are. Keep the host
on `127.0.0.1` unless you understand the exposure of binding a wider interface.
