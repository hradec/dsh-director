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
const floatFrames=new Map();         // host URL → {box,frame}
const bridgeLinked=new Map();        // host URL → the extension said bridge-hello

let activeHost=(typeof localStorage!=='undefined'?localStorage.getItem('dsh-comfy-host'):null)??'';   // last-used endpoint, even while the tab is closed
let hostsCache=[];                                            // for bridge-ready payloads
const pendingLoad=new Map();                                  // host → queued load-workflow msgs awaiting bridge-hello
const helloCbs=new Set();
const deferred=[];                                            // workflows awaiting the first ComfyUI tab mount
let openComfyTab=null;                                        // set by index.jsx from ctx.sidebarRight.openTab
export function setComfyTabOpener(fn){openComfyTab=fn;}

function sendBridge(h,msg){
  const frame=floatFrames.get(h)?.frame,o=originOf(h);
  if(!frame?.isConnected||!o)return false;
  frame.contentWindow?.postMessage({ns:NS,v:V,...msg},o);return true;
}

function markHello(h){
  bridgeLinked.set(h,true);
  sendBridge(h,{type:'bridge-ready',hosts:hostsCache});
  const q=pendingLoad.get(h);
  if(q){pendingLoad.delete(h);for(const m of q)sendBridge(h,m);}
  for(const cb of helloCbs)cb(h);
}

// Right-click "Open in ComfyUI" lane — lives at module scope so it answers even when the sidebar
// ComfyUI tab is closed: the endpoint's frame is kept alive after first visit, or booted hidden on demand.
// hello catcher (module scope so closed-tab frames still register), DOM-guarded: importing the
// bundle must not execute UI side effects — build.test pins that invariant.
if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){
  window.addEventListener('message',(e)=>{
    const d=e.data;if(!d||d.ns!==NS||d.v!==V||d.type!=='bridge-hello')return;
    const h=activeHost,o=originOf(h);if(o&&e.origin===o)markHello(h);
  });
}

globalThis.__DSH_COMFY_BRIDGE__=(msg)=>{
  if(!msg)return false;
  if(msg.type!=='load-workflow'){const h=activeHost;return h&&bridgeLinked.get(h)?sendBridge(h,msg):false;}
  // Send to the CURRENT sidebar ComfyUI endpoint; no tab open yet → open it and let the component boot
  // the first configured endpoint (its settings fetch owns host choice). openTab is what the harness offers.
  const h=activeHost;
  if(h&&floatFrames.get(h)?.frame.isConnected){
    openComfyTab?.();
    if(bridgeLinked.get(h))return sendBridge(h,msg);
    const q=pendingLoad.get(h)??[];q.push(msg);pendingLoad.set(h,q);return true;   // frame booting — deliver on hello
  }
  if(!openComfyTab)return false;   // no tab system available — caller falls back to clipboard/new tab
  deferred.push(msg);openComfyTab();return true;
};

function ensureFrame(host){
  const rec=floatFrames.get(host);
  if(rec?.frame.isConnected)return rec;
  const box=document.createElement('div');box.className='comfy-frame-floating';box.style.display='none';
  const frame=document.createElement('iframe');frame.className='comfy-frame';frame.title='ComfyUI — '+host;
  box.append(frame);document.body.append(box);
  const out={box,frame};floatFrames.set(host,out);return out;
}

async function apiFetch(p,init){
  const r=await fetch('/director-studio'+p,init);
  const v=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(v?.detail??`${p} → HTTP ${r.status}`);
  return v;
}

