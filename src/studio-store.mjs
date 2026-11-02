import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {basename,extname,join,resolve} from 'node:path';

const ASSET_KINDS=new Set(['actors','costumes','scenes','props','layouts','voices']);
const MEDIA_TYPES={
  '.jpg':['image','image/jpeg'],'.jpeg':['image','image/jpeg'],'.png':['image','image/png'],'.webp':['image','image/webp'],'.gif':['image','image/gif'],
  '.mp4':['video','video/mp4'],'.mov':['video','video/quicktime'],'.webm':['video','video/webm'],'.flac':['audio','audio/flac'],'.mp3':['audio','audio/mpeg'],'.wav':['audio','audio/wav'],
};
const clone=value=>JSON.parse(JSON.stringify(value));
const safeText=(value,max=4000)=>typeof value==='string'?value.trim().slice(0,max):'';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stamp=()=>new Date().toISOString();
const id=()=>randomUUID();

export class StudioStoreError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}

function initialState(){return {version:1,projects:[],assets:[],shots:[],files:[],jobs:[]};}
function validName(value,label){const name=safeText(value,160);if(!name)throw new StudioStoreError(`${label} is required.`);return name;}
function canonicalKind(kind){if(!ASSET_KINDS.has(kind))throw new StudioStoreError('Unsupported asset kind.');return kind;}
const REF_KIND={actor:'actors',costume:'costumes',scene:'scenes',prop:'props',layout_ref_frame:'layouts'};
const PROMPT_KEYS=['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music'];
const SHOT_TEXT_FIELDS={scene_id:128,shot_type:160,camera_angle:256,camera_motion:512,composition:4000};
function shotMetadata(input={}){const metadata={};for(const [key,max] of Object.entries(SHOT_TEXT_FIELDS))if(input[key]!==undefined){if(typeof input[key]!=='string')throw new StudioStoreError(`${key} must be a string.`);metadata[key]=safeText(input[key],max);}return metadata;}
function validateVideoContext(s,shot,value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new StudioStoreError('video_context must be an object.');
  const frames=value.context_frames??22;if(![5,22,39,56].includes(frames))throw new StudioStoreError('context_frames must be 5, 22, 39, or 56.');
  if(value.carry_audio!==undefined&&typeof value.carry_audio!=='boolean')throw new StudioStoreError('carry_audio must be a boolean.');
  const carry_audio=value.carry_audio??false;
  if(value.mode==='off')return {mode:'off'};
  if(value.mode==='external_upload'){
    const id=safeText(value.upload_id,128),asset=s.assets.find(item=>item.id===id&&item.kind==='layouts'&&item.project_id===shot.project_id&&item.files?.master),file=asset&&s.files.find(item=>item.path===asset.files.master);
    if(!file?.mime?.startsWith('video/'))throw new StudioStoreError('upload_id must reference a video in this project.');
    return {mode:'external_upload',upload_id:asset.id,context_frames:frames,carry_audio};
  }
  if(value.mode!=='previous_shot')throw new StudioStoreError('video_context mode must be off, previous_shot, or external_upload.');
  const targetIndex=s.shots.findIndex(item=>item.id===shot.id),sourceId=safeText(value.source_shot_id,128)||s.shots[targetIndex-1]?.id;
  const sourceIndex=s.shots.findIndex(item=>item.id===sourceId),source=s.shots[sourceIndex];
  if(!source||source.project_id!==shot.project_id||sourceIndex>=targetIndex)throw new StudioStoreError('source_shot_id must identify an earlier shot in the same project.');
  const sourceAsset=source.video_asset_id&&s.assets.find(item=>item.id===source.video_asset_id&&item.kind==='layouts'),source_job_id=sourceAsset?.job_id||sourceAsset?.id||'';
  if(value.source_job_id!==undefined&&safeText(value.source_job_id,200)!==source_job_id)throw new StudioStoreError('source_job_id must match the selected source shot video.');
  const source_output_key=safeText(value.source_output_key,100)||'master';
  if(source_output_key!=='master')throw new StudioStoreError('Only the saved master video is available for shot continuation.');
  return {mode:'previous_shot',source_shot_id:source.id,...(source_job_id?{source_job_id}:{}),source_output_key,context_frames:frames,carry_audio};
}
function promptSections(value){if(value===undefined)return Object.fromEntries(PROMPT_KEYS.map(key=>[key,'']));if(!value||typeof value!=='object'||Array.isArray(value))throw new StudioStoreError('prompt_sections must be an object.');for(const key of Object.keys(value))if(!PROMPT_KEYS.includes(key))throw new StudioStoreError(`Unknown prompt section: ${key}.`);return Object.fromEntries(PROMPT_KEYS.map(key=>[key,safeText(value[key],10000)]));}
function validateShotRefs(s,projectId,refs,voiceRefs){
  if(!Array.isArray(refs)||refs.length>9)throw new StudioStoreError('refs must be an array with at most 9 entries.');
  const pictures=new Set();const validRefs=refs.map(ref=>{
    if(!ref||typeof ref!=='object'||Array.isArray(ref)||!['actor','costume','scene','prop','layout_ref_frame','other'].includes(ref.role))throw new StudioStoreError('Each visual ref needs a supported role.');
    if(typeof ref.asset_id!=='string'||!ref.asset_id)throw new StudioStoreError('Each visual ref needs an asset_id.');
    if(!Number.isInteger(ref.picture_index)||ref.picture_index<1||ref.picture_index>9||pictures.has(ref.picture_index))throw new StudioStoreError('Picture indices must be unique integers from 1 through 9.');pictures.add(ref.picture_index);
    const asset=s.assets.find(item=>item.id===ref.asset_id&&(!REF_KIND[ref.role]||item.kind===REF_KIND[ref.role])&&(item.project_id===projectId||item.project_id===null));
    if(!asset||!Object.keys(asset.files??{}).length)throw new StudioStoreError('Visual ref asset is missing, belongs to another project, or has no media file.');
    if(ref.file_key!==undefined&&ref.file_key!==null&&!Object.hasOwn(asset.files,ref.file_key))throw new StudioStoreError('Visual ref file_key does not exist on that asset.');
    return {role:ref.role,asset_id:ref.asset_id,picture_index:ref.picture_index,...(ref.file_key!=null?{file_key:safeText(ref.file_key,100)}:{}),...(ref.notes?{notes:safeText(ref.notes,2000)}:{})};
  });
  if(!Array.isArray(voiceRefs)||voiceRefs.length>9)throw new StudioStoreError('voice_refs must be an array with at most 9 entries.');
  const audios=new Set();const validVoiceRefs=voiceRefs.map(ref=>{
    if(!ref||typeof ref!=='object'||Array.isArray(ref)||typeof ref.asset_id!=='string'||!ref.asset_id)throw new StudioStoreError('Each voice ref needs an asset_id.');
    if(!Number.isInteger(ref.audio_index)||ref.audio_index<1||ref.audio_index>9||audios.has(ref.audio_index))throw new StudioStoreError('Audio indices must be unique integers from 1 through 9.');audios.add(ref.audio_index);
    if(typeof ref.file_key!=='string'||!ref.file_key)throw new StudioStoreError('Each voice ref needs a file_key.');
    const asset=s.assets.find(item=>item.id===ref.asset_id&&item.kind==='voices'&&(item.project_id===projectId||item.project_id===null));
    if(!asset||!Object.hasOwn(asset.files??{},ref.file_key))throw new StudioStoreError('Voice ref is missing, belongs to another project, or has no matching media file.');
    return {asset_id:ref.asset_id,audio_index:ref.audio_index,file_key:safeText(ref.file_key,100),speaker:validName(ref.speaker,'Voice speaker'),...(ref.notes?{notes:safeText(ref.notes,2000)}:{})};
  });
  return {refs:validRefs,voice_refs:validVoiceRefs};
}
function mediaType(filename,bytes){
  const ext=extname(filename).toLowerCase(),type=MEDIA_TYPES[ext];
  if(!type)throw new StudioStoreError('Unsupported media file. Use PNG/JPEG/WebP/GIF/MP4/MOV/WebM/FLAC/MP3/WAV.');
  const text=(a,b)=>bytes.toString('ascii',a,b);
  const valid=ext==='.png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
    ['.jpg','.jpeg'].includes(ext)?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
    ext==='.gif'?['GIF87a','GIF89a'].includes(text(0,6)):
    ext==='.webp'?text(0,4)==='RIFF'&&text(8,12)==='WEBP':
    ['.mp4','.mov'].includes(ext)?text(4,8)==='ftyp':
    ext==='.webm'?bytes.subarray(0,4).equals(Buffer.from('1a45dfa3','hex')):
    ext==='.flac'?text(0,4)==='fLaC':
    ext==='.mp3'?text(0,3)==='ID3'||bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0:
    text(0,4)==='RIFF'&&text(8,12)==='WAVE';
  if(!valid)throw new StudioStoreError('Media signature does not match its filename.');
  return type;
}

