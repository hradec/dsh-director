import {useCallback,useEffect,useMemo,useState} from 'react';
import {fetch as apiFetch} from './fetch-inject.mjs';

// Footage board: every video under <workspace>/media/ (recursive) as a card. Group order:
// library-asset tag groups, then permanent custom tag groups (✕ deletes), then "Other" (videos in no group).
// The filter matches tags live and expands groups containing matches; "+" turns the filter text into a permanent group.
// ponytail: group membership is pure tag matching — a video joins a group when one of its tags equals the group name (lowercased).

const hasTag=(file,name)=>(file.tags??[]).some((t)=>String(t).toLowerCase()===String(name).toLowerCase());
// The file url carries the on-disk absolute path in its ?path= param — that is what "copy path" puts on the clipboard.
const fsPath=(file)=>{try{const p=new URL(file.url,location.origin).searchParams.get('path');return p?decodeURIComponent(p):file.url;}catch{return file.url;}};

export function FootageBoard(){
  const [data,setData]=useState(null);
  const [error,setError]=useState('');
  const [filter,setFilter]=useState('');
  const [open,setOpen]=useState({});            // group id → manual expand/collapse; absent = automatic
  const [tagDrafts,setTagDrafts]=useState({});  // file path → "+ tag" draft
  const [importPath,setImportPath]=useState('');
  const [notice,setNotice]=useState('');
  const [playing,setPlaying]=useState(null);    // card open in the fullscreen player
  const [menu,setMenu]=useState(null);          // right-click menu {x,y,file}
  const load=useCallback(()=>apiFetch('/api/footage').then((r)=>r.ok?r.json():Promise.reject(Error(`footage API ${r.status}`))).then((v)=>{setData(v);setError('');}).catch((e)=>setError(`${e.message} — the running DSH service may need a restart (when idle) to enable it.`)),[]);
  useEffect(()=>{load();},[load]);
  const post=(path,method,body)=>apiFetch(path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(async(r)=>{const v=await r.json().catch(()=>null);return r.ok?v:Promise.reject(Error(`${method} ${path} → ${r.status}`));});
  const setTags=async(path,tagsBody)=>{
    try{const v=await post('/api/footage/refs','PUT',{path,...tagsBody});if(v?.tags)setData((d)=>({...d,files:(d?.files??[]).map((f)=>f.path===path?{...f,tags:v.tags}:f)}));}
    catch(e){setError(String(e.message||e));}
  };
  const addTag=async(path)=>{const tag=(tagDrafts[path]??'').trim();if(!tag)return;setTagDrafts((d)=>({...d,[path]:''}));await setTags(path,{tags_add:[tag]});};
  const removeTag=(path,tag)=>void setTags(path,{tags_remove:[tag]});
  const addGroup=async()=>{
    const name=filter.trim();if(!name)return;
    try{const v=await post('/api/footage/group','POST',{name});if(v?.groups)setData((d)=>({...d,groups:v.groups}));setOpen((o)=>({...o,[`g:${name}`]:true}));setNotice(`Group “${name}” created — every video tagged ${name} is in it.`);}
    catch(e){setError(String(e.message||e));}
  };
  const deleteGroup=async(name)=>{
    try{const v=await post('/api/footage/group','DELETE',{name});if(v?.groups)setData((d)=>({...d,groups:v.groups}));}
    catch(e){setError(String(e.message||e));}
  };
  const importVideo=async()=>{
    const path=importPath.trim();if(!path)return;
    try{const v=await post('/api/footage','POST',{path,tags:[]});setNotice(v?.skipped==='same bytes'?'Skipped — identical bytes already in media/.':`Imported ${v?.file?.path??path}`);setImportPath('');load();}
    catch(e){setError(String(e.message||e));}
  };
  const importFolder=async()=>{
    const path=importPath.trim();if(!path)return;
    try{const v=await post('/api/footage/folder','POST',{path});setNotice(`Folder import added ${v?.added??0} video(s).`);setImportPath('');load();}
    catch(e){setError(String(e.message||e));}
  };
  const copyPath=async(file)=>{
    try{await navigator.clipboard.writeText(fsPath(file));setNotice('Absolute path copied to clipboard.');}
    catch{setNotice('Clipboard blocked by the browser — the path was not copied.');}
  };
  useEffect(()=>{
    if(!menu)return undefined;
    const close=()=>setMenu(null),key=(e)=>{if(e.key==='Escape')setMenu(null);};
    document.addEventListener('click',close);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('click',close);document.removeEventListener('keydown',key);};
  },[menu]);
  useEffect(()=>{
    if(!playing)return undefined;
    const key=(e)=>{if(e.key==='Escape')setPlaying(null);};
    document.addEventListener('keydown',key);
    return()=>document.removeEventListener('keydown',key);
  },[playing]);
  const groups=useMemo(()=>{
    const files=data?.files??[],gs=[];
    for(const asset of data?.assets??[])gs.push({id:`a:${asset.name}`,name:asset.name,members:files.filter((f)=>hasTag(f,asset.name))});
    for(const name of data?.groups??[])gs.push({id:`g:${name}`,name,members:files.filter((f)=>hasTag(f,name)),custom:true});
    const grouped=new Set();gs.forEach((g)=>g.members.forEach((f)=>grouped.add(f.path)));
    const other=files.filter((f)=>!grouped.has(f.path));
    if(other.length)gs.push({id:'other',name:'Other',members:other});
    return gs;
  },[data]);
  const needle=filter.trim().toLowerCase();
  const matches=useCallback((f)=>!needle||(f.tags??[]).some((t)=>String(t).toLowerCase().includes(needle)),[needle]);
  const card=(f)=><div key={f.path} className="footage-card" role="button" tabIndex={0} title="Click to play · right-click for the path"
    onClick={()=>{if(menu){setMenu(null);return;}setPlaying(f);}}
    onKeyDown={(e)=>{if(e.key==='Enter')setPlaying(f);}}
    onContextMenu={(e)=>{e.preventDefault();setMenu({x:e.clientX,y:e.clientY,file:f});}}>
    <video src={f.url} muted playsInline preload="metadata"/>
    <div className="footage-card-foot">
      <span className="footage-path" title={f.path}>{f.path}</span>
      <div className="footage-chips" onClick={(e)=>{e.stopPropagation();setMenu(null);}}>
        {(f.tags??[]).map((tag)=><span key={tag} className="footage-chip">{tag}<button type="button" className="footage-chip-x" title={`Remove tag “${tag}”`} aria-label={`Remove tag ${tag} from ${f.path}`} onClick={()=>removeTag(f.path,tag)}>✕</button></span>)}
        <input className="footage-tag-add" placeholder="+ tag ↵" aria-label={`Add tag to ${f.path}`} value={tagDrafts[f.path]??''}
          onChange={(e)=>setTagDrafts((d)=>({...d,[f.path]:e.target.value}))}
          onKeyDown={(e)=>{if(e.key==='Enter'){e.preventDefault();void addTag(f.path);}}}/>
      </div>
    </div>
  </div>;
  return <main className="panel footage-board" aria-label="Footage">
    {error?<div className="banner error" role="alert">{error}</div>:null}
    <div className="footage-bar">
      <input className="footage-filter" type="search" placeholder="Filter by tag…" aria-label="Filter footage by tag" value={filter} onChange={(e)=>setFilter(e.target.value)}/>
      <button type="button" className="btn primary sm" title={`Turn “${filter.trim()||'the filter text'}” into a permanent tag group`} disabled={!filter.trim()} onClick={()=>void addGroup()}>+</button>
      <input className="footage-import-path" placeholder="import path — workspace-relative or absolute (a video file, or a folder for the folder button)" aria-label="Import path" value={importPath} onChange={(e)=>setImportPath(e.target.value)}/>
      <button type="button" className="btn sm" disabled={!importPath.trim()} onClick={()=>void importVideo()}>Import video</button>
      <button type="button" className="btn sm" disabled={!importPath.trim()} onClick={()=>void importFolder()}>Import folder</button>
      {notice?<span className="field-hint">{notice}</span>:null}
    </div>
    {!data&&!error?<div className="muted">Loading footage…</div>:null}
    {data&&!data.files.length?<p className="empty-copy">No videos in media/ yet — generated videos land here automatically.</p>:null}
    {groups.map((g)=>{
      const shown=g.members.filter(matches);
      if(needle&&!shown.length)return null;
      const expanded=open[g.id]??Boolean(needle&&shown.length);
      return <section key={g.id} className="footage-group">
        <div className="footage-group-head">
          <button type="button" className="footage-group-toggle" aria-expanded={expanded} onClick={()=>setOpen((o)=>({...o,[g.id]:!expanded}))}>{expanded?'▾':'▸'} {g.name} <span className="muted tiny">{`(${shown.length})`}</span></button>
          {g.custom?<button type="button" className="btn ghost sm" title={`Delete group “${g.name}”`} aria-label={`Delete group ${g.name}`} onClick={()=>void deleteGroup(g.name)}>✕</button>:null}
        </div>
        {expanded?<div className="footage-grid">{shown.map((f)=>card(f))}</div>:null}
      </section>;
    })}
    {menu?<div className="footage-menu" style={{left:`${menu.x}px`,top:`${menu.y}px`}}>
      <button type="button" onClick={()=>void copyPath(menu.file)}>Copy path to clipboard</button>
    </div>:null}
    {playing?<div className="footage-viewer" role="dialog" onClick={()=>setPlaying(null)}>
      <div className="footage-viewer-body" onClick={(e)=>e.stopPropagation()}>
        <video src={playing.url} controls autoPlay playsInline/>
      </div>
      <button type="button" className="btn ghost sm footage-viewer-close" aria-label="Close player" onClick={()=>setPlaying(null)}>✕</button>
    </div>:null}
  </main>;
}
