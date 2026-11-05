import z from '@deepseek-ai/schemastery';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {apply as registerSubmit} from './submit-comfy-video.mjs';
import {createBundledProvider,createH3GuideStore,createH3GuideTool} from './skills.mjs';
import {createMediaStore} from './media-store.mjs';
import {createCardPresentationRegistry} from './card-presentation.mjs';
import {createMediaTool,createEditReviewTool} from './media-tool.mjs';
import {registerMediaRoute} from './media-route.mjs';
import {createStageImagesTool} from './image-staging.mjs';
import {createGpuStatus,registerGpuStatusRoute,registerGpuReleaseRoute} from './gpu-status.mjs';
import {createAssetTool} from './asset-catalog.mjs';
import {createWorkflowTool} from './workflow-discovery.mjs';
import {createStudioRegistry,StudioStoreError} from './studio-store.mjs';
import {registerStudioApi} from './studio-api.mjs';
import {createStudioTools} from './studio-tools.mjs';

export const name='dsh-director';
export const inject=['tools','jobs','skills','fs','connection','webServer','attachments'];
export const Config=z.object({
  comfyBaseUrl:z.string().default('http://127.0.0.1:8188'),
  comfyTryUrls:z.string().default('').volatile(),
  llamaSwapBaseUrl:z.string().default('http://127.0.0.1:11435'),
  llmHandoffMode:z.union(['llama-swap','comfy-only']).default('llama-swap').volatile(),
  workflowTextToImage:z.string().default('').volatile(),
  workflowImageEdit:z.string().default('').volatile(),
  workflowReferenceToVideo:z.string().default('').volatile(),
  workflowFirstLastFrameToVideo:z.string().default('').volatile(),
  workflowVideoEdit:z.string().default('').volatile(),
  mediaRoot:z.string().default(join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-media')),
  skillCacheRoot:z.string().default(join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-skills'))
});
export async function apply(ctx,config={}){
  // The Director client renders its own settings section (GpuUsageSettings), so the
  // generic auto form stays off; the ComfyUI endpoint fields live there.
  ctx.inject(['settings'],scoped=>{
    scoped.effect(()=>scoped.settings.configure({auto:false},ctx.fiber),'director custom settings section');
  });
  const currentConfigValue=key=>{
    const value=config[key];
    return value&&typeof value.get==='function'?value.get():value;
  };
  const currentHandoffMode=()=>currentConfigValue('llmHandoffMode')??'llama-swap';
  // Session projects can override the per-kind required workflow names (studio gear -> Workflows tab); plugin config is the fallback.
  const currentWorkflowNames=async(cwd)=>{const names={
    text_to_image:String(currentConfigValue('workflowTextToImage')??'').trim(),
    image_edit:String(currentConfigValue('workflowImageEdit')??'').trim(),
    reference_to_video:String(currentConfigValue('workflowReferenceToVideo')??'').trim(),
    first_last_frame_to_video:String(currentConfigValue('workflowFirstLastFrameToVideo')??'').trim(),
    video_edit:String(currentConfigValue('workflowVideoEdit')??'').trim(),};
    if(cwd)try{const {store}=await studioRegistry(cwd);const stored=(await store.getAppSettings()).workflows??{};for(const kind of Object.keys(names)){const value=String(stored[kind]??'').trim();if(value)names[kind]=value;}}catch{}
    return names};
  const llmHandoffMode=currentHandoffMode();
  // Plugin: ordered ComfyUI endpoints — the session project's own list (studio ⚙ → ComfyUI tab) first,
  // then the plugin primary and comfyTryUrls fallbacks; the first /system_stats that answers wins (cached 15s per cwd).
  const comfyProbe=new Map(); // ponytail: one cache entry per session cwd, replaced in place; ceiling = number of live sessions.
  const resolveComfyBaseUrl=async(cwd)=>{
    const cacheKey=cwd??'';const cached=comfyProbe.get(cacheKey);
    if(cached&&Date.now()-cached.at<15000)return cached.base;
    const sessionUrls=[];
    if(cwd)try{const {store}=await studioRegistry(cwd);sessionUrls.push(...String((await store.getAppSettings())?.comfy?.urls??'').split(/[\n,]+/).map(entry=>entry.trim()).filter(Boolean));}catch{}
    const candidates=[...sessionUrls,config.comfyBaseUrl,...String(currentConfigValue('comfyTryUrls')??'').split(/[\n,]+/).map(entry=>entry.trim()).filter(Boolean)];
    const tried=[];
    for(const entry of candidates){
      let origin;try{origin=new URL(entry).origin}catch{continue}
      tried.push(origin);
      try{const response=await fetch(`${origin}/system_stats`,{signal:AbortSignal.timeout(3000),redirect:'error'});if(response.ok){response.body?.cancel?.();comfyProbe.set(cacheKey,{base:origin,at:Date.now()});return origin}}catch{}
    }
    throw new Error(`tried ${tried.join(', ')||'none configured'}`);
  };
  for(const key of ['comfyBaseUrl',...(llmHandoffMode==='llama-swap'?['llamaSwapBaseUrl']:[])])if(config[key]){
    const url=new URL(config[key]);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error(`${key} must be an HTTP(S) origin, not a path or credentials.`);
  }
  const guideStore=createH3GuideStore({cacheRoot:config.skillCacheRoot});
  const provider=await createBundledProvider(undefined,{guideStore});
  ctx.effect(()=>ctx.skills.registerProvider(()=>provider),'director bundled skills');
  // Optional capability: a missing human-question UI must not disable generic
  // Director tools, and model arguments must never stand in for human consent.
  ctx.inject(['tools','userQuestions'],scoped=>{
    scoped.effect(()=>scoped.tools.register(createH3GuideTool({guideStore,userQuestions:scoped.userQuestions})),'director optional H3 guide setup');
  });
  const handoffConfig={...config,llmHandoffMode:currentHandoffMode};
  let goalService;
  if(typeof ctx.inject==='function')ctx.inject(['goals'],scoped=>{goalService=scoped.goals;});
  const getGoal=agent=>{
    if(!agent||typeof goalService?.get!=='function')return undefined;
    try{return goalService.get(agent);}catch{return undefined;}
  };
  const cardPresentation=createCardPresentationRegistry();
  const gpuStatus=createGpuStatus(handoffConfig);
  registerSubmit(ctx,{...handoffConfig,comfyBaseUrl:resolveComfyBaseUrl,getWorkflowNames:currentWorkflowNames,onGpuState:value=>gpuStatus.update(value),getGoal,cardPresentation});
  ctx.effect(()=>registerGpuStatusRoute(ctx,gpuStatus),'director GPU status');
  ctx.effect(()=>registerGpuReleaseRoute(ctx,gpuStatus),'director GPU release');
  const store=createMediaStore({root:config.mediaRoot||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-media')});
  ctx.effect(()=>ctx.tools.register(createAssetTool({root:join(config.mediaRoot||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-media'),'assets'),fs:ctx.fs,attachments:ctx.attachments})),'director asset lookup');
  ctx.effect(()=>ctx.tools.register(createStageImagesTool({root:join(config.mediaRoot||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-media'),'staged-images'),fs:ctx.fs,comfyBaseUrl:resolveComfyBaseUrl})),'director reference staging');
  ctx.effect(()=>ctx.tools.register(createWorkflowTool({comfyBaseUrl:resolveComfyBaseUrl,getWorkflowNames:currentWorkflowNames})),'director workflow discovery');
  const mediaTool=createMediaTool({store,fs:ctx.fs,attachments:ctx.attachments,getGoal,cardPresentation});
  ctx.effect(()=>ctx.tools.register(mediaTool),'director media tool');
  ctx.effect(()=>ctx.tools.register(createEditReviewTool(mediaTool)),'director review edits');
  ctx.effect(()=>registerMediaRoute(ctx,store,cardPresentation),'director media route');
  const studioRegistry=createStudioRegistry();
  let sessionPersistence;
  if(typeof ctx.inject==='function')ctx.inject(['sessionPersistence'],scoped=>{sessionPersistence=scoped.sessionPersistence;});
  async function resolveStudioSession(sessionId){
    if(!sessionPersistence)throw new StudioStoreError('The DSH session lookup service is unavailable.',503);
    const snapshot=await sessionPersistence.stat(sessionId);
    if(!snapshot)throw new StudioStoreError('Unknown DSH session.',404);
    return studioRegistry(snapshot.header.cwd);
  }
  ctx.effect(()=>registerStudioApi(ctx,{resolveSession:resolveStudioSession,comfyBaseUrl:resolveComfyBaseUrl}),'director Studio API');
  ctx.effect(()=>ctx.tools.register(createStudioTools({registry:studioRegistry,fs:ctx.fs,comfyBaseUrl:resolveComfyBaseUrl})),'director Studio project and production tools');
}