export function ComfyFrame({sessionId}){
  const [hosts,setHosts]=useState([]);
  const [host,setHost]=useState(()=>localStorage.getItem('dsh-comfy-host')??'');
  const [note,setNote]=useState('');
  const [linked,setLinked]=useState(()=>bridgeLinked.get(localStorage.getItem('dsh-comfy-host')??'')??false);
  const [picker,setPicker]=useState(null);           // {reqId,kind,files,error?}
  const anchorRef=useRef(null);
  const stagingRef=useRef({});                       // slug → sidecar waiting for stage-images-done
  const sid=sessionId??globalThis.__DSH_DIRECTOR_SESSION__??'';

  const send=(msg)=>sendBridge(host,msg);

  useEffect(()=>{apiFetch('/api/library/app-settings').then((v)=>{
    const list=String(v?.comfy?.urls??'').split('\n').map((s)=>s.trim()).filter(Boolean);
    setHosts(list);hostsCache=list;setHost((h)=>h||list[0]||'');
    if(!list.length)setNote('No ComfyUI endpoints configured — add them in the Studio settings gear (ComfyUI tab).');
  }).catch((e)=>setNote(`Could not read Studio settings: ${e.message}`));},[]);
  useEffect(()=>{if(host){localStorage.setItem('dsh-comfy-host',host);activeHost=host;}},[host]);
  useEffect(()=>{const cb=(h)=>{if(h===host)setLinked(true);};helloCbs.add(cb);if(bridgeLinked.get(host))setLinked(true);return()=>helloCbs.delete(cb);},[host]);

  // Persistent-frame lifecycle: point at host ONLY when the host actually changed (tab switches must not
  // re-navigate), cover the anchor rect, show; on unmount hide — never remove (removal = reload = minutes).
  useEffect(()=>{
    if(!host)return;
    const rec=ensureFrame(host);
    if(rec.frame.dataset.src!==host){rec.frame.dataset.src=host;rec.frame.src=host;}
    if(deferred.length){
      const q=deferred.splice(0);
      for(const m of q){if(bridgeLinked.get(host))sendBridge(host,m);else{const p=pendingLoad.get(host)??[];p.push(m);pendingLoad.set(host,p);}}
    }
    // z-index 50: above harness sidebar chrome, below our own dialogs (settings 60, picker 70)
    const sync=()=>{const a=anchorRef.current;if(!a)return;const r=a.getBoundingClientRect();for(const [h,other] of floatFrames)if(other.box.isConnected)other.box.style.display=h===host?'block':'none';if(!rec.box.isConnected)return;Object.assign(rec.box.style,{position:'fixed',left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`,zIndex:'50'});};
    sync();
    const ro=new ResizeObserver(sync);if(anchorRef.current)ro.observe(anchorRef.current);
    window.addEventListener('resize',sync);window.addEventListener('scroll',sync,true);
    const iv=setInterval(sync,1500);   // pane opens/collapses don't all resize the anchor — ponytail: cheap poll
    return()=>{ro.disconnect();window.removeEventListener('resize',sync);window.removeEventListener('scroll',sync,true);clearInterval(iv);rec.box.style.display='none';};
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
      if(d.type==='bridge-hello')return;   // handled at module scope (markHello)
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

  const switchHost=(h)=>{if(h===host)return;setHost(h);bridgeLinked.set(h,false);setLinked(false);stagingRef.current={};};

  return <div className="comfy-frame-tab">
    <div className="comfy-frame-bar">
      {hosts.map((h)=><button key={h} type="button" className={`btn sm ${h===host?'primary':'ghost'}`} onClick={()=>switchHost(h)}>{h.replace(/^https?:\/\//,'')}</button>)}
      {!hosts.length?<span className="muted tiny">no endpoints — set them in Studio settings (gear → ComfyUI)</span>:null}
      <button type="button" className="btn ghost sm" title="Reload this endpoint's frame" onClick={()=>{const f=floatFrames.get(host)?.frame;if(f){bridgeLinked.set(host,false);setLinked(false);f.src='about:blank';f.dataset.src='';f.src=host;}}}>⟳</button>
      <span className="muted tiny" title="set by the dsh-studio-link extension inside ComfyUI">{linked?'bridge ✓':'awaiting dsh-studio-link bridge-hello…'}</span>
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