// ponytail: one serialized JSON document keeps this first standalone port simple; per-project files can replace it if library size becomes a bottleneck.
function presentGenerationJob(job,s){
  const asset=s.assets.find(item=>item.kind===job.kind&&item.job_id===job.id&&Object.keys(item.files??{}).length);
  const outputs=asset?Object.entries(asset.files).map(([key,path])=>({key,filename:s.files.find(file=>file.path===path)?.filename??null,path})):null;
  const refAsset=job.ref_asset_id?s.assets.find(item=>item.id===job.ref_asset_id):null;
  const inputs=refAsset?Object.entries(refAsset.files??{}).map(([key,path])=>{const file=s.files.find(value=>value.path===path);return file?{key,filename:file.filename,path}:null;}).filter(Boolean):[];
  return {...job,status:asset&&(job.status==='queued'||job.status==='running')?'succeeded':job.status,asset_id:asset?asset.id:job.asset_id||null,ref_names:refAsset?.file_names??{},outputs,inputs};
}
export function createStudioStore({root,maxAssetBytes=64*1024*1024,now=Date.now}={}){
  if(!root||typeof root!=='string')throw new TypeError('A persistent Studio data root is required.');
  root=resolve(root);const statePath=join(root,'studio.json'),mediaRoot=join(root,'media');let state,tail=Promise.resolve();
  async function load(){
    if(state)return state;
    await mkdir(root,{recursive:true,mode:0o700});
    try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;state=initialState();}
    if(!state||state.version!==1||!Array.isArray(state.projects)||!Array.isArray(state.assets)||!Array.isArray(state.shots)||!Array.isArray(state.files))throw new Error('Director Studio data file is invalid; it was left untouched.');
    if(!Array.isArray(state.jobs))state.jobs=[];// older workspaces predate generation jobs; widen in place on next write.
    return state;
  }
  async function change(mutator){
    const operation=tail.then(async()=>{
      const current=await load(),next=clone(current),result=await mutator(next);
      const temporary=statePath+'.'+randomUUID()+'.part';let handle;
      try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(next));await handle.sync();await handle.close();handle=undefined;await rename(temporary,statePath);state=next;}
      finally{await handle?.close();await unlink(temporary).catch(()=>{});}
      return result;
    });
    tail=operation.catch(()=>{});return operation;
  }
  async function putMedia({filename,bytes,kind}){
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxAssetBytes)throw new StudioStoreError(`Media is empty or exceeds the ${maxAssetBytes} byte limit.`,413);
    filename=basename(String(filename??'').replaceAll('\\','/')).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200);
    if(!filename)throw new StudioStoreError('Media filename is required.');
    const [type,mime]=mediaType(filename,bytes);
    const assetId=id(),digest=hash(bytes),ext=extname(filename).toLowerCase();
    await mkdir(mediaRoot,{recursive:true,mode:0o700});
    const path=join(mediaRoot,`${assetId}${ext}`),temporary=path+'.'+randomUUID()+'.part';let handle;
    try{handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;await rename(temporary,path);}
    finally{await handle?.close();await unlink(temporary).catch(()=>{});}
    return {id:assetId,kind,filename:basename(filename).slice(0,200),path,type,mime,size:bytes.length,sha256:digest,created_at:stamp()};
  }
  async function project(projectId,s){const value=s.projects.find(item=>item.id===projectId);if(!value)throw new StudioStoreError('Project not found.',404);return value;}
  return {
    root,
    async listProjects(){return clone((await load()).projects);},
    async createProject(input={}){return change(s=>{const item={id:id(),name:validName(input.name,'Project name'),script_text:safeText(input.script_text,100000),mode:['director','mv','json_production'].includes(input.mode)?input.mode:'director',created_at:stamp(),updated_at:stamp()};s.projects.push(item);return clone(item);});},
    async getProject(projectId){const s=await load();const p=await project(projectId,s);return {...clone(p),shots:clone(s.shots.filter(item=>item.project_id===projectId)),assets:clone(s.assets.filter(item=>item.project_id===projectId))};},
    async patchProject(projectId,input={}){return change(async s=>{const item=await project(projectId,s);if(input.name!==undefined)item.name=validName(input.name,'Project name');if(input.script_text!==undefined)item.script_text=safeText(input.script_text,100000);if(input.mode!==undefined){if(!['director','mv','json_production'].includes(input.mode))throw new StudioStoreError('Unsupported project mode.');item.mode=input.mode;}item.updated_at=stamp();return clone(item);});},
    async listAssets({kind,project_id,include_unassigned=false}={}){const s=await load();return clone(s.assets.filter(item=>(!kind||item.kind===canonicalKind(kind))&&(!project_id||item.project_id===project_id||include_unassigned&&!item.project_id)));},
    async saveAsset(input={}){
      const kind=canonicalKind(input.kind),name=input.asset_id&&input.name===undefined?null:validName(input.name,'Asset name'),projectId=input.project_id||null,fileKey=safeText(input.file_key,100)||'master';
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(fileKey))throw new StudioStoreError('file_key may contain only letters, numbers, underscore and hyphen.');
      let replaced=[];
      return change(async s=>{
        if(projectId)await project(projectId,s);
        const file=input.bytes?await putMedia({filename:input.filename,bytes:input.bytes,kind}):null;
        if(input.asset_id){
          // Regenerate path: swap the file_key media on the existing asset so Production refs keep pointing at it.
          const item=s.assets.find(value=>value.id===input.asset_id&&value.kind===kind);
          if(!item)throw new StudioStoreError('Asset not found.',404);
          if(file){const previous=item.files?.[fileKey];if(previous&&previous!==file.path)replaced.push(previous);item.files={...item.files,[fileKey]:file.path};item.file_names={...item.file_names,[fileKey]:file.filename};s.files=s.files.filter(value=>value.path!==previous);s.files.push(file);}
          if(name)item.name=name;if(input.notes!==undefined)item.notes=safeText(input.notes,10000);if(input.job_id!==undefined)item.job_id=safeText(input.job_id,200);if(Number.isSafeInteger(input.seed))item.seed=input.seed;
          item.updated_at=stamp();return clone(item);
        }
        const item={id:id(),kind,name,notes:safeText(input.notes,10000),pipeline_id:safeText(input.pipeline_id,200),job_id:safeText(input.job_id,200),seed:Number.isSafeInteger(input.seed)?input.seed:null,created_at:stamp(),files:file?{[fileKey]:file.path}:{},file_names:file?{[fileKey]:file.filename}:{},meta:input.meta&&typeof input.meta==='object'&&!Array.isArray(input.meta)?input.meta:{},urls:{},project_id:projectId};
        s.assets.push(item);if(file)s.files.push(file);return clone(item);
      }).finally(()=>Promise.all(replaced.map(path=>unlink(path).catch(()=>{}))));
    },
    // Generation jobs back the Assets tab Casting/Set/Props pages; DSH performs the ComfyUI run and imports an asset carrying job_id=<token>, which flips the job to succeeded.
    // ponytail: job state is derived on read (asset with matching job token wins), so a lost update can never strand a page; ref media lives in a temporary layouts asset the agent reads by source_path.
    async createGenerationJob(input={}){
      const kind=canonicalKind(input.kind);if(!['actors','scenes','props'].includes(kind))throw new StudioStoreError('Generation jobs support actors, scenes and props only.');
      if(input.project_id)await project(input.project_id,await load());
      if(input.asset_id){const s=await load();if(!s.assets.find(item=>item.id===input.asset_id&&item.kind===kind))throw new StudioStoreError('Edited asset does not exist for that kind.',404);}
      const references=[],files=[];
      for(const ref of Array.isArray(input.references)?input.references:[]){
        const key=safeText(ref.key,100);if(!/^[A-Za-z0-9_-]{1,100}$/.test(key))throw new StudioStoreError('Reference field names may contain only letters, numbers, underscore and hyphen.');
        files.push({...await putMedia({filename:ref.filename,bytes:ref.bytes,kind}),key});references.push(key);
      }
      return change(s=>{
        const job={id:id(),kind,status:'queued',error:null,name:safeText(input.name,200),notes:safeText(input.notes,10000),description:safeText(input.description,20000),body_description:safeText(input.body_description,20000),hair_description:safeText(input.hair_description,20000),angle_prompts:safeText(input.angle_prompts,20000),prepend_text:safeText(input.prepend_text,20000),append_text:safeText(input.append_text,20000),negative_prompt:safeText(input.negative_prompt,20000),include_headwear:!!input.include_headwear,include_footwear:!!input.include_footwear,seed:Number.isSafeInteger(input.seed)?input.seed:null,fixed_seed:!!input.fixed_seed,project_id:input.project_id||null,asset_id:input.asset_id||null,ref_asset_id:null,created_at:stamp(),updated_at:stamp()};
        if(files.length){
          const refAsset={id:id(),kind:'layouts',name:`[job ${job.id}] request references`,notes:'Temporary reference inputs for an Assets tab generation request; safe to delete once the request completes.',pipeline_id:'',job_id:job.id,seed:null,created_at:stamp(),files:Object.fromEntries(files.map(file=>[file.key,file.path])),file_names:Object.fromEntries(files.map(file=>[file.key,file.filename])),meta:{temporary_job_refs:true},urls:{},project_id:job.project_id};
          s.assets.push(refAsset);s.files.push(...files);job.ref_asset_id=refAsset.id;
        }
        s.jobs.push(job);return clone(job);
      });
    },
    async getGenerationJob(jobId){const s=await load();const job=s.jobs.find(item=>item.id===jobId);if(!job)return null;return clone(presentGenerationJob(job,s));},
    async listGenerationJobs({kind,project_id,limit=20}={}){
      const s=await load(),jobs=s.jobs.filter(item=>(!kind||item.kind===canonicalKind(kind))&&(!project_id||item.project_id===project_id));
      return clone(jobs.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,Math.max(1,Math.min(100,Number(limit)||20))).map(job=>presentGenerationJob(job,s)));
    },
    async updateGenerationJob(jobId,input={}){
      return change(s=>{const job=s.jobs.find(item=>item.id===jobId);if(!job)throw new StudioStoreError('Generation job not found.',404);
        if(input.status!==undefined){if(!['queued','running','succeeded','failed','cancelled'].includes(input.status))throw new StudioStoreError('Unsupported job status.');job.status=input.status;}
        if(input.error!==undefined)job.error=safeText(input.error,2000)||null;
        job.updated_at=stamp();return clone(job);});
    },
    async updateAsset(kind,assetId,input={}){canonicalKind(kind);return change(s=>{const item=s.assets.find(value=>value.id===assetId&&value.kind===kind);if(!item)throw new StudioStoreError('Asset not found.',404);if(input.name!==undefined)item.name=validName(input.name,'Asset name');if(input.notes!==undefined)item.notes=safeText(input.notes,10000);item.updated_at=stamp();return clone(item);});},
    async deleteAsset(kind,assetId){
      canonicalKind(kind);
      const result=await change(s=>{const index=s.assets.findIndex(value=>value.id===assetId&&value.kind===kind);if(index<0)throw new StudioStoreError('Asset not found.',404);if(s.shots.some(shot=>shot.layout_asset_id===assetId||shot.video_asset_id===assetId||shot.video_context?.upload_id===assetId||(shot.refs??[]).some(ref=>ref.asset_id===assetId)||(shot.voice_refs??[]).some(ref=>ref.asset_id===assetId)))throw new StudioStoreError('Cannot delete an asset referenced by a Production shot.');const [item]=s.assets.splice(index,1),paths=Object.values(item.files??{});s.files=s.files.filter(file=>!paths.includes(file.path));return {deleted:true,id:item.id,paths};});
      await Promise.all(result.paths.map(path=>unlink(path).catch(()=>{})));delete result.paths;return result;
    },
    async assignAsset(kind,assetId,projectId){
      canonicalKind(kind);
      return change(async s=>{
        const item=s.assets.find(value=>value.id===assetId&&value.kind===kind);if(!item)throw new StudioStoreError('Asset not found.',404);
        const target=projectId||null;if(target)await project(target,s);
        const usedElsewhere=Boolean(target&&s.shots.some(shot=>shot.project_id!==target&&(shot.layout_asset_id===assetId||shot.video_asset_id===assetId||shot.video_context?.upload_id===assetId||(shot.refs??[]).some(ref=>ref.asset_id===assetId)||(shot.voice_refs??[]).some(ref=>ref.asset_id===assetId))));
        if(usedElsewhere)throw new StudioStoreError('Cannot move this asset into a project while another project shot references it.');
        item.project_id=target;return clone(item);
      });
    },
    async listShots(projectId){const s=await load();await project(projectId,s);return clone(s.shots.filter(item=>item.project_id===projectId));},
    async getShot(shotId){const shot=(await load()).shots.find(item=>item.id===shotId);if(!shot)throw new StudioStoreError('Shot not found.',404);return clone(shot);},
    async getVideoContextStatus(shotId){const s=await load(),shot=s.shots.find(item=>item.id===shotId);if(!shot)throw new StudioStoreError('Shot not found.',404);const context=shot.video_context??{mode:'off'};const index=s.shots.findIndex(item=>item.id===shot.id),sourceId=context.mode==='previous_shot'?(context.source_shot_id||s.shots[index-1]?.id):null,source=s.shots.find(item=>item.id===sourceId&&item.project_id===shot.project_id);const blocked_reasons=context.mode==='previous_shot'&&!source?.video_asset_id?['Source shot has no linked video asset.']:[];return {mode:context.mode,source_job_id:context.source_job_id||source?.video_job_id||null,context_frames:context.context_frames??null,carry_audio:Boolean(context.carry_audio),blocked_reasons,resolution:null};},
    async getVideoAssetJob(jobId){const s=await load(),asset=s.assets.find(item=>item.kind==='layouts'&&(item.job_id===jobId||item.id===jobId)&&item.files?.master);if(!asset)return null;const file=s.files.find(item=>item.path===asset.files.master);if(!file?.mime?.startsWith('video/'))return null;return {id:jobId,asset_id:asset.id,filename:file.filename,mime:file.mime,source_path:file.path};},
    async saveShot(projectId,input={}){
      const title=validName(input.title,'Shot title'),metadata=shotMetadata(input);
      return change(async s=>{
        await project(projectId,s);
        const dialogue=input.dialogue??[];
        if(!Array.isArray(dialogue)||dialogue.length>100||dialogue.some(line=>typeof line!=='string'))throw new StudioStoreError('dialogue must be an array of at most 100 strings.');
        const refs=validateShotRefs(s,projectId,input.refs??[],input.voice_refs??[]);
        const shot={id:id(),project_id:projectId,scene_id:metadata.scene_id??'',title,script_beat:safeText(input.script_beat,10000),shot_type:metadata.shot_type??'',camera_angle:metadata.camera_angle??'',camera_motion:metadata.camera_motion??'',composition:metadata.composition??'',duration_s:Number.isFinite(input.duration_s)?Math.max(0.1,Math.min(3600,input.duration_s)):4,dialogue:dialogue.map(line=>safeText(line,2000)).filter(Boolean),dialogue_lines:[],refs:refs.refs,voice_refs:refs.voice_refs,prompt_sections:promptSections(input.prompt_sections),layout_asset_id:null,layout_review_status:null,ref_frame_job_id:null,layout_refs:[],video_asset_id:null,video_job_id:null,h3_job_id:null,video_context:{mode:'off'},source_audio_path:null,feedback:'',blocked_reasons:[],meta:{},status:'draft',created_at:stamp(),updated_at:stamp()};
        s.shots.push(shot);return clone(shot);
      });
    },
    async patchShot(shotId,input={}){
      const metadata=shotMetadata(input);
      return change(s=>{
        const shot=s.shots.find(value=>value.id===shotId);if(!shot)throw new StudioStoreError('Shot not found.',404);
        Object.assign(shot,metadata);
        if(input.title!==undefined)shot.title=validName(input.title,'Shot title');
        if(input.script_beat!==undefined)shot.script_beat=safeText(input.script_beat,10000);
        if(input.duration_s!==undefined){if(!Number.isFinite(input.duration_s)||input.duration_s<=0||input.duration_s>3600)throw new StudioStoreError('Shot duration must be between 0 and 3600 seconds.');shot.duration_s=input.duration_s;}
        if(input.dialogue!==undefined){if(!Array.isArray(input.dialogue)||input.dialogue.length>100||input.dialogue.some(line=>typeof line!=='string'))throw new StudioStoreError('dialogue must be an array of at most 100 strings.');shot.dialogue=input.dialogue.map(line=>safeText(line,2000)).filter(Boolean);}
        if(input.refs!==undefined||input.voice_refs!==undefined){const refs=validateShotRefs(s,shot.project_id,input.refs??shot.refs,input.voice_refs??shot.voice_refs);shot.refs=refs.refs;shot.voice_refs=refs.voice_refs;}
        if(input.prompt_sections!==undefined)shot.prompt_sections=promptSections(input.prompt_sections);
        if(input.layout_asset_id!==undefined){
          if(input.layout_asset_id===null)shot.layout_asset_id=null;
          else{const layout=s.assets.find(item=>item.id===input.layout_asset_id&&item.kind==='layouts'&&(item.project_id===shot.project_id||item.project_id===null)&&item.files?.master);if(!layout)throw new StudioStoreError('layout_asset_id must reference a project-available layout asset with a master file.');shot.layout_asset_id=layout.id;}
        }
        if(input.video_asset_id!==undefined){
          if(input.video_asset_id===null){shot.video_asset_id=null;shot.video_job_id=null;}
          else{const asset=s.assets.find(item=>item.id===input.video_asset_id&&item.kind==='layouts'&&(item.project_id===shot.project_id||item.project_id===null)&&item.files?.master);const file=asset&&s.files.find(item=>item.path===asset.files.master);if(!file?.mime?.startsWith('video/'))throw new StudioStoreError('video_asset_id must reference a project-available layout asset with a video master file.');shot.video_asset_id=asset.id;shot.video_job_id=asset.job_id||asset.id;}
        }
        if(input.video_context!==undefined)shot.video_context=validateVideoContext(s,shot,input.video_context);
        if(input.feedback!==undefined)shot.feedback=safeText(input.feedback,10000);
        shot.updated_at=stamp();return clone(shot);
      });
    },
    async approveShot(shotId){return change(s=>{const shot=s.shots.find(value=>value.id===shotId);if(!shot)throw new StudioStoreError('Shot not found.',404);shot.status='approved';shot.updated_at=stamp();return clone(shot);});},
    async getMedia(path){const s=await load(),file=s.files.find(item=>item.path===path);if(!file)throw new StudioStoreError('Media not found.',404);return clone(file);},
    async readMedia(file){if(!file||!file.path.startsWith(mediaRoot+'/'))throw new StudioStoreError('Media not found.',404);return readFile(file.path);},
    async snapshot(){return clone(await load());},
    async close(){await tail;},
  };
}

