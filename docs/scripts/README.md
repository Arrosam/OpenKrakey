# Architecture / dependency graph

A small dev tool that analyzes OpenKrakey's **code dependencies** and renders them as an
interactive graph. It parses every `.ts` under `contracts/`, `packages/`, and `shared/` with the
TypeScript compiler API and builds:

- a **folder → file → declaration → member** containment tree (interfaces, classes, type aliases,
  functions, and their members), plus
- **import** edges (file → resolved file),
- best-effort **ref** edges (a declaration uses an imported symbol),
- **external** edges (file → bare `node:` / npm module).

Ported from the predecessor project's architecture-graph tool to the TS stack.

## Usage

```bash
# one-shot: write a self-contained docs/arch-graph.html, then open it
npm run arch:graph

# live: serve at http://localhost:4178 and auto-rebuild on source changes (SSE)
npm run arch:serve          # PORT=… to change the port
```

In the viewer: drag nodes to rearrange · click a node for its signature/doc/path · double-click a
folder or file to fold it · toggle **imports / refs / externals** · search by name. Colors:
file (blue) · interface (mint) · class (purple) · function (green) · type (amber) · external (grey).

`build-arch-graph.ts` exports `buildGraph()` / `renderHtml()` (reused by the server). The generated
`docs/arch-graph.html` is gitignored. No new runtime dependency — Cytoscape.js loads from a CDN in the
page; parsing uses the already-installed `typescript`.
