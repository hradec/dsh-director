import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
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
  // Expand/collapse persists to footage.json — survives refresh and closing/reopening the tab.
  const toggleOpen=(id,expanded)=>{setOpen((o)=>({...o,[id]:expanded}));post('/api/footage/open','PUT',{id,expanded}).catch((e)=>setError(String(e.message||e)));};
  const addGroup=async()=>{
    const name=filter.trim();if(!name)return;
    try{const v=await post('/api/footage/group','POST',{name});if(v?.groups)setData((d)=>({...d,groups:v.groups}));setOpen((o)=>({...o,[`g:${name}`]:true}));setNotice(`Group “${name}” created — every video tagged ${name} is in it.`);}
    catch(e){setError(String(e.message||e));}
  };
  const deleteGroup=async(name)=>{
    try{const v=await post('/api/footage/group','DELETE',{name});if(v?.groups)setData((d)=>({...d,groups:v.groups}));}
    catch(e){setError(String(e.message||e));}
  };
  // Asset groups mirror the library and are never deleted from Footage — assets live and die in the Assets tab.
  const [smart,setSmart]=useState({});         // free-text bracket query → Set(paths) | 'pending'
  const runSmart=async(queries)=>{
    for(const q of queries){
      if(q in smart)continue;
      setSmart((s)=>({...s,[q]:'pending'}));
      try{const v=await post('/api/footage/smart','POST',{query:q});setSmart((s)=>({...s,[q]:new Set(v?.paths??[])}));}
      catch(e){setSmart((s)=>{const n={...s};delete n[q];return n;});setError(String(e.message||e));}
    }
  };
  // AI tagging: untagged clips get the session's model to watch them and produce content tags — sequentially,
  // one honest call per clip; right-click re-tags any card. seenTag keeps one pass per file per tab session.
  const [tagging,setTagging]=useState(null);   // {done,total} while a pass runs
  const seenTag=useRef(new Set());
  const tagAi=async(f)=>{
    try{const v=await post('/api/footage/tag-ai','POST',{path:f.path,existing:f.tags??[]});if(v?.tags)setData((d)=>({...d,files:(d?.files??[]).map((x)=>x.path===f.path?{...x,tags:v.tags}:x)}));}
    catch(e){setError(String(e.message||e));}
  };
  useEffect(()=>{
    if(!data)return;
    const fresh=(data.files??[]).filter((f)=>!f.tags?.length&&!seenTag.current.has(f.path));
    if(!fresh.length)return;
    fresh.forEach((f)=>seenTag.current.add(f.path));
    void (async()=>{setTagging({done:0,total:fresh.length});let done=0;for(const f of fresh){await tagAi(f);done++;setTagging({done,total:fresh.length});}setTagging(null);})();
  },[data]);
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
    for(const asset of data?.assets??[])gs.push({id:`a:${asset.name}`,name:asset.name,asset,members:files.filter((f)=>hasTag(f,asset.name))});
    for(const name of data?.groups??[])gs.push({id:`g:${name}`,name,members:files.filter((f)=>hasTag(f,name)),custom:true});
    const grouped=new Set();gs.forEach((g)=>g.members.forEach((f)=>grouped.add(f.path)));
    const other=files.filter((f)=>!grouped.has(f.path));
    if(other.length)gs.push({id:'other',name:'Other',members:other});
    // Drag-persisted layout: ids in footage.json order come first, the rest keep their default order.
    const rank=new Map((data?.order??[]).map((id,i)=>[id,i]));
    return gs.slice().sort((a,b)=>(rank.has(a.id)?rank.get(a.id):rank.size)-(rank.has(b.id)?rank.get(b.id):rank.size));
  },[data]);
  // Drag-to-reorder: heads are the handles; a line above/below the hovered group marks where the drop lands.
  const [drag,setDrag]=useState(null);   // {id, overId?, after?}
  const dropGroup=async(targetId,after)=>{
    if(!drag||drag.id===targetId)return;
    const ids=groups.map((g)=>g.id).filter((id)=>id!==drag.id);
    const at=ids.indexOf(targetId)+(after?1:0);
    ids.splice(at,0,drag.id);
    setData((d)=>({...d,order:ids}));setDrag(null);
    try{await post('/api/footage/order','PUT',{order:ids});}
    catch(e){setError(String(e.message||e));load();}
  };
  // Filter grammar: bare words are tag substrings, space ANDs them, nelare+chicken ANDs within one token.
  // [last hour], [last 3 days], [today], [yesterday] filter by file mtime with zero round-trips;
  // any other [free text] goes to /api/footage/smart (the configured LLM picks paths from the catalog) on Enter.
  const TIME_UNITS={minute:6e4,hour:36e5,day:864e5,week:6048e5,month:2592e6,year:31536e6};
  const parsed=useMemo(()=>{
    const text=filter.trim();
    const brackets=[...text.matchAll(/\[([^\]]*)\]/g)].map((m)=>m[1].trim()).filter(Boolean);
    const conds=[];
    for(const tok of text.replace(/\[[^\]]*\]/g,' ').split(/\s+/).filter(Boolean))for(const part of tok.split('+').filter(Boolean)){
      const n=part.toLowerCase();conds.push((f)=>(f.tags??[]).some((t)=>String(t).toLowerCase().includes(n)));
    }
    for(const q of brackets){
      const lm=/^last\s+(\d+)?\s*(minute|hour|day|week|month|year)s?$/.exec(q)??/^past\s+(\d+)?\s*(minute|hour|day|week|month|year)s?$/.exec(q);
      if(lm){const cut=Date.now()-(lm[1]?Number(lm[1]):1)*TIME_UNITS[lm[2]];conds.push((f)=>(f.mtime??0)>=cut);continue;}
      if(q==='today'||q==='yesterday'){
        const now=new Date(),s=new Date(now.getFullYear(),now.getMonth(),now.getDate()-(q==='today'?0:1)).getTime();
        conds.push((f)=>(f.mtime??0)>=s&&(f.mtime??0)<s+864e5);continue;
      }
      const got=smart[q];
      conds.push((f)=>got instanceof Set&&got.has(f.path));
    }
    const smartQ=brackets.filter((q)=>!/^last\s+(\d+)?\s*(minute|hour|day|week|month|year)s?$/.test(q)&&!/^past\s+(\d+)?\s*(minute|hour|day|week|month|year)s?$/.test(q)&&q!=='today'&&q!=='yesterday');
    return {text,conds,smartQ};
  },[filter,smart]);
  const matches=useCallback((f)=>parsed.conds.every((c)=>c(f)),[parsed]);
  const pending=parsed.smartQ.some((q)=>smart[q]==='pending');
  const fname=filter.trim().toLowerCase();
  const card=(f)=><div key={f.path} className="footage-card" role="button" tabIndex={0} title="Click to play · right-click for the path"
    onClick={()=>{if(menu){setMenu(null);return;}setPlaying(f);}}
    onKeyDown={(e)=>{if(e.key==='Enter')setPlaying(f);}}
    onContextMenu={(e)=>{e.preventDefault();setMenu({x:e.clientX,y:e.clientY,file:f});}}>
    {f.empty?<div className="footage-empty" title="The file on disk has no content — nothing to play.">0-byte file</div>:<img src={f.thumb??f.url} alt="" loading="lazy" draggable="false"/>}
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
      <input className="footage-filter" type="search" placeholder="Filter: tag nelare+chicken · [last hour] · [today] · [free text]↵" aria-label="Filter footage by tag" value={filter} onChange={(e)=>setFilter(e.target.value)} onKeyDown={(e)=>{if(e.key==='Enter'){e.preventDefault();void runSmart(parsed.smartQ);}}}/>
      {tagging?<span className="field-hint">AI tagging {tagging.done}/{tagging.total}…</span>:pending?<span className="field-hint">asking the LLM about [ … ]…</span>:null}
      {fname&&(data?.groups??[]).includes(fname)
        ?<button type="button" className="btn ghost sm" title={`Remove the custom group “${fname}” (the videos and their tags stay)`} onClick={()=>{void deleteGroup(fname);}}>✕</button>
        :<button type="button" className="btn primary sm" title={fname&&(data?.assets??[]).some((a)=>a.name.toLowerCase()===fname)?'Asset groups come from the Assets tab — manage them there':`Turn “${fname||'the filter text'}” into a permanent tag group`} disabled={!fname} onClick={()=>void addGroup()}>+</button>}
      <input className="footage-import-path" placeholder="import path — workspace-relative or absolute (a video file, or a folder for the folder button)" aria-label="Import path" value={importPath} onChange={(e)=>setImportPath(e.target.value)}/>
      <button type="button" className="btn sm" disabled={!importPath.trim()} onClick={()=>void importVideo()}>Import video</button>
      <button type="button" className="btn sm" disabled={!importPath.trim()} onClick={()=>void importFolder()}>Import folder</button>
      <button type="button" className="btn sm" title="Reload the board — files, tags, groups and layout" onClick={()=>void load()}>⟳</button>
      {notice?<span className="field-hint">{notice}</span>:null}
    </div>
    {!data&&!error?<div className="muted">Loading footage…</div>:null}
    {data&&!data.files.length?<p className="empty-copy">No videos in media/ yet — generated videos land here automatically.</p>:null}
    {groups.length?<div className="footage-groups">{groups.map((g)=>{
      const shown=g.members.filter(matches);
      if(parsed.text&&!shown.length)return null;
      const expanded=open[g.id]??data?.open?.[g.id]??Boolean(parsed.text&&shown.length);
      const marked=drag&&drag.overId===g.id&&drag.id!==g.id;
      return <section key={g.id} className={`footage-group${expanded?' footage-group-wide':''}${marked?(drag.after?' footage-drop-after':' footage-drop-before'):''}${drag&&drag.id===g.id?' footage-dragging':''}`}
        onDragOver={(e)=>{if(!drag||drag.id===g.id)return;e.preventDefault();const r=e.currentTarget.getBoundingClientRect();setDrag((d)=>d?{...d,overId:g.id,after:e.clientX>r.left+r.width/2}:d);}}
        onDrop={(e)=>{e.preventDefault();void dropGroup(g.id,drag?.after);}}>
        <div className="footage-group-head" draggable={true} title="Drag to reorder groups"
          onDragStart={(e)=>{e.dataTransfer.setData('text/plain',g.id);e.dataTransfer.effectAllowed='move';setDrag({id:g.id});}}
          onDragEnd={()=>setDrag(null)}>
          <button type="button" className="footage-group-toggle" aria-expanded={expanded} onClick={()=>toggleOpen(g.id,!expanded)}>{expanded?'▾':'▸'} {g.name} <span className="muted tiny">{`(${shown.length})`}</span></button>
          {g.custom?<button type="button" className="btn ghost sm" title={`Delete group “${g.name}”`} aria-label={`Delete group ${g.name}`} onClick={()=>void deleteGroup(g.name)}>✕</button>:null}
        </div>
        {expanded?<div className="footage-grid">{shown.map((f)=>card(f))}</div>:<div className="footage-strip" aria-hidden="true">
          {shown.length?<>{shown.slice(0,4).map((f)=>f.empty?<span key={f.path} className="footage-strip-empty" title="0-byte file">0b</span>:<img key={f.path} src={f.thumb??f.url} alt="" loading="lazy" draggable="false"/>)}{shown.length>4?<span className="footage-strip-more" title={`${shown.length-4} more — click the title to open`}>{`+${shown.length-4}`}</span>:null}</>:<span className="footage-strip-empty">EMPTY</span>}
        </div>}
      </section>;
    })}</div>:null}
    {menu?<div className="footage-menu" style={{left:`${menu.x}px`,top:`${menu.y}px`}}>
      <button type="button" onClick={()=>void copyPath(menu.file)}>Copy path to clipboard</button>
      <button type="button" onClick={()=>{const f=menu.file;setMenu(null);void tagAi(f);}}>AI tag / re-tag</button>
    </div>:null}
    {playing?<div className="footage-viewer" role="dialog" onClick={()=>setPlaying(null)}>
      <div className="footage-viewer-body" onClick={(e)=>e.stopPropagation()}>
        <video src={playing.url} poster={playing.thumb??undefined} controls autoPlay playsInline/>
      </div>
      <button type="button" className="btn ghost sm footage-viewer-close" aria-label="Close player" onClick={()=>setPlaying(null)}>✕</button>
    </div>:null}
  </main>;
}
