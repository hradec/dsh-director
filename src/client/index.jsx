import {MediaCard} from './MediaCard.jsx';
import {GpuUsageSettings} from './GpuUsageSettings.jsx';
import {PresetAwareGpuStatus,readLiveStatus} from './GpuStatus.jsx';
import {watchSessionWake} from './session-recovery.mjs';
import {AssetsTab,ProductionTab} from './studio/StudioSidebar.jsx';
import css from './media.css';
export const name='dsh-director-ui';
export const inject=['slots','conversation','connection','sessions','sidebarRightTabs'];
export function apply(ctx){
  ctx.effect(()=>watchSessionWake(ctx.connection),'director foreground recovery');
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.director='media';style.textContent=css;document.head.append(style);return ()=>style.remove();},'director media styles');
  if(typeof ctx.inject==='function')ctx.inject(['configForms'],scoped=>{
    scoped.effect(()=>scoped.configForms.whileServed(['dsh-director'],()=>{
      const form=scoped.configForms.get('dsh-director');
      return ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'director',order:25,label:()=>'Director',inject:()=>({form})},GpuUsageSettings));
    }),'director Settings section');
  });
  const sendSessionMessage=async(sessionId,text)=>{
    if(ctx.connection.state.getSnapshot()!=='connected')throw Error('Reconnect before sending a DSH request.');
    const status=await readLiveStatus();
    if(status.blocked||ctx.connection.state.getSnapshot()!=='connected')throw Error('Cannot send while the GPU handoff or connection is unavailable.');
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
     {id:'dsh-director-studio-assets',kind:'director-studio-assets',title:()=>'Assets',guide:[{id:'assets',order:30,title:()=>'Assets',description:()=>'Actors, scenes, props, voices, and reusable media.'}]},
     {id:'dsh-director-studio-production',kind:'director-studio-production',title:()=>'Production',guide:[{id:'production',order:40,title:()=>'Production',description:()=>'Project shots, references, dialogue, and generation review.'}]},
   ];
   if(ctx.sidebarRightTabs?.register)for(const [index,definition] of studioTabs.entries()){
     const Body=index===0?AssetsTab:ProductionTab;
     ctx.effect(()=>ctx.sidebarRightTabs.register(definition),`director Studio ${definition.kind} type`);
     ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:definition.id,inject:sessionId=>({sessionId,sendDshRequest:text=>sendSessionMessage(sessionId,text)})},Body)),`director Studio ${definition.kind} body`);
   }
}
