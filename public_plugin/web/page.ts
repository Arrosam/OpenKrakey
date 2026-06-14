/**
 * The web channel's single static page — a dark Krakey chat UI (no build step, no
 * framework). Served verbatim at `GET /`. It fetches the agent roster, opens an SSE
 * stream per selected agent, renders the transcript, and posts messages — showing a
 * `sent` tick when a message is queued and `read` once the agent's beat has
 * processed it. Icons are Bootstrap Icons (loaded from CDN). When the tab is in the
 * background, incoming replies raise a browser notification (opt-in via the bell).
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Krakey</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
<style>
  :root{ --mint:#2FD69C; --bg:#0d1210; --bg2:#0a0f0d; --surf:#171e1a; --line:rgba(255,255,255,0.08);
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
  #send:disabled{ opacity:.4; cursor:default; }
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
(function(){
  var roster=document.getElementById('roster'), countEl=document.getElementById('count');
  var titleEl=document.getElementById('title'), subEl=document.getElementById('sub'), havEl=document.getElementById('hav');
  var log=document.getElementById('log'), box=document.getElementById('box'), send=document.getElementById('send'), form=document.getElementById('form');
  var bell=document.getElementById('bell');
  var current=null, es=null, msgs={}, greeted=false;

  function initial(id){ return (id||'?').slice(0,1).toLowerCase(); }
  function esc(s){ var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  function notifySupported(){ return ('Notification' in window); }
  function refreshBell(){
    var on = notifySupported() && Notification.permission==='granted';
    bell.className = on ? 'on' : '';
    bell.firstChild.className = 'bi ' + (on ? 'bi-bell-fill' : (notifySupported() && Notification.permission==='denied' ? 'bi-bell-slash' : 'bi-bell'));
    bell.title = on ? 'Reply notifications on' : (notifySupported() ? 'Click to enable reply notifications' : 'Notifications not supported');
  }
  function askNotify(){
    if(!notifySupported()) return;
    if(Notification.permission==='default'){ Notification.requestPermission().then(refreshBell).catch(function(){}); }
    refreshBell();
  }
  function maybeNotify(text){
    if(!notifySupported() || Notification.permission!=='granted') return;
    if(!document.hidden) return;
    try{ var n=new Notification(current||'Krakey',{ body:text, tag:'krakey-'+current }); n.onclick=function(){ window.focus(); n.close(); }; }catch(e){}
  }
  bell.addEventListener('click', askNotify);

  function showLocked(){
    countEl.textContent='locked';
    roster.innerHTML='';
    log.innerHTML='<div class="empty">This tab isn\\u2019t authorized. Open the link printed in the console &mdash; it carries a one-time token.</div>';
    box.disabled=true; send.disabled=true; box.placeholder='Locked'; current=null;
    if(es){ es.close(); es=null; }
  }
  function loadRoster(){
    fetch('/api/agents').then(function(r){
      if(r.status===401){ showLocked(); return null; }
      return r.json();
    }).then(function(d){
      if(!d) return;
      var list=(d&&d.agents)||[];
      countEl.textContent=list.length+' agent'+(list.length===1?'':'s')+' online';
      roster.innerHTML='';
      list.forEach(function(id){
        var b=document.createElement('button');
        b.className='agent'+(id===current?' sel':'');
        b.innerHTML='<span class="dot"></span><span style="flex:1">'+esc(id)+'</span>';
        b.onclick=function(){ askNotify(); select(id); };
        roster.appendChild(b);
      });
      if(!current && list.length) select(list[0]);
    }).catch(function(){});
  }

  function addAgentMsg(text){
    var row=document.createElement('div'); row.className='row agent-msg';
    row.innerHTML='<div class="av" style="width:22px;height:22px;font-size:11px;margin-top:1px;">'+esc(initial(current))+'</div>'+
      '<div class="bubble">'+esc(text)+'</div>';
    log.appendChild(row); log.scrollTop=log.scrollHeight;
  }
  function addMyMsg(id,text){
    var wrap=document.createElement('div'); wrap.className='me';
    wrap.innerHTML='<div class="bubble">'+esc(text)+'</div>'+
      '<div class="tick" data-msg="'+id+'"><i class="bi bi-check"></i><span class="tk-tx">sent</span></div>';
    log.appendChild(wrap); log.scrollTop=log.scrollHeight; msgs[id]=wrap;
  }
  function renderHistory(messages){
    (messages||[]).forEach(function(m){
      if(!m) return;
      if(m.role==='user'){
        var hasId = typeof m.id!=='undefined' && m.id!==null;
        addMyMsg(hasId?m.id:'', m.text||'');
        if(hasId && m.status==='read') markRead(m.id);
      } else if(m.role==='agent'){
        addAgentMsg(m.text||'');
      }
    });
  }
  function markRead(id){
    var w=msgs[id]; if(!w) return; var t=w.querySelector('.tick'); if(!t) return;
    t.className='tick read'; t.querySelector('.bi').className='bi bi-check-all'; t.querySelector('.tk-tx').textContent='read';
  }

  function select(id){
    if(es){ es.close(); es=null; }
    current=id; msgs={}; greeted=false;
    titleEl.textContent=id; havEl.textContent=initial(id);
    subEl.innerHTML='<span class="dot"></span>online';
    box.disabled=false; send.disabled=false; box.placeholder='Message '+id+'\\u2026'; box.focus();
    log.innerHTML='';
    Array.prototype.forEach.call(roster.children,function(b){ b.classList.toggle('sel', b.textContent.trim()===id); });
    es=new EventSource('/api/agents/'+encodeURIComponent(id)+'/stream');
    es.onmessage=function(ev){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.type==='history'){ renderHistory(m.messages); }
      else if(m.type==='output'){ addAgentMsg(m.text); if(greeted){ maybeNotify(m.text); } greeted=true; }
      else if(m.type==='status' && m.status==='read'){ markRead(m.id); }
    };
  }

  form.addEventListener('submit',function(e){
    e.preventDefault();
    var text=box.value.trim(); if(!text||!current) return;
    box.value=''; askNotify();
    fetch('/api/agents/'+encodeURIComponent(current)+'/message',{
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({text:text})
    }).then(function(r){return r.json();}).then(function(d){ if(d&&typeof d.id!=='undefined') addMyMsg(d.id,text); }).catch(function(){});
  });

  refreshBell();
  loadRoster();
  setInterval(loadRoster, 5000);
})();
</script>
</body>
</html>`;
