/**
 * build-arch-graph — analyze OpenKrakey's code dependencies.
 *
 * Walks the TS source (contracts/ + packages/ + shared/), parses each file with
 * the TypeScript compiler API, and builds a Cytoscape-shaped `{ nodes, edges }`
 * dependency graph: folders (compound) → files, with `import` edges (file → file)
 * and `external` edges (file → bare npm/node module). Each file carries its
 * declarations (interfaces / classes / functions / types + signatures) as data,
 * shown in the side panel on click — so the graph stays at the readable file/
 * module altitude instead of exploding to every property.
 *
 * `renderHtml(graph)` wraps it into a self-contained interactive page.
 * `buildGraph()` is reused by the live-reload server (serve-arch-graph.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const SRC_DIRS = ["contracts", "packages", "shared"];
const SKIP_DIRS = new Set(["node_modules", ".dist", ".git", "data", "tests"]);

// ---------------- file collection ----------------

function collectFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full);
    }
  };
  for (const d of SRC_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join("/");

// ---------------- per-file extraction ----------------

type DeclKind = "interface" | "class" | "type" | "function";
interface Decl {
  name: string;
  kind: DeclKind;
  signature: string;
  doc: string;
  line: number;
}
interface FileInfo {
  rel: string;
  doc: string;
  decls: Decl[];
  imports: string[]; // raw module specifiers
}

function jsDoc(node: ts.Node): string {
  const docs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const text = docs && docs.length ? ts.getTextOfJSDocComment(docs[docs.length - 1].comment) : "";
  return (text ?? "").trim();
}
function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  let t = node.getText(sf);
  const brace = t.indexOf("{");
  if (brace !== -1) t = t.slice(0, brace);
  return t.replace(/\bexport\b\s*/, "").replace(/[;{]\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function extractFile(abs: string): FileInfo {
  const text = fs.readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decls: Decl[] = [];
  const imports: string[] = [];

  let fileDoc = "";
  const lead = ts.getLeadingCommentRanges(text, 0);
  if (lead && lead.length) {
    fileDoc = text.slice(lead[0].pos, lead[0].end).replace(/^\/\*\*?/, "").replace(/\*\/$/, "")
      .split("\n").map((l) => l.replace(/^\s*\*?\s?/, "")).join(" ").replace(/\s+/g, " ").trim();
  }

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      imports.push(st.moduleSpecifier.text);
    } else if (ts.isInterfaceDeclaration(st)) {
      decls.push({ name: st.name.text, kind: "interface", signature: "interface " + st.name.text + " { " + st.members.map((m) => signatureOf(m, sf)).join("; ") + " }", doc: jsDoc(st), line: lineOf(st, sf) });
    } else if (ts.isClassDeclaration(st) && st.name) {
      decls.push({ name: st.name.text, kind: "class", signature: "class " + st.name.text, doc: jsDoc(st), line: lineOf(st, sf) });
    } else if (ts.isTypeAliasDeclaration(st)) {
      decls.push({ name: st.name.text, kind: "type", signature: signatureOf(st, sf), doc: jsDoc(st), line: lineOf(st, sf) });
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      decls.push({ name: st.name.text, kind: "function", signature: signatureOf(st, sf), doc: jsDoc(st), line: lineOf(st, sf) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isIdentifier(d.name)) {
          decls.push({ name: d.name.text, kind: "function", signature: signatureOf(d, sf), doc: jsDoc(st), line: lineOf(d, sf) });
        }
      }
    }
  }
  return { rel: rel(abs), doc: fileDoc, decls, imports };
}

// ---------------- import resolution ----------------

function resolveImport(fromRel: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const cand of [target + ".ts", target + "/index.ts", target]) if (known.has(cand)) return cand;
  return null;
}

// ---------------- graph build ----------------

export interface ArchGraph {
  nodes: { data: Record<string, unknown> }[];
  edges: { data: Record<string, unknown> }[];
  stats: Record<string, number>;
}

