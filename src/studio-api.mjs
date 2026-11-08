import {StudioStoreError,isStudioAssetKind,studioStoreConstants} from './studio-store.mjs';
import {storyStoreFor} from './story-store.mjs';
import {Readable} from 'node:stream';
import {createReadStream,statSync,realpathSync,readdirSync,readFileSync} from 'node:fs';
import {isAbsolute,join,sep,extname} from 'node:path';
import {homedir,tmpdir} from 'node:os';

// ponytail: browsers cannot open server filesystem paths, so dsh-ui media srcs must be URLs; this route streams local media through the GUI origin.
// Ceiling: single Range only (seeks re-stream tail), media extensions only, roots = homedir + /tmp + session workspace; secret dot-folders denied except director-media/attachments.
const FILE_MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.aac':'audio/aac','.pdf':'application/pdf'};
const FILE_MAX_BYTES=512*1024*1024;

const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
function sendJson(res,status,value){const body=JSON.stringify(value);res.writeHead(status,{...jsonHeaders,'Content-Length':String(Buffer.byteLength(body))});res.end(body);}
function routeError(res,error){const status=error instanceof StudioStoreError?error.status:400;sendJson(res,status,{detail:error instanceof Error?error.message:'Request failed.'});}
async function bodyBytes(req,maxBytes,signal){const chunks=[];let size=0;for await(const chunk of req){signal?.throwIfAborted();size+=chunk.length;if(size>maxBytes)throw new StudioStoreError('Request body exceeds its size limit.',413);chunks.push(chunk);}return Buffer.concat(chunks);}
async function readJson(req,signal,maxBytes=1024*1024){const bytes=await bodyBytes(req,maxBytes,signal);if(!bytes.length)return {};if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json'))throw new StudioStoreError('Expected application/json.');try{const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw new StudioStoreError('Request body is invalid JSON.');}}
function parseMultipart(bytes,contentType){
  const match=/^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);const boundary=match?.[1]||match?.[2];
  if(!boundary||boundary.length>200||/[\r\n]/.test(boundary))throw new StudioStoreError('Invalid multipart boundary.');
  const marker=Buffer.from(`--${boundary}`),fields=Object.create(null);let position=0,count=0;
  while(position<bytes.length){let start=bytes.indexOf(marker,position);if(start<0)break;start+=marker.length;if(bytes.subarray(start,start+2).toString()==='--')break;if(bytes.subarray(start,start+2).toString()==='\r\n')start+=2;
    const headersEnd=bytes.indexOf(Buffer.from('\r\n\r\n'),start);if(headersEnd<0)throw new StudioStoreError('Invalid multipart part headers.');const headerText=bytes.subarray(start,headersEnd).toString('latin1');const disposition=/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
    if(!disposition)throw new StudioStoreError('Multipart field is missing a name.');const end=bytes.indexOf(marker,headersEnd+4);if(end<0)throw new StudioStoreError('Multipart body is incomplete.');let value=bytes.subarray(headersEnd+4,end);if(value.subarray(-2).toString()==='\r\n')value=value.subarray(0,-2);
    const name=disposition[1];if(Object.hasOwn(fields,name))throw new StudioStoreError('Duplicate multipart field.');if(++count>32)throw new StudioStoreError('Too many multipart fields.',413);
    if(disposition[2]!==undefined)fields[name]={filename:disposition[2],bytes:Buffer.from(value)};else fields[name]=value.toString('utf8').slice(0,100000);
    position=end;
  }
  return fields;
}
async function readMultipart(req,signal,maxBytes=studioStoreConstants.maxAssetBytes+1024*1024){return parseMultipart(await bodyBytes(req,maxBytes,signal),String(req.headers['content-type']??''));}
const fileUrl=(kind,assetId,key,session)=>`/director-studio/api/files/library/${encodeURIComponent(kind)}/${encodeURIComponent(assetId)}/${encodeURIComponent(key)}?session=${encodeURIComponent(session??'')}`;
function presentAsset(item,session){const urls={},files={};for(const key of Object.keys(item.files??{})){urls[key]=fileUrl(item.kind,item.id,key,session);files[key]=item.file_names?.[key]||item.files[key].split(/[\\/]/).pop();}const {file_names,...publicItem}=item;return {...publicItem,files,urls};}
// Jobs mirror the upstream Casting/Set/Props job records; outputs materialize once DSH imports an asset carrying the job token.
function presentGenerationRecord(job,session){
  const outputs={},output_order=[];
  if(job.outputs&&job.asset_id)for(const output of job.outputs){outputs[output.key]={key:output.key,label:null,filename:output.filename,url:fileUrl(job.kind,job.asset_id,output.key,session)};output_order.push(output.key);}
  const input_previews={},input_files={};for(const input of job.inputs??[]){input_previews[input.key]=fileUrl('layouts',job.ref_asset_id,input.key,session);input_files[input.key]=input.filename;}
  const has=key=>(job.inputs??[]).some(input=>input.key===key);
  return {id:job.id,status:job.status,mode:has('wardrobe_image')?'wardrobe':has('actor_image')?'reference':'text',name:job.name,notes:job.notes,description:job.description??'',body_description:job.body_description??'',hair_description:job.hair_description??'',angle_prompts:job.angle_prompts??'',prepend_text:job.prepend_text??'',append_text:job.append_text??'',negative_prompt:job.negative_prompt??'',has_actor_ref:has('actor_image'),has_wardrobe_ref:has('wardrobe_image'),include_headwear:!!job.include_headwear,include_footwear:!!job.include_footwear,seed:job.seed??null,fixed_seed:!!job.fixed_seed,error:job.error??null,comfy_prompt_id:null,created_at:job.created_at,updated_at:job.updated_at,outputs,output_order,input_previews,input_files,input_labels:job.ref_labels??{},generation_instructions:job.generation_instructions??'',actor_id:job.kind==='actors'?job.asset_id??null:null,scene_id:job.kind==='scenes'?job.asset_id??null:null,prop_id:job.kind==='props'?job.asset_id??null:null,pipeline_id:'dsh-agent'};
}
// The form block lets the studio pages re-fill an existing asset's inputs for a regeneration; the latest job that produced the asset is authoritative.
function generationForm(job){return {description:job.description??'',body_description:job.body_description??'',hair_description:job.hair_description??'',angle_prompts:job.angle_prompts??'',prepend_text:job.prepend_text??'',append_text:job.append_text??'',negative_prompt:job.negative_prompt??'',include_headwear:!!job.include_headwear,include_footwear:!!job.include_footwear,seed:job.seed??null,fixed_seed:!!job.fixed_seed,ref_labels:job.ref_labels??{}};}
// Stored reference images of the job that produced an asset, so the studio pages can refill their upload slots on edit.
function assetReferences(job,session){if(!job?.ref_asset_id)return null;return Object.fromEntries((job.inputs??[]).map(input=>[input.key,{url:fileUrl('layouts',job.ref_asset_id,input.key,session),filename:input.filename,label:job.ref_labels?.[input.key]??input.filename}]));}
function presentProject(project,shots=[]){return {...project,shot_ids:shots.map(shot=>shot.id)};}

