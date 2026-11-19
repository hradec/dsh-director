// Sidebar "ComfyUI" tab — dsh-director half of the dsh-studio bridge (BRIDGE_CONTRACT.md v1).
// The iframe is a document-body SINGLETON (.comfy-frame-floating): sidebar tab switches unmount this React
// component, and removing/re-parenting an iframe reloads it — ComfyUI's frontend takes minutes. So the iframe
// never leaves the body; mounting the tab positions the floating host over the tab's anchor and shows it,
// unmounting hides it. Bridge link state is kept per-host in a module map so remounts know it.
import {useEffect,useRef,useState} from 'react';
import React from 'react';

const NS='dsh-studio',V=1;
const IMAGE_RE=/\.(png|jpe?g|webp|gif|bmp)$/i,AUDIO_RE=/\.(wav|mp3|flac|ogg|m4a)$/i;
const ASSET_KINDS=['actors','scenes','props','costumes','layouts','voices'];
const originOf=(h)=>{try{return new URL(h).origin;}catch{return ''};};
// One persistent iframe PER ComfyUI endpoint in document.body — switching hosts shows/hides frames instead of re-navigating.

let ackTimer=0;
function clearAck(){if(ackTimer){clearTimeout(ackTimer);ackTimer=0;}}
function armAck(){
  // diagnostic only (no gate): if the endpoint never acks a load, say so — 242/243 still run an extension
  // without the v1.2-iframe load-workflow case (their custom_nodes copy predates the edit / nfsshare not mounted at install time)
  clearAck();
  ackTimer=setTimeout(()=>{ackTimer=0;if(G.noteSink)G.noteSink('ComfyUI never confirmed the workflow load — this endpoint likely runs an older dsh-studio-link: 242/243 need install.sh re-run + ComfyUI restart (their /extensions/dsh-studio-link/dsh_link.js has no load-workflow)');},15000);
}

// ALL mutable bridge state lives on globalThis: the harness RE-RUNS the plugin factory (session
// switch, re-activation) — a fresh module instance with per-instance Maps could not see the frames
// already in the DOM, silently created new ones and forced a full ComfyUI re-boot with no src write
// and no DOM removal for forensics to catch (the line 'a NEW ComfyUI frame element was created
// mid-page' proved exactly this). Shared state across instances = re-instantiation REUSES live frames.
const G=globalThis.__DSH_COMFY_STATE__??(globalThis.__DSH_COMFY_STATE__={
  frames:new Map(), linked:new Map(), pending:new Map(), deferred:[], helloCbs:new Set(), srcWrites:[],
  activeHost:(typeof localStorage!=='undefined'?localStorage.getItem('dsh-comfy-host'):null)??'',
  hostsCache:[], warmed:false, listener:false, noteSink:null, openTab:null, moduleSid:'',
});
export function setComfyTabOpener(fn){G.openTab=fn;}

function sendBridge(h,msg){
  const frame=G.frames.get(h)?.frame,o=originOf(h);
  if(!frame?.isConnected||!o)return false;
  frame.contentWindow?.postMessage({ns:NS,v:V,...msg},o);return true;
}

function markHello(h){
  G.linked.set(h,true);
  sendBridge(h,{type:'bridge-ready',hosts:G.hostsCache});
  // latest-wins: stale queued loads from earlier attempts must NOT replay (replaying looked like the canvas reloading right after a load)
  const m=G.pending.get(h);
  if(m){G.pending.delete(h);sendBridge(h,m);armAck();}
  for(const cb of G.helloCbs)cb(h);
}

