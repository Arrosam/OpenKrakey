/**
 * The web channel's single static page — the Krakey chat UI, re-skinned to the
 * "mission-control cockpit" design system (no build step, no framework). Served
 * verbatim at `GET /`. It fetches the agent roster, opens an SSE stream per
 * selected agent, renders the persisted transcript, and posts messages — showing
 * a `sent` tick when a message is queued and `read` once the agent's beat has
 * processed it. Icons are INLINE SVG (no CDN); fonts (Hanken Grotesk + JetBrains
 * Mono) load via the CSS @import. When the tab is in the background, incoming
 * replies raise a browser notification (opt-in via the bell).
 *
 * The CSS and the client script live in sibling files (page.style.ts,
 * page.script.ts) and are interpolated below; the client script rebuilds the
 * header / roster / transcript at runtime, so this shell is just the first-paint
 * skeleton it hydrates.
 */
import { STYLE } from "./page.style";
import { SCRIPT } from "./page.script";

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Krakey</title>
<style>
${STYLE}
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c.4 3.6 1.4 4.6 5 5-3.6.4-4.6 1.4-5 5-.4-3.6-1.4-4.6-5-5 3.6-.4 4.6-1.4 5-5z"/><path d="M18.5 13.5c.2 1.7.6 2.1 2 2.3-1.4.2-1.8.6-2 2.3-.2-1.7-.6-2.1-2-2.3 1.4-.2 1.8-.6 2-2.3z"/></svg></span>
      <div>
        <div class="mark">KRAKEY <span class="b">Chat</span></div>
        <div class="tag">ultimate autonomous agent</div>
      </div>
    </div>
    <div class="roster-label">Agents</div>
    <div class="roster" id="roster"></div>
    <div class="roster-foot" id="count"></div>
  </aside>
  <main class="main">
    <header class="chat-head" id="head">
      <span class="av" id="hav"></span>
      <div class="ht"><div class="htitle">&mdash;</div><div class="hsub">no agent selected</div></div>
      <button class="bell" id="bell" type="button" title="Notify me of replies" aria-label="Toggle reply notifications" aria-pressed="false"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.2 4.3A6 6 0 0 1 18 9c0 2.6.4 4.3 1 5.5M5.5 8.9C6 7 6 6.6 6 9c0 5-1.5 6.5-2.5 7.5h13"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M3.5 3.5l17 17"/></svg></button>
    </header>
    <div class="log" id="log"><div class="empty">Pick an agent to start chatting.</div></div>
    <form class="composer" id="form">
      <div class="quote-host" id="quoteHost"></div>
      <div class="row-in">
        <textarea class="box auto" id="box" rows="1" autocomplete="off" placeholder="Select an agent&hellip;" disabled></textarea>
        <button class="send" id="send" type="submit" disabled aria-label="Send"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V5M6 11l6-6 6 6"/></svg></button>
      </div>
    </form>
  </main>
</div>
<script>
${SCRIPT}
</script>
</body>
</html>`;
