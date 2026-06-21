# config-web

A standalone **web config tool** for OpenKrakey — a sibling of the `cli`, fully
decoupled from the runtime. It serves a single-page console plus a loopback JSON
API that reads and writes the **same config files the `cli` edits**
(`config/llm.json`, `config/agent.default.json`, `agents/<id>/config.json`), and
auto-renders every plugin's settings from the plugins' self-described schemas
(`public_plugin/*/config-schema.ts`) — no per-setting code in the UI.

## Run it

```bash
npm run config:web
```

Then open the URL printed on startup:

```
✦ Config console: http://127.0.0.1:7717/?token=<token>
```

The page plants an HttpOnly session cookie from that token, so once it is open
its API calls authenticate without a token in the URL.

### Environment

| Variable           | Default       | Meaning                                        |
| ------------------ | ------------- | ---------------------------------------------- |
| `CONFIG_WEB_PORT`  | `7717`        | Port to bind (also `argv[2]`; `0` = ephemeral) |
| `CONFIG_WEB_HOST`  | `127.0.0.1`   | Bind host (loopback by default)                |
| `CONFIG_WEB_TOKEN` | random        | Session token; a fresh random one each run if unset |

## Security

Loopback-bound and **token-gated**. The API is **closed when no token is set**:
every `/api/*` request must present the token via the cookie, a `?token=` query
param, or an `Authorization: Bearer` header. Keep the host on `127.0.0.1` unless
you understand the exposure of binding a wider interface.

## Notes

- Changes take effect **on the next `npm start`** — this tool only edits files; it
  does not touch a running Agent.
- Don't run this and the `cli` against the same directory simultaneously; they
  write the same files and a concurrent edit can clobber the other's write.
