import {useCallback,useEffect,useRef,useState} from 'react';
import {fetch as apiFetch} from './fetch-inject.mjs';
import {TimelineBoard} from './TimelineBoard.jsx';

// The Timeline tab: real WeftCut NLE timeline (vendored engine, own React 19
// bundle) over the Editing library, with the legacy shot board as a fallback
// view while the server half awaits the harness restart.
// ponytail: opens the most recently updated edit; upgrade path is tag-scoped
// selection (edit.find by the active episode/sequence tags).
const jsonFetch=(path,init)=>apiFetch(path,init&&{...init,headers:{'content-type':'application/json',...(init.headers??{})}});

export function TimelineStudio(){
  const hostRef=useRef(null);
  const [view,setView]=useState('edit'); // 'edit' = WeftCut engine, 'board' = legacy
  const [ready,setReady]=useState(false);
  const [note,setNote]=useState('');
  const [editName,setEditName]=useState('');
  const loadEngine=useCallback(async()=>{
    let entry=null;
    try{
      const r=await apiFetch('/api/editing');
      if(!r.ok)return null;
      const list=(await r.json()).editing??[];
      entry=list.slice().sort((a,b)=>String(b.updated_at??'').localeCompare(String(a.updated_at??'')))[0]??null;
      if(!entry){const c=await jsonFetch('/api/editing',{method:'POST',body:JSON.stringify({name:'edit 1'})});entry=(await c.json());entry=entry.id?entry:entry.editing;}
    }catch{return null;}
    if(!entry)return null;
    if(!globalThis.DSH_TIMELINE){
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src='/director-studio/timeline-engine.js';s.onload=res;s.onerror=()=>rej(new Error('engine script unavailable'));document.head.appendChild(s);});
    }
    return entry;
  },[]);
  useEffect(()=>{
    let disposed=false;
    loadEngine().then(entry=>{
      if(disposed)return;
      if(entry&&globalThis.DSH_TIMELINE&&hostRef.current){
        globalThis.DSH_TIMELINE.mount(hostRef.current,{editingId:entry.id,apiBase:'/director-studio',session:globalThis.__DSH_DIRECTOR_SESSION__??''});
        setEditName(entry.name??'edit');setReady(true);
      }else{
        setView('board');
        setNote('Editing library not live on this server yet — it activates at the next harness restart. Showing the shot board meanwhile.');
      }
    });
    return()=>{disposed=true;if(globalThis.DSH_TIMELINE&&hostRef.current)globalThis.DSH_TIMELINE.unmount(hostRef.current);};
  },[loadEngine]);
  return <div style={{display:'flex',flexDirection:'column',height:'100%',minHeight:0}}>
    <div style={{display:'flex',gap:8,alignItems:'center',padding:'6px 10px',flex:'0 0 auto'}}>
      <button className={view==='edit'?'btn primary sm':'btn ghost sm'} onClick={()=>setView('edit')} disabled={!ready}>Edit {editName?`“${editName}”`:''}</button>
      <button className={view==='board'?'btn primary sm':'btn ghost sm'} onClick={()=>setView('board')}>Shot board</button>
      {note&&<span style={{opacity:.7,fontSize:12}}>{note}</span>}
    </div>
    {view==='edit'&&<div ref={hostRef} style={{flex:'1 1 auto',minHeight:0,position:'relative'}}/>}
    {view==='board'&&<div style={{flex:'1 1 auto',minHeight:0,overflow:'auto'}}><TimelineBoard/></div>}
  </div>;
}
