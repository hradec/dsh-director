import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {fetch as apiFetch} from './fetch-inject.mjs';

// Episode timeline: sequence buttons switch timelines, blocks are shots playing their selected take.
// ponytail: playback is sequential <video> src swapping (watch-the-edit preview), not an NLE; final ffmpeg cut stays a separate later step.
const PX_PER_SECOND=14,MIN_BLOCK=72;
// Same route the Production page uses; the query session identifies the workspace when the browser element cannot send headers.
const clipUrl=clip=>`/director-studio/api/files/library/layouts/${encodeURIComponent(clip.asset_id)}/master?session=${encodeURIComponent(globalThis.__DSH_DIRECTOR_SESSION__??'')}`;

export function TimelineBoard(){
  const [board,setBoard]=useState(null);
  const [error,setError]=useState('');
  const [episodeId,setEpisodeId]=useState('');
  const [sequenceId,setSequenceId]=useState('');
  const [openShotId,setOpenShotId]=useState('');
  const [playIndex,setPlayIndex]=useState(-1);
  const videoRef=useRef(null),queueRef=useRef([]);
  const load=useCallback(()=>apiFetch('/api/library/timeline').then(r=>r.ok?r.json():Promise.reject(new Error(String(r.status)))).then(setBoard).catch(()=>setError('Timeline API not live yet — the running DSH service needs a restart (when idle) to enable it.')),[]);
  useEffect(()=>{load();},[load]);
  const episodes=useMemo(()=>[...(board?.episodes??[])].sort((a,b)=>(a.season-b.season)||(a.order-b.order)),[board]);
  const sequences=useMemo(()=>[...(board?.sequences??[])].sort((a,b)=>a.order-b.order).filter(item=>!episodeId||item.episode_id===episodeId),[board,episodeId]);
  const shots=useMemo(()=>(board?.shots??[]).filter(shot=>!sequenceId||shot.sequence_id===sequenceId),[board,sequenceId]);
  const takesOf=useCallback(shotId=>(board?.takes??[]).filter(take=>take.shot_id===shotId),[board]);
  const playFrom=useCallback(index=>{
    queueRef.current=shots.slice(index).map(shot=>board.clips[shot.id]).filter(Boolean);
    if(!queueRef.current.length)return;
    setPlayIndex(index);
    const video=videoRef.current;
    if(video){video.src=clipUrl(queueRef.current.shift());video.play().catch(()=>{});}
  },[shots,board]);
  const onEnded=useCallback(()=>{
    const video=videoRef.current;
    if(video&&queueRef.current.length){video.src=clipUrl(queueRef.current.shift());video.play().catch(()=>{});}
    else setPlayIndex(-1);
  },[]);
  const selectTake=useCallback(async(takeId)=>{await apiFetch('/api/library/take/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({take_id:takeId})});load();},[load]);
  const setDuration=useCallback(async(shotId,value)=>{
    const duration_s=Number(value);
    if(Number.isFinite(duration_s)&&duration_s>0&&duration_s!==shots.find(shot=>shot.id===shotId)?.duration_s)await apiFetch(`/api/shots/${encodeURIComponent(shotId)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({duration_s})});
    load();
  },[shots,load]);
  if(error)return <div className="banner error" role="alert">{error}</div>;
  if(!board)return <div className="muted">Loading timeline…</div>;
  const openShot=shots.find(shot=>shot.id===openShotId);
  return <main className="panel" style={{padding:'1rem',display:'grid',gap:'.8rem'}} aria-label="Episode timeline">
    <div style={{display:'flex',gap:'.6rem',flexWrap:'wrap',alignItems:'center'}}>
      <label className="field" style={{margin:0}}><span>Episode</span>
        <select value={episodeId} onChange={event=>{setEpisodeId(event.target.value);setSequenceId('');}}>
          <option value="">All episodes</option>
          {episodes.map(episode=><option key={episode.id} value={episode.id}>S{episode.season} · E{episode.order} — {episode.title}</option>)}
        </select>
      </label>
      <button className="btn primary sm" onClick={()=>playFrom(0)} disabled={!shots.some(shot=>board.clips[shot.id])}>▶ Play {sequenceId?sequences.find(s=>s.id===sequenceId)?.name??'sequence':'episode'}</button>
      <span className="muted tiny">{shots.length} shots · {shots.reduce((sum,shot)=>sum+(shot.duration_s??0),0).toFixed?.(1)??shots.reduce((sum,shot)=>sum+(shot.duration_s??0),0)} s total</span>
    </div>
    <div role="tablist" aria-label="Sequences" style={{display:'flex',gap:'.35rem',flexWrap:'wrap'}}>
      <button role="tab" aria-selected={!sequenceId} className={!sequenceId?'btn primary sm':'btn ghost sm'} onClick={()=>setSequenceId('')}>All</button>
      {sequences.map(sequence=><button key={sequence.id} role="tab" aria-selected={sequenceId===sequence.id} className={sequenceId===sequence.id?'btn primary sm':'btn ghost sm'} onClick={()=>setSequenceId(sequence.id)}>{sequence.name}</button>)}
    </div>
    <div style={{display:'flex',gap:'2px',overflowX:'auto',padding:'.4rem',background:'rgba(0,0,0,.06)',borderRadius:'8px'}} aria-label="Timeline track">
      {shots.map((shot,index)=>{
        const clip=board.clips[shot.id],width=Math.max(MIN_BLOCK,(shot.duration_s??4)*PX_PER_SECOND),playing=index>=playIndex&&playIndex>=0;
        return <button key={shot.id} onClick={()=>{setOpenShotId(shot.id===openShotId?'':shot.id);}} title={clip?`Click to select — double-click to play from here`:undefined} onDoubleClick={()=>playFrom(index)}
          style={{width:`${width}px`,minWidth:`${width}px`,padding:'.35rem',borderRadius:'6px',cursor:'pointer',textAlign:'left',border:playing?'2px solid #6a8daf':'1px solid rgba(0,0,0,.25)',background:clip?(shot.status==='approved'?'#dcead8':'#e9e3d6'):'#d8d0c4'}}>
          <div style={{fontSize:'.72rem',fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{shot.title}</div>
          <div className="muted" style={{fontSize:'.66rem'}}>{shot.duration_s}s{clip?'':' · no clip'}{(shot.arcs??[]).length?` · ${(shot.arcs??[]).join(' / ')}`:''}</div>
        </button>;
      })}
      {!shots.length?<div className="muted tiny" style={{padding:'.4rem'}}>No shots in this sequence yet — assign them with director_studio shot.update sequence_id.</div>:null}
    </div>
    <video ref={videoRef} controls playsInline preload="metadata" onEnded={onEnded} style={{width:'100%',maxHeight:'44vh',background:'#000',borderRadius:'8px'}}/>
    {openShot?<div className="panel" style={{padding:'.7rem',display:'grid',gap:'.5rem'}}>
      <div style={{display:'flex',gap:'.7rem',flexWrap:'wrap',alignItems:'center'}}>
        <strong>{openShot.title}</strong>
        <label className="field" style={{margin:0}}><span>Duration (s)</span>
          <input type="number" min="0.1" step="0.1" defaultValue={openShot.duration_s} onBlur={event=>setDuration(openShot.id,event.target.value)} style={{width:'5.5rem'}}/>
        </label>
        {board.clips[openShot.id]?<button className="btn sm" onClick={()=>playFrom(shots.findIndex(shot=>shot.id===openShot.id))}>▶ from here</button>:null}
      </div>
      <div style={{display:'grid',gap:'.35rem'}}>
        {takesOf(openShot.id).length?takesOf(openShot.id).map(take=><label key={take.id} style={{display:'flex',gap:'.5rem',alignItems:'center'}}>
          <input type="radio" name={`take-${openShot.id}`} checked={take.status==='selected'} onChange={()=>selectTake(take.id)}/>
          <span>{take.label} <span className="muted">({take.kind}{take.parent_take_id?' ← from a take':''}{take.workflow_path?` · ${take.workflow_path.split('/').pop()}`:''} · {new Date(take.created_at).toLocaleString()})</span></span>
        </label>):<div className="muted tiny">No takes yet — clips auto-register when bound to the shot.</div>}
      </div>
    </div>:null}
  </main>;
}
