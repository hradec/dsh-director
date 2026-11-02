import {useEffect} from 'react';
import {AssetWorkspace} from './vendor/features/assets/AssetWorkspace.tsx';
import {ProductionPage} from './vendor/features/production/ProductionPage.tsx';
import {ProjectProvider,useProject} from './vendor/shared/project/ProjectContext.tsx';
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
  const slots=kind==='actors'?'master (base render), bust_threeview, fullbody_threeview, wardrobe_ref, or asset_sheet':kind==='scenes'?'master plus one file_key per requested angle view':'master (plus optional extra view file_keys)';
  const spec=[`name=${job.name}`,job.notes?`notes=${job.notes}`:'',job.description?`description=${job.description}`:'',job.angle_prompts?`angle_prompts=${job.angle_prompts.replaceAll('\n',' | ')}`:'',job.prepend_text?`prepend=${job.prepend_text}`:'',job.append_text?`append=${job.append_text}`:'',job.negative_prompt?`negative_prompt=${job.negative_prompt}`:'',`seed=${job.seed??'random'}${job.fixed_seed?' (fixed)':''}`,kind==='actors'?`headwear=${job.include_headwear}; footwear=${job.include_footwear}`:''].filter(Boolean).join('; ');
  const refs=Object.keys(job.input_previews??{}).length?`Uploaded reference images exist: run director_studio asset.list kind=layouts query "${job.id}" and stage every returned source_path with director_stage_images before generating.`:'No reference images were uploaded.';
  const editNote=editAsset?`, regenerate existing asset ${editAsset}`:': new asset';
  return `[Director Studio ${kind} request] The Assets tab queued a ${kind} studio request (job token ${job.id}${editNote}). Form spec: ${spec}. ${refs} Generate the matching media with an inspected local ComfyUI image workflow, then save every image with director_studio asset.create (kind=${kind}, job_id=${job.id}${editAsset?`, asset_id=${editAsset}`:''}, file_key from ${slots}) so this page shows the result automatically. Import the base render as file_key=master.`;
}
function StudioContent({area,sendDshRequest}){
  useEffect(()=>{
    // ponytail: one generation bridge per sidebar realm; the vendored api wrappers call it right after the plugin queues the job.
    globalThis.__DSH_STUDIO_JOB__=(kind,job)=>sendDshRequest?.(studioJobPrompt(kind,job));
    return()=>{delete globalThis.__DSH_STUDIO_JOB__;};
  },[sendDshRequest]);
  return <div className="app dsh-director-studio-app" data-theme="oat-walnut">
    <WorkspaceHeader/>
    {area==='assets'?<AssetWorkspace sendAssetRequest={sendDshRequest}/>:<ProductionPage requestProduction={sendDshRequest}/>}
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
