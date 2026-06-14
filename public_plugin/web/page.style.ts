/**
 * The web chat page's CSS — the dark Krakey theme. Extracted verbatim from the
 * single static page so the markup, style, and script each live in one file; the
 * assembled PAGE_HTML (see page.ts) is byte-identical to the inlined original.
 */
export const STYLE = `  :root{ --mint:#2FD69C; --bg:#0d1210; --bg2:#0a0f0d; --surf:#171e1a; --line:rgba(255,255,255,0.08);
    --tx:#e7ece9; --tx2:#7b847e; --tx3:#5f6863; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; height:100%; }
  body{ background:var(--bg); color:var(--tx); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  #app{ display:flex; height:100vh; }
  aside{ width:208px; background:var(--bg2); border-right:.5px solid var(--line); display:flex; flex-direction:column; padding:18px 12px; flex-shrink:0; }
  .brand{ font-size:16px; font-weight:500; letter-spacing:.3px; padding:0 6px 18px; }
  .lbl{ font-size:11px; color:var(--tx3); letter-spacing:.8px; padding:0 6px 8px; }
  .agent{ display:flex; align-items:center; gap:9px; padding:9px 10px; border-radius:8px; font-size:13px; color:#aab4ae; cursor:pointer; border:none; background:none; width:100%; text-align:left; }
  .agent:hover{ background:rgba(255,255,255,0.04); }
  .agent.sel{ background:rgba(47,214,156,0.12); color:var(--tx); }
  .dot{ width:7px; height:7px; border-radius:50%; background:var(--mint); flex-shrink:0; }
  .roster-foot{ margin-top:auto; display:flex; align-items:center; gap:7px; padding:10px 6px 0; border-top:.5px solid var(--line); font-size:12px; color:var(--tx2); }
  main{ flex:1; display:flex; flex-direction:column; min-width:0; }
  header{ display:flex; align-items:center; gap:10px; padding:13px 18px; border-bottom:.5px solid var(--line); }
  .av{ border-radius:50%; background:rgba(47,214,156,0.14); display:flex; align-items:center; justify-content:center; color:var(--mint); font-weight:500; flex-shrink:0; }
  #title{ font-size:14px; font-weight:500; }
  #sub{ font-size:11.5px; color:var(--tx2); display:flex; align-items:center; gap:6px; }
  #bell{ border:none; background:none; color:var(--tx2); font-size:18px; cursor:pointer; padding:6px; border-radius:8px; display:flex; }
  #bell:hover{ background:rgba(255,255,255,0.05); color:var(--tx); }
  #bell.on{ color:var(--mint); }
  #log{ flex:1; overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:13px; }
  .row{ display:flex; gap:9px; align-items:flex-start; }
  .bubble{ border-radius:12px; padding:9px 13px; font-size:13.5px; line-height:1.5; max-width:78%; white-space:pre-wrap; word-break:break-word; }
  .agent-msg .bubble{ background:var(--surf); border:.5px solid rgba(255,255,255,0.06); color:#dfe6e2; }
  .me{ display:flex; flex-direction:column; align-items:flex-end; gap:3px; }
  .me .bubble{ background:rgba(47,214,156,0.13); border:.5px solid rgba(47,214,156,0.22); color:#d6f3e7; }
  .tick{ font-size:11px; display:flex; align-items:center; gap:4px; padding-right:2px; color:var(--tx2); }
  .tick .bi{ font-size:13px; }
  .tick.read{ color:var(--mint); }
  .empty{ color:var(--tx2); font-size:13px; margin:auto; }
  form{ display:flex; gap:10px; align-items:center; padding:13px 16px; border-top:.5px solid var(--line); }
  #box{ flex:1; background:#111714; border:.5px solid rgba(255,255,255,0.10); border-radius:10px; padding:11px 13px; font-size:13px; color:var(--tx); outline:none; }
  #box::placeholder{ color:var(--tx2); }
  #send{ width:40px; height:40px; border:none; border-radius:10px; background:var(--mint); color:#06251a; font-size:18px; cursor:pointer; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
  #send:disabled{ opacity:.4; cursor:default; }`;
