import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {fetch as apiFetch} from './fetch-inject.mjs';

// Episode timeline, Premiere/FCP-style: player on top; below it a track with a time ruler,
// a draggable playhead (click the ruler or drag the head to position; ▶ plays from the head to the end).
// ponytail: playback is sequential <video> src swapping (watch-the-edit preview), not an NLE; final ffmpeg cut stays a separate later step.
// ponytail: ruler geometry uses the planned shot.duration_s; the marker follows the real clip time inside its block,
// so a clip whose real length differs from its shot duration shows a small drift — fix by editing duration_s.
const PX_PER_SECOND=14,MIN_BLOCK=72;
// Same route the Production page uses; the query session identifies the workspace when the browser element cannot send headers.
const clipUrl=clip=>`/director-studio/api/files/library/layouts/${encodeURIComponent(clip.asset_id)}/master?session=${encodeURIComponent(globalThis.__DSH_DIRECTOR_SESSION__??'')}`;
const mmss=s=>{const t=Math.max(0,Math.floor(s||0));return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`;};

export function TimelineBoard(){
  const [board,setBoard]=useState(null);
  const [error,setError]=useState('');
  const [episodeId,setEpisodeId]=useState('');
  const [sequenceId,setSequenceId]=useState('');
  const [openShotId,setOpenShotId]=useState('');
  const [newSeqName,setNewSeqName]=useState('');
  const [playhead,setPlayhead]=useState(0); // global seconds on the planned ruler
  const [playing,setPlaying]=useState(false);
  const videoRef=useRef(null),trackRef=useRef(null),queueRef=useRef([]),indexRef=useRef(-1),seekRef=useRef(0),dragRef=useRef(false);
  const load=useCallback(()=>apiFetch('/api/library/timeline').then(r=>r.ok?r.json():Promise.reject(new Error(String(r.status)))).then(setBoard).catch(()=>setError('Timeline API not live yet — the running DSH service needs a restart (when idle) to enable it.')),[]);
  useEffect(()=>{load();},[load]);
  const episodes=useMemo(()=>[...(board?.episodes??[])].sort((a,b)=>(a.season-b.season)||(a.order-b.order)),[board]);
  const sequences=useMemo(()=>[...(board?.sequences??[])].sort((a,b)=>a.order-b.order).filter(item=>!episodeId||item.episode_id===episodeId),[board,episodeId]);
  const shots=useMemo(()=>(board?.shots??[]).filter(shot=>!sequenceId||shot.sequence_id===sequenceId),[board,sequenceId]);
  const takesOf=useCallback(shotId=>(board?.takes??[]).filter(take=>take.shot_id===shotId),[board]);
  // One entry per shot: x/w are track pixels, tStart/tEnd are ruler seconds; MIN_BLOCK keeps short shots clickable.
  const layout=useMemo(()=>{let x=0,t=0;return shots.map(shot=>{const planned=shot.duration_s??4,w=Math.max(MIN_BLOCK,planned*PX_PER_SECOND),item={shot,w,x,xEnd:x+w,tStart:t,tEnd:t+planned,planned};x+=w;t+=planned;return item;});},[shots]);
  const totalSeconds=useMemo(()=>layout.length?layout[layout.length-1].tEnd:0,[layout]);
  const totalPx=useMemo(()=>layout.length?layout[layout.length-1].xEnd:0,[layout]);
  const timeToX=useCallback(t=>{
    const item=layout.find(entry=>t<entry.tEnd)??layout[layout.length-1];
    if(!item)return 0;
    return item.x+Math.min(1,Math.max(0,(t-item.tStart)/item.planned))*item.w;
  },[layout]);
  const xToTime=useCallback(x=>{
    const item=layout.find(entry=>x<entry.xEnd)??layout[layout.length-1];
    if(!item)return 0;
    return item.tStart+Math.min(1,Math.max(0,(x-item.x)/item.w))*item.planned;
  },[layout]);
  const posFromEvent=useCallback(event=>{
    const track=trackRef.current;if(!track)return 0;
    return xToTime(Math.min(totalPx,Math.max(0,event.clientX-track.getBoundingClientRect().left)));
  },[xToTime,totalPx]);
  const startPlayback=useCallback((t,{autoplay=true}={})=>{
    // First clip-entry covering or after t, then every later clip-entry plays in order.
    const first=layout.find(entry=>board.clips[entry.shot.id]&&entry.tEnd>t+0.02)||layout.find(entry=>board.clips[entry.shot.id]);
    if(!first)return;
    const local=Math.max(0,Math.min(first.planned-0.05,t-first.tStart));
    queueRef.current=layout.filter(entry=>entry.tStart>=first.tEnd&&board.clips[entry.shot.id]).map(entry=>entry.shot.id);
    indexRef.current=layout.indexOf(first);
    seekRef.current=local;
    const video=videoRef.current;
    if(!video)return;
    video.src=clipUrl(board.clips[first.shot.id]);
    setPlayhead(Math.min(t,totalSeconds));
    if(autoplay){setPlaying(true);const played=video.play();if(played)played.catch(()=>{});}
    else{setPlaying(false);video.pause();}
  },[layout,board,totalSeconds]);
  const onLoadedMetadata=useCallback(()=>{const video=videoRef.current;if(seekRef.current>0.05){try{video.currentTime=seekRef.current;}catch{/* seek before buffer: the browser clamps; playback continues from there */}seekRef.current=0;}},[]);
  const onTimeUpdate=useCallback(()=>{
    const video=videoRef.current,item=layout[indexRef.current];
    if(video&&item&&Number.isFinite(video.currentTime))setPlayhead(Math.min(item.tEnd,item.tStart+video.currentTime));
  },[layout]);
  const onEnded=useCallback(()=>{
    const nextId=queueRef.current.shift(),video=videoRef.current;
    if(nextId&&video){
      const next=layout.find(entry=>entry.shot.id===nextId);
      if(next){indexRef.current=layout.indexOf(next);seekRef.current=0;video.src=clipUrl(board.clips[next.shot.id]);video.play().catch(()=>{});return;}
    }
    setPlaying(false);indexRef.current=-1;
  },[layout,board]);
  const pause=useCallback(()=>{const video=videoRef.current;if(video)video.pause();setPlaying(false);},[]);
  const stop=useCallback(()=>{pause();queueRef.current=[];indexRef.current=-1;setPlayhead(0);},[pause]);
  const applyPointer=useCallback(t=>{if(playing)startPlayback(t);else startPlayback(t,{autoplay:false});},[playing,startPlayback]);
  const selectTake=useCallback(async(takeId)=>{await apiFetch('/api/library/take/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({take_id:takeId})});load();},[load]);
  const setDuration=useCallback(async(shotId,value)=>{
    const duration_s=Number(value);
    if(Number.isFinite(duration_s)&&duration_s>0&&duration_s!==shots.find(shot=>shot.id===shotId)?.duration_s)await apiFetch(`/api/shots/${encodeURIComponent(shotId)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({duration_s})});
    load();
  },[shots,load]);
  if(error)return <div className="banner error" role="alert">{error}</div>;
  if(!board)return <div className="muted">Loading timeline…</div>;
  const openShot=shots.find(shot=>shot.id===openShotId);
  const ticks=[];for(let t=5;t<totalSeconds;t+=5)ticks.push(t);
  return <main className="panel" style={{padding:'1rem',display:'grid',gap:'.8rem'}} aria-label="Episode timeline">
    <div style={{display:'flex',gap:'.6rem',flexWrap:'wrap',alignItems:'center'}}>
      <label className="field" style={{margin:0}}><span>Episode</span>
        <select value={episodeId} onChange={event=>{setEpisodeId(event.target.value);setSequenceId('');stop();}}>
          <option value="">All episodes</option>
          {episodes.map(episode=><option key={episode.id} value={episode.id}>S{episode.season} · E{episode.order} — {episode.title}</option>)}
        </select>
      </label>
      <button className="btn primary sm" onClick={()=>startPlayback(playhead>=totalSeconds-0.05?0:playhead)} disabled={!shots.some(shot=>board.clips[shot.id])}>{playing?'▶ playing…':'▶ Play from marker'}</button>
      <button className="btn sm" onClick={pause} disabled={!playing}>⏸ Pause</button>
      <button className="btn sm" onClick={stop}>⏹</button>
      <span className="muted tiny">{mmss(playhead)} / {mmss(totalSeconds)} · {shots.length} shots</span>
    </div>
    <div role="tablist" aria-label="Sequences" style={{display:'flex',gap:'.35rem',flexWrap:'wrap'}}>
      <button role="tab" aria-selected={!sequenceId} className={!sequenceId?'btn primary sm':'btn ghost sm'} onClick={()=>{setSequenceId('');stop();}}>All</button>
      {sequences.map(sequence=><button key={sequence.id} role="tab" aria-selected={sequenceId===sequence.id} className={sequenceId===sequence.id?'btn primary sm':'btn ghost sm'} onClick={()=>{setSequenceId(sequence.id);stop();}}>{sequence.name}</button>)}
      <input value={newSeqName} onChange={event=>setNewSeqName(event.target.value)} placeholder="new sequence" style={{fontSize:'.74rem',padding:'2px 6px',width:'8.5rem'}} aria-label="New sequence name"/>
      <button className="btn sm" disabled={!newSeqName.trim()} onClick={async()=>{await apiFetch('/api/library/sequence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:newSeqName.trim(),episode_id:episodeId})});setNewSeqName('');load();}}>+ Sequence</button>
    </div>
    {/* Player first, timeline underneath — like an NLE. */}
    <video ref={videoRef} playsInline preload="metadata" onLoadedMetadata={onLoadedMetadata} onTimeUpdate={onTimeUpdate} onEnded={onEnded} controls style={{width:'100%',maxHeight:'44vh',background:'#000',borderRadius:'8px'}}/>
    <div style={{overflowX:'auto',background:'rgba(0,0,0,.06)',borderRadius:'8px',padding:'.4rem'}} aria-label="Timeline track">
      <div ref={trackRef} style={{position:'relative',width:`${Math.max(totalPx,120)}px`}}>
        {/* ruler: click to position the marker */}
        <div onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);const t=posFromEvent(event);setPlayhead(t);const move=e=>setPlayhead(posFromEvent(e));const up=e=>{event.currentTarget.removeEventListener('pointermove',move);event.currentTarget.removeEventListener('pointerup',up);applyPointer(posFromEvent(e));};event.currentTarget.addEventListener('pointermove',move);event.currentTarget.addEventListener('pointerup',up);}}
          style={{position:'relative',height:'20px',cursor:'text',userSelect:'none'}}>
          {ticks.map(t=><span key={t} style={{position:'absolute',left:`${timeToX(t)}px`,top:0,bottom:0,width:'1px',background:'rgba(0,0,0,.25)'}}/>)}
          {ticks.filter(t=>t%10===0).map(t=><span key={`l${t}`} style={{position:'absolute',left:`${timeToX(t)+3}px`,fontSize:'.6rem',color:'#666'}}>{mmss(t)}</span>)}
        </div>
        <div style={{display:'flex',gap:'2px',padding:'.25rem 0'}}>
          {shots.map((shot,index)=>{
            const clip=board.clips[shot.id],item=layout[index],active=indexRef.current===index;
            return <button key={shot.id} onClick={()=>setOpenShotId(shot.id===openShotId?'':shot.id)} onDoubleClick={()=>startPlayback(item.tStart)}
              title={clip?'Click to edit · double-click to play from here':'No clip bound yet'}
              style={{width:`${item.w}px`,minWidth:`${item.w}px`,padding:'.35rem',borderRadius:'6px',cursor:'pointer',textAlign:'left',border:active?'2px solid #6a8daf':'1px solid rgba(0,0,0,.25)',background:clip?(shot.status==='approved'?'#dcead8':'#e9e3d6'):'#d8d0c4'}}>
              <div style={{fontSize:'.72rem',fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{shot.title}</div>
              <div className="muted" style={{fontSize:'.66rem'}}>{shot.duration_s}s{clip?'':' · no clip'}{(shot.arcs??[]).length?` · ${(shot.arcs??[]).join(' / ')}`:''}</div>
            </button>;
          })}
        </div>
        {!shots.length?<div className="muted tiny" style={{padding:'.4rem'}}>No shots in this sequence yet — assign them with director_studio shot.update sequence_id.</div>:null}
        {/* playhead: drag the diamond to change the current position */}
        <div onPointerDown={event=>{event.stopPropagation();dragRef.current=true;event.currentTarget.setPointerCapture(event.pointerId);}}
          onPointerMove={event=>{if(dragRef.current)setPlayhead(posFromEvent(event));}}
          onPointerUp={event=>{if(!dragRef.current)return;dragRef.current=false;applyPointer(playhead);}}
          aria-label="Playhead — drag to move" title="Drag to move the play position"
          style={{position:'absolute',left:`${timeToX(playhead)}px`,top:0,bottom:0,width:'12px',marginLeft:'-6px',cursor:'ew-resize',touchAction:'none',zIndex:3}}>
          <div style={{width:'2px',height:'100%',background:'#c0392b',margin:'0 auto'}}/>
          <div style={{position:'absolute',top:'-2px',left:'50%',transform:'translateX(-50%)',width:'10px',height:'10px',background:'#c0392b',clipPath:'polygon(0 0,100% 0,50% 100%)'}}/>
        </div>
      </div>
    </div>
    {openShot?<div className="panel" style={{padding:'.7rem',display:'grid',gap:'.5rem'}}>
      <div style={{display:'flex',gap:'.7rem',flexWrap:'wrap',alignItems:'center'}}>
        <strong>{openShot.title}</strong>
        <label className="field" style={{margin:0}}><span>Duration (s)</span>
          <input type="number" min="0.1" step="0.1" defaultValue={openShot.duration_s} onBlur={event=>setDuration(openShot.id,event.target.value)} style={{width:'5.5rem'}}/>
        </label>
        <label className="field" style={{margin:0}}><span>Sequence</span>
          <select value={openShot.sequence_id??''} onChange={async event=>{await apiFetch(`/api/shots/${encodeURIComponent(openShot.id)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({sequence_id:event.target.value||null})});load();}}>
            <option value="">— none —</option>
            {(board?.sequences??[]).map(sequence=><option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}
          </select>
        </label>
        {board.clips[openShot.id]?<button className="btn sm" onClick={()=>startPlayback(layout[shots.findIndex(shot=>shot.id===openShot.id)]?.tStart??0)}>▶ from here</button>:null}
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
