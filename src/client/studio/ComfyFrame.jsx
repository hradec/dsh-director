// Sidebar "ComfyUI" tab — dsh-director half of the dsh-studio bridge (BRIDGE_CONTRACT.md v1).
// Renders the ComfyUI web app in an iframe (verified embeddable: no frame-blocking headers) and carries the
// parent side of the postMessage contract: bridge-ready, library-data, the stage-asset handshake, the node
// picker (pick-request/pick-result) and load-workflow targeting for right-click "Open in ComfyUI".
import {useEffect,useRef,useState} from 'react';
import React from 'react';

const NS='dsh-studio',V=1;
const IMAGE_RE=/\.(png|jpe?g|webp|gif|bmp)$/i,AUDIO_RE=/\.(wav|mp3|flac|ogg|m4a)$/i;
const ASSET_KINDS=['actors','scenes','props','costumes','layouts','voices'];

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
  const [linked,setLinked]=useState(false);          // the dsh-studio-link extension said bridge-hello
  const [picker,setPicker]=useState(null);           // {reqId,kind,files,error?}
  const frameRef=useRef(null);
  const stagingRef=useRef({});                       // slug → sidecar waiting for stage-images-done
  const sid=sessionId??globalThis.__DSH_DIRECTOR_SESSION__??'';

  const originOf=(h)=>{try{return new URL(h).origin;}catch{return ''};};
  const send=(msg)=>{const w=frameRef.current?.contentWindow,o=originOf(host);if(!w||!o)return false;w.postMessage({ns:NS,v:V,...msg},o);return true;};

  useEffect(()=>{apiFetch('/api/library/app-settings').then((v)=>{
    const list=String(v?.comfy?.urls??'').split('\n').map((s)=>s.trim()).filter(Boolean);
    setHosts(list);setHost((h)=>h||list[0]||'');
    if(!list.length)setNote('No ComfyUI endpoints configured — add them in the Studio settings gear (ComfyUI tab).');
  }).catch((e)=>setNote(`Could not read Studio settings: ${e.message}`));},[]);
  useEffect(()=>{if(host)localStorage.setItem('dsh-comfy-host',host);},[host]);

  const stageAsset=async(slug)=>{
    try{
      const items=(await Promise.all(ASSET_KINDS.map((k)=>apiFetch(`/api/library?kind=${k}`)))).flat();
      const item=items.find((a)=>a.folder===slug);
      if(!item){setNote(`No asset folder "${slug}" in the library.`);return;}
      const meta=item.ref_meta??{};
      const sidecar={slug,contract:1,updated_at:new Date().toISOString(),images:[],videos:[],audio:[],description:item.description??'',notes:item.notes??''};
      const local=[];   // images ride the browser lane: the extension (same-origin inside the iframe) fetches these URLs and POSTs /upload/image
      for(const [key,abs] of Object.entries(item.paths??{})){
        const name=String(abs).split(/[\\/]/).pop(),m=meta[key]??{};
        const rec={key,file:`dsh/${name}`,tags:m.tags??[],note:m.note??''};
        if(IMAGE_RE.test(name)){
          local.push({...rec,url:`${location.origin}/director-studio/api/file?path=${encodeURIComponent(abs)}&session=${encodeURIComponent(sid)}`});
          sidecar.images.push(rec);
        }else{
          // footage/audio move by the server relay — the Comfy box can never reach 127.0.0.1:3081 itself
          const v=await apiFetch('/api/comfy-upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:abs,comfy_origin:host})});
          rec.file=`${v.subfolder}/${v.name}`;
          (AUDIO_RE.test(name)?sidecar.audio:sidecar.videos).push(rec);
        }
      }
      if(local.length&&send({type:'stage-images',slug,items:local})){stagingRef.current[slug]=sidecar;setNote(`Staging "${slug}": ${local.length} image(s) via browser relay, ${sidecar.videos.length+sidecar.audio.length} via server relay.`);}
      else{send({type:'staged',slug,payload:sidecar});setNote(`Staged "${slug}" (${sidecar.images.length+sidecar.videos.length+sidecar.audio.length} files).`);}
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
        send({type:'pick-result',reqId:p.reqId,file:`${v.subfolder}/${v.name}`});
        setNote(`Picked ${v.subfolder}/${v.name} for the node.`);
      }catch(e){send({type:'pick-result',reqId:p.reqId,file:null});setNote(`Pick failed: ${e.message}`);}
    })();
  };

  useEffect(()=>{
    const onMsg=(e)=>{
      const d=e.data;if(!d||d.ns!==NS||d.v!==V)return;
      const o=originOf(host);if(!o||e.origin!==o)return;   // only from the currently embedded host
      if(d.type==='bridge-hello'){setLinked(true);send({type:'bridge-ready',hosts});return;}
      if(d.type==='library-request'){
        const k=d.kind;
        const grab=k==='assets'?Promise.all(ASSET_KINDS.map((kind)=>apiFetch(`/api/library?kind=${kind}`).then((items)=>({kind,items})))).then((kinds)=>({kinds}))
          :apiFetch(`/api/${k==='images'?'images':'footage'}`);
        void grab.then((payload)=>send({type:'library-data',kind:k,payload})).catch((err)=>setNote(`library-request ${k}: ${err.message}`));
        return;}
      if(d.type==='stage-asset'){void stageAsset(String(d.slug??''));return;}
      if(d.type==='pick-request'){void openPicker(d.reqId,String(d.kind??'images'));return;}
      if(d.type==='stage-images-done'){
        const st=stagingRef.current[d.slug];delete stagingRef.current[d.slug];
        if(st)send({type:'staged',slug:d.slug,payload:st});
        setNote(`Staged "${d.slug}" for ComfyUI${(d.failed??[]).length?` (${d.failed.length} image(s) failed)`:''}.`);
        return;}
    };
    window.addEventListener('message',onMsg);return()=>window.removeEventListener('message',onMsg);
  },[hosts,host,sid]);

  // Right-click "Open in ComfyUI" in Footage/Images/Assets boards calls this when the tab is mounted and linked:
  // the graph loads directly in the embedded ComfyUI instead of the clipboard+new-tab dance.
  useEffect(()=>{
    globalThis.__DSH_COMFY_BRIDGE__=(msg)=>{if(!linked||!host)return false;return send(msg);};
    return()=>{delete globalThis.__DSH_COMFY_BRIDGE__;};
  },[linked,host]);

  const switchHost=(h)=>{setHost(h);setLinked(false);stagingRef.current={};};

  return <div className="comfy-frame-tab">
    <div className="comfy-frame-bar">
      {hosts.map((h)=><button key={h} type="button" className={`btn sm ${h===host?'primary':'ghost'}`} onClick={()=>switchHost(h)}>{h.replace(/^https?:\/\//,'')}</button>)}
      {!hosts.length?<span className="muted tiny">no endpoints — set them in Studio settings (gear → ComfyUI)</span>:null}
      <button type="button" className="btn ghost sm" title="Reload the embedded ComfyUI" onClick={()=>{setLinked(false);frameRef.current?.contentWindow?.location.replace(host);}}>⟳</button>
      <span className="muted tiny" title="set by the dsh-studio-link extension inside ComfyUI">{linked?'bridge ✓':'awaiting dsh-studio-link bridge-hello…'}</span>
    </div>
    {host?<iframe ref={frameRef} className="comfy-frame" title="ComfyUI" src={host}/>:<div className="footage-empty">No ComfyUI endpoint selected.</div>}
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
