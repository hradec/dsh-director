import {useCallback,useEffect,useRef,useState} from 'react';
import {fetch as apiFetch} from './fetch-inject.mjs';
import {TimelineBoard} from './TimelineBoard.jsx';

// The Timeline tab: real WeftCut NLE timeline (vendored engine, own React 19
// bundle) over the Editing library, with the legacy shot board as a fallback
// view while the server half awaits the harness restart.
// The picker lists every catalog edit with its derived tags (shot-/sequence-/
// episode-), so an edit is opened BY TAG — the same tags agents query with
// edit.find. The chosen edit is remembered per session (sessionStorage) so
// sidebar tab switches return to it instead of the most recent one.
const jsonFetch=(path,init)=>apiFetch(path,init&&{...init,headers:{'content-type':'application/json',...(init.headers??{})}});
const LAST_EDIT_KEY='dsh-director.timeline-edit';

export function TimelineStudio(){
  const hostRef=useRef(null);
  const mountedRef=useRef(null); // {el,api}: the element the engine root is bound to RIGHT NOW
  const [view,setView]=useState('edit'); // 'edit' = WeftCut engine, 'board' = legacy
  const [ready,setReady]=useState(false);
  const [note,setNote]=useState('');
  const [edits,setEdits]=useState([]);
  const [currentId,setCurrentId]=useState('');
  const unmountEngine=useCallback(()=>{
    const m=mountedRef.current;
    if(m){m.api.unmount(m.el);mountedRef.current=null;}
  },[]);
  const loadEdits=useCallback(async()=>{
    const r=await apiFetch('/api/editing');
    if(!r.ok)return null;
    const list=(await r.json()).editing??[];
    return list.slice().sort((a,b)=>String(b.updated_at??'').localeCompare(String(a.updated_at??'')));
  },[]);
  const mountEdit=useCallback(async entry=>{
    const host=hostRef.current;
    if(!host)return;
    // Realm alignment: the Studio panel hosts its DOM in an IFRAME. The engine's
    // vendored gesture code listens on ITS OWN realm's window — loaded into the
    // top frame it never sees pointermove from the iframe document, which kills
    // playhead scrubbing and clip drags. Load + run the engine in the host
    // element's own document.
    const doc=host.ownerDocument;const win=doc&&doc.defaultView;
    if(win&&!win.DSH_TIMELINE){
      await new Promise((res,rej)=>{const s=doc.createElement('script');s.src='/director-studio/timeline-engine.js';s.onload=res;s.onerror=()=>rej(new Error('engine script unavailable'));doc.head.appendChild(s);});
    }
    const api=(win&&win.DSH_TIMELINE)||globalThis.DSH_TIMELINE;
    if(api&&host.isConnected){ // view may have toggled while the script loaded
      unmountEngine(); // previous edit lived on its own element; release it (Pixi tickers keep running on detached nodes)
      api.unmount(host); // idempotent; fresh mount for the new edit
      api.mount(host,{editingId:entry.id,apiBase:'/director-studio',session:globalThis.__DSH_DIRECTOR_SESSION__??''});
      mountedRef.current={el:host,api};
      setCurrentId(entry.id);setReady(true);
      try{sessionStorage.setItem(LAST_EDIT_KEY,entry.id);}catch{/* private mode */}
    }
  },[unmountEngine]);
  useEffect(()=>{
    let disposed=false;
    (async()=>{
      let list=await loadEdits();
      if(list===null){if(!disposed){setView('board');setNote('Editing library not live on this server yet — it activates at the next harness restart. Showing the shot board meanwhile.');}return;}
      if(!list.length){
        const c=await jsonFetch('/api/editing',{method:'POST',body:JSON.stringify({name:'edit 1'})});
        const created=(await c.json());const entry=created.id?created:created.editing;
        if(entry)list=[entry];
      }
      if(disposed||!list.length)return;
      let remembered=null;
      try{remembered=sessionStorage.getItem(LAST_EDIT_KEY);}catch{}
      const entry=list.find(item=>item.id===remembered)??list[0];
      setEdits(list);
      await mountEdit(entry);
    })().catch(()=>{if(!disposed){setView('board');setNote('Timeline engine unavailable — showing the shot board.');}});
    return()=>{disposed=true;unmountEngine();};
  },[loadEdits,mountEdit,unmountEngine]);
  // View switches replace the host div (conditional render), so the engine must
  // remount onto the new one when returning, and must be released when leaving:
  // a React root on a detached element keeps Pixi tickers + observers alive.
  useEffect(()=>{
    if(view!=='edit'){unmountEngine();return;}
    const entry=edits.find(item=>item.id===currentId);
    if(entry&&hostRef.current&&mountedRef.current?.el!==hostRef.current)void mountEdit(entry);
  },[view,currentId,edits,mountEdit,unmountEngine]);
  const switchEdit=useCallback(async id=>{
    const entry=edits.find(item=>item.id===id);
    if(entry)await mountEdit(entry);
  },[edits,mountEdit]);
  const newEdit=useCallback(async()=>{
    const c=await jsonFetch('/api/editing',{method:'POST',body:JSON.stringify({name:`edit ${edits.length+1}`})});
    const created=(await c.json());const entry=created.id?created:created.editing;
    if(entry){setEdits(list=>[entry,...list]);await mountEdit(entry);}
  },[edits.length,mountEdit]);
  const current=edits.find(item=>item.id===currentId);
  // dockview sizes itself off an explicit height: the Studio tab body is an
  // auto-height scroll container, so `height:100%` collapses the whole dock.
  // Measure the host's real top edge instead of guessing a header offset.
  const [hostH,setHostH]=useState(480);
  useEffect(()=>{
    if(view!=='edit')return;
    const update=()=>{const el=hostRef.current;if(!el)return;setHostH(Math.max(420,window.innerHeight-el.getBoundingClientRect().top-12));};
    update();
    window.addEventListener('resize',update);
    const t=setInterval(update,800); // toolbar/panel chrome changes have no resize event
    return()=>{window.removeEventListener('resize',update);clearInterval(t);};
  },[view,currentId]);
  return <div style={{display:'flex',flexDirection:'column',height:'100%',minHeight:0}}>
    <div style={{display:'flex',gap:8,alignItems:'center',padding:'6px 10px',flex:'0 0 auto'}}>
      <button className={view==='edit'?'btn primary sm':'btn ghost sm'} onClick={()=>setView('edit')} disabled={!ready}>Edit {current?`“${current.name}”`:''}</button>
      <button className={view==='board'?'btn primary sm':'btn ghost sm'} onClick={()=>setView('board')}>Shot board</button>
      {ready&&<select value={currentId} onChange={event=>switchEdit(event.target.value)} title="Open an edit by name or tag (tags are derived from the layers' shot/sequence/episode)" style={{fontSize:'.78rem',padding:'2px 6px',maxWidth:'26rem'}}>
        {edits.map(item=><option key={item.id} value={item.id}>{item.name}{(item.tags??[]).length?` — ${(item.tags??[]).join(' ')}`:''}</option>)}
      </select>}
      {ready&&<button className="btn ghost sm" onClick={newEdit}>+ New edit</button>}
      {note&&<span style={{opacity:.7,fontSize:12}}>{note}</span>}
    </div>
    {view==='edit'&&<div ref={hostRef} style={{flex:'1 1 auto',minHeight:0,position:'relative',height:hostH}}/>}
    {view==='board'&&<div style={{flex:'1 1 auto',minHeight:0,overflow:'auto'}}><TimelineBoard/></div>}
  </div>;
}