export const studioStoreConstants=Object.freeze({assetKinds:[...ASSET_KINDS],maxAssetBytes:64*1024*1024});

// ponytail: the DSH session workspace IS the project; each workspace keeps its single project database and media in a hidden .director-studio folder.
// One store per workspace path is cached in-process. Known ceiling: projects[0] wins if the folder already held a legacy multi-project file; revisit with a picker only if that ever matters.
export function createStudioRegistry({dotFolder='.director-studio'}={}){
  const entries=new Map();
  return async function studioFor(cwd){
    if(!cwd||typeof cwd!=='string')throw new StudioStoreError('The active DSH session has no workspace folder.',409);
    const root=resolve(join(resolve(cwd),dotFolder));
    let entry=entries.get(root);
    if(!entry){
      entry=(async()=>{
        const store=createStudioStore({root});
        const projects=await store.listProjects();
        const project=projects[0]??await store.createProject({name:basename(resolve(cwd))||'Session workspace'});
        return {store,project};
      })().catch(error=>{entries.delete(root);throw error;});
      entries.set(root,entry);
    }
    return entry;
  };
}
export function studioAssetDigest(bytes){return hash(bytes);}
export function isStudioAssetKind(kind){return ASSET_KINDS.has(kind);}
export function studioMediaMetadata(filename,bytes){return mediaType(filename,bytes);}
export function studioSafeText(value,max){return safeText(value,max);}
export function studioTimestamp(now=Date.now){return new Date(now()).toISOString();}
