# Node: cli

## Purpose
A standalone **config-file management tool** (a User Interface) — the convenient way to create/edit
Agent config files (in the right format) and the Default Plugin Setting. Decoupled from the runtime;
a user could hand-edit the files instead. Shows the Krakey ASCII logo.

## Zone
core

## Implements contracts
None.

## Depends on contracts
- `agent` — produces/edits `AgentDefinition` files.
- (Uses shared `config` for paths + the `DefaultAgentSetting` shape.)

## Exposed interface
- `createCli(deps: { agentsDir, defaultPath, out, io? }): Cli` with `handleLine(line)` / `start()` / `stop()`.
- Commands (indicative): `/new <id>` (copy the Default Plugin Setting → `agents/<id>/config.json`),
  `/default` (show/edit the default), `/list`, `/edit <id> ...`, `/rm <id>`, `/help`.

## Internal structure
A readline REPL printing the Krakey logo on start. Reads/writes JSON config files under `agents/<id>/`
and `config/agent.default.json`. `handleLine` is the testable core (pure-ish over an injected `out`
and fs). It manages files only — it does NOT run or talk to live agents.

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
