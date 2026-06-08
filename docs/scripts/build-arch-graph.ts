/**
 * build-arch-graph — analyze OpenKrakey's code dependencies.
 *
 * Walks the TS source (contracts/ + packages/ + shared/), parses each file with
 * the TypeScript compiler API (the TS counterpart of Python's `ast`), and builds
 * a Cytoscape-shaped `{ nodes, edges }` graph:
 *   - a folder → file → declaration → member CONTAINMENT tree (compound nodes), plus
 *   - `import` edges (file → resolved file),
 *   - best-effort `ref` edges (a declaration uses an imported symbol),
 *   - `external` edges (file → bare npm/node module).
 *
 * `renderHtml(graph)` wraps the payload into a self-contained, draggable,
 * expandable interactive page. `buildGraph()` is reused by the live-reload
 * server (serve-arch-graph.ts).
 *
 * Ported from the KrakeyBot architecture-graph tool (Python/ast) to TS.
 * Edge resolution is heuristic; dynamic dispatch is not tracked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** Source roots scanned for the dependency graph. */
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
type MemberKind = "method" | "property";

interface Member {
  name: string;
  kind: MemberKind;
  signature: string;
  line: number;
}
interface Decl {
  name: string;
  kind: DeclKind;
  signature: string;
  doc: string;
  line: number;
  members: Member[];
}
interface ImportRef {
  /** raw module specifier, e.g. "../../../contracts/clock" or "node:fs". */
  specifier: string;
  /** imported binding names (named + default + namespace alias). */
  names: string[];
}
interface FileInfo {
  rel: string;
  doc: string;
  decls: Decl[];
  imports: ImportRef[];
}

function jsDoc(node: ts.Node): string {
  const docs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const text = docs && docs.length ? ts.getTextOfJSDocComment(docs[docs.length - 1].comment) : "";
  return (text ?? "").trim();
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** A one-line signature: the node's text up to its body / terminator. */
function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  let t = node.getText(sf);
  const brace = t.indexOf("{");
  if (brace !== -1) t = t.slice(0, brace);
  t = t.replace(/\bexport\b\s*/, "").replace(/[;{]\s*$/, "");
  return t.replace(/\s+/g, " ").trim().slice(0, 200);
}

function memberName(m: ts.NamedDeclaration): string {
  return m.name ? m.name.getText() : "(anon)";
}

function extractFile(abs: string): FileInfo {
  const text = fs.readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const decls: Decl[] = [];
  const imports: ImportRef[] = [];

  // module-level doc = leading block comment of the file
  let fileDoc = "";
  const lead = ts.getLeadingCommentRanges(text, 0);
  if (lead && lead.length) {
    fileDoc = text
      .slice(lead[0].pos, lead[0].end)
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*?\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const names: string[] = [];
      const clause = st.importClause;
      if (clause) {
        if (clause.name) names.push(clause.name.text); // default import
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) names.push("*" + nb.name.text);
        else if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.push(el.name.text);
      }
      imports.push({ specifier: st.moduleSpecifier.text, names });
      continue;
    }

    if (ts.isInterfaceDeclaration(st)) {
      const members: Member[] = st.members.map((m) => ({
        name: memberName(m),
        kind: ts.isMethodSignature(m) ? "method" : "property",
        signature: signatureOf(m, sf),
        line: lineOf(m, sf),
      }));
      decls.push({ name: st.name.text, kind: "interface", signature: "interface " + st.name.text, doc: jsDoc(st), line: lineOf(st, sf), members });
    } else if (ts.isClassDeclaration(st) && st.name) {
      const members: Member[] = st.members
        .filter((m) => ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m))
        .map((m) => ({
          name: memberName(m as ts.NamedDeclaration),
          kind: ts.isPropertyDeclaration(m) ? "property" : "method",
          signature: signatureOf(m, sf),
          line: lineOf(m, sf),
        }));
      decls.push({ name: st.name.text, kind: "class", signature: "class " + st.name.text, doc: jsDoc(st), line: lineOf(st, sf), members });
    } else if (ts.isTypeAliasDeclaration(st)) {
      decls.push({ name: st.name.text, kind: "type", signature: signatureOf(st, sf), doc: jsDoc(st), line: lineOf(st, sf), members: [] });
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      decls.push({ name: st.name.text, kind: "function", signature: signatureOf(st, sf), doc: jsDoc(st), line: lineOf(st, sf), members: [] });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isIdentifier(d.name)) {
          decls.push({ name: d.name.text, kind: "function", signature: signatureOf(d, sf), doc: jsDoc(st), line: lineOf(d, sf), members: [] });
        }
      }
    }
  }

  return { rel: rel(abs), doc: fileDoc, decls, imports };
}

