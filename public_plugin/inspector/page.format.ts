/**
 * inspector/page.format.ts — pure render helper shared by the served dashboard
 * script and the test suite.
 *
 * Builds the dashboard's "request →" text from an `llm.request` payload's `data`
 * ({ context?: { text? }, messages? }). It renders BOTH the composed context (the
 * system prefix) AND the conversation `messages` (which previously weren't shown).
 * Kept ES5-plain (var; no arrow/const/template-literals) and dependency-free so its
 * source can be embedded verbatim into the browser SCRIPT via `.toString()`.
 */
export function formatRequest(data: unknown): string {
  var d: any = (data && typeof data === "object") ? data : {};
  var ctx: string = (d.context && typeof d.context.text === "string") ? d.context.text : "";
  var msgs: any = d.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return ctx;
  var lines: string[] = [];
  for (var i = 0; i < msgs.length; i++) {
    var m: any = (msgs[i] && typeof msgs[i] === "object") ? msgs[i] : {};
    var head: string = m.role ? String(m.role) : "?";
    if (typeof m.name === "string" && m.name) head += " (" + m.name + ")";
    var body: string;
    if (typeof m.content === "string") body = m.content;
    else if (m.content === null || m.content === undefined) body = "";
    else body = JSON.stringify(m.content);
    var line: string = head + ": " + body;
    if (typeof m.toolCallId === "string") line += "  [toolCallId=" + m.toolCallId + "]";
    if (Array.isArray(m.toolCalls) && m.toolCalls.length) line += "\n    toolCalls: " + JSON.stringify(m.toolCalls);
    lines.push(line);
  }
  var header: string = "— messages (" + msgs.length + ") —";
  var joined: string = lines.join("\n");
  return ctx ? (ctx + "\n\n" + header + "\n" + joined) : (header + "\n" + joined);
}
