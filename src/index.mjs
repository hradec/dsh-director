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

export const name='dsh-director';
export const inject=['tools','jobs','skills','fs','connection','webServer','attachments'];
export const Config=z.object({
  comfyBaseUrl:z.string().default('http://127.0.0.1:8188'),
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
  ctx.inject(['settings'],scoped=>{
    scoped.effect(()=>scoped.settings.configure({auto:false},ctx.fiber),'director custom settings section');
  });
  const currentConfigValue=key=>{
    const value=config[key];
    return value&&typeof value.get==='function'?value.get():value;
  };
  const currentHandoffMode=()=>currentConfigValue('llmHandoffMode')??'llama-swap';
  const currentWorkflowNames=()=>({
    text_to_image:String(currentConfigValue('workflowTextToImage')??'').trim(),
    image_edit:String(currentConfigValue('workflowImageEdit')??'').trim(),
    reference_to_video:String(currentConfigValue('workflowReferenceToVideo')??'').trim(),
    first_last_frame_to_video:String(currentConfigValue('workflowFirstLastFrameToVideo')??'').trim(),
    video_edit:String(currentConfigValue('workflowVideoEdit')??'').trim(),
  });
  const llmHandoffMode=currentHandoffMode();
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
  registerSubmit(ctx,{...handoffConfig,getWorkflowNames:currentWorkflowNames,onGpuState:value=>gpuStatus.update(value),getGoal,cardPresentation});
  ctx.effect(()=>registerGpuStatusRoute(ctx,gpuStatus),'director GPU status');
  ctx.effect(()=>registerGpuReleaseRoute(ctx,gpuStatus),'director GPU release');
  const store=createMediaStore({root:config.mediaRoot||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-media')});
  ctx.effect(()=>ctx.tools.register(createAssetTool({root:join(config.mediaRoot||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-media'),'assets'),fs:ctx.fs,attachments:ctx.attachments})),'director asset lookup');
  ctx.effect(()=>ctx.tools.register(createStageImagesTool({root:join(config.mediaRoot||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'director-media'),'staged-images'),fs:ctx.fs,comfyBaseUrl:config.comfyBaseUrl})),'director reference staging');
  ctx.effect(()=>ctx.tools.register(createWorkflowTool({comfyBaseUrl:config.comfyBaseUrl,getWorkflowNames:currentWorkflowNames})),'director workflow discovery');
  const mediaTool=createMediaTool({store,fs:ctx.fs,attachments:ctx.attachments,getGoal,cardPresentation});
  ctx.effect(()=>ctx.tools.register(mediaTool),'director media tool');
  ctx.effect(()=>ctx.tools.register(createEditReviewTool(mediaTool)),'director review edits');
  ctx.effect(()=>registerMediaRoute(ctx,store,cardPresentation),'director media route');
}
