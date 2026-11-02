import {open} from 'node:fs/promises';
import {StudioStoreError,isStudioAssetKind,studioMediaMetadata} from './studio-store.mjs';

const kinds=['actors','costumes','scenes','props','layouts','voices'];
const fail=message=>{throw new Error(`director_studio: ${message}`);};
async function readWorkspaceMedia(path,{exec,fs,maxBytes=64*1024*1024}={}){
  if(typeof path!=='string'||!path.trim()||/^[a-z]+:\/\//i.test(path))fail('media_path must be a local workspace file, not a URL. Download a verified ComfyUI output into the current DSH session workspace first.');
  const cwd=exec.agent?.session?.header?.cwd;if(!cwd||!fs)fail('a live DSH session and filesystem are required.');
  const target=await fs.resolve(path,{cwd,signal:exec.signal}),parent=await fs.resolve(cwd,{cwd,signal:exec.signal});
  if(!fs.contains(parent,target))fail('media_path must stay inside the current DSH session workspace.');
  const info=await fs.stat(target,exec.signal);if(info?.type!=='file'||!info.size||info.size>maxBytes)fail(`media_path must be a nonempty file no larger than ${maxBytes} bytes.`);
  const host=fs.processPath(target);if(fs.processPathFromHostPath?.(host)!==host)fail('filesystem path is not mapped to this DSH host.');
  const handle=await open(host,'r');
  try{const before=await handle.stat();if(!before.isFile()||before.size>maxBytes)fail('media file changed or exceeds its size limit.');const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){exec.signal?.throwIfAborted();const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}const after=await handle.stat();if(offset!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail('media file changed while being read.');return {bytes,filename:path.split(/[\\/]/).pop()};}finally{await handle.close();}
}
async function readComfyArtifact(viewUrl,{comfyBaseUrl,exec,fetchImpl,maxBytes}={}){
  if(typeof viewUrl!=='string'||!viewUrl.trim())fail('comfy_view_url must be the exact view_url from a completed DSH Comfy job.');
  let base,url;try{base=new URL(comfyBaseUrl);url=new URL(viewUrl);}catch{fail('ComfyUI artifact URL is invalid.');}
  const keys=[...url.searchParams.keys()].sort();
  if(url.origin!==base.origin||url.pathname!=='/view'||url.username||url.password||url.hash||JSON.stringify(keys)!==JSON.stringify(['filename','subfolder','type'])||url.searchParams.getAll('filename').length!==1||url.searchParams.getAll('subfolder').length!==1||url.searchParams.getAll('type').length!==1||url.searchParams.get('type')!=='output')fail('comfy_view_url must be an output /view URL from the configured ComfyUI origin.');
  const filename=url.searchParams.get('filename'),subfolder=url.searchParams.get('subfolder');
  if(!filename||filename==='.'||filename==='..'||filename.includes('/')||filename.includes('\\')||/[\u0000-\u001f\u007f]/.test(filename)||subfolder.split('/').some(part=>part==='..'||part.includes('\\')||/[\u0000-\u001f\u007f]/.test(part)))fail('ComfyUI artifact path is invalid.');
  const response=await fetchImpl(url,{redirect:'error',signal:exec.signal});if(!response.ok)fail(`ComfyUI artifact download failed with HTTP ${response.status}.`);
  const size=Number(response.headers.get('content-length'));if(Number.isFinite(size)&&size>maxBytes)fail(`ComfyUI artifact exceeds the ${maxBytes} byte limit.`);
  if(!response.body)fail('ComfyUI returned an empty artifact.');const chunks=[];let total=0;
  for await(const chunk of response.body){exec.signal?.throwIfAborted();total+=chunk.length;if(total>maxBytes)fail(`ComfyUI artifact exceeds the ${maxBytes} byte limit.`);chunks.push(Buffer.from(chunk));}
  if(!total)fail('ComfyUI returned an empty artifact.');return {bytes:Buffer.concat(chunks),filename};
}
const shortAsset=item=>({id:item.id,kind:item.kind,name:item.name,notes:item.notes,project_id:item.project_id,pipeline_id:item.pipeline_id,job_id:item.job_id,created_at:item.created_at,files:Object.entries(item.files??{}).map(([key,source_path])=>({key,filename:item.file_names?.[key]||null,source_path}))});
const shortShot=item=>({id:item.id,project_id:item.project_id,title:item.title,script_beat:item.script_beat,scene_id:item.scene_id,shot_type:item.shot_type,camera_angle:item.camera_angle,camera_motion:item.camera_motion,composition:item.composition,layout_asset_id:item.layout_asset_id,video_asset_id:item.video_asset_id,video_job_id:item.video_job_id,video_context:item.video_context,duration_s:item.duration_s,dialogue:item.dialogue,refs:item.refs,voice_refs:item.voice_refs,prompt_sections:item.prompt_sections,status:item.status});

export function createStudioTools({registry,fs,comfyBaseUrl,fetchImpl=globalThis.fetch,maxMediaBytes=64*1024*1024}={}){
  return {
    name:'director_studio',
    description:'Create and edit the Director Studio library for the current DSH session: the session workspace folder IS the project, and its single project database plus media live in a hidden .director-studio folder inside that workspace. Manage actors/scenes/props/voices and production shots here; changes appear immediately in the Assets/Production sidebar tabs. Shot updates include camera/composition metadata, layout/video links, and project-scoped video continuation settings. Generate requested media with an inspected ComfyUI workflow using submit_comfy_job, then call asset.create with the exact completed job output_artifacts.view_url as comfy_view_url; this tool downloads only /view type=output files from the configured ComfyUI origin, verifies their media signatures, and saves them directly into the workspace library. The result includes exact source_path values for saved files; use read_image on an image before staging it as a visual reference. You may also import a local media_path from the active session workspace. No separate Director Studio server is used; H3 submission retains its Director review/confirmation gate.',
    parameters:{type:'object',properties:{action:{type:'string',enum:['project.list','project.update','asset.list','asset.create','asset.update','shot.list','shot.create','shot.update','shot.approve']},project_name:{type:'string'},script_text:{type:'string'},asset_id:{type:'string',description:'For asset.update, the asset to edit. For asset.create with new media, replace this existing asset\'s file_key media in place (regeneration) so Production references keep pointing at it.'},kind:{type:'string',enum:kinds},name:{type:'string'},notes:{type:'string'},media_path:{type:'string',description:'Optional local media file inside the active DSH session workspace.'},comfy_view_url:{type:'string',description:'For asset.create, the exact output_artifacts.view_url from a completed submit_comfy_job result.'},job_id:{type:'string',description:'Originating completed DSH Comfy job ID, when importing comfy_view_url. For Assets-tab studio requests it must equal the job token quoted in the request so the page updates itself.'},file_key:{type:'string',description:'Output slot name for imported media, e.g. master, bust_threeview, fullbody_threeview, wardrobe_ref, asset_sheet; one asset.create call per generated image.'},shot_id:{type:'string'},title:{type:'string'},script_beat:{type:'string'},scene_id:{type:'string'},shot_type:{type:'string'},camera_angle:{type:'string'},camera_motion:{type:'string'},composition:{type:'string'},layout_asset_id:{anyOf:[{type:'string'},{type:'null'}]},video_asset_id:{anyOf:[{type:'string'},{type:'null'}]},video_context:{type:'object',properties:{mode:{type:'string',enum:['off','previous_shot','external_upload']},source_shot_id:{type:'string'},source_job_id:{type:'string'},source_output_key:{type:'string'},upload_id:{type:'string'},context_frames:{type:'integer',enum:[5,22,39,56]},carry_audio:{type:'boolean'}},required:['mode'],additionalProperties:false},duration_s:{type:'number',exclusiveMinimum:0,maximum:3600},dialogue:{type:'array',items:{type:'string'}},refs:{type:'array',items:{type:'object'}},voice_refs:{type:'array',items:{type:'object'}},prompt_sections:{type:'object'},query:{type:'string'}},required:['action'],additionalProperties:false},
    timeoutMs:60000,
    async execute(args={},exec){
      const {store,project}=await registry(exec?.agent?.session?.header?.cwd);
      if(args.action==='project.list')return {projects:[project]};
      if(args.action==='project.update')return {project:await store.patchProject(project.id,{...(args.project_name!==undefined?{name:args.project_name}:{}),...(args.script_text!==undefined?{script_text:args.script_text}:{})})};
      if(args.action==='asset.list'){
        if(args.kind&&!isStudioAssetKind(args.kind))fail('kind is unsupported.');
        const assets=await store.listAssets({kind:args.kind,project_id:project.id,include_unassigned:true});const query=String(args.query??'').trim().toLowerCase();
        return {assets:assets.filter(item=>!query||`${item.name} ${item.notes} ${item.kind}`.toLowerCase().includes(query)).map(shortAsset)};
      }
      if(args.action==='asset.create'){
        if(!args.kind||!isStudioAssetKind(args.kind))fail('kind is required and must be one of actors, costumes, scenes, props, layouts, or voices.');
        if(args.media_path&&args.comfy_view_url)fail('provide either media_path or comfy_view_url, not both.');
        let bytes,filename;if(args.media_path){({bytes,filename}=await readWorkspaceMedia(args.media_path,{exec,fs,maxBytes:maxMediaBytes}));studioMediaMetadata(filename,bytes);}
        else if(args.comfy_view_url){if(!args.job_id||!String(args.job_id).trim())fail('job_id from the completed submit_comfy_job result is required for direct artifact import.');if(!comfyBaseUrl)fail('ComfyUI is not configured for direct artifact import.');({bytes,filename}=await readComfyArtifact(args.comfy_view_url,{comfyBaseUrl,exec,fetchImpl,maxBytes:maxMediaBytes}));studioMediaMetadata(filename,bytes);}
        const asset=await store.saveAsset({kind:args.kind,name:args.name,notes:args.notes,project_id:project.id,asset_id:args.asset_id,filename,bytes,file_key:args.file_key,job_id:args.job_id});return {asset:shortAsset(asset),stored_media:!!bytes};
      }
      if(args.action==='asset.update'){
        if(!args.kind||!args.asset_id)fail('kind and asset_id are required.');
        const patch={};if(args.name!==undefined)patch.name=args.name;if(args.notes!==undefined)patch.notes=args.notes;
        return {asset:shortAsset(await store.updateAsset(args.kind,args.asset_id,patch))};
      }
      if(args.action==='shot.list')return {shots:(await store.listShots(project.id)).map(shortShot)};
      if(args.action==='shot.create')return {shot:shortShot(await store.saveShot(project.id,{title:args.title,script_beat:args.script_beat,scene_id:args.scene_id,shot_type:args.shot_type,camera_angle:args.camera_angle,camera_motion:args.camera_motion,composition:args.composition,duration_s:args.duration_s,dialogue:args.dialogue,refs:args.refs,voice_refs:args.voice_refs,prompt_sections:args.prompt_sections}))};
      if(args.action==='shot.update'){if(!args.shot_id)fail('shot_id is required.');const patch={};for(const key of ['title','script_beat','scene_id','shot_type','camera_angle','camera_motion','composition','layout_asset_id','video_asset_id','video_context','duration_s','dialogue','refs','voice_refs','prompt_sections'])if(args[key]!==undefined)patch[key]=args[key];return {shot:shortShot(await store.patchShot(args.shot_id,patch))};}
      if(args.action==='shot.approve'){if(!args.shot_id)fail('shot_id is required.');return {shot:shortShot(await store.approveShot(args.shot_id)),generation:'not submitted; use the reviewed Director/submit_comfy_job workflow'};}
      fail('unsupported action.');
    },
    output:{schema:{type:'object'},render(_args,value){return [{type:'text',text:JSON.stringify(value)}];}},
  };
}

export const studioToolKinds=Object.freeze(kinds);
export const studioToolError=StudioStoreError;
