/**
 * The web chat page's client script — the cockpit re-skin grafted onto the REAL
 * data layer. No build step, no framework. The DATA/PROTOCOL is preserved exactly
 * from the original page: roster polling (GET /api/agents, 401 -> locked), a
 * per-agent SSE stream (GET /api/agents/:id/stream) carrying { type:"history" }
 * (replayed transcript with per-id read state), { type:"output" } (agent sends,
 * background-only opt-in notifications gated by a `greeted` flag) and
 * { type:"status", id, status } (per-message sent/read), message POST
 * (POST /api/agents/:id/message -> { id }), and the read-tick keyed by message id.
 *
 * The DESIGN + new client interactions come from the approved mock
 * (design/chat-mock/app.js): inline SVG icon set, two-line roster rows with
 * ellipsis + hover tooltip, per-message hover copy button, the two-click gutter
 * quote flow, an auto-grow <textarea> composer (Enter sends / Shift+Enter
 * newline), the agent-switch viewIn transition, the three-signal connection pill,
 * and the embedded-brand hide.
 *
 * Two real bugs are FIXED here:
 *   1) The header connection status is driven by the EventSource state (onopen ->
 *      connected, onerror/closed -> disconnected/reconnecting), not a hardcoded
 *      "online".
 *   2) The notification bell toggles via an explicit `notifyArmed` flag (reflected
 *      with aria-pressed + an ON/OFF tooltip), not derived solely from
 *      Notification.permission — so it can be turned back off.
 *
 * Authored with string concatenation (no nested template literals / ${...}) so the
 * inlined script never collides with PAGE_HTML's outer template literal.
 */
