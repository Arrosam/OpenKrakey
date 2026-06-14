/**
 * The web channel's single static page — a dark Krakey chat UI (no build step, no
 * framework). Served verbatim at `GET /`. It fetches the agent roster, opens an SSE
 * stream per selected agent, renders the transcript, and posts messages — showing a
 * `sent` tick when a message is queued and `read` once the agent's beat has
 * processed it. Icons are Bootstrap Icons (loaded from CDN). When the tab is in the
 * background, incoming replies raise a browser notification (opt-in via the bell).
 *
 * The CSS and the client script live in sibling files (page.style.ts, page.script.ts)
 * and are interpolated below; the assembled string is byte-identical to the original.
 */
import { STYLE } from "./page.style";
import { SCRIPT } from "./page.script";

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Krakey</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
<style>
${STYLE}
</style>
</head>
<body>
<div id="app">
  <aside>
    <div class="brand">Krakey</div>
    <div class="lbl">AGENTS</div>
    <div id="roster"></div>
    <div class="roster-foot"><span id="count">0 agents online</span></div>
  </aside>
  <main>
    <header>
      <div class="av" id="hav" style="width:26px;height:26px;font-size:13px;"></div>
      <div style="flex:1;min-width:0;">
        <div id="title">&mdash;</div>
        <div id="sub"></div>
      </div>
      <button id="bell" type="button" title="Notify me of replies" aria-label="Enable notifications"><i class="bi bi-bell-slash"></i></button>
    </header>
    <div id="log"><div class="empty">Pick an agent to start chatting.</div></div>
    <form id="form">
      <input id="box" autocomplete="off" placeholder="Select an agent&hellip;" disabled />
      <button id="send" type="submit" disabled aria-label="Send"><i class="bi bi-send-fill"></i></button>
    </form>
  </main>
</div>
<script>
${SCRIPT}
</script>
</body>
</html>`;