// ---------------- import resolution ----------------

/** Resolve a relative import specifier to a known file rel-path, or null. */
function resolveImport(fromRel: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null; // bare module → external
  const baseDir = path.posix.dirname(fromRel);
  const target = path.posix.normalize(path.posix.join(baseDir, specifier));
  for (const cand of [target + ".ts", target + "/index.ts", target]) {
    if (known.has(cand)) return cand;
  }
  return null;
}

// ---------------- graph build ----------------

interface CyNode {
  data: Record<string, unknown>;
}
interface CyEdge {
  data: Record<string, unknown>;
}
export interface ArchGraph {
  nodes: CyNode[];
  edges: CyEdge[];
  stats: Record<string, number>;
}

export function buildGraph(): ArchGraph {
  const files = collectFiles();
  const infos = files.map(extractFile);
  const known = new Set(infos.map((i) => i.rel));

  const nodes: CyNode[] = [];
  const edges: CyEdge[] = [];
  const seenNode = new Set<string>();
  const seenEdge = new Set<string>();

  const addNode = (data: Record<string, unknown>): void => {
    const id = data.id as string;
    if (seenNode.has(id)) return;
    seenNode.add(id);
    nodes.push({ data });
  };
  const addEdge = (source: string, target: string, kind: string): void => {
    if (source === target) return;
    const key = source + ">" + target + ":" + kind;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ data: { id: "e" + edges.length, source, target, kind } });
  };

  // folders (compound parents)
  const dirSet = new Set<string>();
  for (const i of infos) {
    let d = path.posix.dirname(i.rel);
    while (d && d !== ".") {
      dirSet.add(d);
      d = path.posix.dirname(d);
    }
  }
  for (const d of [...dirSet].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    const parent = path.posix.dirname(d);
    addNode({ id: d, label: d.split("/").pop() + "/", kind: "dir", parent: parent && parent !== "." ? parent : undefined, fullPath: d });
  }

  // files + decls + members
  const declNodeId = new Map<string, string>(); // `${rel}::${name}` → node id (same)
  for (const i of infos) {
    const dir = path.posix.dirname(i.rel);
    addNode({ id: i.rel, label: i.rel.split("/").pop(), kind: "file", parent: dir !== "." ? dir : undefined, fullPath: i.rel, doc: i.doc });
    for (const d of i.decls) {
      const did = i.rel + "::" + d.name;
      declNodeId.set(did, did);
      addNode({ id: did, label: d.name, kind: d.kind, parent: i.rel, signature: d.signature, doc: d.doc, fullPath: i.rel + ":" + d.line });
      for (const m of d.members) {
        addNode({ id: did + "." + m.name, label: m.name, kind: m.kind, parent: did, signature: m.signature, fullPath: i.rel + ":" + m.line });
      }
    }
  }

  // import edges (file→file) + external nodes + ref edges
  let externals = 0;
  let importEdges = 0;
  let refEdges = 0;
  for (const i of infos) {
    // map imported name → resolved target file rel
    const nameTarget = new Map<string, string>();
    for (const imp of i.imports) {
      const tgt = resolveImport(i.rel, imp.specifier, known);
      if (tgt) {
        addEdge(i.rel, tgt, "import");
        importEdges++;
        for (const n of imp.names) nameTarget.set(n.replace(/^\*/, ""), tgt);
      } else if (!imp.specifier.startsWith(".")) {
        const extId = "ext:" + imp.specifier;
        addNode({ id: "externals", label: "external", kind: "extgroup", fullPath: "external modules" });
        addNode({ id: extId, label: imp.specifier, kind: "external", parent: "externals", fullPath: imp.specifier });
        addEdge(i.rel, extId, "external");
        externals++;
      }
    }
    // best-effort ref edges: a decl that uses an imported name → that symbol's decl (or its file)
    if (nameTarget.size === 0) continue;
    const fileAbs = path.join(ROOT, i.rel);
    const sf = ts.createSourceFile(fileAbs, fs.readFileSync(fileAbs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declStmts = sf.statements.filter(
      (s) => ts.isInterfaceDeclaration(s) || (ts.isClassDeclaration(s) && s.name) || ts.isTypeAliasDeclaration(s) || (ts.isFunctionDeclaration(s) && s.name) || ts.isVariableStatement(s),
    );
    for (const st of declStmts) {
      const declName = declNameOf(st);
      if (!declName) continue;
      const srcId = i.rel + "::" + declName;
      const used = new Set<string>();
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && nameTarget.has(n.text)) used.add(n.text);
        ts.forEachChild(n, visit);
      };
      visit(st);
      for (const name of used) {
        const tgtFile = nameTarget.get(name)!;
        const symId = tgtFile + "::" + name;
        const target = declNodeId.has(symId) ? symId : tgtFile;
        if (addRef(srcId, target)) refEdges++;
      }
    }
  }

  function addRef(src: string, tgt: string): boolean {
    if (!seenNode.has(src) || !seenNode.has(tgt) || src === tgt) return false;
    const before = seenEdge.size;
    addEdge(src, tgt, "ref");
    return seenEdge.size > before;
  }

  const stats = {
    files: infos.length,
    declarations: nodes.filter((n) => ["interface", "class", "type", "function"].includes(n.data.kind as string)).length,
    imports: importEdges,
    refs: refEdges,
    externals,
  };
  return { nodes, edges, stats };
}

