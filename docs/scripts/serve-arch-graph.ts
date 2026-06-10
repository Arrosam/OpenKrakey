/**
 * serve-arch-graph — live-reload viewer for the OpenKrakey dependency graph.
 *
 * Serves the interactive page on http://localhost:<PORT>, rebuilds the graph
 * in-memory whenever a watched source file changes (contracts/ + packages/ +
 * shared/), and pushes a refresh to the browser over Server-Sent Events. The
 * page re-fetches `/graph.json` and re-renders without a full reload.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { buildGraph, renderHtml, ROOT, type ArchGraph } from "./build-arch-graph";

const PORT = Number(process.env.PORT) || 4178;
const WATCH = ["contracts", "packages", "shared"];

let graph: ArchGraph = buildGraph();
const graphJson = (): string =>
  JSON.stringify({ elements: { nodes: graph.nodes, edges: graph.edges }, stats: graph.stats });

const clients = new Set<http.ServerResponse>();

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/" || url.startsWith("/index")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHtml(graph, true));
  } else if (url.startsWith("/graph.json")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(graphJson());
  } else if (url.startsWith("/events")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

function broadcast(): void {
  for (const c of clients) {
    try {
      c.write("data: changed\n\n");
    } catch {
      clients.delete(c);
    }
  }
}

let timer: NodeJS.Timeout | null = null;
function onChange(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      graph = buildGraph();
      console.log(`rebuilt: ${graph.stats.files} files · ${graph.stats.declarations} decls · ${graph.stats.imports} imports`);
      broadcast();
    } catch (err) {
      console.error("rebuild failed:", err);
    }
  }, 150);
}

function watch(): void {
  for (const d of WATCH) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    try {
      fs.watch(abs, { recursive: true }, (_e, file) => {
        if (!file || (file.toString().endsWith(".ts") && !file.toString().endsWith(".d.ts"))) onChange();
      });
    } catch {
      // recursive watch unsupported (some platforms) — fall back to a shallow watch.
      fs.watch(abs, (_e, file) => {
        if (!file || file.toString().endsWith(".ts")) onChange();
      });
    }
  }
}

server.listen(PORT, "127.0.0.1", () => {
  watch();
  console.log(`OpenKrakey arch graph → http://localhost:${PORT}  (live; Ctrl+C to stop)`);
  console.log(`  ${graph.stats.files} files · ${graph.stats.declarations} decls · ${graph.stats.imports} imports`);
});
