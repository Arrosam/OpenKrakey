# Code-dependency graph

A small dev tool that analyzes OpenKrakey's **code dependencies** and renders them as an interactive
graph. It parses every `.ts` under `contracts/`, `packages/`, and `shared/` with the TypeScript
compiler API and builds a **file-level dependency graph**:

- folders as compound boxes, **files** as nodes inside them,
- **import** edges (file → resolved file) — the dependency structure,
- **external** edges (file → bare `node:` / npm module; toggle on),

…with each file's **declarations** (interfaces / classes / functions / types + signatures) shown in the
side panel when you click it — so the graph stays at the readable file/module altitude instead of
exploding to every property.

## Usage

```bash
npm run arch:graph    # write a self-contained docs/arch-graph.html, then open it
npm run arch:serve    # serve at http://localhost:4178 and auto-rebuild on source changes (PORT= to change)
```

In the viewer, folders start **collapsed** (the top-level `contracts` / `packages` / `shared`). When
several same-direction imports connect the same two boxes they **merge into a single arrow** that
**thickens with** — and is **labelled by** — the number of imports it stands for (e.g. one
`packages → contracts` arrow marked *23*), so collapsing never produces a bundle of overlapping
curves. **Double-click a folder** to expand/collapse it (or use *collapse all* / *expand all*); the
merged counts re-compute at every level (expanding `packages` splits its *23* into `loader → contracts`
*6*, `orchestrator → contracts` *5*, …). **Click a node** to focus its dependency neighbourhood — the file plus what it imports
and what imports it stay lit, everything unrelated fades — and see its path, import counts
(↓ imports / ↑ imported by), doc, and declaration list in the panel. **Right-drag** to pan, **scroll**
to zoom, **search** by file name, **externals** toggles `node:`/npm modules. Colors: file (blue) ·
folder (grey) · external (grey) · and in the panel, interface (mint) · class (purple) · function
(green) · type (amber).

`build-arch-graph.ts` exports `buildGraph()` / `renderHtml()` (reused by the server). The generated
`docs/arch-graph.html` is gitignored. No new runtime dependency — Cytoscape.js loads from a CDN in the
page; parsing uses the already-installed `typescript`. (Needs network for the CDN the first time.)
