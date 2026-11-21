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
  const [view,setView]=useState('edit'); // 'edit' = WeftCut engine, 'board' = legacy
  const [ready,setReady]=useState(false);
  const [note,setNote]=useState('');
  const [edits,setEdits]=useState([]);
  const [currentId,setCurrentId]=useState('');
  const loadEdits=useCallback(async()=>{
    const r=await apiFetch('/api/editing');
    if(!r.ok)return null;
    const list=(await r.json()).editing??[];
    return list.slice().sort((a,b)=>String(b.updated_at??'').localeCompare(String(a.updated_at??'')));
  },[]);
  const mountEdit=useCallback(async entry=>{
    if(!globalThis.DSH_TIMELINE){
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src='/director-studio/timeline-engine.js';s.onload=res;s.onerror=()=>rej(new Error('engine script unavailable'));document.head.appendChild(s);});
    }
    if(globalThis.DSH_TIMELINE&&hostRef.current){
      globalThis.DSH_TIMELINE.unmount(hostRef.current); // idempotent; fresh mount for the new edit
      globalThis.DSH_TIMELINE.mount(hostRef.current,{editingId:entry.id,apiBase:'/director-studio',session:globalThis.__DSH_DIRECTOR_SESSION__??''});
      setCurrentId(entry.id);setReady(true);
      try{sessionStorage.setItem(LAST_EDIT_KEY,entry.id);}catch{/* private mode */}
    }
  },[]);
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
    return()=>{disposed=true;if(globalThis.DSH_TIMELINE&&hostRef.current)globalThis.DSH_TIMELINE.unmount(hostRef.current);};
  },[loadEdits,mountEdit]);
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
