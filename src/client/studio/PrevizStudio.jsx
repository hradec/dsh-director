// Previz tab — review surface for single-file animated previs. The LLM authors the scene
// JSON (chat or POST /api/previz/scene); the human scrubs the live three.js stage, renders
// a playblast mp4, and registers it into the Footage/Images libraries. Deliberately no
// drag-and-drop editor: every scene is plain JSON in a .previz.html that plays standalone.
import {useEffect,useRef,useState} from 'react';
import {createStage} from './previz-player.js';
import {normalizeScene,previzPromptNotes} from '../../previz-format.mjs';
import {fetch as apiFetch} from './fetch-inject.mjs';

export function PrevizStudio(){
  const [shots,setShots]=useState([]);
  const [rows,setRows]=useState([]);
  const [shotId,setShotId]=useState('');
  const [scene,setScene]=useState(null);
  const [draft,setDraft]=useState('');
  const [status,setStatus]=useState('');
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
    setShotId(id);setPlaying(false);setT(0);setPlayblast('');setStatus('');
    try{
      const v=await (await apiFetch(`api/previz/scene?shot_id=${encodeURIComponent(id)}`)).json();
      setScene(v.scene);setDraft(JSON.stringify(v.scene,null,2));
      const row=rows.find((r)=>r.shot_id===id);
      if(row?.playblast)setPlayblast('/director-studio/api/file?path='+encodeURIComponent(row.playblast));
    }catch(e){setStatus(String(e.message??e));setScene(null);setDraft('');}
  }
  async function createNew(){
    const shot=shots.find((s)=>s.id===shotId)??shots[0];
    const id=shot?shot.id:(shotId||'untitled');
    const dur=Number(shot?.duration_s)||6;
    const scene={shot_id:id,title:shot?.title??'',duration_s:dur,fps:24,width:1280,height:720,
      camera:{fov:40,keys:[{t:0,pos:[0,1.6,6],look:[0,1,0]},{t:dur,pos:[-2,1.4,4],look:[0,1,0]}]},
      actors:[{id:'actor',shape:'biped',color:'#c8bfae',scale:1.8,keys:[{t:0,pos:[0,0,0]}]}],props:[]};
    await apiFetch('api/previz/scene',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:id,scene})});
    await reload();openRow(id);setStatus('New previz baked — edit the JSON here or ask the agent to author the scene.');
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
      if(s.status==='done'){setStatus(`Playblast: ${s.result.mp4}`);setPlayblast('/director-studio/api/file?path='+encodeURIComponent(s.result.mp4));reload();}
      else setStatus('Render failed: '+s.error);
    };
    poll();
  }
  async function register(){
    const v=await (await apiFetch('api/previz/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shot_id:shotId})})).json();
    setStatus(`Registered: Footage ${v.footage?.path??''}${v.image?`, Images ${v.image.path}`:''}.`);
    reload();
  }

  const scene0=scene?normalizeScene(scene):null;
  return <div className="dsh-director-previz" style={{display:'flex',flexDirection:'column',gap:10,padding:12}}>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
      <select value={shotId} onChange={(e)=>openRow(e.target.value)} style={{minWidth:200}}>
        <option value="">— shot —</option>
        {shots.map((s)=><option key={s.id} value={s.id}>{s.id} · {s.title??''}</option>)}
        {rows.filter((r)=>!shots.some((s)=>s.id===r.shot_id)).map((r)=><option key={r.shot_id} value={r.shot_id}>{r.shot_id} (previz only)</option>)}
      </select>
      <button className="btn" onClick={createNew}>New previz</button>
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
    {scene?<div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-start'}}>
      <canvas ref={canvasRef} style={{border:'1px solid #2c3546',maxWidth:'100%'}}/>
      <div style={{minWidth:260,flex:1}}>
        <div className="muted" style={{fontSize:12,marginBottom:4}}>camera / movement wording for the H3 prompt:</div>
        <pre style={{whiteSpace:'pre-wrap',fontSize:12,margin:0}}>{scene0?previzPromptNotes(scene0):''}</pre>
        {playblast?<video src={playblast} controls style={{width:'100%',marginTop:8}}/>:null}
      </div>
    </div>:null}
    {scene?<textarea rows={14} value={draft} onChange={(e)=>setDraft(e.target.value)} style={{fontFamily:'ui-monospace,monospace',fontSize:12,width:'100%'}}/>:null}
    <div className="muted" style={{fontSize:12}}>previz files: {rows.map((r)=><span key={r.shot_id} style={{marginRight:8}}>{r.shot_id}{r.playblast?' (mp4)':''}</span>)}</div>
  </div>;
}