// Right-click "Open in ComfyUI" lane — lives at module scope so it answers even when the sidebar
// ComfyUI tab is closed: the endpoint's frame is kept alive after first visit, or booted hidden on demand.
// hello catcher (module scope so closed-tab frames still register), DOM-guarded: importing the
// bundle must not execute UI side effects — build.test pins that invariant.
if(typeof window!=='undefined'&&typeof window.addEventListener==='function'&&!G.listener){G.listener=true;
  window.addEventListener('message',(e)=>{
    const d=e.data;if(!d||d.ns!==NS||d.v!==V)return;
    const h=G.activeHost,o=originOf(h);if(!o||e.origin!==o)return;
    if(d.type==='iframe-nav'){if(G.noteSink)G.noteSink(`ComfyUI page (re)load: browser says initiator='${d.kind}' — 'reload' means the browser/you re-navigated the SAME url (F5, ⟳, crash or memory restore); 'navigate' means Director Studio pointed the frame at it`);return;}
    if(d.type==='iframe-leaving'){if(G.noteSink)G.noteSink(`ComfyUI (${G.activeHost}) announced it is leaving the page at ${new Date().toLocaleTimeString()}`);return;}
    if(d.type==='bridge-hello'){markHello(h);return;}
    if(d.type==='workflow-loaded'){clearAck();if(G.noteSink)G.noteSink('ComfyUI loaded the workflow into its canvas ✓');return;}
    // verbatim from the iframe — no local guesswork about what the graph did
    if(d.type==='workflow-error'){clearAck();if(G.noteSink)G.noteSink(`ComfyUI rejected the workflow: ${d.error??'unknown error'}`);}
  });
}

// Warm the first configured endpoint shortly after page load: the frame boots HIDDEN in the
// background, so a later right-click lands on a running ComfyUI canvas instead of paying its
// cold-start minute inside the tab (the "dont force comfyui to refresh" complaint).
// Browser-only: skipped unless a real document exists (lazy-factory tests provide neither).
async function warmComfyFrame(){
  if(G.warmed)return;
  G.moduleSid=globalThis.__DSH_DIRECTOR_SESSION__||(typeof localStorage!=='undefined'?localStorage.getItem('dsh-director-session'):null)||'';
  if(!G.moduleSid)return;                                       // retry once a session is known (component mount re-fetches settings itself)
  G.warmed=true;
  try{
    const v=await apiFetch('/api/library/app-settings');
    const list=String(v?.comfy?.urls??'').split('\n').map((x)=>x.trim()).filter(Boolean);
    if(!list.length)return;
    G.hostsCache=list;
    for(const h of list){const rec=ensureFrame(h);if(rec.frame.dataset.src!==h){rec.frame.dataset.src=h;writeSrc(rec.frame,h,'warmComfyFrame +4s boot-all');}}
    G.activeHost=G.activeHost&&list.includes(G.activeHost)?G.activeHost:list[0];
  }catch{}
}
if(typeof window!=='undefined'&&typeof document!=='undefined'&&typeof document.body!=='undefined'&&typeof setTimeout==='function')setTimeout(warmComfyFrame,4000);

globalThis.__DSH_COMFY_BRIDGE__=(msg)=>{
  if(!msg)return false;
  if(msg.type!=='load-workflow'){const h=G.activeHost;return h&&G.linked.get(h)?sendBridge(h,msg):false;}
  // Send to the CURRENT sidebar ComfyUI endpoint; no tab open yet → open it and let the component boot
  // the first configured endpoint (its settings fetch owns host choice). openTab is what the harness offers.
  const h=G.activeHost;
  if(h&&G.frames.get(h)?.frame.isConnected){
    G.openTab?.();
    if(G.linked.get(h)){const ok=sendBridge(h,msg);if(ok)armAck();return ok;}
    G.pending.set(h,msg);armAck();return true;   // latest-wins: one parked load per host, delivered on hello (or the note explains)

  }
  if(!G.openTab)return false;   // no tab system available — caller falls back to clipboard/new tab
  G.deferred.push(msg);G.openTab();return true;
};

