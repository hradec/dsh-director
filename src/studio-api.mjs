import {agentTaskStoreRootFor} from './agent-task.mjs';
import {StudioStoreError,isStudioAssetKind,studioStoreConstants} from './studio-store.mjs';
import {storyStoreFor} from './story-store.mjs';
import {editingStoreFor,EditingStore} from './editing-store.mjs';
import {ensureWaveform,readWaveformTile} from './media-waveform.mjs';
import {Readable} from 'node:stream';
import {createReadStream,statSync,fstatSync,realpathSync,readdirSync,readFileSync,rmSync,existsSync,mkdirSync,writeFileSync,openSync,closeSync,readSync,utimesSync,renameSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {isAbsolute,join,sep,extname,basename,resolve} from 'node:path';
import {apiToUi} from './comfy-api-to-ui.mjs';
import {homedir,tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

// ponytail: browsers cannot open server filesystem paths, so dsh-ui media srcs must be URLs; this route streams local media through the GUI origin.
// Ceiling: single Range only incl. suffix (seeks re-stream tail), media extensions only, roots = homedir + /tmp + session workspace; secret dot-folders denied except director-media/attachments.
// No size cap here on purpose (2026-11-14: the old 512 MB gate 413-blocked real footage; streaming uses createReadStream, memory is constant).
const FILE_MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.aac':'audio/aac','.pdf':'application/pdf'};

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
function presentAsset(item,session){const urls={},files={};for(const key of Object.keys(item.files??{})){urls[key]=fileUrl(item.kind,item.id,key,session);files[key]=item.file_names?.[key]||item.files[key].split(/[\\/]/).pop();}
  // Tag-linked library refs (0.2.58): library pictures/clips join the asset by tag — give the Assets board direct URLs for them.
  const library_refs=(item.library_refs??[]).map(ref=>({...ref,url:`/director-studio/api/file?path=${encodeURIComponent(ref.abs??'')}&session=${encodeURIComponent(session??'')}`,thumb:ref.library==='footage'?`/director-studio/api/footage/thumb?path=${encodeURIComponent(ref.abs??'')}&session=${encodeURIComponent(session??'')}`:null}));
  const paths={};for(const key of Object.keys(item.files??{}))paths[key]=item.files[key];
  const {file_names,...publicItem}=item;return {...publicItem,files,urls,paths,library_refs};}
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
// The model a DSH session is currently running lives in that session's projcache row (modelSelection.lastUsed).
async function sessionModel(sessionId){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(String(sessionId??'')))return {model:'',reasoning:null};
  try{const used=JSON.parse(readFileSync(join(homedir(),'.dsh','storages','session_projcache','sessions',`${sessionId}.json`),'utf8'))?.record?.rows?.modelSelection?.val?.lastUsed;if(used?.model)return {model:String(used.model),reasoning:used.reasoningEffort?String(used.reasoningEffort):null};}catch{}
  return {model:'',reasoning:null};
}
// No session model resolved (footage the human added by hand): pick the qwen from the endpoint's own model list, per the human's instruction.
async function qwenFallback(url,fetchImpl,signal){
  try{const j=await fetchImpl(`${url}/models`,{signal}).then(r=>r.ok?r.json():null);const ids=(j?.data??[]).map(m=>String(m?.id??''));return ids.find(id=>id.toLowerCase().includes('qwen'))??'';}catch{return '';}
}
// iPad Safari cannot decode AV1 and other exotic encodings Chrome handles; transcode once, cache, then stream normally.
// Everything is strictly on demand (a device requesting a video triggers its own remux/transcode — never preemptive).
// Cache lives in the workspace (.director-studio/transcode-cache), NOT /tmp which is RAM-backed tmpfs; entries age out 7 days after LAST USE.
const AV_CACHE_TTL=7*24*3600*1000;
const transcodeCacheFor=workspace=>workspace?join(workspace,'.director-studio','transcode-cache'):join(homedir(),'.dsh','director-media','transcode-cache');
// ponytail: ceiling = one global transcode at a time (1-hour lock safety), cache 7 days; upgrade path = per-file locks + queue.
let transcodeLock=null;
function ffprobeInfo(file){return new Promise(resolve=>{execFile('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,pix_fmt','-of','csv=p=0',file],{timeout:20000},(error,stdout)=>resolve(error?'':String(stdout).trim()));});}
const deviceFriendly=info=>/h264/.test(info)&&!/yuv4(22|44)/.test(info);
function ensureTranscode(source,resolved,mode='reencode',cacheDir=transcodeCacheFor(null)){
  if(!transcodeLock||Date.now()-transcodeLock.at>3600000)transcodeLock={at:Date.now(),files:new Set()};
  const key=resolved.replace(/[^A-Za-z0-9._-]/g,'_')+(mode==='copy'?'.faststart':'');
  const lockKey=resolved+'#'+mode;
  const target=join(cacheDir,key+'.mp4');
  // Safari will not retry 503: concurrent waiters poll for the finished copy (up to 10 min) and then stream it.
  if(transcodeLock.files.has(lockKey))return new Promise((resolve,reject)=>{const started=Date.now();const poll=setInterval(()=>{if(existsSync(target+'.done')){clearInterval(poll);resolve(target);}else if(Date.now()-started>600000){clearInterval(poll);reject(new StudioStoreError('Transcode did not finish in time.',504));}},2000);});
  transcodeLock.files.add(lockKey);
  try{for(const entry of readdirSync(cacheDir)){const full=join(cacheDir,entry);if(statSync(full).mtimeMs<Date.now()-AV_CACHE_TTL)rmSync(full,{force:true});}}catch{}
  if(existsSync(target+'.done')){const now=new Date();try{utimesSync(target,now,now);utimesSync(target+'.done',now,now);}catch{}return Promise.resolve(target);}
  process.stdout.write(`[dsh-director transcode] ffmpeg ${mode} starting for ${source}\n`);
  mkdirSync(cacheDir,{recursive:true});
  const args=mode==='copy'?['-y','-v','error','-i',source,'-c','copy','-movflags','+faststart',target]:['-y','-v','error','-threads','4','-i',source,'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart','-c:a','copy',target];
  return new Promise((resolve,reject)=>{execFile('ffmpeg',args,{timeout:3600000},(error,stdout,stderr)=>{process.stdout.write(`[dsh-director transcode] ffmpeg done err=${String(error?.message??'').slice(0,120)} stderr=${String(stderr).slice(0,160)}\n`);transcodeLock?.files.delete(lockKey);if(error){try{rmSync(target,{force:true});}catch{}reject(new StudioStoreError('Server transcode failed: '+String(stderr||error?.message).slice(0,160),502));return;}try{writeFileSync(target+'.done','');}catch{}resolve(target);});});
}
// moov-at-end mp4s are unplayable until the browser downloads the whole file (black tiles, dead players on every device).
// Scan top-level atoms; if moov follows mdat, remux lossless (-c copy +faststart) into the transcode cache and serve that copy.
function mp4Faststart(file){
  let fd;try{
    fd=openSync(file,'r');const size=fstatSync(fd).size;let pos=0,mdat=-1;const buf=Buffer.alloc(16);
    while(pos<size-7){
      if(readSync(fd,buf,0,8,pos)!==8)return null;
      let sz=buf.readUInt32BE(0);const type=buf.toString('latin1',4,8);
      if(sz===1){if(readSync(fd,buf,0,8,pos+8)!==8)return null;sz=Number(buf.readBigUInt64BE(0));pos+=8;}
      if(sz===0)sz=size-pos;
      if(sz<8)return null;
      if(type==='moov')return mdat<0;
      if(type==='mdat')mdat=pos;
      pos+=sz;
    }
    return null;
  }catch{return null;}finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
}
// Footage grid posters: one ffmpeg frame per video, cached under <store.root>/footage-thumbs keyed by path+mtime+size,
// so a re-encode of the same file gets a fresh poster and stale ones age out (30-day sweep).
const THUMB_INFLIGHT=new Map();
function videoDuration(file){return new Promise(resolve=>{execFile('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{timeout:20000},(error,stdout)=>resolve(error?0:Number(String(stdout).trim())||0));});}
// Real source height — the 480p preview the LLM watches cannot reveal the true resolution, so we probe it.
function videoHeight(file){return new Promise(resolve=>{execFile('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=height','-of','csv=p=0',file],{timeout:20000},(error,stdout)=>resolve(error?0:Number(String(stdout).trim())||0));});}
function resolutionTag(height){return height>=2000?'4k':height>=1000?'2k':height>=600?'720p':height>0?'480p':'';}
// ComfyUI SaveVideo embeds the graph in container metadata: `workflow` (UI format) preferred, `prompt` (API format) fallback.
function embeddedComfyWorkflow(file){return new Promise(resolve=>{execFile('ffprobe',['-v','error','-show_entries','format_tags=prompt,workflow','-of','json',file],{timeout:20000},(error,stdout)=>{if(error){resolve(null);return;}
  try{const tags=JSON.parse(String(stdout))?.format?.tags??{};if(String(tags.workflow??'').includes('nodes'))resolve({kind:'workflow',json:tags.workflow});else if(String(tags.prompt??'').includes('class_type'))resolve({kind:'prompt',json:tags.prompt});else resolve(null);}catch{resolve(null);}});});}
// ComfyUI SaveImage embeds the graph as PNG tEXt chunks (`prompt`/`workflow` keywords); ffmpeg/ffprobe cannot see those custom keys, so parse the chunks.
async function embeddedComfyPng(file){const buf=readFileSync(file);
  if(buf.length<8||buf.toString('latin1',0,8)!==Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).toString('latin1'))return null;
  let off=8,prompt='',workflow='';
  while(off+8<=buf.length){const len=buf.readUInt32BE(off),type=buf.toString('latin1',off+4,off+8),data=buf.subarray(off+8,off+8+len);
    if(type==='tEXt'){const zero=data.indexOf(0),keyword=data.toString('latin1',0,zero),value=data.toString('latin1',zero+1);if(keyword==='prompt')prompt=value;else if(keyword==='workflow')workflow=value;}
    else if(type==='iTXt'){const zero=data.indexOf(0),keyword=data.toString('latin1',0,zero);let end=data.indexOf(0,zero+2);end=data.indexOf(0,end+1);const value=data.subarray(end+1).toString('utf8');if(keyword==='prompt')prompt=value;else if(keyword==='workflow')workflow=value;}
    else if(type==='IEND')break;
    if(len===0)break;off+=12+len;}// zero length guard keeps a malformed tail from spinning forever
  if(workflow.includes('nodes'))return {kind:'workflow',json:workflow};
  if(prompt.includes('class_type'))return {kind:'prompt',json:prompt};
  return null;}
// ComfyUI hosts to try for "Open in ComfyUI": plugin config first, then the gear panel, first that answers wins (human chose this; wrong host only means missing models).
async function firstOnlineComfy({comfyHosts,store,fetchImpl,signal}){
  const configured=[...await comfyHosts(),...String((await store.getAppSettings()).comfy?.urls??'').split(/[\n,]+/).map(entry=>entry.trim()).filter(Boolean)];
  for(const base of configured){try{const r=await fetchImpl(`${base}/system_stats`,{signal:signal??AbortSignal.timeout(3000)});if(r.ok)return base;}catch{}}return '';}
// Timeline artwork (pool posters + filmstrip tiles): same cache discipline as
// footage thumbs, but keys also carry time/height so LOD sweeps never collide.
// Art is served ONLY through the session-gated art-file route (dot-folder files
// deliberately never go through /api/file's media allowlist).
const ART_INFLIGHT=new Map();
const DIMS_CACHE=new Map();
function probeDims(source){
  if(DIMS_CACHE.has(source))return Promise.resolve(DIMS_CACHE.get(source));
  return new Promise((done)=>{execFile('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0:s=x',source],{timeout:20000},(error,stdout)=>{
    const m=error?null:/(\d+)x(\d+)/.exec(String(stdout).trim());
    const dims=m?{w:Number(m[1]),h:Number(m[2])}:{w:16,h:9};
    DIMS_CACHE.set(source,dims);done(dims);
  });});
}
function ensureArtFrame(store,source,tUs,heightPx){
  const info=statSync(source);
  const key=createHash('sha1').update(`art|${source}|${info.mtimeMs}|${info.size}|${String(Math.round(tUs))}|${heightPx}`).digest('hex');
  const root=join(store.root,'timeline-art');
  const target=join(root,`${key}.jpg`);
  if(existsSync(target))return Promise.resolve(target);
  if(ART_INFLIGHT.has(target))return ART_INFLIGHT.get(target);
  mkdirSync(root,{recursive:true});
  const work=new Promise((res2,rej)=>{
    const args=['-y','-v','error'];
    if(tUs>0)args.push('-ss',(tUs/1e6).toFixed(6));
    args.push('-i',source,'-frames:v','1','-vf',`scale=-2:${heightPx}`,'-q:v','3',target);
    execFile('ffmpeg',args,{timeout:120000},(error,stdout,stderr)=>{
      ART_INFLIGHT.delete(target);
      if(error||!existsSync(target)){try{rmSync(target,{force:true});}catch{}rej(new StudioStoreError('Timeline art frame failed: '+String(stderr||error?.message||'no frame written').slice(0,160),502));return;}
      res2(target);
    });
  });
  ART_INFLIGHT.set(target,work);return work;
}
// Media row of an editing document -> absolute workspace path, containment-checked.
function editingMediaAbs(doc,mediaId,workspaceRoot){
  const med=(doc&&doc.media_pool)?doc.media_pool[mediaId]:null;
  if(!med)return null;
  const p=String(med.path_abs??'');
  if(!p)return null;
  const abs=isAbsolute(p)?p:join(workspaceRoot,p);
  const root=resolve(workspaceRoot);
  const want=resolve(abs);
  if(want!==root&&!want.startsWith(root+sep))return null;
  return {med,abs:want};
}
// WebCodecs (any browser) refuses H.264 High 10 / non-420 pixel formats — the
// Comfy renders are all 10-bit. Normalize such sources to 8-bit yuv420p copies
// under media/normalized/ (originals untouched) so preview + filmstrip +
// waveform pipelines can decode them. Returns the workspace-relative path to pool.
const NORM_INFLIGHT=new Map();
function probePixfmt(source){
  return new Promise((done)=>{execFile('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=pix_fmt,profile','-of','csv=p=0',source],{timeout:20000},(error,stdout)=>{const line=String(stdout).trim().split('\n')[0]??'';done(error?'':line);});});
}
// ffprobe csv field order is NOT the request order (profile first here), so
// find the pix_fmt token by shape: exactly 'yuv420p' = 8-bit planar = WebCodecs
// decodable; 'yuv420p10le' (High 10) and anything else are not.
function isBrowserDecodable(probeLine){
  const toks=String(probeLine).split(',').map((s)=>s.trim());
  const fmt=toks.find((t)=>/^(yuv|rgb|gbr|gray)/.test(t))??'';
  return fmt==='yuv420p';
}
async function ensureNormalized(workspaceRoot,rel){
  const abs=join(workspaceRoot,rel);
  const fmt=await probePixfmt(abs);
  if(isBrowserDecodable(fmt))return rel;
  const name=basename(rel).replace(/\.[^.]+$/,'')+'.mp4';
  const nrel='media/normalized/'+name;
  const nabs=join(workspaceRoot,nrel);
  if(existsSync(nabs))return nrel;
  if(NORM_INFLIGHT.has(nabs))return NORM_INFLIGHT.get(nabs);
  mkdirSync(join(workspaceRoot,'media','normalized'),{recursive:true});
  const work=new Promise((res2,rej)=>{execFile('ffmpeg',['-y','-v','error','-i',abs,'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-crf','20','-preset','veryfast','-c:a','copy',nabs+'.tmp.mp4'],{timeout:3600000},(error,stdout,stderr)=>{
    NORM_INFLIGHT.delete(nabs);
    if(error){try{rmSync(nabs+'.tmp.mp4',{force:true});}catch{}res2(rel);return;} // transcode failure: pool the original honestly
    try{renameSync(nabs+'.tmp.mp4',nabs);}catch{res2(rel);return;}
    res2(nrel);
  });});
  NORM_INFLIGHT.set(nabs,work);
  return work;
}
function ensureFootageThumb(store,source){
  const info=statSync(source);
  const key=createHash('sha1').update(`${source}|${info.mtimeMs}|${info.size}`).digest('hex');
  const root=join(store.root,'footage-thumbs');
  const target=join(root,`${key}.jpg`);
  if(existsSync(target))return Promise.resolve(target);
  if(THUMB_INFLIGHT.has(target))return THUMB_INFLIGHT.get(target);
  mkdirSync(root,{recursive:true});
  try{for(const entry of readdirSync(root)){const full=join(root,entry);if(statSync(full).mtimeMs<Date.now()-30*24*3600*1000)rmSync(full,{force:true});}}catch{}
  const work=videoDuration(source).then((dur)=>new Promise((resolve,reject)=>{
    const ss=dur>0?Math.min(2,dur*0.1):0;
    execFile('ffmpeg',['-y','-v','error','-ss',String(ss),'-i',source,'-frames:v','1','-vf','scale=480:-2','-q:v','3',target],{timeout:120000},(error,stdout,stderr)=>{
      THUMB_INFLIGHT.delete(target);
      if(error){try{rmSync(target,{force:true});}catch{}reject(new StudioStoreError('Thumbnail generation failed: '+String(stderr||error?.message).slice(0,160),502));return;}
      resolve(target);
    });
  }));
  THUMB_INFLIGHT.set(target,work);return work;
}
// 480p silent preview for AI tagging: same cache dir/key rule as posters; audio stripped (tags are visual+descriptive).
function ensureFootagePreview(store,source){
  const info=statSync(source);
  const key=createHash('sha1').update(`tag|${source}|${info.mtimeMs}|${info.size}`).digest('hex');
  const root=join(store.root,'footage-thumbs');
  const target=join(root,`${key}.tag.mp4`);
  if(existsSync(target))return Promise.resolve(target);
  if(THUMB_INFLIGHT.has(target))return THUMB_INFLIGHT.get(target);
  mkdirSync(root,{recursive:true});
  const work=new Promise((resolveP,reject)=>{
    execFile('ffmpeg',['-y','-v','error','-i',source,'-an','-vf','scale=480:-2','-c:v','libx264','-crf','30','-preset','veryfast','-movflags','+faststart',target],{timeout:120000},(error,stdout,stderr)=>{
      THUMB_INFLIGHT.delete(target);
      if(error){try{rmSync(target,{force:true});}catch{}reject(new StudioStoreError('Tag preview failed: '+String(stderr||error?.message).slice(0,160),502));return;}
      resolveP(target);
    });
  });
  THUMB_INFLIGHT.set(target,work);return work;
}
// Media request diary: one line per served answer so device-side failures (iPad Safari!) can be traced from the server journal.
const mediaLog=(req,status,extra)=>{try{process.stdout.write(`[dsh-director media] ${req.socket?.remoteAddress??'?'} ${req.method} ${String(req.headers.range??'-')} -> ${status} ${extra}\n`);}catch{}};
// Shared path gate for /api/file and /api/footage/thumb: roots, secret dot-folders deny, media extensions.
const realpathOrNull=p=>{try{return realpathSync(p);}catch{return null;}};
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function resolveMediaPath(url,workspace,sessionIndex=defaultSessionIndex){
  const raw=url.searchParams.get('path')??'';
  if(!raw||raw.length>2000)throw new StudioStoreError('A path query parameter is required.');
  const candidate=isAbsolute(raw)?raw:(workspace?join(workspace,raw):'');
  if(!candidate)throw new StudioStoreError('Relative paths need the session parameter.',400);
  // Cold autofs/NFS mounts (workspaces on /net/…) transiently ENOENT while mounting — proven live 2026-11-14; retry once.
  let resolved=realpathOrNull(candidate);
  if(resolved===null){await nap(250);resolved=realpathOrNull(candidate);}
  if(resolved===null)throw new StudioStoreError('File not found.',404);
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
  if(!info.isFile())throw new StudioStoreError('Not a servable file (type).',400);
  return {resolved,info,mime};
}
async function serveFileRoute(req,res,url,{workspace,sessionIndex=defaultSessionIndex}){
  const {resolved,info,mime}=await resolveMediaPath(url,workspace,sessionIndex);
  let served=resolved,stat=info;const cacheDir=transcodeCacheFor(workspace);
  if(mime.startsWith('video/')&&/iPhone|iPad|iPod/.test(String(req.headers['user-agent']??''))){
    mediaLog(req,'probing',mime);
    const probe=await ffprobeInfo(resolved);mediaLog(req,'probe',probe||'unknown');
    if(probe&&!deviceFriendly(probe)){served=await ensureTranscode(resolved,resolved,'reencode',cacheDir);stat=statSync(served);mediaLog(req,'transcode',mime+' -> h264');}
  }
  // moov-at-end mp4/mov: lossless faststart remux so browsers (and iOS) can read metadata from the file head.
  if(served===resolved&&['video/mp4','video/quicktime'].includes(mime)&&mp4Faststart(served)===false){
    mediaLog(req,'remuxing',mime+' faststart');
    served=await ensureTranscode(resolved,resolved,'copy',cacheDir);stat=statSync(served);mediaLog(req,'remux',mime+' -> faststart');
  }
  const m=/^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range??''));
  const base={'Content-Type':mime,'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Cache-Control':'private, max-age=300'};
  if(m&&(m[1]!==''||m[2]!=='')){
    let start,end;
    if(m[1]!==''){start=Number(m[1]);end=m[2]!==''?Math.min(Number(m[2]),stat.size-1):stat.size-1;}
    else{const n=Number(m[2]);start=Math.max(0,stat.size-n);end=stat.size-1;}
    if(start>stat.size-1||end<start){res.writeHead(416,{...base,'Content-Range':`bytes */${stat.size}`});mediaLog(req,416,mime);res.end();return;}
    res.writeHead(206,{...base,'Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/${stat.size}`});mediaLog(req,206,`${mime} ${String(req.headers['range'])}`);
    if(req.method==='HEAD'){res.end();return;}
    createReadStream(served,{start,end}).pipe(res);return;
  }
  res.writeHead(200,{...base,'Content-Length':String(stat.size)});mediaLog(req,200,mime);
  if(req.method==='HEAD'){res.end();return;}
  createReadStream(served).pipe(res);
}

function createNullAgentTasks(){return {async submit(){throw Error('agent tasks not configured');},list(){return [];},cancel(){return null;}};}
export function createStudioApiHandler({resolveSession,requestRejection,comfyBaseUrl='http://127.0.0.1:8188',comfyHosts=async()=>[],sessionIndex=defaultSessionIndex,fetchImpl=globalThis.fetch,maxUploadBytes=studioStoreConstants.maxAssetBytes,agentTasks=createNullAgentTasks(),controllers=new Set()}={}){
  return async(req,res)=>{
    const controller=new AbortController();controllers.add(controller);const abort=()=>controller.abort();res.once('close',abort);
    try{
      const rejection=requestRejection(req);if(rejection!==undefined){res.writeHead(rejection);res.end();return;}
      const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/director-studio')){sendJson(res,404,{detail:'Not found.'});return;}
      const path=url.pathname.slice('/director-studio'.length)||'/';if(path==='/timeline-engine.js'&&req.method==='GET'){try{const f=readFileSync(new URL('../lib/timeline-engine.js',import.meta.url));res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-cache'});res.end(f);}catch{sendJson(res,404,{detail:'timeline-engine.js not built — run node scripts/build.mjs'});}return;}if(!path.startsWith('/api/')){sendJson(res,404,{detail:'Not found.'});return;}
      // Bridge contract v1 (BRIDGE_CONTRACT.md): the ComfyUI page (iframe or standalone) fetches these GETs cross-origin from the browser; auth model unchanged (?session=), CORS only on the read lanes.
      const isBridgePath=(p)=>p==='/api/file'||p==='/api/footage/thumb'||p.startsWith('/api/library')||p==='/api/footage'||p==='/api/images';
      if(req.method==='OPTIONS'){res.writeHead(204,{Allow:'GET, HEAD, POST, PATCH, DELETE, OPTIONS',...(isBridgePath(path)?{'access-control-allow-origin':'*','access-control-allow-methods':'GET, HEAD, OPTIONS','access-control-allow-headers':'content-type'}:{})});res.end();return;}
      if(isBridgePath(path)&&(req.method==='GET'||req.method==='HEAD'))res.setHeader('access-control-allow-origin','*');
      if(req.method==='GET'&&path==='/api/health'){
        let reachable=false,comfyError=null;try{const base=typeof comfyBaseUrl==='function'?await comfyBaseUrl():comfyBaseUrl;const response=await fetchImpl(`${base}/system_stats`,{signal:controller.signal,redirect:'error'});reachable=response.ok;if(!response.ok)comfyError=`HTTP ${response.status}`;}catch(error){comfyError=error.message;}
        sendJson(res,200,{ok:true,comfy_reachable:reachable,comfy_error:comfyError});return;
      }
      // Repaired conversation media URLs carry no session: absolute paths resolve roots via the session index.
      if(path==='/api/file'&&['GET','HEAD'].includes(req.method)&&typeof req.headers['x-director-session']!=='string'&&!url.searchParams.get('session')){await serveFileRoute(req,res,url,{workspace:null,sessionIndex});return;}
      // The DSH sidebar identifies its session by header; media URLs use ?session= because <img>/<video> tags cannot send headers.
      const sessionId=(typeof req.headers['x-director-session']==='string'?req.headers['x-director-session']:'')||url.searchParams.get('session')||'';
      if(!sessionId){sendJson(res,400,{detail:'Director Studio requests need the X-Director-Session header or session query parameter identifying the active DSH session.'});return;}
      // v1.39 companion: the DSStudioAsset node may carry the WORKSPACE PATH instead of
      // a session id — map it through the session index (realpath-tolerant, newest wins).
      let sid=sessionId;
      if(sid.startsWith('/')&&typeof sessionIndex==='function'){
        const want=sid.replace(/\/+$/,'');let realWant=null;
        try{realWant=realpathSync(want);}catch{}
        const rows=await sessionIndex();
        const hit=(rows??[]).find(r=>{const c=String(r.cwd??'').replace(/\/+$/,'');if(c===want)return true;try{return realpathSync(c)===want||(realWant&&realpathSync(c)===realWant);}catch{return false;}});
        if(hit)sid=hit.id;
      }
      const {store,project}=await resolveSession(sid);
      if(path==='/api/agent-task'&&req.method==='POST'){const body=await readJson(req,controller.signal);const prompt=String(body.prompt??'').trim();
        if(!prompt){sendJson(res,400,{detail:'prompt required'});return;}
        const task=await agentTasks.submit({prompt,label:body.label,sessionId,cwd:agentTaskStoreRootFor(store)});
        sendJson(res,201,{id:task.id,status:task.status,model:task.model});return;}
      if(path==='/api/agent-tasks'&&req.method==='GET'){sendJson(res,200,agentTasks.list());return;}
      const taskMatch=/^\/api\/agent-task\/([A-Za-z0-9_-]+)$/.exec(path);
      if(taskMatch&&req.method==='DELETE'){const done=agentTasks.cancel(taskMatch[1]);sendJson(res,done?200:409,done??{detail:'only waiting tasks can be cancelled'});return;}
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
        // ponytail: this Comfy build 404s on combined filename="sub/name.png"; split legacy joined fence URLs into filename+subfolder parts.
        let fileName=url.searchParams.get('filename')??'';let subFolder=url.searchParams.get('subfolder')??'';
        if(fileName.includes('/')){const idx=fileName.lastIndexOf('/');const prefix=fileName.slice(0,idx);fileName=fileName.slice(idx+1);subFolder=[subFolder,prefix].filter(Boolean).join('/');}
        const target=`${host}/view?filename=${encodeURIComponent(fileName)}&subfolder=${encodeURIComponent(subFolder)}&type=${encodeURIComponent(url.searchParams.get('type')??'output')}`;
        const rangeReq=String(req.headers.range??'');
        // iOS Safari refuses players on responses without range support; mirror Comfy's range answer through the proxy.
        const upstream=await fetchImpl(target,{signal:controller.signal,headers:rangeReq?{range:rangeReq}:{}});
        if(upstream.status!==200&&upstream.status!==206)throw new StudioStoreError(`Comfy endpoint answered ${upstream.status}.`,upstream.status===404?404:502);
        const forward={'Content-Type':upstream.headers.get('content-type')??'application/octet-stream',...(upstream.headers.get('content-length')?{'Content-Length':upstream.headers.get('content-length')}:{}),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'};
        for(const h of ['content-range','accept-ranges']){const v=upstream.headers.get(h);if(v)forward[h]=v;}
        res.writeHead(upstream.status,forward);mediaLog(req,upstream.status,`comfy ${String(req.headers.range??'-')}`);
        if(req.method==='HEAD'){res.end();return;}
        Readable.fromWeb(upstream.body).pipe(res);return;
      }
      if(path==='/api/file'&&['GET','HEAD'].includes(req.method)){await serveFileRoute(req,res,url,{workspace:join(store.root,'..'),sessionIndex});return;}
      // Multi-season spine + clip versions for the episode timeline (season/episode live on the Story wall).
      if(path==='/api/library/sequences'&&req.method==='GET'){sendJson(res,200,{sequences:await store.listSequences(project.id),takes:await store.listTakes({project_id:project.id})});return;}
      if(path==='/api/library/sequence'&&req.method==='POST'){sendJson(res,201,await store.saveSequence(project.id,await readJson(req,controller.signal)));return;}
      match=/^\/api\/library\/sequence\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if(match&&req.method==='DELETE'){sendJson(res,200,await store.deleteSequence(match[1]));return;}
      if(path==='/api/library/take'&&req.method==='POST'){sendJson(res,201,await store.saveTake(await readJson(req,controller.signal)));return;}
      if(path==='/api/library/take/select'&&req.method==='POST'){const b=await readJson(req,controller.signal);sendJson(res,200,await store.selectTake(String(b.take_id??'')));return;}
      if(path==='/api/library/timeline'&&req.method==='GET'){
        const shots=await store.listShots(project.id),sequences=await store.listSequences(project.id),takes=await store.listTakes({project_id:project.id});
        const assets=new Map((await store.listAssets({project_id:project.id,include_unassigned:true})).map(item=>[item.id,item]));
        const files=new Map((await store.snapshot()).files.map(item=>[item.path,item]));
        const clips=Object.fromEntries(shots.map(shot=>{const asset=shot.video_asset_id?assets.get(shot.video_asset_id):null,file=asset?.files?.master?files.get(asset.files.master):null;return [shot.id,file?{asset_id:asset.id,path:file.path,filename:file.filename}:null];}));
        sendJson(res,200,{shots,sequences,takes,clips,episodes:(await storyStoreFor(store).story()).episodes});return;
      }
      // Editing library (WeftCut EDLs): catalog + documents under <workspace>/editing/, SAME
      // EditingStore singleton the agent tools use — tags are derived from the document on
      // every save; nobody (UI or agent) hand-writes them. Live at the next harness restart.
      if(path==='/api/editing'&&req.method==='GET'){const ed=editingStoreFor(store.workspaceRoot??join(store.root,'..'));const tags=(url.searchParams.get('tags')??'').split(',').filter(Boolean);const items=tags.length?await ed.find(tags):Object.values(await ed.catalog());sendJson(res,200,{editing:items});return;}
      if(path==='/api/editing'&&req.method==='POST'){const ed=editingStoreFor(store.workspaceRoot??join(store.root,'..'));const b=await readJson(req,controller.signal);sendJson(res,201,await ed.create({name:String(b.name??'edit'),note:b.note??null,doc:b.doc}));return;}
      match=/^\/api\/editing\/([A-Za-z0-9_-]{1,64})(?:\/(command|undo|redo|checkpoint|publication|seed|relink|thumbnail|tile|art-file|import-footage|waveform-levels|waveform-tile|normalize-pool|normalize-status))?$/.exec(path);
      if(match){const ed=editingStoreFor(store.workspaceRoot??join(store.root,'..'));const id=match[1],sub=match[2];
        if(!sub&&req.method==='GET'){const got=await ed.get(id);if(!got){sendJson(res,404,{detail:'no such editing document'});return;}sendJson(res,200,got);return;}
        if(!sub&&req.method==='DELETE'){sendJson(res,200,{deleted:await ed.delete(id)});return;}
        // The renderer reads the WeftCut summary projection, never the raw doc.
        if(sub==='publication'&&req.method==='GET'){const pub=await ed.publication(id);if(!pub){sendJson(res,404,{detail:'no such editing document'});return;}sendJson(res,200,pub);return;}
        // --- timeline art (renderer TileEngine + MediaPosterCache contracts) ---
        if(sub==='thumbnail'&&req.method==='GET'){
          const got=await ed.get(id);if(!got){sendJson(res,404,{detail:'no such editing document'});return;}
          const mediaAbs=editingMediaAbs(got.doc,url.searchParams.get('mediaId')??'',store.workspaceRoot??join(store.root,'..'));
          if(!mediaAbs||!existsSync(mediaAbs.abs)){sendJson(res,200,{ok:false,error:{code:'not_ready',detail:'media file unavailable'}});return;}
          const dur=await videoDuration(mediaAbs.abs);
          const target=await ensureArtFrame(store,mediaAbs.abs,Math.round((dur>0?Math.min(2,dur*0.1):0)*1e6),180);
          const dataUrl='data:image/jpeg;base64,'+readFileSync(target).toString('base64');
          sendJson(res,200,{ok:true,value:dataUrl});return;
        }
        if(sub==='tile'&&req.method==='GET'){
          const got=await ed.get(id);if(!got){sendJson(res,404,{detail:'no such editing document'});return;}
          const mediaAbs=editingMediaAbs(got.doc,url.searchParams.get('mediaId')??'',store.workspaceRoot??join(store.root,'..'));
          if(!mediaAbs||!existsSync(mediaAbs.abs)){sendJson(res,200,{ok:false,error:{code:'not_ready',detail:'media file unavailable'}});return;}
          // TileEngine contract (FilmstripTileProducer.ts): tUs = index * 250_000 * 2^lod.
          const lod=Math.max(0,Number(url.searchParams.get('lod')??0)||0);
          const index=Math.max(0,Number(url.searchParams.get('index')??0)||0);
          let tUs=index*250_000*(2**lod);
          const dur=await videoDuration(mediaAbs.abs);
          if(dur>0&&tUs>=dur*1e6)tUs=Math.max(0,Math.floor(dur*1e6)-40_000);
          const heightPx=128;
          const target=await ensureArtFrame(store,mediaAbs.abs,tUs,heightPx);
          const dims=await probeDims(mediaAbs.abs);
          const widthPx=Math.max(2,2*Math.round(heightPx*dims.w/dims.h/2));
          sendJson(res,200,{ok:true,value:{path:target,widthPx,heightPx}});return;
        }
        if(sub==='art-file'&&req.method==='GET'){
          const want=resolve(url.searchParams.get('path')??'');
          const artRoot=resolve(join(store.root,'timeline-art'));
          if(want!==artRoot&&!want.startsWith(artRoot+sep)||extname(want)!=='.jpg'){sendJson(res,404,{detail:'not an art cache file'});return;}
          const info=statSync(want);
          res.writeHead(200,{'Content-Type':'image/jpeg','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=86400','Content-Length':String(info.size)});mediaLog(req,200,'art-file');
          if(req.method==='HEAD'){res.end();return;}
          createReadStream(want).pipe(res);return;
        }
        // Waveform lanes: pyramid peaks built once per source with ffmpeg,
        // cached under .director-studio/waveform (meta JSON + int16 block).
        if(sub==='waveform-levels'&&req.method==='GET'){
          const got=await ed.get(id);if(!got){sendJson(res,404,{detail:'no such editing document'});return;}
          const mediaAbs=editingMediaAbs(got.doc,url.searchParams.get('mediaId')??'',store.workspaceRoot??join(store.root,'..'));
          if(!mediaAbs||!existsSync(mediaAbs.abs)){sendJson(res,200,{ok:false,error:{code:'not_ready',detail:'media file unavailable'}});return;}
          try{
            const meta=await ensureWaveform(join(store.root,'waveform'),mediaAbs.abs);
            sendJson(res,200,{ok:true,value:{channels:meta.channels,levels:meta.levels}});
          }catch(error){
            if(String(error?.message).includes('not_ready'))sendJson(res,200,{ok:false,error:{code:'not_ready'}});
            else sendJson(res,200,{ok:false,error:{code:'not_ready',detail:String(error?.message??error).slice(0,160)}});
          }
          return;
        }
        if(sub==='waveform-tile'&&req.method==='GET'){
          const got=await ed.get(id);if(!got){sendJson(res,404,{detail:'no such editing document'});return;}
          const mediaAbs=editingMediaAbs(got.doc,url.searchParams.get('mediaId')??'',store.workspaceRoot??join(store.root,'..'));
          if(!mediaAbs||!existsSync(mediaAbs.abs)){sendJson(res,200,{ok:false,error:{code:'not_ready',detail:'media file unavailable'}});return;}
          try{
            const meta=await ensureWaveform(join(store.root,'waveform'),mediaAbs.abs);
            const value=readWaveformTile(meta,Number(url.searchParams.get('level')??0),Number(url.searchParams.get('channel')??0),Number(url.searchParams.get('startPeak')??0),Number(url.searchParams.get('count')??2048));
            sendJson(res,200,{ok:true,value});
          }catch(error){sendJson(res,200,{ok:false,error:{code:'not_ready',detail:String(error?.message??error).slice(0,160)}});}
          return;
        }
        // '+ Footage': every workspace media/ video not already in the pool joins it —
        // the same add_media_item actor op drags use, through the shared store singleton.
        if(sub==='import-footage'&&req.method==='POST'){
          const got=await ed.get(id);if(!got){sendJson(res,404,{detail:'no such editing document'});return;}
          const root=store.workspaceRoot??join(store.root,'..');
          const pool=got.doc.media_pool??{};
          const have=new Set(Object.values(pool).map((item)=>String(item.path_abs??'')));
          const mediaDir=join(root,'media');
          const added=[];
          let entries=[];
          try{entries=readdirSync(mediaDir,{recursive:true,withFileTypes:true});}catch{}
          for(const ent of entries){
            if(!ent.isFile())continue;
            if(!/\.(mp4|m4v|webm|mov|mkv)$/i.test(ent.name))continue;
            // rel: workspace-relative 'media/...' — Dirent.path is the ABSOLUTE
            // directory just scanned, so strip the mediaDir prefix.
            const rel0='media/'+join(ent.path,ent.name).slice(mediaDir.length+1).split(sep).join('/');
            if(have.has(rel0)||have.has(join(root,rel0)))continue;
            if(rel0.startsWith('media/normalized/'))continue; // already-normalized copies are not new candidates
            const rel=await ensureNormalized(root,rel0); // 10-bit/odd sources pool as 8-bit copies
            if(have.has(rel))continue;
            const dur=await videoDuration(join(root,rel));
            const dims=await ed.probeDims(join(root,rel));
            const aud=await ed.probeAudio(join(root,rel));
            const med=await ed.dispatchOp(id,'add_media_item',{media:EditingStore.poolEntry(randomUUID(),rel,Math.round(dur*1e6)||null,dims,aud)});
            if(med.ok)added.push({path:rel,media_id:med.value});
          }
          sendJson(res,200,{ok:true,added});return;
        }
        // Repair route: transcode every pool source the browser cannot decode
        // (High 10 etc.) that is ACTUALLY USED ON THE TIMELINE (pool posters stay
        // 10-bit originals — they're server-rendered). Relinks flow to the open
        // editor one by one. Runs in the background.
        if(sub==='normalize-pool'&&req.method==='POST'){
          const got=await ed.get(id);if(!got){sendJson(res,404,{detail:'no such editing document'});return;}
          const root=store.workspaceRoot??join(store.root,'..');
          const jobs=ed.normalizeJobs??(ed.normalizeJobs=new Map());
          if(jobs.get(id)?.running){sendJson(res,200,{ok:true,already_running:true,progress:jobs.get(id)});return;}
          const used=new Set();
          for(const comp of Object.values(got.doc.compositions??{}))for(const tr of comp.tracks??[])for(const l of tr.layers??[])if(l.params&&l.params.media)used.add(String(l.params.media));
          const need=[];
          for(const mid of used){
            const med=got.doc.media_pool?.[mid];
            const rel=String(med?.path_abs??'');
            if(!rel||rel.startsWith('media/normalized/'))continue;
            const abs=med.path_abs&&isAbsolute(med.path_abs)?med.path_abs:join(root,rel);
            if(!existsSync(abs))continue;
            const fmt=await probePixfmt(abs);
            if(!isBrowserDecodable(fmt))need.push({mid,rel,name:basename(rel)});
          }
          const progress={running:true,total:need.length,done:0,current:null,failed:0};
          jobs.set(id,progress);
          (async()=>{
            for(const item of need){
              progress.current=item.rel;
              try{
                const nrel=await ensureNormalized(root,item.rel);
                if(nrel!==item.rel){
                  const durMs=await videoDuration(join(root,nrel));
                  const rl=await ed.relinkMedia(id,{media_id:item.mid,path:nrel,duration_us:durMs>0?Math.round(durMs*1e6):undefined});
                  if(!rl.ok)progress.failed++;
                } else progress.failed++;
              }catch{progress.failed++;}
              progress.done++;
            }
            progress.running=false;progress.current=null;
          })();
          sendJson(res,200,{ok:true,started:need.length,progress});return;
        }
        if(sub==='normalize-status'&&req.method==='GET'){
          sendJson(res,200,{ok:true,progress:(ed.normalizeJobs??new Map()).get(id)??{running:false,total:0,done:0,current:null,failed:0}});return;
        }
        if(!sub||req.method!=='POST')return void sendJson(res,405,{detail:'method not allowed'});
        const b=await readJson(req,controller.signal);
        if(sub==='command')sendJson(res,200,await ed.command(id,String(b.channel??''),b.args??{},String(b.by??'user')));
        else if(sub==='undo')sendJson(res,200,await ed.undo(id));
        else if(sub==='redo')sendJson(res,200,await ed.redo(id));
        else if(sub==='seed')sendJson(res,200,await ed.seedShots(id,b.shots??b));
        else if(sub==='relink')sendJson(res,200,await ed.relinkMedia(id,{media_id:b.media_id,shot_id:b.shot_id,path:b.path,duration_us:b.duration_us}));
        else sendJson(res,200,await ed.checkpoint(id,String(b.label??'checkpoint')));
        return;}
      // (The engine bundle is served pre-session at the /api gate above: a
      //  <script> tag cannot send the session header.)
      // Footage & Images libraries: /api/footage* over media/ (video) and /api/images* over images/ — one shared block, kind from the URL segment.
      // Bridge contract: footage/big files move DSH→ComfyUI input/dsh/ by the SERVER (the Comfy box can never reach 127.0.0.1:3081); the browser only passes names.
      if(path==='/api/comfy-upload'&&req.method==='POST'){
        const b=await readJson(req,controller.signal);
        const raw=String(b.path??'').trim();const origin=String(b.comfy_origin??'').trim().replace(/\/+$/,'');
        if(!raw){sendJson(res,400,{detail:'A file path is required.'});return;}
        if(!/^https?:\/\//.test(origin)){sendJson(res,400,{detail:'comfy_origin must be an http(s) origin.'});return;}
        const candidates=[raw,join(await store.libRoot('footage'),raw),join(await store.libRoot('images'),raw)];
        const abs=candidates.find((c)=>existsSync(c));
        if(!abs){sendJson(res,404,{detail:'File not found.'});return;}
        const bytes=readFileSync(abs);
        const form=new FormData();
        form.append('image',new Blob([bytes]),basename(abs));
        form.append('subfolder','dsh');form.append('type','input');form.append('overwrite','true');
        const r=await fetchImpl(`${origin}/upload/image`,{method:'POST',body:form,signal:controller.signal}).catch(()=>null);
        if(!r){sendJson(res,502,{detail:`ComfyUI at ${origin} refused the upload connection.`});return;}
        const v=await r.json().catch(()=>null);
        if(!r.ok){sendJson(res,r.status,{detail:v??`upload/image responded HTTP ${r.status}`});return;}
        sendJson(res,200,v??{});return;}
      match=/^\/api\/(footage|images)(?:\/(open|delete|comfy|order|thumb|folder|refs|group|smart|tag-ai|seen))?$/.exec(path);
      if(match){
        const seg=match[1],kind=seg==='images'?'images':'footage',sub=match[2]??'';
        if(!sub&&req.method==='GET'){
          const [library,root,assets]=await Promise.all([store.listLib(kind),store.libRoot(kind),store.listAssets({project_id:project.id,include_unassigned:true})]);
          const files=library.files.map(item=>{const abs=join(root,item.path),enc=encodeURIComponent(abs);let size=null,mtime=null;try{const st=statSync(abs);size=st.size;mtime=st.mtimeMs;}catch{}const empty=size===0;return {...item,size,mtime,empty,url:`/director-studio/api/file?path=${enc}&session=${encodeURIComponent(sessionId)}`,thumb:empty||kind==='images'?null:`/director-studio/api/footage/thumb?path=${enc}&session=${encodeURIComponent(sessionId)}`};});
          sendJson(res,200,{files,groups:library.groups,order:library.order,open:library.open,assets:assets.filter(item=>['actors','scenes','props'].includes(item.kind)).map(item=>({name:item.name,kind:item.kind,id:item.id}))});return;}
        if(sub==='open'&&req.method==='PUT'){const b=await readJson(req,controller.signal);sendJson(res,200,await store.setLibOpen(kind,{id:b.id,expanded:b.expanded}));return;}
        // Selected files leave the library by going to the OS trash (XDG), one result row per file.
        if(sub==='delete'&&req.method==='POST'){const b=await readJson(req,controller.signal);
          const results=[];for(const p of Array.isArray(b.paths)?b.paths:[]){try{results.push(await store.deleteLib(kind,{path:p}));}catch(e){results.push({path:String(p),error:String(e.message||e)});}}
          sendJson(res,200,{results});return;}
        // A card was opened: its NEW/unwatched outline goes away for good.
        if(sub==='seen'&&req.method==='POST'){const b=await readJson(req,controller.signal);sendJson(res,200,await store.setLibSeen(kind,{path:b.path}));return;}
        // "Open in ComfyUI": ComfyUI embeds the whole graph in the saved file (mp4 container tags; PNG tEXt chunks) — UI `workflow` first, else API `prompt`.
        // probe:true → just presence (the menu greys the item out). Full call → extract, hand JSON to the browser, push it into the first ComfyUI that answers.
        if(sub==='comfy'&&req.method==='POST'){
          const b=await readJson(req,controller.signal);
          // Asset mode: a file that lives on an asset (not in the media//images/ libraries) — resolve its absolute path from the record.
          const aRef=b.asset&&typeof b.asset==='object'&&isStudioAssetKind(String(b.asset.kind??''))?{kind:String(b.asset.kind),id:String(b.asset.asset_id??''),key:String(b.asset.key??'')}:null;
          let abs,rel;
          if(aRef){
            const item=(await store.listAssets({kind:aRef.kind})).find((v)=>v.id===aRef.id);
            abs=item?.files?.[aRef.key]??'';rel=String(abs).split(/[\\/]/).pop();
            if(!abs||!existsSync(abs)){sendJson(res,404,{detail:'Asset file not found.'});return;}
          }else{
            rel=String(b.path??'');const root=await store.libRoot(kind);abs=join(root,rel);
            if(!rel||!abs.startsWith(root+sep)||!existsSync(abs)){sendJson(res,404,{detail:'Library file not found.'});return;}
          }
          const isImage=/\.(png|jpe?g|webp|gif)$/i.test(abs);
          const wf=isImage?await embeddedComfyPng(abs):await embeddedComfyWorkflow(abs);
          if(b.probe){sendJson(res,200,{has:Boolean(wf)});return;}
          if(!wf){sendJson(res,404,{detail:'No embedded ComfyUI workflow in this file.'});return;}
          const base=await firstOnlineComfy({comfyHosts,store,fetchImpl,signal:controller.signal});
          // Convert API graphs to UI format with the target host's own /object_info so the browser clipboard can be pasted anywhere (the UI paste path does NOT convert API format itself; File→Open does).
          let uploaded='',ui='';if(wf.kind==='prompt'&&base){try{const oi=await fetchImpl(`${base}/object_info`,{signal:controller.signal}).then((r)=>r.ok?r.json():null);if(oi){const conv=apiToUi(JSON.parse(wf.json),oi);if(conv)ui=JSON.stringify(conv);}}catch{}}
          if(base){
            const name=`workflows/dsh/${String(rel).replace(/\.[a-z0-9]+$/i,'')}.json`;
            const v2=await fetchImpl(`${base}/api/userdata/v2/${name.split('/').map(encodeURIComponent).join('/')}`,{method:'PUT',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({content:ui||wf.json})}).catch(()=>null);
            if(v2?.ok)uploaded=name;
            else{const v1=await fetchImpl(`${base}/api/userdata?path=${encodeURIComponent(name)}`,{method:'PUT',signal:controller.signal,headers:{'content-type':'application/json'},body:ui||wf.json}).catch(()=>null);if(v1?.ok)uploaded=name;}
          }
          sendJson(res,200,{kind:wf.kind,json:wf.json,ui:ui||undefined,host:base,uploaded});return;}
        if(sub==='order'&&req.method==='PUT'){const b=await readJson(req,controller.signal);sendJson(res,200,await store.setLibOrder(kind,{order:Array.isArray(b.order)?b.order:[]}));return;}
        // Poster for a footage video: one ffmpeg frame, cached in .director-studio/footage-thumbs (streamed here, never via /api/file). Images serve their own bytes.
        if(sub==='thumb'&&['GET','HEAD'].includes(req.method)){
          const {resolved,mime}=await resolveMediaPath(url,join(store.root,'..'),sessionIndex);
          if(!mime.startsWith('video/'))throw new StudioStoreError('Thumbnails are generated for videos only.',400);
          const target=await ensureFootageThumb(store,resolved);const tinfo=statSync(target);
          res.writeHead(200,{'Content-Type':'image/jpeg','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=3600','Content-Length':String(tinfo.size)});mediaLog(req,200,'thumb '+extname(resolved));
          if(req.method==='HEAD'){res.end();return;}
          createReadStream(target).pipe(res);return;}
        if(!sub&&req.method==='POST'){sendJson(res,201,await store.addLib(kind,await readJson(req,controller.signal)));return;}
        if(sub==='folder'&&req.method==='POST'){sendJson(res,200,await store.attachLibFolder(kind,await readJson(req,controller.signal)));return;}
        if(sub==='refs'&&req.method==='PUT'){sendJson(res,200,await store.tagLib(kind,await readJson(req,controller.signal)));return;}
        if(sub==='group'&&req.method==='POST'){sendJson(res,200,await store.addLibGroup(kind,await readJson(req,controller.signal)));return;}
        if(sub==='group'&&req.method==='DELETE'){const b=await readJson(req,controller.signal).catch(()=>({}));sendJson(res,200,await store.removeLibGroup(kind,{name:String(b.name??url.searchParams.get('name')??'')}));return;}
        // Smart filter: free-text query → one cheap chat call over the compact catalog → matching paths.
        // ponytail: naive whole-catalog prompt (fine for thousands of items); upgrade path = embeddings. Answer is
        // intersected with real catalog paths so a hallucinated path can never render.
        if(sub==='smart'&&req.method==='POST'){
          const b=await readJson(req,controller.signal);
          const query=String(b.query??'').trim();
          const smart=(await store.getAppSettings()).smart??{};
          if(!query||!String(smart.url??'').trim()){sendJson(res,400,{detail:'Smart filter needs a query and an LLM endpoint — set the smart-query URL in the gear panel.'});return;}
          // The model is the requesting session's own current model; gear's smart.model is only an explicit override. No local timeout: whatever the model takes, it takes.
          const override=String(smart.model??'').trim();
          const used=override?{model:override,reasoning:null}:await sessionModel(sessionId);
          const model=used.model,reasoning=used.reasoning;
          const [library,root]=await Promise.all([store.listLib(kind),store.libRoot(kind)]);
          const noun=kind==='images'?'image':'video';
          const catalog=library.files.map(item=>{let day=null;try{day=new Date(statSync(join(root,item.path)).mtimeMs).toISOString().slice(0,10);}catch{}return {path:item.path,tags:item.tags??[],day};});
          const reply=await fetchImpl(`${String(smart.url).trim().replace(/\/$/,'')}/chat/completions`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({model:model||undefined,temperature:0,...(reasoning?{reasoning_effort:reasoning}:{}),messages:[{role:'system',content:`You filter a ${noun} library. Reply with ONLY a JSON array of matching "path" values taken verbatim from the CATALOG. No prose.`},{role:'user',content:`CATALOG\n${JSON.stringify(catalog)}\n\nShow the ${noun}s matching: ${query}`}]})}).then(r=>r.ok?r.json():Promise.reject(Error(`LLM endpoint answered ${r.status}`))).catch(e=>({__err:String(e.message||e)}));
          if(reply.__err){sendJson(res,502,{detail:`Smart filter LLM: ${reply.__err}`});return;}
          const found=/\[[\s\S]*\]/.exec(reply?.choices?.[0]?.message?.content??'');
          let picked=[];if(found){try{picked=JSON.parse(found[0]);}catch{}}
          const known=new Set(catalog.map(c=>c.path));
          sendJson(res,200,{query,paths:(Array.isArray(picked)?picked:[]).filter(p=>known.has(String(p)))});return;}
        // AI tagging (0.2.45 / 0.2.57): the session's own model looks at the media and returns content tags.
        // Videos ride a 480p preview (also keeps bodies under the codex-router's big-body limit — verified external
        // limit: ≥~5MB base64 503s; if a body still fails the endpoint's own error surfaces verbatim, no local gate).
        // Images are sent as-is via image_url.
        if(sub==='tag-ai'&&req.method==='POST'){
          const b=await readJson(req,controller.signal);
          const smart=(await store.getAppSettings()).smart??{};
          const url=String(smart.url??'').trim().replace(/\/$/,'');
          const aTag=b.asset&&typeof b.asset==='object'&&isStudioAssetKind(String(b.asset.kind??''))?{kind:String(b.asset.kind),id:String(b.asset.asset_id??''),key:String(b.asset.key??'')}:null;
          if(!aTag&&!String(b.path??'').trim()||!url){sendJson(res,400,{detail:'AI tagging needs a file path (or an asset reference) and the smart-filter endpoint (gear panel).'});return;}
          let abs;
          if(aTag){
            const item=(await store.listAssets({kind:aTag.kind})).find((v)=>v.id===aTag.id);
            abs=item?.files?.[aTag.key]??'';
            if(!abs||!existsSync(abs)){sendJson(res,404,{detail:'Asset file not found.'});return;}
          }else{
            const root=await store.libRoot(kind);
            abs=join(root,String(b.path).replaceAll('\\','/'));// join normalizes ../ so the containment check below is exact
            if(abs!==root&&!abs.startsWith(root+sep)){sendJson(res,400,{detail:`Path must be inside the ${kind==='images'?'images/':'media/'} library.`});return;}
          }
          let mediaPart;
          if(kind==='images'){
            const mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'})[extname(abs).toLowerCase()];
            if(!mime)throw new StudioStoreError('AI tagging supports PNG/JPG/WebP/GIF images.',400);
            mediaPart={type:'image_url',image_url:{url:`data:${mime};base64,${readFileSync(abs).toString('base64')}`}};
          }else{
            let preview;try{preview=await ensureFootagePreview(store,abs);}catch(e){sendJson(res,e instanceof StudioStoreError?e.status:502,{detail:String(e.message||e)});return;}
            mediaPart={type:'video_url',video_url:{url:`data:video/mp4;base64,${readFileSync(preview).toString('base64')}`}};
          }
          let model=String(smart.model??'').trim(),reasoning=null;
          if(!model){const used=await sessionModel(sessionId);model=used.model;reasoning=used.reasoning;}
          if(!model)model=await qwenFallback(url,fetchImpl,controller.signal);
          // Group membership is tag equality (tab collapsibles), so the tagger also gets every group name —
          // one call per file therefore updates ALL groups, asset and custom, when the file belongs there.
          const [lib,assetsAll]=await Promise.all([store.listLib(kind),store.listAssets({project_id:project.id,include_unassigned:true})]);
          const groupNames=[...new Set([...lib.groups,...assetsAll.filter(item=>['actors','scenes','props'].includes(item.kind)).map(item=>item.name.toLowerCase())])];
          const text=kind==='images'
            ?`You are tagging one image of an AI film production library. Look at the image. Reply with ONLY a JSON array of 4-10 lowercase tags (1-2 words each): characters/creatures, main content, setting, style, mood. No prose, no duplicates of the existing tags. Library path: ${abs}. Existing tags: ${JSON.stringify(b.existing??[])}. Library groups (collapsibles): ${JSON.stringify(groupNames)} — if the image clearly belongs to a group, include that exact group name as a tag so it joins that group.`
            :`You are tagging one clip of an AI film production library. Watch the video. Reply with ONLY a JSON array of 4-10 lowercase tags (1-2 words each): characters/creatures, main actions, setting, camera movement, mood. No prose, no duplicates of the existing tags. Library path: ${abs}. Existing tags: ${JSON.stringify(b.existing??[])}. Library groups (collapsibles): ${JSON.stringify(groupNames)} — if the clip clearly belongs to a group, include that exact group name as a tag so it joins that group.`;
          const reply=await fetchImpl(`${url}/chat/completions`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({model:model||undefined,temperature:0,...(reasoning?{reasoning_effort:reasoning}:{}),messages:[{role:'user',content:[{type:'text',text},mediaPart]}]})}).then(r=>r.ok?r.json():r.text().catch(()=>'').then(t=>Promise.reject(Error(`LLM endpoint answered ${r.status}: ${String(t).slice(0,300)}`)))).catch(e=>({__err:String(e.message||e)}));
          if(reply.__err){sendJson(res,502,{detail:`AI tagging LLM: ${reply.__err}`});return;}
          const found=/\[[\s\S]*\]/.exec(reply?.choices?.[0]?.message?.content??'');
          let tags=[];if(found){try{const arr=JSON.parse(found[0]);if(Array.isArray(arr))tags=arr.map(String);}catch{}}
          const resolution=resolutionTag(await videoHeight(abs));
          if(aTag){
            const v=await store.setAssetRef(aTag.kind,aTag.id,{key:aTag.key,tags_add:resolution?[...tags,resolution]:tags});
            sendJson(res,200,{path:abs,tags:v.tags??[],model:model||'endpoint default',resolution});return;
          }
          const v=await store.tagLib(kind,{path:String(b.path),tags_add:resolution?[...tags,resolution]:tags});
          sendJson(res,200,{path:v.path,tags:v.tags,model:model||'endpoint default',resolution});return;}
      }
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
        // Bridge contract v1.2: kind=assets serves the flat sidecar-shaped list the dsh-studio-link extension
        // consumes directly (iframe AND standalone modes): {assets:[{slug,images,videos,audio,description,notes}]}.
        if(kind==='assets'){
          const IMG=/\.(png|jpe?g|webp|gif|bmp)$/i,AUD=/\.(wav|mp3|flac|ogg|m4a)$/i;
          const out=[];
          for(const g of ['actors','costumes','scenes','props','layouts','voices'])for(const item of await store.listAssets({kind:g,project_id:project.id,include_unassigned:true})){
            const pa=presentAsset(item,sessionId);
            const entry={slug:String(pa.folder??pa.slug??pa.id??''),description:pa.description??'',notes:pa.notes??'',images:[],videos:[],audio:[]};
            for(const [key,abs] of Object.entries(pa.paths??{})){
              const name=String(abs).split(/[\\/]/).pop(),m=(pa.ref_meta??{})[key]??{};
              const rec={key,file:name,abs,tags:m.tags??[],note:m.note??''};
              (IMG.test(name)?entry.images:AUD.test(name)?entry.audio:entry.videos).push(rec);
            }
            out.push(entry);
          }
          sendJson(res,200,{assets:out});return;
        }
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
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/files\/([A-Za-z0-9_-]{1,100})$/.exec(path);
      if(match&&req.method==='DELETE'){sendJson(res,200,await store.deleteAssetFile(match[1],match[2],match[3]));return;}
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/source$/.exec(path);
      if(match&&req.method==='POST'){const out=await store.attachAssetSource(match[1],match[2],await readJson(req,controller.signal));sendJson(res,200,{added:out.added,asset:presentAsset(out.asset,sessionId)});return;}
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/scan$/.exec(path);
      if(match&&req.method==='POST'){const out=await store.scanAsset(match[1],match[2]);sendJson(res,200,{added:out.added,asset:presentAsset(out.asset,sessionId)});return;}
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/refs\/([A-Za-z0-9_-]{1,100})$/.exec(path);
      if(match&&req.method==='PUT'){sendJson(res,200,await store.setAssetRef(match[1],match[2],{key:match[3],...(await readJson(req,controller.signal))}));return;}
      match=/^\/api\/library\/([a-z_]+)\/([A-Za-z0-9_-]{1,128})\/project$/.exec(path);
      if(match&&req.method==='PATCH'){await readJson(req,controller.signal);sendJson(res,200,presentAsset(await store.assignAsset(match[1],match[2],project.id),sessionId));return;}
      if(path==='/api/library/assign-project'&&req.method==='POST'){
        const input=await readJson(req,controller.signal);if(!Array.isArray(input.asset_ids)||input.asset_ids.length>200)throw new StudioStoreError('asset_ids must be an array with at most 200 entries.');
        const result=[];for(const asset of input.asset_ids){if(!asset||!isStudioAssetKind(asset.kind))throw new StudioStoreError('Each asset needs a supported kind.');result.push(presentAsset(await store.assignAsset(asset.kind,asset.id,project.id),sessionId));}sendJson(res,200,result);return;
      }
      if(path==='/api/shots/reorder'&&req.method==='POST'){sendJson(res,200,{shots:await store.reorderShots((await readJson(req,controller.signal)).shot_ids)});return;}
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
    }catch(error){try{const p=new URL(req.url,'http://localhost').pathname;if(p.endsWith('/api/file')||p.endsWith('/api/comfy-view'))mediaLog(req,'err',String(error?.message??error));}catch{}if(!res.headersSent&&!res.destroyed)routeError(res,error);else if(!res.destroyed)res.destroy();}
    finally{res.removeListener('close',abort);controllers.delete(controller);}
  };
}

export function registerStudioApi(ctx,{resolveSession,comfyBaseUrl,comfyHosts,agentTasks}={}){
  const controllers=new Set(),unregister=ctx.webServer.register({kind:'prefix',path:'/director-studio',handler:createStudioApiHandler({resolveSession,comfyBaseUrl,comfyHosts,agentTasks,controllers,requestRejection:req=>ctx.connection.requestRejection(req)})});
  return ()=>{unregister();for(const controller of controllers)controller.abort();};
}
