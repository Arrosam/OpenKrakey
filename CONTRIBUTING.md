# Contributing to OpenKrakey

Thank you for considering a contribution. OpenKrakey is a small, deliberately constrained
codebase; its architecture is defended by a set of invariants (see
[ARCHITECTURE.md §9](ARCHITECTURE.md#9-invariants-anti-rot--test-enforced)). The most useful
thing you can do before writing code is to read those — a change that violates one will be asked
to evolve a contract rather than work around it.

## Development setup

> **Prerequisites:** Node.js **≥ 20** and npm.

```bash
git clone https://github.com/Arrosam/OpenKrakey.git
cd OpenKrakey
npm install
```

Common commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the contract-derived edge tests via **tsx** (`tests/**/*.test.ts`). |
| `npm run typecheck` | Runs `tsc --noEmit` over `contracts/` + `packages/` + `shared/`. |
| `npm run build` | Compiles with `tsc`. |
| `npm start` | Boots every configured Agent. |
| `npm run cli` | Opens the configuration wizard. |

**Tests are run via tsx and are *not* type-checked by `tsc`.** Do not run `tsc` to "check" a
plugin or test — it emits stray `.js` / `.d.ts` files next to your `.ts`. If any appear, delete
them before committing (`tsc` is scoped to `contracts/` + `packages/` + `shared/` for exactly
this reason).

## Repository map

| Directory | Contents |
|---|---|
| `contracts/` | **L1** — the only shared vocabulary (pure types + well-known event/action names). |
| `packages/` | Kernel module implementations (one directory per module). |
| `public_plugin/` | Bundled plugins (one directory per plugin). |
| `shared/` | Cross-cutting helpers (actions, config, logging, theme, …). |
| `tests/` | Edge tests, derived from contracts. |
| `docs/` | Documentation and the architecture-graph tooling. |

## The rules that matter

1. **Plugins talk only through the bus.** A plugin may import `contracts/*`, `shared/*`, and Node
   builtins — **never another plugin** or kernel internals. Inter-plugin calls go over the
   actionbus (R2).
2. **No domain behavior in the kernel.** No prompt construction, memory, model-selection logic, or
   tool implementations in `packages/`. Those are plugins. API keys never leave the core (R1).
3. **Single responsibility.** One module / plugin, one job (R4).
4. **Keep state per-Agent.** Mutable state lives in the plugin factory closure, never at module
   scope (R6).
5. **Tests precede / accompany behavior.** Write black-box edge tests derived from the *contract*,
   not the implementation.

If a contract is insufficient for what you want to build, **do not work around it** — that is how
the predecessor rotted. Open an issue to evolve the contract properly.

## Building a plugin

The full authoring guide is [docs/PLUGIN_DEV.md](docs/PLUGIN_DEV.md). The canonical worked
examples are `public_plugin/system-prompt/` (the simplest plugin), `public_plugin/web/` (a
tool + channel), and `public_plugin/krakeycode/` (a thorough toolkit with a complete test suite).

## Commits & pull requests

- Keep each commit a single logical unit with a clear, present-tense message
  (`area: short summary`, e.g. `web: fold tool results into the conversation block`).
- Ensure `npm test` and `npm run typecheck` pass, and that no stray `.js`/`.d.ts` were left behind.
- Describe the change and its rationale in the PR, and note which invariant(s) it touches, if any.

## Reporting bugs & proposing features

Use the issue templates under [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE). For security
issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
