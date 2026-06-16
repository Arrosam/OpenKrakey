/**
 * inspector/page.format.ts — pure render helper shared by the served dashboard
 * script and the test suite. Builds the "request →" block from a captured "sent"
 * record's payload, in a friendly "readable" view or a "raw" JSON view.
 *
 * Payload is one of:
 *   - llm.request.sent:       { data: { request: <assembled LLMRequest> } }
 *   - llm.request (fallback): { data: { context: { text? }, messages? } }
 * Both normalize to a request object { system?, messages?, tools?, temperature?,
 * maxTokens?, model? }. Kept ES5-plain + dependency-free so its source embeds
 * verbatim into the browser SCRIPT via `.toString()`.
 */
export function formatRequest(payload: unknown, mode: "readable" | "raw"): string {
  var p: any = (payload && typeof payload === "object") ? payload : {};
  var d: any = (p.data && typeof p.data === "object") ? p.data : {};
  var req: any;
  if (d.request && typeof d.request === "object") {
    req = d.request;
  } else {
    req = {
      system: (d.context && typeof d.context.text === "string") ? d.context.text : undefined,
      messages: d.messages,
    };
  }
  if (mode === "raw") return JSON.stringify(req, null, 2);
  var parts: string[] = [];
  var sys: string = (typeof req.system === "string") ? req.system : "";
  if (sys) parts.push(sys);
  var msgs: any = req.messages;
  if (Array.isArray(msgs) && msgs.length) {
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
    parts.push("— messages (" + msgs.length + ") —\n" + lines.join("\n"));
  }
  var tools: any = req.tools;
  if (Array.isArray(tools) && tools.length) {
    var names: string[] = [];
    for (var j = 0; j < tools.length; j++) {
      var t: any = tools[j];
      names.push((t && typeof t.name === "string") ? t.name : "?");
    }
    parts.push("— tools (" + tools.length + ") —\n" + names.join(", "));
  }
  var pp: string[] = [];
  if (typeof req.temperature === "number") pp.push("temperature=" + req.temperature);
  if (typeof req.maxTokens === "number") pp.push("maxTokens=" + req.maxTokens);
  if (typeof req.model === "string") pp.push("model=" + req.model);
  if (pp.length) parts.push("params: " + pp.join(" · "));
  return parts.join("\n\n");
}

/**
 * Pick which of two corrId-paired "prompt.sent" records is the authoritative request
 * to display. The orchestrator's plain `llm.request` and llm-core's assembled
 * `llm.request.sent` share a corrId and can arrive in EITHER order (the sent event is
 * emitted re-entrantly during the request emit). Prefer the assembled one — the record
 * carrying `payload.data.request` — so a plain request never overwrites it.
 *
 * MUST stay FLAT — no nested/inner function. This source is embedded verbatim into the
 * served browser SCRIPT via `.toString()`, and the bundler instruments nested function
 * expressions with a `__name(...)` helper that is undefined in the browser (it would
 * throw at runtime). The `has(...)` check is therefore inlined, not a closure.
 */
export function chooseSent(current: unknown, incoming: unknown): unknown {
  if (!incoming) return current;
  if (!current) return incoming;
  var inc: any = incoming;
  if (inc.payload && inc.payload.data && inc.payload.data.request) return incoming;
  var cur: any = current;
  if (cur.payload && cur.payload.data && cur.payload.data.request) return current;
  return incoming;
}