export function buildGraph(): ArchGraph {
  const infos = collectFiles().map(extractFile);
  const known = new Set(infos.map((i) => i.rel));
  const nodes: { data: Record<string, unknown> }[] = [];
  const edges: { data: Record<string, unknown> }[] = [];
  const seenNode = new Set<string>();
  const seenEdge = new Set<string>();
  const addNode = (data: Record<string, unknown>): void => { const id = data.id as string; if (!seenNode.has(id)) { seenNode.add(id); nodes.push({ data }); } };
  const addEdge = (source: string, target: string, kind: string): void => {
    if (source === target) return;
    const key = source + ">" + target + ":" + kind;
    if (!seenEdge.has(key)) { seenEdge.add(key); edges.push({ data: { id: "e" + edges.length, source, target, kind } }); }
  };

  // folders (compound parents)
  const dirSet = new Set<string>();
  for (const i of infos) { let d = path.posix.dirname(i.rel); while (d && d !== ".") { dirSet.add(d); d = path.posix.dirname(d); } }
  for (const d of [...dirSet].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    const parent = path.posix.dirname(d);
    addNode({ id: d, label: d.split("/").pop() + "/", kind: "dir", parent: parent && parent !== "." ? parent : undefined, fullPath: d });
  }

  // files (leaf nodes carrying their declarations as data for the side panel)
  for (const i of infos) {
    const dir = path.posix.dirname(i.rel);
    addNode({ id: i.rel, label: i.rel.split("/").pop(), kind: "file", parent: dir !== "." ? dir : undefined, fullPath: i.rel, doc: i.doc, decls: i.decls });
  }

  // import edges (file -> file) + external nodes/edges
  let importEdges = 0;
  let externals = 0;
  for (const i of infos) {
    for (const spec of i.imports) {
      const tgt = resolveImport(i.rel, spec, known);
      if (tgt) { addEdge(i.rel, tgt, "import"); importEdges++; }
      else if (!spec.startsWith(".")) {
        addNode({ id: "externals", label: "external", kind: "extgroup", fullPath: "external modules" });
        addNode({ id: "ext:" + spec, label: spec, kind: "external", parent: "externals", fullPath: spec });
        addEdge(i.rel, "ext:" + spec, "external");
        externals++;
      }
    }
  }

  return {
    nodes,
    edges,
    stats: { files: infos.length, declarations: infos.reduce((n, i) => n + i.decls.length, 0), imports: importEdges, externals },
  };
}

// ---------------- HTML rendering ----------------

export function renderHtml(graph: ArchGraph, live = false): string {
  const payload = JSON.stringify({ elements: { nodes: graph.nodes, edges: graph.edges }, stats: graph.stats });
  return HTML_SHELL.replace("__GRAPH__", payload).replace("__LIVE__", live ? "true" : "false");
}