function writeSrc(f,src,why){G.srcWrites.push({t:Date.now(),src:String(src),why,stack:new Error().stack});f.src=src;}
let observed=false;
function observeRemoval(){                                    // does the APP rip our box out of the DOM? log it (turn-end re-render was the user-observed trigger)
  if(observed||typeof MutationObserver!=='function'||typeof document==='undefined')return;observed=true;
  new MutationObserver((ms)=>{for(const m of ms)for(const n of m.removedNodes)for(const [h,rec] of G.frames)if(n===rec.box){
    const t=new Date().toLocaleTimeString();
    globalThis.__DSH_FRAME_LOG__=(globalThis.__DSH_FRAME_LOG__??[]).concat([{t,host:h,event:'box-removed'}]);
    if(G.noteSink)G.noteSink(`${h}: frame box REMOVED from page DOM at ${t} (by the app, not by our code) — re-attaching`);
  }}).observe(document.body,{childList:true});
}
function ensureFrame(host){
  const livePage=typeof document!=='undefined'&&!!document.body;   // module tests run without body; creation audits are browser-only
  const rec=G.frames.get(host);
  if(rec?.frame.isConnected)return rec;
  // Harness re-renders can DETACH our body-level box; re-attach the SAME element — a detached-then-
  // re-appended iframe keeps its document (no reload). Only a truly absent frame may be created:
  // recreating what merely got detached cost the user a full 2-minute ComfyUI boot every time.
  if(rec){if(!rec.box.isConnected)document.body.appendChild(rec.box);return rec;}
  // Element CREATED while the page lives = the old box vanished invisibly (browser purge, outerHTML
  // rewrite, adopted node): the only reload path the load-counter and body-observer can't see. Make it speak.
  if(livePage){globalThis.__DSH_FRAME_LOG__=(globalThis.__DSH_FRAME_LOG__??[]).concat([{t:Date.now(),host,event:'frame-created',stack:new Error().stack}]);if(G.noteSink)G.noteSink(`${host}: a NEW ComfyUI frame element was created mid-page (old one disappeared without any src write or DOM-removal notice) — see console stack`);}
  const box=document.createElement('div');box.className='comfy-frame-floating';
  // NEVER display:none: Chrome memory-saver DISCARDS hidden iframe documents and reloads them on show —
  // the "ComfyUI refreshed out of the blue, 2 minutes gone" complaints. Off-screen-but-rendered survives.
  Object.assign(box.style,{position:'fixed',left:'-99999px',top:'0px',width:'900px',height:'700px',zIndex:'50'});
  const frame=document.createElement('iframe');frame.className='comfy-frame';frame.title='ComfyUI — '+host;
  let loads=0;
  frame.addEventListener('load',()=>{loads++;if(loads>1){
    console.warn(`[comfy-frame] ${host} load #${loads}`,new Error().stack);
    const recent=G.srcWrites.filter((w)=>Date.now()-w.t<4000);
    const verdict=recent.length?`a src write caused it: ${recent[recent.length-1].why}`:'NO src write — the browser reloaded the document itself (discard/OOM) or a removed+re-created element';
    globalThis.__DSH_FRAME_LOG__=(globalThis.__DSH_FRAME_LOG__??[]).concat([{t:Date.now(),host,n:loads,verdict}]);
    if(G.noteSink)G.noteSink(`ComfyUI (${host}) reloaded on its own: ${verdict}`);
  }});
  observeRemoval();

  box.append(frame);document.body.append(box);
  const out={box,frame};G.frames.set(host,out);return out;
}

async function apiFetch(p,init){
  const url='/director-studio'+p+(G.moduleSid?`${p.includes('?')?'&':'?'}session=${encodeURIComponent(G.moduleSid)}`:'');
  const r=await fetch(url,init);
  const v=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(v?.detail??`${p} → HTTP ${r.status}`);
  return v;
}