let sessionIndexCache=null;
// ponytail: session-less /api/file infers the workspace root from DSH session headers (prefix match, 60s cache); ceilings: stale up to 60s, newest cwd wins.
function defaultSessionIndex(){
  if(sessionIndexCache&&Date.now()-sessionIndexCache.at<60000)return sessionIndexCache.rows;
  const dir=join(homedir(),'.dsh','storages','session_projcache','sessions');let rows=[];
  try{for(const entry of readdirSync(dir)){
    if(!entry.startsWith('session-')||!entry.endsWith('.json'))continue;
    try{const full=join(dir,entry);const cwd=JSON.parse(readFileSync(full,'utf8'))?.record?.identity?.cwd;if(cwd)rows.push({id:entry.slice(0,-5),cwd,mtime:statSync(full).mtimeMs});}catch{}
  }rows.sort((a,b)=>b.mtime-a.mtime);}catch{}
  sessionIndexCache={at:Date.now(),rows};return rows;
}
async function serveFileRoute(req,res,url,{workspace,sessionIndex=defaultSessionIndex}){
  const raw=url.searchParams.get('path')??'';
  if(!raw||raw.length>2000)throw new StudioStoreError('A path query parameter is required.');
  const candidate=isAbsolute(raw)?raw:(workspace?join(workspace,raw):'');
  if(!candidate)throw new StudioStoreError('Relative paths need the session parameter.',400);
  let resolved;try{resolved=realpathSync(candidate);}catch{throw new StudioStoreError('File not found.',404);}
  const inside=(file,root)=>file===root||file.startsWith(root.endsWith(sep)?root:root+sep);
  let roots=[homedir(),tmpdir(),...(workspace?[workspace]:[])].filter(Boolean);
  if(!roots.some(root=>inside(resolved,root))&&isAbsolute(candidate)){for(const entry of sessionIndex()){if(entry.cwd&&(candidate.startsWith(entry.cwd+sep)||resolved.startsWith(entry.cwd+sep))){roots=[...roots,entry.cwd];break;}}}
  if(!roots.some(root=>inside(resolved,root)))throw new StudioStoreError('File is outside the allowed roots (session workspace, home, /tmp).',403);
  // Secret dot-folders deny at REAL paths: symlinked homes and session-index roots must not smuggle them past a literal ~/.dsh compare.
  const realpathSafe=p=>{try{return realpathSync(p);}catch{return '';}};
  const homeReal=realpathSafe(homedir());
  const deniedDirs=['.ssh','.aws','.gnupg','.azure','.config'].map(d=>realpathSafe(join(homeReal,d))).filter(Boolean);
  if(deniedDirs.some(dir=>inside(resolved,dir)))throw new StudioStoreError('That location is not served.',403);
  const dsh=join(homeReal,'.dsh');
  if(inside(resolved,dsh)&&!['director-media','attachments','custom-plugins'].some(x=>inside(resolved,join(dsh,x))))throw new StudioStoreError('That location is not served.',403);
  const mime=FILE_MIME[extname(resolved).toLowerCase()];
  if(!mime)throw new StudioStoreError('Only media and PDF files are served here.');
  const info=statSync(resolved);
  if(!info.isFile()||info.size>FILE_MAX_BYTES)throw new StudioStoreError('Not a servable file (size or type).',413);
  const range=/^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range??''));
  const base={'Content-Type':mime,'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Cache-Control':'private, max-age=300'};
  if(range){if(Number(range[1])>info.size-1){res.writeHead(416,{...base,'Content-Range':`bytes */${info.size}`});res.end();return;}const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),info.size-1):info.size-1;res.writeHead(206,{...base,'Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/${info.size}`});if(req.method==='HEAD'){res.end();return;}createReadStream(resolved,{start,end}).pipe(res);return;}
  res.writeHead(200,{...base,'Content-Length':String(info.size)});
  if(req.method==='HEAD'){res.end();return;}
  createReadStream(resolved).pipe(res);
}

export function createStudioApiHandler({resolveSession,requestRejection,comfyBaseUrl='http://127.0.0.1:8188',comfyHosts=async()=>[],sessionIndex=defaultSessionIndex,fetchImpl=globalThis.fetch,maxUploadBytes=studioStoreConstants.maxAssetBytes,controllers=new Set()}={}){
  return async(req,res)=>{
    const controller=new AbortController();controllers.add(controller);const abort=()=>controller.abort();res.once('close',abort);
    try{
      const rejection=requestRejection(req);if(rejection!==undefined){res.writeHead(rejection);res.end();return;}
      const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/director-studio')){sendJson(res,404,{detail:'Not found.'});return;}
      const path=url.pathname.slice('/director-studio'.length)||'/';if(!path.startsWith('/api/')){sendJson(res,404,{detail:'Not found.'});return;}
      if(req.method==='OPTIONS'){res.writeHead(204,{Allow:'GET, HEAD, POST, PATCH, DELETE, OPTIONS'});res.end();return;}
      if(req.method==='GET'&&path==='/api/health'){
        let reachable=false,comfyError=null;try{const base=typeof comfyBaseUrl==='function'?await comfyBaseUrl():comfyBaseUrl;const response=await fetchImpl(`${base}/system_stats`,{signal:controller.signal,redirect:'error'});reachable=response.ok;if(!response.ok)comfyError=`HTTP ${response.status}`;}catch(error){comfyError=error.message;}
        sendJson(res,200,{ok:true,comfy_reachable:reachable,comfy_error:comfyError});return;
      }
      // Repaired conversation media URLs carry no session: absolute paths resolve roots via the session index.
      if(path==='/api/file'&&['GET','HEAD'].includes(req.method)&&typeof req.headers['x-director-session']!=='string'&&!url.searchParams.get('session')){await serveFileRoute(req,res,url,{workspace:null,sessionIndex});return;}
      // The DSH sidebar identifies its session by header; media URLs use ?session= because <img>/<video> tags cannot send headers.
      const sessionId=(typeof req.headers['x-director-session']==='string'?req.headers['x-director-session']:'')||url.searchParams.get('session')||'';
      if(!sessionId){sendJson(res,400,{detail:'Director Studio requests need the X-Director-Session header or session query parameter identifying the active DSH session.'});return;}
      const {store,project}=await resolveSession(sessionId);
      if(path==='/api/projects'&&req.method==='GET'){const shots=await store.snapshot();sendJson(res,200,[presentProject(project,shots.shots.filter(shot=>shot.project_id===project.id))]);return;}
      if(path==='/api/projects'&&req.method==='POST'){sendJson(res,409,{detail:'The DSH session workspace is the project. Open a session in another folder to start another one.'});return;}
      let match=/^\/api\/projects\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match){if(match[1]!==project.id){sendJson(res,404,{detail:'Only the current DSH session workspace project is available.'});return;}}
      if(match&&req.method==='GET'){const data=await store.getProject(match[1]),{shots,assets,...projectData}=data;sendJson(res,200,{project:presentProject(projectData,shots),shots});return;}
      if(match&&req.method==='PATCH'){const item=await store.patchProject(match[1],await readJson(req,controller.signal));const data=await store.getProject(match[1]);sendJson(res,200,presentProject(item,data.shots));return;}
      match=/^\/api\/projects\/([A-Za-z0-9_-]{1,128})\/managed-run$/.exec(path);
      match=/^\/api\/projects\/([A-Za-z0-9_-]{1,128})\/video-context\/uploads$/.exec(path);
       if(match&&req.method==='POST'){
         if(match[1]!==project.id){sendJson(res,404,{detail:'Only the current DSH session workspace project is available.'});return;}
         const fields=await readMultipart(req,controller.signal,maxUploadBytes+1024*1024),file=fields.file;
         if(!file||typeof file!=='object'||!file.filename)throw new StudioStoreError('A continuation video file is required.');
         const asset=await store.saveAsset({kind:'layouts',name:fields.name||file.filename.replace(/\.[^.]+$/,''),project_id:match[1],filename:file.filename,bytes:file.bytes});
         const stored=await store.getMedia(asset.files.master);sendJson(res,201,{upload_id:asset.id,filename:stored.filename,sha256:stored.sha256,size_bytes:stored.size});return;
       }
       match=/^\/api\/projects\/([A-Za-z0-9_-]{1,128})\/managed-run$/.exec(path);
       if(match&&req.method==='GET'){sendJson(res,200,null);return;}
      if(req.method==='GET'&&path==='/api/pipelines'){sendJson(res,200,[]);return;}
      if(req.method==='GET'&&path==='/api/meta/actor-defaults'){const a=(await store.getAppSettings()).actor_defaults;sendJson(res,200,{default_description:a.description,default_negative:a.negative_prompt});return;}
      if(req.method==='GET'&&path==='/api/meta/scene-defaults'){const d=(await store.getAppSettings()).scene_defaults;sendJson(res,200,{default_angles:d.angle_prompts,default_prepend:d.prepend_text,default_append:d.append_text});return;}
      if(path==='/api/library/app-settings'&&(req.method==='GET'||req.method==='PUT')){
        if(req.method==='GET'){sendJson(res,200,await store.getAppSettings());return;}
        const input=await readJson(req,controller.signal);sendJson(res,200,await store.setAppSettings(input));return;
      }
      // Story wall (Phase 2): identical store methods to the director_studio tool — one rulebook, both hands.
      if(path==='/api/story'&&req.method==='GET'){sendJson(res,200,await storyStoreFor(store).story());return;}
      if(path==='/api/story/decision'&&req.method==='POST'){sendJson(res,201,await storyStoreFor(store).logDecision(await readJson(req,controller.signal)));return;}
      match=/^\/api\/story\/decision\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='PATCH'){sendJson(res,200,await storyStoreFor(store).updateDecision(match[1],await readJson(req,controller.signal)));return;}
      if(match&&req.method==='DELETE'){sendJson(res,200,await storyStoreFor(store).deleteDecision(match[1]));return;}
      if(path==='/api/story/entity'&&req.method==='POST'){sendJson(res,201,await storyStoreFor(store).saveEntity(await readJson(req,controller.signal)));return;}
      match=/^\/api\/story\/entity\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='PATCH'){sendJson(res,200,await storyStoreFor(store).saveEntity({entity_id:match[1],...await readJson(req,controller.signal)}));return;}
      if(match&&req.method==='DELETE'){sendJson(res,200,await storyStoreFor(store).deleteEntity(match[1]));return;}
      if(path==='/api/story/beat'&&req.method==='POST'){sendJson(res,201,await storyStoreFor(store).saveBeat(await readJson(req,controller.signal)));return;}
      match=/^\/api\/story\/beat\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='PATCH'){sendJson(res,200,await storyStoreFor(store).saveBeat({beat_id:match[1],...await readJson(req,controller.signal)}));return;}
      if(match&&req.method==='DELETE'){sendJson(res,200,await storyStoreFor(store).deleteBeat(match[1]));return;}
      if(path==='/api/story/episode'&&req.method==='POST'){sendJson(res,201,await storyStoreFor(store).saveEpisode(await readJson(req,controller.signal)));return;}
      match=/^\/api\/story\/episode\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='PATCH'){sendJson(res,200,await storyStoreFor(store).saveEpisode({episode_id:match[1],...await readJson(req,controller.signal)}));return;}
      if(match&&req.method==='DELETE'){sendJson(res,200,await storyStoreFor(store).deleteEpisode(match[1]));return;}
      // Media proxy: the browser may sit outside the Comfy network (SSH-tunnelled GUI); stream configured hosts' /view through the GUI origin. Ceiling: no Range passthrough — large video seeks re-stream.
      if(path==='/api/comfy-view'&&['GET','HEAD'].includes(req.method)){
        const host=url.searchParams.get('host')??'';
        const allowed=new Set([...await comfyHosts(),...String((await store.getAppSettings()).comfy?.urls??'').split(/[\n,]+/).map(entry=>entry.trim()).filter(Boolean)]);
        if(!allowed.has(host))throw new StudioStoreError('Comfy host is not in the configured endpoint list (gear panel Comfy URLs or plugin comfyBaseUrl/comfyTryUrls).');
        const target=`${host}/view?filename=${encodeURIComponent(url.searchParams.get('filename')??'')}&subfolder=${encodeURIComponent(url.searchParams.get('subfolder')??'')}&type=${encodeURIComponent(url.searchParams.get('type')??'output')}`;
        const rangeReq=String(req.headers.range??'');
        // iOS Safari refuses players on responses without range support; mirror Comfy's range answer through the proxy.
        const upstream=await fetchImpl(target,{signal:controller.signal,headers:rangeReq?{range:rangeReq}:{}});
        if(upstream.status!==200&&upstream.status!==206)throw new StudioStoreError(`Comfy endpoint answered ${upstream.status}.`,upstream.status===404?404:502);
        const forward={'Content-Type':upstream.headers.get('content-type')??'application/octet-stream',...(upstream.headers.get('content-length')?{'Content-Length':upstream.headers.get('content-length')}:{}),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'};
        for(const h of ['content-range','accept-ranges']){const v=upstream.headers.get(h);if(v)forward[h]=v;}
        res.writeHead(upstream.status,forward);
        if(req.method==='HEAD'){res.end();return;}
        Readable.fromWeb(upstream.body).pipe(res);return;
      }
      if(path==='/api/file'&&['GET','HEAD'].includes(req.method)){await serveFileRoute(req,res,url,{workspace:join(store.root,'..'),sessionIndex});return;}
      match=/^\/api\/(actors|scenes|props)(?:\/(generate|jobs)(?:\/([A-Za-z0-9_-]{1,128})(?:\/(cancel|save))?)?)?$/.exec(path);
      if(match){
        const [,kind,section,jobId,action]=match;
        if(!section&&req.method==='GET'){
          const [assets,jobs]=await Promise.all([store.listAssets({kind,project_id:project.id}),store.listGenerationJobs({kind,project_id:project.id,limit:100})]);
          const byJob=new Map(),byAsset=new Map();for(const job of jobs.slice().reverse()){byJob.set(job.id,job);if(job.asset_id)byAsset.set(job.asset_id,job);}// jobs arrive newest-first; reversing makes the newest job overwrite older ones.
          const items=assets.filter(item=>!item.meta?.temporary_job_refs).map(item=>{const job=byJob.get(item.job_id)??byAsset.get(item.id);return {...presentAsset(item,sessionId),form:job?generationForm(job):null,references:job?assetReferences(job,sessionId):null};});
          sendJson(res,200,{items});return;
        }
        if(section==='generate'&&req.method==='POST'){
          const fields=await readMultipart(req,controller.signal,maxUploadBytes*3+2*1024*1024),references=[];
          for(const key of Object.keys(fields)){if(['actor_image','wardrobe_image','scene_image','prop_image'].includes(key)||/^reference_image_\d{1,2}$/.test(key)){const file=fields[key];if(file&&typeof file==='object'&&file.filename)references.push({key,filename:file.filename,bytes:file.bytes});}}
          let ref_labels={};try{const parsed=JSON.parse(String(fields.reference_labels??'{}'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))ref_labels=parsed;}catch{ref_labels={};}
          const job=await store.createGenerationJob({kind,project_id:project.id,asset_id:typeof fields.asset_id==='string'&&fields.asset_id?fields.asset_id:undefined,name:fields.name,notes:fields.notes,description:fields.description,body_description:fields.body_description,hair_description:fields.hair_description,angle_prompts:fields.angle_prompts,prepend_text:fields.prepend_text,append_text:fields.append_text,negative_prompt:fields.negative_prompt,include_headwear:fields.include_headwear==='true',include_footwear:fields.include_footwear==='true',fixed_seed:fields.fixed_seed==='true',seed:Number.isSafeInteger(Number(fields.seed))?Number(fields.seed):null,references,ref_labels});
          sendJson(res,200,presentGenerationRecord(await store.getGenerationJob(job.id),sessionId));return;
        }
        if(section==='jobs'&&!jobId&&req.method==='GET'){const jobs=await store.listGenerationJobs({kind,project_id:project.id,limit:Number(url.searchParams.get('limit'))||20});sendJson(res,200,jobs.map(job=>presentGenerationRecord(job,sessionId)));return;}
        if(section==='jobs'&&jobId&&req.method==='GET'){const job=await store.getGenerationJob(jobId);if(!job||job.project_id!==project.id){sendJson(res,404,{detail:'No plugin-managed asset job exists.'});return;}sendJson(res,200,presentGenerationRecord(job,sessionId));return;}
        if(section==='jobs'&&jobId&&action==='cancel'&&req.method==='POST'){
          const job=await store.getGenerationJob(jobId);if(!job||job.project_id!==project.id){sendJson(res,404,{detail:'No plugin-managed asset job exists.'});return;}
          const updated=await store.updateGenerationJob(jobId,['queued','running'].includes(job.status)?{status:'cancelled'}:{});sendJson(res,200,presentGenerationRecord(await store.getGenerationJob(jobId)??updated,sessionId));return;
        }
        if(section==='jobs'&&jobId&&action==='save'&&req.method==='POST'){
          const body=await readJson(req,controller.signal);const job=await store.getGenerationJob(jobId);if(!job||job.project_id!==project.id){sendJson(res,404,{detail:'No plugin-managed asset job exists.'});return;}
          if(!job.asset_id)throw new StudioStoreError('DSH has not imported the generated asset yet. Complete the DSH request first; saving happens when the agent imports it with this job id.',409);
          sendJson(res,200,presentAsset(await store.updateAsset(kind,job.asset_id,{...(typeof body.name==='string'&&body.name.trim()?{name:body.name.trim()}:{}),...(typeof body.notes==='string'?{notes:body.notes}:{})}),sessionId));return;
        }
      }
      if(path==='/api/library'&&req.method==='GET'){
        const kind=url.searchParams.get('kind')||undefined;
        sendJson(res,200,(await store.listAssets({kind,project_id:project.id,include_unassigned:true})).map(item=>presentAsset(item,sessionId)));return;
      }
      if(path==='/api/library/import'&&req.method==='POST'){
        const fields=await readMultipart(req,controller.signal,maxUploadBytes+1024*1024),file=fields.file;
        if(!file||typeof file!=='object'||!file.filename)throw new StudioStoreError('A media file is required.');
        if(!isStudioAssetKind(fields.kind))throw new StudioStoreError('Unsupported asset kind.');
        const item=await store.saveAsset({kind:fields.kind,name:fields.name||file.filename.replace(/\.[^.]+$/,''),notes:fields.notes,project_id:project.id,filename:file.filename,bytes:file.bytes});sendJson(res,201,presentAsset(item,sessionId));return;
      }
      if(path==='/api/library/generation-settings'&&req.method==='GET'){sendJson(res,200,await store.getGenerationSettings());return;}
      if(path==='/api/library/generation-settings'&&req.method==='PUT'){const input=await readJson(req,controller.signal);sendJson(res,200,await store.setGenerationSettings(input.kind,input.instructions));return;}
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='PATCH'){const item=await store.updateAsset(match[1],match[2],await readJson(req,controller.signal));sendJson(res,200,presentAsset(item,sessionId));return;}
      if(match&&req.method==='DELETE'){sendJson(res,200,await store.deleteAsset(match[1],match[2]));return;}
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/files\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if(match&&req.method==='DELETE'){sendJson(res,200,await store.deleteAssetFile(match[1],match[2],match[3]));return;}
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/project$/.exec(path);
      if(match&&req.method==='PATCH'){await readJson(req,controller.signal);sendJson(res,200,presentAsset(await store.assignAsset(match[1],match[2],project.id),sessionId));return;}
      if(path==='/api/library/assign-project'&&req.method==='POST'){
        const input=await readJson(req,controller.signal);if(!Array.isArray(input.asset_ids)||input.asset_ids.length>200)throw new StudioStoreError('asset_ids must be an array with at most 200 entries.');
        const result=[];for(const asset of input.asset_ids){if(!asset||!isStudioAssetKind(asset.kind))throw new StudioStoreError('Each asset needs a supported kind.');result.push(presentAsset(await store.assignAsset(asset.kind,asset.id,project.id),sessionId));}sendJson(res,200,result);return;
      }
      match=/^\/api\/shots\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='GET'){sendJson(res,200,await store.getShot(match[1]));return;}
      if(match&&req.method==='PATCH'){sendJson(res,200,await store.patchShot(match[1],await readJson(req,controller.signal)));return;}
      match=/^\/api\/shots\/([A-Za-z0-9_-]{1,128})\/approve$/.exec(path);
      if(match&&req.method==='POST'){sendJson(res,200,await store.approveShot(match[1]));return;}
      match=/^\/api\/shots\/([A-Za-z0-9_-]{1,128})\/submit$/.exec(path);
      if(match&&req.method==='POST'){sendJson(res,409,{detail:'Production UI cannot queue H3 directly. Ask Director to show and confirm the shot/reference plan, then submit through submit_comfy_job.'});return;}
      match=/^\/api\/shots\/([A-Za-z0-9_-]{1,128})\/layouts\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='DELETE'){sendJson(res,409,{detail:'This layout operation is not implemented by the standalone plugin yet.'});return;}
      match=/^\/api\/files\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&['GET','HEAD'].includes(req.method)){
        const asset=(await store.listAssets({kind:match[1],include_unassigned:true})).find(item=>item.id===match[2]);if(!asset)throw new StudioStoreError('Media not found.',404);
        const stored=asset.files?.[match[3]];if(!stored)throw new StudioStoreError('Media not found.',404);const file=await store.getMedia(stored),bytes=await store.readMedia(file);
        res.writeHead(200,{'Content-Type':file.mime,'Content-Length':String(file.size),'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});if(req.method==='HEAD'){res.end();return;}res.end(bytes);return;
      }
      match=/^\/api\/shots\/([A-Za-z0-9_-]{1,128})\/video-context$/.exec(path);
       if(match&&req.method==='GET'){sendJson(res,200,await store.getVideoContextStatus(match[1]));return;}
       if(match&&req.method==='PUT'){const shot=await store.patchShot(match[1],{video_context:await readJson(req,controller.signal)});sendJson(res,200,{shot_id:shot.id,video_context:shot.video_context});return;}
       match=/^\/api\/h3-ref2va\/jobs\/([A-Za-z0-9_-]{1,200})$/.exec(path);
       if(match&&req.method==='GET'){const job=await store.getVideoAssetJob(match[1]);if(!job){sendJson(res,404,{detail:'Completed video asset was not found.'});return;}sendJson(res,200,{id:job.id,status:'succeeded',outputs:{master:{key:'master',filename:job.filename,url:fileUrl('layouts',job.asset_id,'master',sessionId)}}});return;}
       if(path==='/api/h3-ref2va/provider'&&req.method==='GET'){sendJson(res,200,{default_provider:'local',minimax_configured:false,minimax_resolution:'704x1280'});return;}
      if(path==='/api/h3-ref2va/resolutions'&&req.method==='GET'){sendJson(res,200,{presets:[{id:'704x1280',label:'Portrait · 704 × 1280',width:704,height:1280},{id:'1280x704',label:'Landscape · 1280 × 704',width:1280,height:704}]});return;}
      if(req.method==='OPTIONS'){res.writeHead(204,{Allow:'GET, HEAD, POST, PATCH, DELETE, OPTIONS'});res.end();return;}
      sendJson(res,404,{detail:'Director Studio API route is not implemented.'});
    }catch(error){if(!res.headersSent&&!res.destroyed)routeError(res,error);else if(!res.destroyed)res.destroy();}
    finally{res.removeListener('close',abort);controllers.delete(controller);}
  };
}

export function registerStudioApi(ctx,{resolveSession,comfyBaseUrl,comfyHosts}={}){
  const controllers=new Set(),unregister=ctx.webServer.register({kind:'prefix',path:'/director-studio',handler:createStudioApiHandler({resolveSession,comfyBaseUrl,comfyHosts,controllers,requestRejection:req=>ctx.connection.requestRejection(req)})});
  return ()=>{unregister();for(const controller of controllers)controller.abort();};
}