function declNameOf(st: ts.Statement): string | null {
  if (ts.isInterfaceDeclaration(st) || (ts.isClassDeclaration(st) && st.name) || ts.isTypeAliasDeclaration(st) || (ts.isFunctionDeclaration(st) && st.name)) {
    return (st as ts.InterfaceDeclaration).name.text;
  }
  if (ts.isVariableStatement(st)) {
    const d = st.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.name.text;
  }
  return null;
}

// ---------------- HTML rendering ----------------

export function renderHtml(graph: ArchGraph, live = false): string {
  const payload = JSON.stringify({ elements: { nodes: graph.nodes, edges: graph.edges }, stats: graph.stats });
  return HTML_SHELL.replace("__GRAPH__", payload).replace("__LIVE__", live ? "true" : "false");
}

const HTML_SHELL = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenKrakey — Architecture Graph</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#c9d1d9;--mut:#8b949e;--mint:#2fd69c}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
#cy{position:absolute;inset:0;left:300px}
#side{position:absolute;top:0;left:0;bottom:0;width:300px;background:var(--panel);border-right:1px solid var(--line);padding:14px;overflow:auto}
h1{font-size:15px;margin:0 0 2px;color:var(--mint)}.sub{color:var(--mut);font-size:11px;margin-bottom:12px}
.btn{display:inline-block;cursor:pointer;background:#21262d;border:1px solid var(--line);color:var(--text);padding:4px 8px;border-radius:6px;margin:2px 2px 2px 0;font-size:12px}
.btn:hover{border-color:var(--mint)}.btn.on{border-color:var(--mint);color:var(--mint)}
input{width:100%;background:#0d1117;border:1px solid var(--line);color:var(--text);padding:6px 8px;border-radius:6px;margin:6px 0}
.leg{margin-top:12px}.leg div{display:flex;align-items:center;gap:8px;margin:3px 0;color:var(--mut)}.dot{width:11px;height:11px;border-radius:3px;flex:0 0 auto}
#info{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}#info .nm{color:var(--mint);font-weight:bold;word-break:break-all}
#info .kd{color:var(--mut);font-size:11px}#info .sg{background:#0d1117;border:1px solid var(--line);border-radius:6px;padding:6px;margin-top:6px;white-space:pre-wrap;word-break:break-word}
#info .dc{color:var(--mut);margin-top:6px}.hint{color:var(--mut);font-size:11px;margin-top:10px}
</style></head><body>
<div id="side">
  <h1>OpenKrakey</h1><div class="sub" id="stats">architecture graph</div>
  <input id="q" placeholder="search node…" autocomplete="off">
  <div>
    <span class="btn" id="b-fit">fit</span><span class="btn" id="b-relayout">re-layout</span>
    <span class="btn on" id="b-import">imports</span><span class="btn" id="b-ref">refs</span>
    <span class="btn" id="b-ext">externals</span><span class="btn" id="b-collapse">collapse files</span>
  </div>
  <div class="leg" id="legend"></div>
  <div id="info"><div class="kd">click a node for details · drag to move · double-click a folder/file to fold</div></div>
  <div class="hint" id="livehint"></div>
</div>
<div id="cy"></div>
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script src="https://unpkg.com/layout-base@2.0.1/layout-base.js"></script>
<script src="https://unpkg.com/cose-base@2.2.0/cose-base.js"></script>
<script src="https://unpkg.com/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
<script>
var DATA = __GRAPH__, LIVE = __LIVE__;
var COLORS = {dir:"#394150",file:"#3b6ea5",interface:"#2fd69c",class:"#a371f7",type:"#e3a008",function:"#3fb950",method:"#8b949e",property:"#6e7681",external:"#484f58",extgroup:"#21262d"};
var cy;
function styleArr(){return [
  {selector:"node",style:{"label":"data(label)","color":"#c9d1d9","font-family":"ui-monospace,monospace","font-size":"10px","text-valign":"center","text-halign":"center","background-color":function(e){return COLORS[e.data("kind")]||"#888"},"border-width":0,"shape":"round-rectangle","width":"label","height":"18px","padding":"6px","text-max-width":"160px"}},
  {selector:":parent",style:{"background-opacity":0.10,"background-color":function(e){return COLORS[e.data("kind")]||"#888"},"border-width":1,"border-color":function(e){return COLORS[e.data("kind")]||"#888"},"text-valign":"top","text-halign":"center","font-size":"11px","color":"#8b949e","padding":"10px","shape":"round-rectangle"}},
  {selector:'node[kind="interface"],node[kind="class"],node[kind="function"],node[kind="type"]',style:{"color":"#0d1117","font-weight":"bold"}},
  {selector:"edge",style:{"width":1,"curve-style":"bezier","target-arrow-shape":"triangle","arrow-scale":0.8,"opacity":0.6}},
  {selector:'edge[kind="import"]',style:{"line-color":"#3b6ea5","target-arrow-color":"#3b6ea5"}},
  {selector:'edge[kind="ref"]',style:{"line-color":"#6e7681","target-arrow-color":"#6e7681","line-style":"dashed","opacity":0.4}},
  {selector:'edge[kind="external"]',style:{"line-color":"#30363d","target-arrow-color":"#30363d","line-style":"dotted","opacity":0.35}},
  {selector:".dim",style:{"opacity":0.08}},{selector:".hl",style:{"border-width":3,"border-color":"#2fd69c","opacity":1}},
  {selector:".hidden",style:{"display":"none"}}
];}
function layout(){var l;try{l=cy.layout({name:"fcose",quality:"default",animate:false,nodeSeparation:75,packComponents:true,nestingFactor:0.1,idealEdgeLength:70});}catch(e){l=cy.layout({name:"cose",animate:false});}l.run();}
function build(data){
  if(cy)cy.destroy();
  cy=cytoscape({container:document.getElementById("cy"),elements:data.elements,style:styleArr(),wheelSensitivity:0.25,minZoom:0.1,maxZoom:3});
  layout();
  var s=data.stats;document.getElementById("stats").textContent=s.files+" files · "+s.declarations+" decls · "+s.imports+" imports · "+s.refs+" refs";
  var lastTap={id:null,t:0};
  cy.on("tap","node",function(ev){var n=ev.target,now=Date.now();if(lastTap.id===n.id()&&now-lastTap.t<300){if(n.isParent()){n.descendants().toggleClass("hidden");layout();}lastTap.t=0;return;}lastTap={id:n.id(),t:now};showInfo(n);});
  applyToggles();
}
function showInfo(n){
  var d=n.data(),h='<div class="nm">'+esc(d.label||d.id)+'</div><div class="kd">'+esc(d.kind)+(d.fullPath?" · "+esc(d.fullPath):"")+'</div>';
  if(d.signature)h+='<div class="sg">'+esc(d.signature)+'</div>';
  if(d.doc)h+='<div class="dc">'+esc(d.doc)+'</div>';
  var ind=n.incomers("edge").length,outd=n.outgoers("edge").length;
  h+='<div class="kd" style="margin-top:8px">→ depends on '+outd+' · ← used by '+ind+'</div>';
  document.getElementById("info").innerHTML=h;
  cy.elements().removeClass("hl dim");cy.elements().addClass("dim");
  var nb=n.closedNeighborhood().union(n.connectedEdges());nb.removeClass("dim");n.addClass("hl");
}
function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
var show={import:true,ref:false,external:false};
function applyToggles(){
  cy.batch(function(){
    cy.edges().forEach(function(e){var k=e.data("kind");e.toggleClass("hidden",!show[k]);});
    cy.nodes('[kind="external"],[kind="extgroup"]').toggleClass("hidden",!show.external);
  });
}
function tog(id,key){var b=document.getElementById(id);b.onclick=function(){show[key]=!show[key];b.classList.toggle("on",show[key]);applyToggles();};}
window.addEventListener("DOMContentLoaded",function(){
  var L=document.getElementById("legend"),order=["file","interface","class","function","type","method","external"];
  L.innerHTML=order.map(function(k){return '<div><span class="dot" style="background:'+COLORS[k]+'"></span>'+k+'</div>';}).join("");
  document.getElementById("b-fit").onclick=function(){cy.fit(undefined,40);};
  document.getElementById("b-relayout").onclick=layout;
  tog("b-import","import");tog("b-ref","ref");tog("b-ext","external");
  document.getElementById("b-collapse").onclick=function(){cy.nodes('[kind="file"]').forEach(function(f){f.descendants().toggleClass("hidden");});layout();};
  var q=document.getElementById("q");q.oninput=function(){var v=q.value.toLowerCase();cy.elements().removeClass("hl dim");if(!v)return;cy.nodes().forEach(function(n){if((n.data("label")||"").toLowerCase().indexOf(v)>=0)n.addClass("hl");});};
  build(DATA);
  if(LIVE){document.getElementById("livehint").textContent="● live — watching source";var es=new EventSource("/events");es.onmessage=function(ev){fetch("/graph.json").then(function(r){return r.json();}).then(function(g){build(g);});};}
});
</script></body></html>`;

// ---------------- CLI ----------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const graph = buildGraph();
  const outDir = path.join(ROOT, "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "arch-graph.html");
  fs.writeFileSync(out, renderHtml(graph), "utf8");
  console.log(
    `arch-graph: ${graph.stats.files} files, ${graph.stats.declarations} declarations, ` +
      `${graph.stats.imports} imports, ${graph.stats.refs} refs, ${graph.stats.externals} external edges`,
  );
  console.log("wrote " + path.relative(ROOT, out) + "  (open it in a browser, or run `npm run arch:serve`)");
}
