// The shot's H3 reference contract: the Cast & continuity refs (shot.refs) supply every asset-derived
// Picture; the shot's previz files supply the NEW references that are not assets — frame 0 as the
// H3 Image input for the hi-res first frame, and the playblast mp4 as the <Video 1> cut/pacing
// conditioning. Pure module: the studio API route, the shot panel and the agent all read the same shape.
export function h3ReferenceSet(shot,previz){
  const pictures=(shot?.refs??[])
    .slice()
    .sort((a,b)=>a.picture_index-b.picture_index)
    .map((ref)=>({kind:'picture',picture_index:ref.picture_index,role:ref.role,asset_id:ref.asset_id,...(ref.file_key?{file_key:ref.file_key}:{}),from_asset:true}));
  const extras=[];
  if(previz?.frame0)extras.push({kind:'picture',source:'previz_frame0',path:previz.frame0,label:'previz frame 0 — input for the hi-res H3 Image first frame'});
  const video=previz?.playblast?{kind:'video',video_index:1,path:previz.playblast,label:'previz playblast — <Video 1> cut and pacing structure (weak_reference)'}:null;
  return {shot_id:shot?.id??'',pictures,extras,video};
}
// Compact human/agent-readable block listing the full reference set for one shot.
export function h3ReferenceText(set){
  const lines=[];
  for(const p of set.pictures)lines.push(`Picture ${p.picture_index} — ${p.role} ${p.asset_id}${p.file_key?` (file ${p.file_key})`:' (default master)'}`);
  for(const e of set.extras)lines.push(`Picture candidate — ${e.path} [${e.label}]`);
  if(set.video)lines.push(`Video 1 — ${set.video.path} [${set.video.label}]`);
  if(!lines.length)lines.push('Nothing cast and no previz rendered yet — use Edit materials to cast assets, then render a playblast.');
  return lines.join('\n');
}
// Starter scene from the shot's cast: one actor entry per casted actor/costume asset (deduped),
// one box prop per scene/prop asset, camera defaults matching the shot duration. The agent (or human)
// edits the JSON from here — the point is the ids already line up with the shot's asset list.
const PALETTE=['#a04636','#c8bfae','#4a7fa0','#67a04a','#b58a3c','#8a5fa0'];
export function seedScene(shot){
  const duration_s=Number(shot.duration_s)||6;
  const refs=Array.isArray(shot.refs)?shot.refs:[];
  const actors=[],seenActor=new Set();
  for(const ref of refs){
    if(ref.role!=='actor'&&ref.role!=='costume')continue;
    if(seenActor.has(ref.asset_id))continue;
    seenActor.add(ref.asset_id);
    actors.push({id:seedId(ref.asset_id),shape:'biped',color:PALETTE[(actors.length%PALETTE.length)],scale:1.8,keys:[{t:0,pos:[actors.length*1.6-seenActor.size*0.8,0,0]}]});
  }
  if(!actors.length)actors.push({id:'actor',shape:'biped',color:PALETTE[0],scale:1.8,keys:[{t:0,pos:[0,0,0]}]});
  const props=[],seenProp=new Set();
  for(const ref of refs){
    if(ref.role!=='prop'&&ref.role!=='scene')continue;
    if(seenProp.has(ref.asset_id))continue;
    seenProp.add(ref.asset_id);
    props.push({id:seedId(ref.asset_id),shape:'box',color:'#39485e',size:[1.5,1.5,1.5],pos:[3+props.length*2,0.75,-2]});
  }
  return {shot_id:shot.id??'',title:shot.title??'',duration_s,fps:24,width:1280,height:720,
    camera:{fov:40,keys:[{t:0,pos:[0,1.6,6],look:[0,1,0]},{t:duration_s,pos:[-2,1.4,4.5],look:[0,1,0]}]},
    actors,props};
}
function seedId(assetId){return String(assetId??'asset').trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'')||'asset';}
