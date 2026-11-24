// Previz — review surface for single-file animated previs. The LLM authors the scene
// JSON (chat or POST /api/previz/scene); the human scrubs the live three.js stage, renders
// a playblast mp4, and registers it into the Footage/Images libraries. Deliberately no
// drag-and-drop editor: every scene is plain JSON in a .previz.html that plays standalone.
// Two mounts: the standalone tab (shot picker) and the Shot setup "Previz" section
// (boundShotId — the shot is already known; cast + H3 reference set shown inline).
import {useEffect,useRef,useState} from 'react';
import {createStage} from './previz-player.js';
import {normalizeScene,previzPromptNotes} from '../../previz-format.mjs';
import {h3ReferenceText} from '../../previz-h3refs.mjs';
import {fetch as apiFetch} from './fetch-inject.mjs';

export function PrevizStudio({boundShotId=null,sendDshRequest=null}={}){
  const [shots,setShots]=useState([]);
  const [rows,setRows]=useState([]);
  const [shotId,setShotId]=useState(boundShotId??'');
  const [scene,setScene]=useState(null);
  const [draft,setDraft]=useState('');
  const [status,setStatus]=useState('');
  const [refsText,setRefsText]=useState('');
  const [versions,setVersions]=useState([]);
  const [playblast,setPlayblast]=useState('');
  const [playing,setPlaying]=useState(false);
  const [t,setT]=useState(0);
  const canvasRef=useRef(null),stageRef=useRef(null);

  async function reload(){
    const lib=await (await apiFetch('api/library')).json();
    setShots((lib.shots??[]).slice().sort((a,b)=>String(a.id).localeCompare(String(b.id))));
    setRows((await (await apiFetch('api/previz')).json()).previz??[]);
  }
  useEffect(()=>{reload().catch((e)=>setStatus(String(e.message??e)));},[]);

  // The canvas mounts when a scene loads; the stage lives as long as that node does.
  useEffect(()=>{
    if(!canvasRef.current)return;
    const stage=createStage(canvasRef.current);stageRef.current=stage;
    return()=>{stage.dispose();stageRef.current=null;};
  },[shotId,Boolean(scene)]);
  useEffect(()=>{
    const stage=stageRef.current;if(!stage||!scene)return;
    stage.setScene(normalizeScene(scene));
    stage.resize(Number(scene.width)||1280,Number(scene.height)||720);
    stage.setT(t);
  },[scene]);
  useEffect(()=>{stageRef.current?.setT(t);},[t]);
  useEffect(()=>{
    if(!playing||!scene)return;
    const s=normalizeScene(scene);
    let raf=0,last=performance.now();
    const step=(now)=>{const dt=(now-last)/1000;last=now;setT((v)=>v+dt>=s.duration_s?0:v+dt);raf=requestAnimationFrame(step);};
    raf=requestAnimationFrame(step);
    return()=>cancelAnimationFrame(raf);
  },[playing,scene]);

  async function openRow(id){
    setShotId(id);setPlaying(false);setT(0);setPlayblast('');setStatus('');setRefsText('');
    try{
      const v=await (await apiFetch(`api/previz/scene?shot_id=${encodeURIComponent(id)}`)).json();
      setScene(v.scene);setDraft(JSON.stringify(v.scene,null,2));
      const row=rows.find((r)=>r.shot_id===id);
      if(row?.playblast)setPlayblast('/director-studio/api/file?path='+encodeURIComponent(row.playblast));
      loadRefs(id);
    }catch(e){setStatus(String(e.message??e));setScene(null);setDraft('');}
  }
  async function loadRefs(id){
    try{
      const set=await (await apiFetch(`api/previz/refs?shot_id=${encodeURIComponent(id)}`)).json();
      setRefsText(h3ReferenceText(set));setVersions(set.versions??[]);
    }catch(e){setRefsText(String(e.message??e));setVersions([]);}
  }
  // Approving one playblast makes it THE shot previz: refs/Video 1 and the agent handoff follow it.
  async function approve(path){
    await apiFetch('api/previz/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:shotId,path})});
    setStatus(`Approved previz version: ${path}`);loadRefs(shotId);
  }
  // Bound to a shot (Production tab): open it as soon as the shot id arrives.
  useEffect(()=>{
    if(!boundShotId)return;
    if(shotId===boundShotId&&scene)return;
    openRow(boundShotId);
  },[boundShotId,rows]);

  // "New from cast": the server seeds a starter scene straight from the Shot's cast refs,
  // so actor ids line up with the assets before anyone edits a coordinate.
  async function createNew(){
    const shot=shots.find((s)=>s.id===shotId)??shots[0];
    const id=shot?shot.id:(shotId||'untitled');
    let scene;
    try{
      scene=(await (await apiFetch('api/previz/seed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:id})})).json()).scene;
    }catch{
      const dur=Number(shot?.duration_s)||6;
      scene={shot_id:id,title:shot?.title??'',duration_s:dur,fps:24,width:1280,height:720,
        camera:{fov:40,keys:[{t:0,pos:[0,1.6,6],look:[0,1,0]},{t:dur,pos:[-2,1.4,4],look:[0,1,0]}]},
        actors:[{id:'actor',shape:'biped',color:'#c8bfae',scale:1.8,keys:[{t:0,pos:[0,0,0]}]}],props:[]};
    }
    await apiFetch('api/previz/scene',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:id,scene})});
    await reload();openRow(id);setStatus('New previz seeded from the Shot cast — edit the JSON here or ask the agent to author the scene.');
  }
  async function saveDraft(){
    try{
      const parsed=JSON.parse(draft);
      await apiFetch('api/previz/scene',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:shotId,scene:parsed})});
      setScene(parsed);setStatus(`Saved — previz/${shotId}.previz.html rebaked.`);
    }catch(e){setStatus('Save failed: '+String(e.message??e));}
  }
  async function render(){
    setStatus('Rendering playblast (frame-exact, this takes a moment)…');setPlaying(false);
    const job=await (await apiFetch('api/previz/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:shotId})})).json();
    const poll=async()=>{
      const s=await (await apiFetch(`api/previz/render/${job.id}`)).json();
      if(s.status==='running'){setTimeout(poll,2000);return;}
      if(s.status==='done'){
        setPlayblast('/director-studio/api/file?path='+encodeURIComponent(s.result.mp4));
        // Every render lands in the Footage library as a previz version of this shot (tags: previz + shot id).
        const reg=await (await apiFetch('api/previz/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:shotId})})).json();
        setStatus(`Playblast rendered and registered as a version: ${reg.footage?.path??s.result.mp4} — approve one below to make it the shot previz.`);
        reload();loadRefs(shotId);
      }
      else setStatus('Render failed: '+s.error);
    };
    poll();
  }
  async function register(){
    const v=await (await apiFetch('api/previz/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:shotId})})).json();
    setStatus(`Registered: Footage ${v.footage?.path??''}${v.image?`, Images ${v.image.path}`:''}.`);
    reload();loadRefs(shotId);
  }
  function sendRefs(){
    if(!sendDshRequest||!refsText)return;
    sendDshRequest(`Shot ${shotId} — complete H3 reference set (cast assets + previz):\n${refsText}\nBuild the H3 prompt for this shot from these references: stage the Pictures, use the playblast mp4 as <Video 1> (cut and pacing structure, weak_reference) and the frame0 png as the input still for the hi-res H3 Image first frame. Previz timing wording to fold in is in the shot's previz notes.`);
  }

  const scene0=scene?normalizeScene(scene):null;
  return <div className="dsh-director-previz" style={{display:'flex',flexDirection:'column',gap:10,padding:12}}>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
      {boundShotId?null:<select value={shotId} onChange={(e)=>openRow(e.target.value)} style={{minWidth:200}}>
        <option value="">— shot —</option>
        {shots.map((s)=><option key={s.id} value={s.id}>{s.id} · {s.title??''}</option>)}
        {rows.filter((r)=>!shots.some((s)=>s.id===r.shot_id)).map((r)=><option key={r.shot_id} value={r.shot_id}>{r.shot_id} (previz only)</option>)}
      </select>}
      <button className="btn" onClick={createNew}>{scene?'Replace from cast':'New from cast'}</button>
      {scene?<>
        <button className="btn primary" onClick={()=>setPlaying((v)=>!v)}>{playing?'Pause':'Play'}</button>
        <button className="btn" onClick={saveDraft}>Save JSON</button>
        <button className="btn" onClick={render}>Render playblast mp4</button>
        <button className="btn" onClick={register}>Register in Footage</button>
        <input type="range" min="0" max={String(Math.max(1,Math.round((scene0?.duration_s??0)*(scene0?.fps??24))))} value={String(Math.round(t*(scene0?.fps??24)))} onChange={(e)=>{setPlaying(false);setT(Number(e.target.value)/(scene0?.fps??24));}} style={{flex:1,minWidth:140}}/>
        <span className="muted">{t.toFixed(2)}s</span>
      </>:null}
    </div>
    {status?<div className="muted" style={{fontSize:12}}>{status}</div>:null}
    {!scene&&boundShotId?<div className="muted" style={{fontSize:12}}>No previz for this shot yet — “New from cast” seeds one from the assets you cast under References.</div>:null}
    {scene?<div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-start'}}>
      <canvas ref={canvasRef} style={{border:'1px solid #2c3546',maxWidth:'100%'}}/>
      <div style={{minWidth:260,flex:1}}>
        <div className="muted" style={{fontSize:12,marginBottom:4}}>camera / movement wording for the H3 prompt:</div>
        <pre style={{whiteSpace:'pre-wrap',fontSize:12,margin:0}}>{scene0?previzPromptNotes(scene0):''}</pre>
        {playblast?<video src={playblast} controls style={{width:'100%',marginTop:8}}/>:null}
      </div>
    </div>:null}
    {versions.length?<div>
      <div className="muted" style={{fontSize:12,marginBottom:4}}>Previz versions for this shot (Footage, tag previz + {shotId}):</div>
      <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
        {versions.map((v)=><div key={v.path} style={{border:'1px solid #2c3546',padding:6,display:'flex',flexDirection:'column',gap:4,width:230}}>
          <video src={v.url} controls preload="none" style={{width:'100%'}}/>
          <div style={{fontSize:11,display:'flex',justifyContent:'space-between',gap:6,alignItems:'center'}}>
            <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.path.split('/').pop()}</span>
            {v.approved?<span className="badge" style={{background:'#2f6f3f',color:'#fff'}}>Shot previz</span>
              :<button className="btn" onClick={()=>approve(v.path)}>Approve</button>}
          </div>
        </div>)}
      </div>
    </div>:null}
    {refsText?<div>
      <div className="muted" style={{fontSize:12,marginBottom:4}}>Minimax H3 references for this shot (cast + previz):</div>
      <pre style={{whiteSpace:'pre-wrap',fontSize:12,margin:0}}>{refsText}</pre>
      {sendDshRequest?<button className="btn" onClick={sendRefs} style={{marginTop:4}}>Hand reference set to the agent</button>:null}
    </div>:null}
    {scene?<textarea rows={14} value={draft} onChange={(e)=>setDraft(e.target.value)} style={{fontFamily:'ui-monospace,monospace',fontSize:12,width:'100%'}}/>:null}
    {boundShotId?null:<div className="muted" style={{fontSize:12}}>previz files: {rows.map((r)=><span key={r.shot_id} style={{marginRight:8}}>{r.shot_id}{r.playblast?' (mp4)':''}</span>)}</div>}
  </div>;
}