export function ComfyFrame({sessionId}){
  const [hosts,setHosts]=useState([]);
  const [host,setHost]=useState(()=>localStorage.getItem('dsh-comfy-host')??'');
  const [note,setNote]=useState('');
  const [linked,setLinked]=useState(()=>G.linked.get(localStorage.getItem('dsh-comfy-host')??'')??false);
  const [picker,setPicker]=useState(null);           // {reqId,kind,files,error?}
  const anchorRef=useRef(null);
  const stagingRef=useRef({});                       // slug → sidecar waiting for stage-images-done
  const sid=sessionId||globalThis.__DSH_DIRECTOR_SESSION__||(typeof localStorage!=='undefined'?localStorage.getItem('dsh-director-session'):null)||'';
  G.moduleSid=sid;
  if(sid&&typeof localStorage!=='undefined')localStorage.setItem('dsh-director-session',sid);
  if(sid)globalThis.__DSH_DIRECTOR_SESSION__=sid;

  const send=(msg)=>sendBridge(host,msg);

  useEffect(()=>{if(!sid)return;apiFetch('/api/library/app-settings').then((v)=>{
    const list=String(v?.comfy?.urls??'').split('\n').map((s)=>s.trim()).filter(Boolean);
    setHosts(list);G.hostsCache=list;setHost((h)=>h||list[0]||'');
    // User request: boot EVERY configured endpoint once (off-screen) so switching between hosts is instant —
    // each frame persists per host; only the visible one paints, the others idle in memory.
    for(const h of list){const rec=ensureFrame(h);if(rec.frame.dataset.src!==h){rec.frame.dataset.src=h;writeSrc(rec.frame,h,'boot-all-endpoints on settings load');}}
    if(!list.length)setNote('No ComfyUI endpoints configured — add them in the Studio settings gear (ComfyUI tab).');
  }).catch((e)=>setNote(`Could not read Studio settings: ${e.message}`));},[sid]);
  useEffect(()=>{if(host){localStorage.setItem('dsh-comfy-host',host);G.activeHost=host;}},[host]);
  useEffect(()=>{const cb=(h)=>{if(h===host)setLinked(true);};G.helloCbs.add(cb);if(G.linked.get(host))setLinked(true);return()=>G.helloCbs.delete(cb);},[host]);
  useEffect(()=>{G.noteSink=setNote;return()=>{if(G.noteSink===setNote)G.noteSink=null;};},[setNote]);
  // The dialog lives inside the React tab while our frame boxes are body-level z50 — without this,
  // the picker renders BEHIND ComfyUI (backdrop darkens, panel invisible). Park frames low while open.
  useEffect(()=>{for(const rec of G.frames.values())rec.box.style.zIndex=picker?'1':'50';},[picker]);

  // Persistent-frame lifecycle: point at host ONLY when the host actually changed (tab switches must not
  // re-navigate), cover the anchor rect, show; on unmount hide — never remove (removal = reload = minutes).
  useEffect(()=>{
    if(!host)return;
    const rec=ensureFrame(host);
    if(rec.frame.dataset.src!==host){rec.frame.dataset.src=host;writeSrc(rec.frame,host,'component [host] effect mount/switch');}
    const m=G.deferred.pop();   // latest-wins
    if(m){if(G.linked.get(host))sendBridge(host,m);else G.pending.set(host,m);}
    // z-index 50: above harness sidebar chrome, below our own dialogs (settings 60, picker 70)
    const sync=()=>{const a=anchorRef.current;if(!a)return;const r=a.getBoundingClientRect();for(const [h,other] of G.frames)if(other.box.isConnected)other.box.style.left=h===host?`${r.left}px`:'-99999px';if(!rec.box.isConnected)return;Object.assign(rec.box.style,{position:'fixed',left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`,zIndex:'50'});};
    sync();
    const ro=new ResizeObserver(sync);if(anchorRef.current)ro.observe(anchorRef.current);
    window.addEventListener('resize',sync);window.addEventListener('scroll',sync,true);
    const iv=setInterval(sync,1500);   // pane opens/collapses don't all resize the anchor — ponytail: cheap poll
    return()=>{ro.disconnect();window.removeEventListener('resize',sync);window.removeEventListener('scroll',sync,true);clearInterval(iv);rec.box.style.left='-99999px';};
  },[host]);

  const stageAsset=async(slug)=>{
    try{
      const items=(await Promise.all(ASSET_KINDS.map((k)=>apiFetch(`/api/library?kind=${k}`)))).flat();
      const item=items.find((a)=>a.folder===slug);
      if(!item){setNote(`No asset folder "${slug}" in the library.`);return;}
      const meta=item.ref_meta??{};
      const sidecar={slug,contract:1,updated_at:new Date().toISOString(),images:[],videos:[],audio:[],description:item.description??'',notes:item.notes??''};
      // images ride the browser lane: the extension (same-origin inside the iframe) fetches these URLs and POSTs /upload/image
      const local=[];
      for(const [key,abs] of Object.entries(item.paths??{})){
        const name=String(abs).split(/[\\/]/).pop(),m=meta[key]??{};
        const rec={key,file:`dsh/${name}`,tags:m.tags??[],note:m.note??''};
        if(IMAGE_RE.test(name)){
          local.push({name,url:abs,url2:`${location.origin}/director-studio/api/file?path=${encodeURIComponent(abs)}&session=${encodeURIComponent(sid)}`});
          sidecar.images.push(rec);
        }else{
          // footage/audio move by the server relay — the Comfy box can never reach 127.0.0.1:3081 itself
          const v=await apiFetch('/api/comfy-upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:abs,comfy_origin:host})});
          rec.file=`${v.subfolder}/${v.name}`;
          (AUDIO_RE.test(name)?sidecar.audio:sidecar.videos).push(rec);
        }
      }
      if(local.length&&local.every((it)=>send({type:'stage-file',name:it.name,url:it.url2}))){
        // handshake as SHIPPED in dsh_link.js (v1.2): one stage-file per image, stage-done back per name, then staged
        stagingRef.current[slug]={sidecar,pending:new Set(local.map((it)=>it.name)),failed:0};
        setNote(`Staging "${slug}": ${local.length} image(s) via browser relay, ${sidecar.videos.length+sidecar.audio.length} via server relay.`);
      }else{
        for(const it of local)try{await apiFetch('/api/comfy-upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:it.url,comfy_origin:host})});}catch{}
        send({type:'staged',slug,payload:sidecar});setNote(`Staged "${slug}" (${sidecar.images.length+sidecar.videos.length+sidecar.audio.length} files).`);
      }
    }catch(e){setNote(`stage-asset "${slug}" failed: ${e.message}`);}
  };

  const openPicker=async(reqId,kind)=>{
    try{const v=await apiFetch(`/api/${kind==='footage'?'footage':'images'}`);setPicker({reqId,kind,files:v.files??[]});}
    catch(e){setPicker({reqId,kind,files:[],error:String(e.message||e)});}
  };
  const resolvePick=(file)=>{
    const p=picker;setPicker(null);
    if(file===null)return;
    void (async()=>{
      try{
        // library payloads carry the absolute path inside their same-origin file url
        const abs=new URL(file.url,location.origin).searchParams.get('path')??file.path;
        const v=await apiFetch('/api/comfy-upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:abs,comfy_origin:host})});
        // v1.2: pick-result.file is the BARE name — the iframe sets the combo to INIF+"/"+file (double prefix otherwise)
        send({type:'pick-result',reqId:p.reqId,file:v.name});
        setNote(`Picked ${v.subfolder}/${v.name} for the node.`);
      }catch(e){send({type:'pick-result',reqId:p.reqId,file:null});setNote(`Pick failed: ${e.message}`);}
    })();
  };

  useEffect(()=>{
    const onMsg=(e)=>{
      const d=e.data;if(!d||d.ns!==NS||d.v!==V)return;
      const o=originOf(host);if(!o||e.origin!==o)return;   // only from the currently embedded host
      if(d.type==='bridge-hello'||d.type==='workflow-loaded'||d.type==='workflow-error')return;   // module scope owns these
      if(d.type==='library-request'){
        const k=d.kind;
        const grab=k==='assets'?Promise.all(ASSET_KINDS.map((kind)=>apiFetch(`/api/library?kind=${kind}`).then((items)=>({kind,items})))).then((kinds)=>({kinds}))
          :apiFetch(`/api/${k==='images'?'images':'footage'}`);
        void grab.then((payload)=>send({type:'library-data',kind:k,payload})).catch((err)=>setNote(`library-request ${k}: ${err.message}`));
        return;}
      if(d.type==='stage-asset'){void stageAsset(String(d.slug??''));return;}
      if(d.type==='pick-request'){void openPicker(d.reqId,String(d.kind??'images'));return;}
      if(d.type==='stage-done'||d.type==='stage-error'){
        // stage-file handshake replies carry only the file name — find the slug owning it (ponytail: linear scan, few concurrent stagings)
        for(const [slug,st] of Object.entries(stagingRef.current)){
          if(!st.pending?.has(d.name))continue;
          st.pending.delete(d.name);if(d.type==='stage-error')st.failed++;
          if(!st.pending.size){delete stagingRef.current[slug];send({type:'staged',slug,payload:st.sidecar});setNote(`Staged "${slug}" for ComfyUI${st.failed?` (${st.failed} image(s) failed)`:''}.`);}
          return;}
        return;}
    };
    window.addEventListener('message',onMsg);return()=>window.removeEventListener('message',onMsg);
  },[hosts,host,sid]);

  const switchHost=(h)=>{if(h===host)return;setHost(h);G.linked.set(h,false);setLinked(false);stagingRef.current={};};

  return <div className="comfy-frame-tab">
    <div className="comfy-frame-bar">
      {hosts.map((h)=><button key={h} type="button" className={`btn sm ${h===host?'primary':'ghost'}`} style={h===host?{color:'#ff8c3b',fontWeight:700}:undefined} onClick={()=>switchHost(h)}>{h.replace(/^https?:\/\//,'')}</button>)}
      {!hosts.length?<span className="muted tiny">no endpoints — set them in Studio settings (gear → ComfyUI)</span>:null}
      <button type="button" className="btn ghost sm" title="Reload this endpoint's frame" onClick={()=>{const f=G.frames.get(host)?.frame;if(f){G.linked.set(host,false);setLinked(false);f.dataset.src='';writeSrc(f,'about:blank','user clicked reload button');writeSrc(f,host,'user clicked reload button');}}}>⟳</button>
      <span className="muted tiny" title="client build running in this page — if it disagrees with the shipped version, the page has NOT reloaded yet">v{__DSH_VERSION__}</span>
      <span className="muted tiny" title={linked?'set by the dsh-studio-link extension inside ComfyUI':'If this never flips to ✓: open ComfyUI settings (gear) inside the frame, find DSHStudio.comfyOrigin, set it to '+location.origin+' , then hit ⟳ — see BRIDGE_CONTRACT v1.3'}>{linked?'bridge ✓':'awaiting dsh-studio-link bridge-hello…'}</span>
    </div>
    <div ref={anchorRef} className="comfy-frame-anchor"/>
    {note?<div className="comfy-frame-note">{note}</div>:null}
    {picker?<div className="comfy-picker-backdrop" onClick={()=>{const p=picker;setPicker(null);send({type:'pick-result',reqId:p.reqId,file:null});}}>
      <div className="comfy-picker" onClick={(e)=>e.stopPropagation()}>
        <div className="comfy-picker-head"><span>Pick {picker.kind} from Director Studio</span><button type="button" className="btn ghost sm" onClick={()=>{const p=picker;setPicker(null);send({type:'pick-result',reqId:p.reqId,file:null});}}>✕</button></div>
        <div className="comfy-picker-grid">{(picker.files??[]).map((f)=><button type="button" key={f.path} className="comfy-pick-card" title={f.path} onClick={()=>resolvePick(f)}>{<img src={f.thumb??f.url} alt="" loading="lazy" draggable="false"/>}<span>{f.name}</span></button>)}</div>
        {picker.error?<div className="comfy-frame-note">{picker.error}</div>:null}
      </div>
    </div>:null}
  </div>;
}
