# OpenKrakey — Config Console (design mock)

A **schema-driven** config-management web UI + onboarding wizard, built as a
static prototype for design review. No build step, no backend — open it and
click around.

## Run it

```bash
npx http-server design/config-ui-mock -p 4321 -c-1   # or: python -m http.server -d design/config-ui-mock 4321
# then open http://localhost:4321
```

Or just open `design/config-ui-mock/index.html` directly in a browser.

## What it demonstrates

1. **Onboarding that catches current features.** The guided wizard adds a
   **Capabilities** step (Welcome → AI service → **Capabilities** → Agent →
   Review) where you pick from *all nine* plugins — web chat, coding tools, web
   search, browser control, inspector, notes — the step today's CLI wizard skips.

2. **A config console that auto-fetches every setting.** `schema.js` mirrors the
   real OpenKrakey settings (extracted from `shared/config`, `packages/cli`, and
   each plugin's config reader). `app.js` renders controls *generically* from
   those descriptors — it has zero per-field knowledge. Add a field to the schema
   and it appears in the UI automatically.

## Control mapping (the review brief)

| Value shape | Control | Examples |
|---|---|---|
| multi-choice | **selection-pick** (chip grid, ◉/◯) | capabilities, input/output modalities, plugins |
| single-select (enumerable) | **dropdown** | provider type, AI service, krakeycode mode, safesearch |
| boolean | **toggle** | allowWrite, allowCommands, usePublicFallback, headless |
| free value | **input** | model, base URL (url), API key/token (secret), persona (textarea), context window / ports / timeouts (number) |
| free list | **tag input** | command allowlist, public instance pool |

The provider dropdown is **reactive**: switching provider type re-constrains the
capability/modality picks so the config can never name something the gateway
would reject — exactly like the CLI does today. Sandbox-only fields (root,
allowlist) appear/vanish with the mode dropdown.

## Files

- `index.html` — entry point (loads the two scripts)
- `schema.js` — the settings schema (source of truth the UI reads)
- `styles.css` — the "mission-control cockpit" theme (mint `#2FD69C`)
- `app.js` — generic control renderer + view router + wizard

## Status

Design mock for review only. Nothing here is wired to the real config files yet —
"Save" shows a toast and updates in-memory state. Once the design is signed off,
the real work (updating the `cli` node + adding a config web-UI node) goes through
the normal modular-dev flow.
