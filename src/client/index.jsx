import {MediaCard} from './MediaCard.jsx';
import {askDshAgent} from './studio/agent-queue.jsx';
import {GpuUsageSettings} from './GpuUsageSettings.jsx';
import {setComfyTabOpener} from './studio/ComfyFrame.jsx';
import {PresetAwareGpuStatus} from './GpuStatus.jsx';
import {AssetsTab,ComfyTab,FootageTab,ImagesTab,ProductionTab,StoryTab,TimelineTab} from './studio/StudioSidebar.jsx';
import {createMediaBody,MEDIA_KINDS} from './MediaBodies.jsx';
import {startMediaPathFixer} from './markdown-media.mjs';
import {startMediaFenceTakeover} from './media-fence-enhancer.mjs';
import css from './media.css';
export const name='dsh-director-ui';
export const inject=['slots','conversation','connection','sessions','sidebarRight','sidebarRightTabs','documentPreviews'];
export function apply(ctx){
  ctx.effect(()=>startMediaPathFixer(document),'director markdown media path repair');
  ctx.effect(()=>startMediaFenceTakeover(document),'director GenUI media fence takeover');
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.director='media';style.textContent=css;document.head.append(style);return ()=>style.remove();},'director media styles');
  if(typeof ctx.inject==='function')ctx.inject(['configForms'],scoped=>{
    scoped.effect(()=>scoped.configForms.whileServed(['dsh-director'],()=>{
      const form=scoped.configForms.get('dsh-director');
      return ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'director',order:25,label:()=>'Director',inject:()=>({form})},GpuUsageSettings));
    }),'director Settings section');
  });
  const sendSessionMessage=async(sessionId,text)=>{
    // No GPU/connection gates: the studio bridge never pauses. conversation.send reports real delivery failures itself.
    const conversation=ctx.sessions.scope(sessionId)?.get('conversation');
    if(!conversation)throw Error('This conversation is no longer available.');
    await conversation.send(text);
  };
  const reviewInject=sessionId=>({sessionId,sendConfirmation:text=>sendSessionMessage(sessionId,text)});
  ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key:'director_show_media',inject:reviewInject},MediaCard));
  ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key:'director_edit_review',inject:reviewInject},MediaCard));
  // Keep Harness's tool tree and its file diff, search, question and image views.
  // Director contributes only its own keyed media/review rows.
  ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'director-gpu-status',order:-10,inject:sessionId=>{
    const scope=ctx.sessions?.scope(sessionId);
    return {sessionId,sessionList:ctx.sessions?.list,shell:scope?ctx.conversation.input.for(scope):ctx.conversation.input.shell?.(sessionId),connection:ctx.connection};
  }},PresetAwareGpuStatus));
   const studioTabs=[
     {id:'dsh-director-studio-assets',kind:'director-studio-assets',title:()=>'Assets',Body:AssetsTab,guide:[{id:'assets',order:30,title:()=>'Assets — Director Studio',description:()=>'Actors, scenes, props, voices, and reusable media.'}]},
     {id:'dsh-director-studio-production',kind:'director-studio-production',title:()=>'Production',Body:ProductionTab,guide:[{id:'production',order:40,title:()=>'Production — Director Studio',description:()=>'Project shots, references, dialogue, and generation review.'}]},
     {id:'dsh-director-studio-timeline',kind:'director-studio-timeline',title:()=>'Timeline',Body:TimelineTab,guide:[{id:'timeline',order:45,title:()=>'Timeline — Director Studio',description:()=>'Episode timeline: sequence buttons, shot blocks, take switching, watch the whole cut before rendering it.'}]},
     {id:'dsh-director-studio-footage',kind:'director-studio-footage',title:()=>'Footage',Body:FootageTab,guide:[{id:'footage',order:42,title:()=>'Footage — Director Studio',description:()=>'Every video under media/ with tags: asset groups, custom tag groups, filter, right-click copy path.'}]},
     {id:'dsh-director-studio-comfy',kind:'director-studio-comfy',title:()=><span style={{color:'#ff8c3b'}}>ComfyUI</span>,Body:ComfyTab,guide:[{id:'comfy',order:43,title:()=>'ComfyUI — Director Studio',description:()=>'This project\u0027s ComfyUI embedded in the sidebar: host switcher, dsh-studio-link bridge (library, asset staging, node picker) and in-tab workflow loading from Open in ComfyUI.'}]},
     {id:'dsh-director-studio-images',kind:'director-studio-images',title:()=>'Images',Body:ImagesTab,guide:[{id:'images',order:41,title:()=>'Images — Director Studio',description:()=>'Every image under images/ with tags: asset groups, custom tag groups, filter, AI tagging, Open in ComfyUI for embedded graphs.'}]},
     {id:'dsh-director-studio-story',kind:'director-studio-story',title:()=>'Story',Body:StoryTab,guide:[{id:'story',order:50,title:()=>'Story — Director Studio',description:()=>'Decision cards, canon floor, story beats on two clocks — the wall that remembers what you decided.'}]},
   ];
   const sidebarRight=ctx.sidebarRight;
   ctx.effect(()=>{
     setComfyTabOpener(()=>sidebarRight.openTab('director-studio-comfy',{params:{}}));
     return ()=>setComfyTabOpener(null);
   },'director ComfyUI tab opener');
   if(ctx.sidebarRightTabs?.register)for(const definition of studioTabs){
     const Body=definition.Body;
     ctx.effect(()=>ctx.sidebarRightTabs.register(definition),`director Studio ${definition.kind} type`);
     ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:definition.id,inject:sessionId=>({sessionId,sendDshRequest:(text,label)=>askDshAgent(text,label)})},Body)),`director Studio ${definition.kind} body`);
   }
   // The core document tabs have no video/audio renderer and fall back to the Open button; stream media players instead.
   if(ctx.documentPreviews?.register)for(const [group,extensions] of MEDIA_KINDS){
     const id=`dsh-director/media-${group}`;
     ctx.effect(()=>ctx.documentPreviews.register({id,extensions:Object.keys(extensions),binaryExtensions:Object.keys(extensions),priority:'builtin',title:()=>group==='video'?'Video player':'Audio player',loading:'renderer',wrap:false}),`director media ${group} preview metadata`);
     ctx.effect(()=>ctx.slots.inject('sidebar.right.tab.document',()=>ctx.slots.register({name:'sidebar.right.tab.document',key:id},createMediaBody(extensions))),`director media ${group} body`);
   }
}