export const SCRIPT = `(function(){
  var $ = function(sel, root){ return (root||document).querySelector(sel); };
  function elm(tag, cls, html){ var n=document.createElement(tag); if(cls) n.className=cls; if(html!=null) n.innerHTML=html; return n; }
  var ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){ return ESC[c]; }); }
  function initial(id){ return (id||'?').slice(0,1).toLowerCase(); }

  // ── Inline SVG icon set (no CDN) — drawn in the config-web line-icon style.
  // 'quote' is the one FILLED glyph (stroked it traces broken at the 14px chip size).
  var ICONS={
    chat: '<path d="M20.5 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 20.5 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    checkAll: '<path d="M2 12.5l4 4L13.5 9"/><path d="M11 16.5l1 .5L22 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 1.5 6.5 2.5 7.5H3.5C4.5 15.5 6 14 6 9z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    bellSlash: '<path d="M9.2 4.3A6 6 0 0 1 18 9c0 2.6.4 4.3 1 5.5M5.5 8.9C6 7 6 6.6 6 9c0 5-1.5 6.5-2.5 7.5h13"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M3.5 3.5l17 17"/>',
    send: '<path d="M12 20V5M6 11l6-6 6 6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V4.6A1.6 1.6 0 0 1 4.6 3h8.9A1.5 1.5 0 0 1 15 4.5V5"/>',
    quote: '<path d="M5 7.5a3.5 3.5 0 0 0-2 3.2v4.3a1.5 1.5 0 0 0 1.5 1.5H8a1.5 1.5 0 0 0 1.5-1.5V12A1.5 1.5 0 0 0 8 10.5H6.4c.2-.9.8-1.6 1.7-2A1 1 0 0 0 7.5 6.6 5.4 5.4 0 0 0 5 7.5zM15 7.5a3.5 3.5 0 0 0-2 3.2v4.3a1.5 1.5 0 0 0 1.5 1.5H18a1.5 1.5 0 0 0 1.5-1.5V12A1.5 1.5 0 0 0 18 10.5h-1.6c.2-.9.8-1.6 1.7-2a1 1 0 0 0-.6-1.9A5.4 5.4 0 0 0 15 7.5z"/>'
  };
  var FILLED_ICONS={ quote:1 };
  function icon(name, cls){
    var p=ICONS[name]; if(!p) return '';
    var paint = FILLED_ICONS[name]
      ? 'fill="currentColor" stroke="none"'
      : 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
    return '<svg class="ic'+(cls?' '+cls:'')+'" viewBox="0 0 24 24" '+paint+' aria-hidden="true">'+p+'</svg>';
  }

  // ── Element refs (the static shell from page.ts; the script hydrates them).
  var roster=document.getElementById('roster'), countEl=document.getElementById('count');
  var head=document.getElementById('head'), log=document.getElementById('log');
  var box=document.getElementById('box'), send=document.getElementById('send'), form=document.getElementById('form');
  var quoteHost=document.getElementById('quoteHost');

  // ── State.
  var current=null;          // selected agent id
  var es=null;               // the live EventSource for the selected agent
  var msgs={};               // message id -> the user-bubble row (for markRead by id)
  var greeted=false;         // first agent 'output' is the greeting, NOT a notification
  var agents=[];             // last roster (ids) from GET /api/agents
  var locked=false;          // 401 — this tab isn't authorized
  // CONNECTION state — the live SSE channel, INDEPENDENT of an agent's presence.
  // Bug fix 1: driven by es.onopen / es.onerror, NOT a hardcoded 'online'.
  var connected=false;
  // NOTIFY state — bug fix 2: an explicit armed flag the bell click toggles
  // (gated on permission), NOT derived solely from Notification.permission.
  var notifyArmed=false;
  // QUOTE state machine (mock): armId = a row whose gutter is armed (1st click
  // landed, awaiting the 2nd); quote = the committed 'replying to' ref.
  var armId=null, quote=null;
  var bubbleSeq=0;

  // ── Embedded mode: iframed in the unified Krakey Console (which renders the one
  // global brand). Hide our own sidebar brand so two KRAKEY logos don't stack.
  // window.self !== window.top is true in any iframe and works cross-origin.
  (function detectEmbedded(){
    var embedded=false;
    try{ embedded = window.self !== window.top; }catch(e){ embedded=true; }
    if(embedded) document.documentElement.classList.add('embedded');
  })();

  function scrollDown(){ if(log) log.scrollTop=log.scrollHeight; }

  // ── Notifications (real flow preserved; opt-in + background-only).
  function notifySupported(){ return ('Notification' in window); }
  // Bug fix 2: the bell reflects the explicit armed flag + permission, with a
  // crystal-clear ON/OFF (mint filled bell / muted bell-slash + tooltip + aria-pressed).
  function refreshBell(){
    var b=$('#bell', head); if(!b) return;
    var on = notifyArmed && notifySupported() && Notification.permission==='granted';
    b.classList.toggle('on', on);
    b.innerHTML = icon(on ? 'bell' : 'bellSlash');
    b.setAttribute('aria-pressed', String(on));
    if(!notifySupported()){ b.title='Notifications not supported'; return; }
    if(Notification.permission==='denied'){ b.title='Reply notifications blocked by the browser'; return; }
    b.title = on
      ? 'Reply notifications ON \\u2014 click to mute'
      : 'Reply notifications OFF \\u2014 click to enable';
  }
  // The bell CLICK toggles the armed flag (requesting permission if needed) — so a
  // granted permission can still be turned back OFF (the original couldn't).
  function toggleBell(){
    if(!notifySupported()){ refreshBell(); return; }
    if(!notifyArmed){
      // turning ON: request permission if we don't have it yet
      if(Notification.permission==='default'){
        Notification.requestPermission().then(function(p){ notifyArmed = (p==='granted'); refreshBell(); }).catch(function(){ refreshBell(); });
        return;
      }
      notifyArmed = (Notification.permission==='granted'); // denied -> stays off
    } else {
      notifyArmed=false; // turning OFF
    }
    refreshBell();
  }
  function maybeNotify(text){
    if(!notifyArmed || !notifySupported() || Notification.permission!=='granted') return;
    if(!document.hidden) return; // background-only
    try{ var n=new Notification(current||'Krakey',{ body:text, tag:'krakey-'+current }); n.onclick=function(){ window.focus(); n.close(); }; }catch(e){}
  }

  // ── Avatar with a presence dot. Presence reflects the live CONNECTION state for
  // the SELECTED agent (mint when connected, slate when not) — the roster carries
  // only ids, so there is no per-agent online flag to read.
  function avatar(id, online){
    return '<span class="av">'+esc(initial(id))+
      '<span class="pres'+(online?'':' off')+'"></span></span>';
  }

  // ── Roster.
  function renderRoster(){
    if(!roster) return;
    roster.innerHTML='';
    agents.forEach(function(id){
      var sel = (id===current);
      var b=elm('button', 'agent'+(sel?' sel':''));
      b.type='button';
      b.title=id; // hover-reveal the full id when the line ellipsis-truncates
      // presence dot reflects the connection state only for the SELECTED agent;
      // others render neutral (mint dot, not "off") so the roster reads calm.
      var online = sel ? connected : true;
      var subTxt = sel ? (connected ? 'connected' : 'reconnecting\\u2026') : 'agent';
      b.innerHTML = avatar(id, online) +
        '<span class="at"><span class="an" title="'+esc(id)+'">'+esc(id)+'</span>'+
        '<span class="as" title="'+esc(subTxt)+'">'+esc(subTxt)+'</span></span>';
      b.onclick=function(){ select(id); };
      roster.appendChild(b);
    });
    renderConnFoot();
  }

  // Roster footer — agents-online count + a live dot mirroring the CONNECTION state.
  function renderConnFoot(){
    if(!countEl) return;
    if(locked){ countEl.innerHTML='<p>locked</p>'; return; }
    var n=agents.length;
    var live = (current && !connected)
      ? '<span class="live" style="background:var(--amber);box-shadow:none;animation:dpulse 1.5s ease-in-out infinite"></span>'
      : '<span class="live"></span>';
    countEl.innerHTML = live + '<p>'+n+' agent'+(n===1?'':'s')+' online</p>';
  }

  // ── Locked / 401 state (real behavior preserved): show the auth hint + disable.
  function showLocked(){
    locked=true; current=null;
    if(es){ es.close(); es=null; }
    if(roster) roster.innerHTML='';
    renderConnFoot();
    if(head) head.innerHTML =
      avatar('?', false) +
      '<div class="ht"><div class="htitle">&mdash;</div><div class="hsub">not authorized</div></div>'+
      '<button class="bell" id="bell" type="button" aria-label="Toggle reply notifications" aria-pressed="false" disabled>'+icon('bellSlash')+'</button>';
    if(log) log.innerHTML='<div class="empty"><span class="eic">'+icon('chat')+'</span>'+
      '<span class="et">This tab isn\\u2019t authorized.</span>'+
      '<span class="es">open the link printed in the console \\u2014 it carries a one-time token</span></div>';
    box.disabled=true; send.disabled=true; box.placeholder='Locked';
  }

  function loadRoster(){
    fetch('/api/agents').then(function(r){
      if(r.status===401){ showLocked(); return null; }
      return r.json();
    }).then(function(d){
      if(!d) return;
      locked=false;
      agents=(d&&d.agents)||[];
      renderRoster();
      if(!current && agents.length) select(agents[0]);
    }).catch(function(){});
  }

  // ── Transcript rendering.
  // The empty-gutter quote hit-area markup. ONE affordance element (.qchip) that
  // upgrades in place (idle ghost -> armed mint pill) so the hints never stack.
  function quoteZoneHTML(){
    return '<div class="quote-zone"><span class="qchip">'+icon('quote')+'<span class="qlabel">Quote</span></span></div>';
  }

  // Wire a freshly-built row: hover copy button on the bubble (does NOT arm
  // quoting, so bubble text stays selectable), and the two-click quote flow on the
  // empty gutter. Leaving the row before the 2nd click resets the arm.
  function wireBubble(row, bubble, who, text){
    var bid='b'+(++bubbleSeq);
    row.dataset.bid=bid;
    var copyBtn=elm('button','copy');
    copyBtn.type='button';
    copyBtn.title='Copy message';
    copyBtn.setAttribute('aria-label','Copy message');
    copyBtn.innerHTML=icon('copy');
    copyBtn.onclick=function(e){ e.stopPropagation(); copyText(text, copyBtn); };
    bubble.appendChild(copyBtn);
    var zone=$('.quote-zone', row);
    if(zone) zone.addEventListener('click', function(){ onZoneClick(bid, who, text, row); });
    row.addEventListener('mouseleave', function(){ if(armId===bid) disarmZone(); });
  }

  function addAgentMsg(text, animate){
    var row=elm('div','msg agent');
    if(animate===false) row.style.animation='none';
    row.innerHTML =
      '<div class="msg-inner">'+avatar(current, connected)+
      '<div class="bubble"><div class="bmeta">'+esc(current||'agent')+' \\u00b7 frame</div>'+esc(text)+'</div></div>'+
      quoteZoneHTML();
    wireBubble(row, $('.bubble', row), current||'agent', text);
    log.appendChild(row); scrollDown();
  }

  function addMyMsg(id, text, read, animate){
    var wrap=elm('div','msg me');
    if(animate===false) wrap.style.animation='none';
    var tickCls = read ? 'tick read' : 'tick';
    var tickIco = read ? icon('checkAll','tk-ic') : icon('check','tk-ic');
    var tkLabel = read ? 'read' : 'sent';
    var idAttr = (id===''||id==null) ? '' : ' data-msg="'+esc(String(id))+'"';
    wrap.innerHTML =
      '<div class="me-row">'+ quoteZoneHTML() +
        '<div class="bubble">'+esc(text)+'</div>'+
      '</div>'+
      '<div class="'+tickCls+'"'+idAttr+'>'+tickIco+
      '<span class="tk-tx">'+tkLabel+'</span></div>';
    wireBubble(wrap, $('.bubble', wrap), 'you', text);
    log.appendChild(wrap); scrollDown();
    if(id!=='' && id!=null) msgs[id]=wrap;
    return wrap;
  }

  // ── History replay (real behavior preserved): user messages carry id + status
  // ('read' replays already flipped); agent messages render as agent bubbles.
  function renderHistory(messages){
    (messages||[]).forEach(function(m){
      if(!m) return;
      if(m.role==='user'){
        var hasId = typeof m.id!=='undefined' && m.id!==null;
        addMyMsg(hasId?m.id:'', m.text||'', hasId && m.status==='read', false);
      } else if(m.role==='agent'){
        addAgentMsg(m.text||'', false);
      }
    });
  }

  // Flip a user message's tick 'sent' -> 'read' (mint double-check), keyed by id.
  function markRead(id){
    var w=msgs[id]; if(!w) return; var t=w.querySelector('.tick'); if(!t) return;
    t.className='tick read';
    var ic=t.querySelector('.tk-ic'); if(ic) ic.outerHTML=icon('checkAll','tk-ic');
    var tx=t.querySelector('.tk-tx'); if(tx) tx.textContent='read';
  }

  // ── Copy.
  function copyText(text, btn){
    var done=function(){ flashCopied(btn); };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(function(){ legacyCopy(text, done); });
    } else { legacyCopy(text, done); }
  }
  function legacyCopy(text, done){
    try{
      var ta=elm('textarea'); ta.value=text;
      ta.style.cssText='position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); done();
    }catch(e){}
  }
  function flashCopied(btn){
    btn.classList.add('copied');
    btn.innerHTML=icon('check');
    btn.title='Copied';
    clearTimeout(btn._revert);
    btn._revert=setTimeout(function(){
      btn.classList.remove('copied');
      btn.innerHTML=icon('copy');
      btn.title='Copy message';
    }, 1100);
  }

  // ── Two-click quote flow (armed from the empty gutter, NOT the bubble).
  function onZoneClick(bid, who, text, row){
    if(armId===bid){ disarmZone(); setQuote(who, text); }
    else { disarmZone(); armZone(bid, row); }
  }
  function armZone(bid, row){
    armId=bid; row.classList.add('arming');
    var zone=$('.quote-zone', row); if(!zone) return;
    zone.classList.add('armed');
    var chip=$('.qchip', zone);
    if(chip){ chip.classList.add('armed'); var label=$('.qlabel', chip); if(label) label.textContent='Click again to quote'; }
  }
  function disarmZone(){
    if(!armId) return;
    var row=log.querySelector('.msg[data-bid="'+armId+'"]');
    if(row){
      row.classList.remove('arming');
      var zone=$('.quote-zone', row);
      if(zone){
        zone.classList.remove('armed');
        var chip=$('.qchip', zone);
        if(chip){ chip.classList.remove('armed'); var label=$('.qlabel', chip); if(label) label.textContent='Quote'; }
      }
    }
    armId=null;
  }

  // ── Composer quote chip ('replying to …').
  function setQuote(who, text){ quote={ who:who, text:text }; renderQuoteChip(); if(box && !box.disabled) box.focus(); }
  function clearQuote(){ quote=null; renderQuoteChip(); }
  function renderQuoteChip(){
    if(!quoteHost) return;
    quoteHost.innerHTML='';
    if(!quote) return;
    var snip=quote.text.replace(/\\s+/g,' ').trim();
    var chip=elm('div','quote-chip');
    chip.innerHTML =
      '<div class="qbody"><div class="qwho">'+icon('quote')+'<span>replying to '+esc(quote.who)+'</span></div>'+
      '<div class="qsnip">'+esc(snip)+'</div></div>'+
      '<button class="qx" type="button" title="Cancel reply" aria-label="Cancel reply">'+icon('x')+'</button>';
    $('.qx', chip).onclick=clearQuote;
    quoteHost.appendChild(chip);
  }

  // ── Empty state.
  function renderEmpty(){
    log.innerHTML =
      '<div class="empty"><span class="eic">'+icon('chat')+'</span>'+
      '<span class="et">Pick an agent to start chatting.</span>'+
      '<span class="es">your agents wake on a frame loop \\u2014 talk to them anytime</span></div>';
  }

  // ── Header (connection pill + bell). Bug fix 1: the pill reflects the live
  // CONNECTION state — connected => mint dot + 'connected', disconnected => amber
  // 'disconnected — reconnecting…'.
  function connectionMarkup(id){
    if(connected){
      return '<span class="conn" id="conn" title="Channel live"><span class="cdot"></span>'+
        '<span class="ctext">connected</span></span>';
    }
    return '<span class="conn down" id="conn" title="Channel down \\u2014 reconnecting"><span class="cdot"></span>'+
      '<span class="ctext">disconnected \\u2014 reconnecting\\u2026</span></span>';
  }
  function renderHeader(id){
    if(!head) return;
    head.innerHTML =
      avatar(id, connected) +
      '<div class="ht"><div class="htitle">'+esc(id)+'</div>'+
      '<div class="hsub">'+connectionMarkup(id)+'</div></div>'+
      '<button class="bell'+((notifyArmed && notifySupported() && Notification.permission==="granted")?' on':'')+'" id="bell" type="button" '+
      'aria-label="Toggle reply notifications" aria-pressed="false">'+icon('bellSlash')+'</button>';
    var b=$('#bell', head); if(b) b.onclick=toggleBell;
    refreshBell();
  }

  // Re-render the connection-dependent chrome (header pill + roster + footer) when
  // the EventSource open/close state changes.
  function refreshConnection(){
    if(current) renderHeader(current);
    renderRoster();
  }

  // ── Select an agent.
  function select(id){
    if(es){ es.close(); es=null; }
    current=id; msgs={}; greeted=false; connected=false;
    armId=null; clearQuote();

    renderHeader(id);
    renderRoster();

    log.innerHTML='';
    log.appendChild(elm('div','daybreak','<span>today</span>'));

    box.disabled=false; send.disabled=false; box.placeholder='Message '+id+'\\u2026';
    autogrow(); box.focus();

    // Open the per-agent SSE stream. Bug fix 1: drive the connection state from the
    // EventSource lifecycle (onopen -> connected, onerror/closed -> disconnected).
    es=new EventSource('/api/agents/'+encodeURIComponent(id)+'/stream');
    es.onopen=function(){ if(current!==id) return; if(!connected){ connected=true; refreshConnection(); } };
    es.onerror=function(){
      if(current!==id) return;
      // EventSource auto-reconnects; reflect the dropped/reconnecting channel.
      if(connected || (es && es.readyState!==EventSource.OPEN)){ connected=false; refreshConnection(); }
    };
    es.onmessage=function(ev){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      // Any received message confirms the channel is live.
      if(current===id && !connected){ connected=true; refreshConnection(); }
      if(m.type==='history'){ renderHistory(m.messages); }
      else if(m.type==='output'){ addAgentMsg(m.text, true); if(greeted){ maybeNotify(m.text); } greeted=true; }
      else if(m.type==='status' && m.status==='read'){ markRead(m.id); }
    };

    animateView();
  }

  // Re-trigger the view-enter slide-up/fade on the header + transcript each select.
  function animateView(){
    [head, log].forEach(function(m){
      if(!m) return;
      m.classList.remove('view-enter');
      void m.offsetWidth; // force reflow so the keyframe restarts
      m.classList.add('view-enter');
    });
  }

  // ── Composer: auto-grow textarea (cap matches COMPOSER_MAX_H in the CSS).
  var COMPOSER_MAX_H=160;
  function autogrow(){
    var t=box; if(!t) return;
    t.style.height='auto';
    var h=Math.min(t.scrollHeight, COMPOSER_MAX_H);
    t.style.height=h+'px';
    t.style.overflowY = t.scrollHeight > COMPOSER_MAX_H ? 'auto' : 'hidden';
  }

  // ── Send: POST the message, append the user bubble keyed by the server id (so
  // the per-id sent/read status flow works), reset the composer, clear the quote.
  function submitComposer(){
    var text=box.value.trim();
    if(!text || !current) return;
    box.value=''; autogrow(); clearQuote();
    fetch('/api/agents/'+encodeURIComponent(current)+'/message',{
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({text:text})
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d && typeof d.id!=='undefined') addMyMsg(d.id, text, false, true);
    }).catch(function(){});
  }

  form.addEventListener('submit', function(e){ e.preventDefault(); submitComposer(); });
  box.addEventListener('input', autogrow);
  // Enter sends; Shift+Enter inserts a newline (browser handles it natively).
  box.addEventListener('keydown', function(e){
    if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); submitComposer(); }
  });

  // Initial bell wiring (the static shell's bell, before any header re-render).
  var bell0=document.getElementById('bell'); if(bell0) bell0.onclick=toggleBell;

  // ── Boot.
  refreshBell();
  renderEmpty();
  loadRoster();
  setInterval(loadRoster, 5000);
})();`;
