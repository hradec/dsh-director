import {useEffect,useState} from 'react';
import {AssetWorkspace} from './vendor/features/assets/AssetWorkspace.tsx';
import {ProductionPage} from './vendor/features/production/ProductionPage.tsx';
import {StoryWall} from './StoryWall.jsx';
import {TimelineBoard} from './TimelineBoard.jsx';
import {ProjectProvider,useProject} from './vendor/shared/project/ProjectContext.tsx';
import {MediaRail} from './MediaRail.jsx';
import {fetch as apiFetch} from './fetch-inject.mjs';
import css from './vendor/shared/styles.css';

// The DSH session workspace IS the project: no picker, no "New project". The host auto-creates the single project named after the folder.
function WorkspaceHeader(){
  const {project,loading,error}=useProject();
  return <header className="topbar" aria-label="Director Studio project">
    <div className="topbar-row">
      <div className="brand"><div className="brand-text"><div className="brand-title">Director Studio</div></div></div>
      <div className="muted tiny project-scope-hint">{loading?'Loading workspace…':project?`Session workspace: ${project.name}`:'This session has no workspace folder.'}</div>
    </div>
    {error?<div className="banner error" role="alert">{error}</div>:null}
  </header>;
}

// A queued Casting/Set/Props job becomes a structured request in the DSH conversation; the agent generates with a reviewed local ComfyUI workflow and imports the result carrying the same job token, which flips the page's job to succeeded.
function studioJobPrompt(kind,job){
  const editAsset=job.actor_id||job.scene_id||job.prop_id||'';
  const slots=kind==='actors'?'master (base render), bust_threeview, fullbody_threeview, wardrobe_ref, asset_sheet, or any other file_key (body_ref, ref_<name>, …) for images the human keeps as references — every non-master key refills the edit page as an extra reference':kind==='scenes'?'master plus one file_key per requested angle view':'master (plus extra non-master file_keys, which the edit page treats as reference images)';
  const spec=[`name=${job.name}`,job.notes?`notes=${job.notes}`:'',job.description?`description=${job.description}`:'',job.angle_prompts?`angle_prompts=${job.angle_prompts.replaceAll('\n',' | ')}`:'',job.prepend_text?`prepend=${job.prepend_text}`:'',job.append_text?`append=${job.append_text}`:'',job.negative_prompt?`negative_prompt=${job.negative_prompt}`:'',`seed=${job.seed??'random'}${job.fixed_seed?' (fixed)':''}`,kind==='actors'?`headwear=${job.include_headwear}; footwear=${job.include_footwear}`:''].filter(Boolean).join('; ');
  const refs=Object.keys(job.input_previews??{}).length?`Uploaded reference images exist: run director_studio asset.list kind=layouts query "${job.id}" and stage every returned source_path with director_stage_images before generating.`:'No reference images were uploaded.';
  const named=Object.entries(job.input_labels??{}).filter(([,label])=>String(label).trim()).map(([key,label])=>`${key}="${String(label).trim()}"`).join(', ');
  const instr=String(job.generation_instructions??'').trim()?` The human's generation instructions for this kind (gear panel): "${String(job.generation_instructions).trim()}" — follow them (workflow template, model, LoRAs).`:'';
  const crew=Object.keys(globalThis.__DSH_CREW__??{}).length?` Crew system prompts (film-crew skill — when spawning a specialist subagent for a role, paste that role's prompt verbatim as its persona): ${JSON.stringify(globalThis.__DSH_CREW__)}.`:'';
  const editNote=editAsset?`, regenerate existing asset ${editAsset}`:': new asset';
  return `[Director Studio ${kind} request] The Assets tab queued a ${kind} studio request (job token ${job.id}${editNote}). Form spec: ${spec}. ${refs}${named?` The human named these references: ${named} — when they cite one of these names in a later message, that is the image.`:''}${instr}${crew} Generate the matching media with an inspected local ComfyUI image workflow, then save every image with director_studio asset.create (kind=${kind}, job_id=${job.id}${editAsset?`, asset_id=${editAsset}`:''}, file_key from ${slots}) so this page shows the result automatically. Import the base render as file_key=master.`;
}
// The top-right gear on every studio page: instructions per asset kind plus the default form values the pages prefill.
// ponytail: mirrors DEFAULT_CREW_PROMPTS in studio-store.mjs; the client seeds them so an
// older running DSH service (pre-0.1.99, blank crew) still shows and persists real prompts.
const CREW_DEFAULTS={
producer:'You are the Producer of an AI film production. You translate the human showrunner\'s words into briefs for the right crew member, keep scope and schedule honest, and never let a note reach a camera or render decision without the Director\'s approval. You route work: only the roles a problem actually touches get called. You protect the story from well-meaning fixes, track clip counts and costs, and always end with a concrete next action for the crew or the human.',
director:'You are the Director, creative owner of story, performance, pacing and editing. Every note — from the human, the critic, continuity or the cinematographer — is weighed against one question: does this make the story more compelling, thrilling and cinematic? You re-work shots, cutting order, timing and framing until the answer is yes. Camera must reveal only what the beat needs and hide the rest; angles are chosen to show the magnitude of things (low to empower, high to diminish, close to isolate); blocking and eyelines carry the emotion. Answer with concrete shot-level decisions, not moods.',
screenwriter:'You are the Screenwriter. Deliver scenes, beats and dialogue with clear want/obstacle/turn per beat and economy of words. Dialogue is spoken, not described; subtext over exposition. Mark each beat so the Director can map it to shots. Never defend a line that fails the scene\'s turn — cut it.',
cinematographer:'You are the Cinematographer. Translate the Director\'s intent into camera language: shot size, angle, height, lens feel, movement, lighting and lensing for each shot. When asked for options, give 2-3 concrete alternatives, each one sentence of visual result plus one line on why it serves the beat. You never decide story; you propose and the Director chooses.',
storyboard:'You are the Storyboard Artist. Draw the Director\'s approved shot as one clear still: correct blocking, camera angle and height, staging depth, and every prop that must exist in the shot. Silhouette and value over detail; the frame must read at thumbnail size. If the board reveals an impossible or ambiguous staging, flag it to the Director instead of silently fixing it.',
critic:'You are the Critic, a hostile but fair audience of one. Watch the plan or the finished footage and report only what fails: boring beats, unclear geography, unmotivated movement, emotional beats that land flat, pacing dead spots. Every note ends with keep/drop/fix and a one-line reason. No praise padding, no rewrite of the work yourself.',
continuity:'You are the Script Supervisor. Compare each storyboard and each generated clip against the continuity ledger and all previous approved shots. Report only breaks: objects appearing or disappearing, state jumps (a prop handled before it exists), wardrobe or position changes, screen-direction reversals, objects vanishing mid-movement. For each break name the shot, the frame/time, the object or state, and what the ledger said.'};
function AppSettingsPanel({onClose}){
  const [s,setS]=useState(null);
  const [note,setNote]=useState('');
  const [tab,setTab]=useState('generation');
  useEffect(()=>{apiFetch('/api/library/app-settings').then((r)=>r.json()).then((v)=>{
    const crew=Object.fromEntries(Object.entries({...CREW_DEFAULTS,...(v.crew??{})}).map(([k,val])=>[k,String(val).trim()?String(val):(CREW_DEFAULTS[k]??'')]));
    const seeded=!Object.keys(CREW_DEFAULTS).every((k)=>String(v.crew?.[k]??'').trim());
    setS({...v,crew});
    // Seed blank crew prompts once so the stored settings survive even before a service restart.
    if(seeded)apiFetch('/api/library/app-settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...v,crew})}).catch(()=>{});
  }).catch(()=>setNote('Settings API not live yet — restart the DSH service to enable it.'));},[onClose]);
  const setIn=(k)=>(e)=>setS((v)=>({...v,instructions:{...v.instructions,[k]:e.target.value}}));
  const setScene=(k)=>(e)=>setS((v)=>({...v,scene_defaults:{...v.scene_defaults,[k]:e.target.value}}));
  const setActor=(k)=>(e)=>setS((v)=>({...v,actor_defaults:{...v.actor_defaults,[k]:e.target.value}}));
  const setCrew=(k)=>(e)=>setS((v)=>({...v,crew:{...(v.crew??{}),[k]:e.target.value}}));
  const setComfy=(k)=>(e)=>setS((v)=>({...v,comfy:{...(v.comfy??{}),[k]:e.target.value}}));
  const setWorkflow=(k)=>(e)=>setS((v)=>({...v,workflows:{...(v.workflows??{}),[k]:e.target.value}}));
  const saveSettings=()=>apiFetch('/api/library/app-settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(s)}).then((r)=>r.json()).then((v)=>{setS(v);setNote('Saved.');}).catch(()=>setNote('Save failed — does the running DSH service know this API (restart needed)?'));
  return <div style={{position:'fixed',inset:0,zIndex:60,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'flex-start',justifyContent:'center',padding:'1.5rem .8rem',overflow:'auto'}} onClick={onClose}>
    <div className="panel" style={{width:'min(46rem,100%)',position:'relative',background:'var(--bg-panel)',border:'1px solid var(--border-strong)',borderRadius:'10px',boxShadow:'0 12px 40px rgba(0,0,0,.45)',color:'var(--text)'}} onClick={(e)=>e.stopPropagation()}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'.6rem'}}><h2 style={{margin:0}}>Studio settings</h2><button className="btn ghost sm" aria-label="Close settings" onClick={onClose}>✕</button></div>
      {s?<>
        <div role="tablist" style={{display:'flex',gap:'.35rem',flexWrap:'wrap',marginBottom:'.9rem'}}>
          {[['generation','Generation'],['scenes','Scenes'],['actors','Actors'],['crew','Crew'],['comfy','ComfyUI'],['workflows','Workflows']].map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} className={tab===id?'btn primary sm':'btn ghost sm'} onClick={()=>setTab(id)}>{label}</button>)}
        </div>
        {tab==='generation'&&<>
          <label className="field"><span>DSH generation instructions · Actors</span><textarea rows={3} value={s.instructions.actors} onChange={setIn('actors')}/></label>
          <label className="field"><span>DSH generation instructions · Scenes</span><textarea rows={3} value={s.instructions.scenes} onChange={setIn('scenes')}/></label>
          <label className="field"><span>DSH generation instructions · Props</span><textarea rows={3} value={s.instructions.props} onChange={setIn('props')}/></label>
        </>}
        {tab==='scenes'&&<>
          <label className="field"><span>Angle prompts (one per line; each line becomes one rendered view)</span><textarea rows={6} value={s.scene_defaults.angle_prompts} onChange={setScene('angle_prompts')}/></label>
          <label className="field"><span>Prepend to every scene prompt</span><textarea rows={2} value={s.scene_defaults.prepend_text} onChange={setScene('prepend_text')}/></label>
          <label className="field"><span>Append to every scene prompt</span><textarea rows={2} value={s.scene_defaults.append_text} onChange={setScene('append_text')}/></label>
        </>}
        {tab==='actors'&&<>
          <label className="field"><span>Default character description</span><textarea rows={3} value={s.actor_defaults.description} onChange={setActor('description')}/></label>
        </>}
        {tab==='crew'&&<>
          <label className="field"><span>Producer system prompt (routing, scope, protecting the story from bad fixes)</span><textarea rows={4} value={s.crew?.producer ?? ""} onChange={setCrew('producer')}/></label>
          <label className="field"><span>Director system prompt (owns story, pacing and editing; adjudicates every note)</span><textarea rows={4} value={s.crew?.director ?? ""} onChange={setCrew('director')}/></label>
          <label className="field"><span>Screenwriter system prompt</span><textarea rows={4} value={s.crew?.screenwriter ?? ""} onChange={setCrew('screenwriter')}/></label>
          <label className="field"><span>Cinematographer system prompt (camera language, 2-3 concrete options)</span><textarea rows={4} value={s.crew?.cinematographer ?? ""} onChange={setCrew('cinematographer')}/></label>
          <label className="field"><span>Storyboard artist system prompt (one still per shot, before video)</span><textarea rows={4} value={s.crew?.storyboard ?? ""} onChange={setCrew('storyboard')}/></label>
          <label className="field"><span>Critic system prompt (hostile but fair keep/drop/fix verdicts)</span><textarea rows={4} value={s.crew?.critic ?? ""} onChange={setCrew('critic')}/></label>
          <label className="field"><span>Continuity system prompt (watches storyboards and clips against the ledger)</span><textarea rows={4} value={s.crew?.continuity ?? ""} onChange={setCrew('continuity')}/></label>
        </>}
        {tab==='comfy'&&<>
          <label className="field"><span>ComfyUI endpoints for this project (first that answers wins; takes priority over the plugin default)</span><textarea rows={4} placeholder={'http://240.0.0.242:8188\nhttp://240.1.0.100:8188'} value={s.comfy?.urls ?? ''} onChange={setComfy('urls')}/></label>
          <p className="field-hint">Job submission, reference staging and artifact import all use the same chosen endpoint. If this list is empty, the plugin settings (comfyBaseUrl, comfyTryUrls) apply. A model or LoRA missing on the chosen box can be installed there via ssh from the URL's host.</p>
        </>}
        {tab==='workflows'&&<>
          <label className="field"><span>Text-to-image workflow (saved name, or paste API-mode JSON)</span><textarea rows={3} value={s.workflows?.text_to_image ?? ''} onChange={setWorkflow('text_to_image')}/></label>
          <label className="field"><span>Image-edit workflow (saved name, or paste API-mode JSON)</span><textarea rows={3} value={s.workflows?.image_edit ?? ''} onChange={setWorkflow('image_edit')}/></label>
          <label className="field"><span>Reference-to-video workflow (saved name, or paste API-mode JSON)</span><textarea rows={3} value={s.workflows?.reference_to_video ?? ''} onChange={setWorkflow('reference_to_video')}/></label>
          <label className="field"><span>First/last-frame-to-video workflow (saved name, or paste API-mode JSON)</span><textarea rows={3} value={s.workflows?.first_last_frame_to_video ?? ''} onChange={setWorkflow('first_last_frame_to_video')}/></label>
          <label className="field"><span>Video-edit workflow (saved name, or paste API-mode JSON)</span><textarea rows={3} value={s.workflows?.video_edit ?? ''} onChange={setWorkflow('video_edit')}/></label>
          <p className="field-hint">A non-empty value is mandatory for that task kind in this project: the agent must inspect that workflow and submit its adapted graph; empty falls back to the plugin defaults. Paste the full API-mode JSON (starts with &quot;&#123;&quot;) to pin a workflow without the ComfyUI workflow store — the agent inspects it via the inline:&lt;kind&gt; label.</p>
        </>}
        <div style={{display:'flex',gap:'.5rem',alignItems:'center',marginTop:'.7rem'}}>
          <button className="btn primary" onClick={saveSettings}>Save</button>
          {note?<span className="field-hint">{note}</span>:null}
        </div>
      </>:<div className="muted">Loading settings…</div>}
    </div>
  </div>;
}
function StudioContent({area,sendDshRequest}){
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [railOpen,setRailOpen]=useState(false);
  useEffect(()=>{
    // Plugin: keep the latest crew persona notes visible to the request bridge (film-crew skill).
    apiFetch('/api/library/app-settings').then((r)=>r.json()).then((v)=>{globalThis.__DSH_CREW__=v.crew??{};}).catch(()=>{});
  },[]);
  useEffect(()=>{
    // ponytail: one generation bridge per sidebar realm; the vendored api wrappers call it right after the plugin queues the job.
    globalThis.__DSH_STUDIO_JOB__=(kind,job)=>sendDshRequest?.(studioJobPrompt(kind,job));
    return()=>{delete globalThis.__DSH_STUDIO_JOB__;};
  },[sendDshRequest]);
  return <div className={`app dsh-director-studio-app${railOpen?" media-rail-open":""}`} data-theme="oat-walnut" style={{position:'relative'}}>
    <button className="btn ghost corner-media" title="Studio media rail" aria-label="Studio media rail" aria-pressed={railOpen} onClick={()=>setRailOpen((v)=>!v)}>🎞</button>
    <button className="btn ghost corner-settings" title="Studio settings" aria-label="Studio settings" onClick={()=>setSettingsOpen(true)}>⚙</button>
    {settingsOpen?<AppSettingsPanel onClose={()=>setSettingsOpen(false)}/>:null}
    <WorkspaceHeader/>
    {area==='story'?<StoryWall/>:area==='timeline'?<TimelineBoard/>:area==='assets'?<AssetWorkspace sendAssetRequest={sendDshRequest}/>:<ProductionPage requestProduction={sendDshRequest}/>}
    {railOpen?<MediaRail onClose={()=>setRailOpen(false)}/>:null}
  </div>;
}

export function StudioRoot({area,sendDshRequest}){
  return <ProjectProvider><StudioContent area={area} sendDshRequest={sendDshRequest}/></ProjectProvider>;
}

export function mountStudioFrame(frame,area,createRoot,React,sendDshRequest){
  const doc=frame.contentDocument;
  if(!doc)throw new Error('Director Studio side-panel frame is unavailable.');
  doc.open();doc.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Director Studio</title></head><body><div id="root"></div></body></html>');doc.close();
  const style=doc.createElement('style');style.textContent=css;doc.head.append(style);
  doc.title='Director Studio';doc.documentElement.dataset.theme='oat-walnut';doc.documentElement.style.height='100%';doc.body.style.cssText='height:100%;min-height:100%;overflow:auto;margin:0';
  const root=createRoot(doc.getElementById('root'));
  root.render(React.createElement(StudioRoot,{area,sendDshRequest}));
  return ()=>root.unmount();
}
