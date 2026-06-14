/**
 * The web chat page's client script — roster polling, per-agent SSE stream,
 * transcript rendering, sent/read ticks, and opt-in reply notifications. No build
 * step, no framework. Extracted verbatim; the assembled PAGE_HTML is byte-identical
 * to the inlined original.
 */
export const SCRIPT = `(function(){
  var roster=document.getElementById('roster'), countEl=document.getElementById('count');
  var titleEl=document.getElementById('title'), subEl=document.getElementById('sub'), havEl=document.getElementById('hav');
  var log=document.getElementById('log'), box=document.getElementById('box'), send=document.getElementById('send'), form=document.getElementById('form');
  var bell=document.getElementById('bell');
  var current=null, es=null, msgs={}, greeted=false;

  function initial(id){ return (id||'?').slice(0,1).toLowerCase(); }
  var ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){ return ESC[c]; }); }

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
      '<div class="tick" data-msg="'+esc(String(id))+'"><i class="bi bi-check"></i><span class="tk-tx">sent</span></div>';
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
})();`;