const HTML_SHELL = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenKrakey — Dependency Graph</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#c9d1d9;--mut:#8b949e;--mint:#2fd69c}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
#cy{position:absolute;inset:0;left:320px}
#side{position:absolute;top:0;left:0;bottom:0;width:320px;background:var(--panel);border-right:1px solid var(--line);padding:14px;overflow:auto}
h1{font-size:15px;margin:0 0 2px;color:var(--mint)}.sub{color:var(--mut);font-size:11px;margin-bottom:12px}
.btn{display:inline-block;cursor:pointer;background:#21262d;border:1px solid var(--line);color:var(--text);padding:4px 8px;border-radius:6px;margin:2px 2px 2px 0;font-size:12px}
.btn:hover{border-color:var(--mint)}.btn.on{border-color:var(--mint);color:var(--mint)}
input{width:100%;background:#0d1117;border:1px solid var(--line);color:var(--text);padding:6px 8px;border-radius:6px;margin:6px 0}
.leg{margin-top:12px}.leg div{display:flex;align-items:center;gap:8px;margin:3px 0;color:var(--mut)}.dot{width:11px;height:11px;border-radius:3px;flex:0 0 auto}
#info{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}#info .nm{color:var(--mint);font-weight:bold;word-break:break-all}
#info .kd{color:var(--mut);font-size:11px}#info .dc{color:var(--mut);margin-top:6px}
.decl{margin-top:6px;padding:5px 7px;background:#0d1117;border:1px solid var(--line);border-radius:6px}
.decl b{color:var(--text)}.decl .sg{color:var(--mut);font-size:11px;white-space:pre-wrap;word-break:break-word;margin-top:2px}
.hint{color:var(--mut);font-size:11px;margin-top:10px}
</style></head><body>
<div id="side">
  <h1>OpenKrakey</h1><div class="sub" id="stats">dependency graph</div>
  <input id="q" placeholder="search file…" autocomplete="off">
  <div><span class="btn" id="b-fit">fit</span><span class="btn" id="b-relayout">re-layout</span><span class="btn" id="b-ext">externals</span></div>
  <div class="leg" id="legend"></div>
  <div id="info"><div class="kd">click a file for its declarations · drag to move · scroll to zoom</div></div>
  <div class="hint" id="livehint"></div>
</div>
<div id="cy"></div>
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script src="https://unpkg.com/layout-base@2.0.1/layout-base.js"></script>
<script src="https://unpkg.com/cose-base@2.2.0/cose-base.js"></script>
<script src="https://unpkg.com/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
<script>
var DATA = __GRAPH__, LIVE = __LIVE__;
var COLORS = {dir:"#30363d",file:"#3b6ea5",external:"#484f58",extgroup:"#21262d",interface:"#2fd69c",class:"#a371f7",function:"#3fb950",type:"#e3a008"};
var cy;
function styleArr(){return [
  {selector:"node",style:{"label":"data(label)","color":"#0d1117","font-family":"ui-monospace,monospace","font-size":"11px","font-weight":"bold","text-valign":"center","text-halign":"center","background-color":function(e){return COLORS[e.data("kind")]||"#888"},"border-width":0,"shape":"round-rectangle","width":"label","height":"22px","padding":"7px","text-max-width":"220px"}},
  {selector:'node[kind="file"]',style:{"color":"#dbe6f2"}},
  {selector:":parent",style:{"background-opacity":0.08,"background-color":"#8b949e","border-width":1,"border-color":"#30363d","text-valign":"top","color":"#8b949e","font-weight":"normal","padding":"12px","shape":"round-rectangle"}},
  {selector:'node[kind="external"]',style:{"color":"#c9d1d9","font-weight":"normal","font-size":"10px"}},
  {selector:"edge",style:{"width":1.2,"curve-style":"bezier","target-arrow-shape":"triangle","arrow-scale":0.85,"opacity":0.65}},
  {selector:'edge[kind="import"]',style:{"line-color":"#3b6ea5","target-arrow-color":"#3b6ea5"}},
  {selector:'edge[kind="external"]',style:{"line-color":"#30363d","target-arrow-color":"#30363d","line-style":"dotted","opacity":0.4}},
  {selector:".dim",style:{"opacity":0.1}},{selector:".hl",style:{"border-width":3,"border-color":"#2fd69c","opacity":1}},
  {selector:".hidden",style:{"display":"none"}}
];}
function layout(){var l;try{l=cy.layout({name:"fcose",quality:"proof",animate:false,nodeSeparation:110,packComponents:true,nestingFactor:0.6,idealEdgeLength:95,gravity:0.3,gravityCompound:1.4});}catch(e){l=cy.layout({name:"cose",animate:false});}l.run();}
function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
function build(data){
  if(cy)cy.destroy();
  cy=cytoscape({container:document.getElementById("cy"),elements:data.elements,style:styleArr(),minZoom:0.08,maxZoom:3});
  layout();
  var s=data.stats;document.getElementById("stats").textContent=s.files+" files · "+s.declarations+" decls · "+s.imports+" imports · "+s.externals+" ext";
  cy.on("tap","node",function(ev){showInfo(ev.target);});
  cy.on("tap",function(ev){if(ev.target===cy){cy.elements().removeClass("hl dim");}});
  applyExt();
}
function showInfo(n){
  var d=n.data(),h='<div class="nm">'+esc(d.fullPath||d.label||d.id)+'</div><div class="kd">'+esc(d.kind)+' · ↓ imports '+n.outgoers('edge[kind="import"]').length+' · ↑ imported by '+n.incomers('edge[kind="import"]').length+'</div>';
  if(d.doc)h+='<div class="dc">'+esc(d.doc)+'</div>';
  var decls=d.decls||[];
  if(decls.length){h+='<div class="kd" style="margin-top:8px">'+decls.length+' declaration(s):</div>';
    decls.forEach(function(x){h+='<div class="decl"><b style="color:'+(COLORS[x.kind]||"#fff")+'">'+esc(x.kind)+'</b> <b>'+esc(x.name)+'</b><div class="sg">'+esc(x.signature)+'</div></div>';});}
  document.getElementById("info").innerHTML=h;
  cy.elements().addClass("dim").removeClass("hl");
  n.closedNeighborhood().union(n.connectedEdges()).removeClass("dim");n.addClass("hl");
}
var showExt=false;
function applyExt(){cy.batch(function(){cy.nodes('[kind="external"],[kind="extgroup"]').toggleClass("hidden",!showExt);cy.edges('[kind="external"]').toggleClass("hidden",!showExt);});}
window.addEventListener("DOMContentLoaded",function(){
  var L=document.getElementById("legend");L.innerHTML=[["file","file"],["dir","folder"],["external","external"],["interface","interface"],["class","class"],["function","function"],["type","type"]].map(function(k){return '<div><span class="dot" style="background:'+COLORS[k[0]]+'"></span>'+k[1]+'</div>';}).join("");
  document.getElementById("b-fit").onclick=function(){cy.fit(undefined,40);};
  document.getElementById("b-relayout").onclick=layout;
  var be=document.getElementById("b-ext");be.onclick=function(){showExt=!showExt;be.classList.toggle("on",showExt);applyExt();if(showExt)layout();};
  var q=document.getElementById("q");q.oninput=function(){var v=q.value.toLowerCase();cy.elements().removeClass("hl dim");if(!v)return;cy.elements().addClass("dim");cy.nodes().forEach(function(n){if((n.data("label")||"").toLowerCase().indexOf(v)>=0){n.removeClass("dim").addClass("hl");n.connectedEdges().removeClass("dim");}});};
  build(DATA);
  if(LIVE){document.getElementById("livehint").textContent="● live — watching source";var es=new EventSource("/events");es.onmessage=function(){fetch("/graph.json").then(function(r){return r.json();}).then(build);};}
});
</script></body></html>`;

// ---------------- CLI ----------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const graph = buildGraph();
  fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
  const out = path.join(ROOT, "docs", "arch-graph.html");
  fs.writeFileSync(out, renderHtml(graph), "utf8");
  console.log(`arch-graph: ${graph.stats.files} files, ${graph.stats.declarations} declarations, ${graph.stats.imports} imports, ${graph.stats.externals} external edges`);
  console.log("wrote " + path.relative(ROOT, out) + "  (open it, or run `npm run arch:serve`)");
}
