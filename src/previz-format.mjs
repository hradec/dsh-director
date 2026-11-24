// Previz scene format — the single source of truth for a shot's animated previsualization.
// A scene is a hand-editable JSON document: actors ride keyframed world paths, the camera
// rides a keyframed path (pos/look/fov), cuts are hard discontinuities flagged on keys.
// Everything the toolchain needs (playblast frames, camera wording, first/last stills)
// samples THIS module — the mp4 and the prompt text can never disagree with the preview.
// Pure data + math: no fs, no DOM, so the agent tools, the studio tab and the standalone
// HTML player all import the same semantics.

export const SCENE_VERSION=1;

// Smootherstep easing between keys: C2 continuous, so the playblast never snaps,
// yet each key lands exactly where the author wrote it. ponytail: per-segment ease,
// not global spline — upgrade path is Catmull-Rom if authors ever demand overshoot.
const ease=(u)=>u*u*u*(u*(u*6-15)+10);
const lerp=(a,b,t)=>a+(b-a)*t;
const lerp3=(a,b,t)=>[lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t)];

// Defaults are FILLED, never capped: no gate here limits keys, actors, durations or sizes.
export function normalizeScene(raw={}){
  const scene={
    version:SCENE_VERSION,
    shot_id:String(raw.shot_id??''),
    title:String(raw.title??''),
    notes:String(raw.notes??''),
    fps:Number(raw.fps)===raw.fps?Number(raw.fps):24,
    width:Number(raw.width)===raw.width?Number(raw.width):1280,
    height:Number(raw.height)===raw.height?Number(raw.height):720,
    palette:{sky:'#10141f',ground:'#232a38',grid:'#39445c',...(raw.palette??{})},
    camera:normalizeTrack(raw.camera??{},['pos','look'],[40]),
    actors:(raw.actors??[]).map((a)=>({...normalizeTrack(a,['pos'],[2]),
      id:String(a.id??'actor'),
      shape:String(a.shape??'poly'),
      color:String(a.color??'#c8bfae'),
      scale:Number(a.scale)===a.scale?Number(a.scale):1,
      billboard:a.billboard!==false,
      ...(Array.isArray(a.poly)?{poly:a.poly.map((p)=>[Number(p[0])||0,Number(p[1])||0])}:{})})),
    props:(raw.props??[]).map((p)=>({shape:String(p.shape??'box'),color:String(p.color??'#4a5568'),
      pos:readVec(p.pos,[0,0,0]),size:readVec(p.size,[1,1,1]),rot:Number(p.rot)===p.rot?Number(p.rot):0,
      ...(Array.isArray(p.poly)?{poly:p.poly.map((q)=>[Number(q[0])||0,Number(q[1])||0])}:{})})),
  };
  scene.duration_s=Number(raw.duration_s)===Number(raw.duration_s)?Number(raw.duration_s)
    :Math.max(timeOfLastKey(scene.camera),...scene.actors.map(timeOfLastKey),0);
  return scene;
}
function readVec(v,fallback){return Array.isArray(v)&&v.length>=3?[Number(v[0])||0,Number(v[1])||0,Number(v[2])||0]:[...fallback];}
function timeOfLastKey(track){const keys=track.keys??[];return keys.length?Number(keys[keys.length-1].t):0;}

// Keys: {t, pos, look?, fov?, ...params}; camera gets look/fov channels, actors get params.
function normalizeTrack(track,vectorChannels,scalarChannels){
  const keys=(Array.isArray(track.keys)&&track.keys.length?track.keys:[track]).map((k)=>k??{});
  const sorted=keys.map((k)=>({t:Number(k.t)===k.t?Number(k.t):0,...k})).sort((a,b)=>a.t-b.t);
  const out={fov:Number(track.fov)===track.fov?Number(track.fov):scalarChannels[0],keys:sorted.map((k)=>{
    const key={t:k.t};
    for(const c of vectorChannels)if(k[c]!==undefined)key[c]=readVec(k[c],[0,0,0]);
    for(const c of scalarChannels)if(k[c]!==undefined)key[c]=Number(k[c]);
    if(k.params)key.params={...k.params};
    if(k.rot!==undefined)key.rot=Number(k.rot);
    if(k.flip!==undefined)key.flip=Number(k.flip)===k.flip?Number(k.flip):1;
    if(k.cut)key.cut=true;
    return key;
  })};
  // A single-key track repeats forever: static camera/actor without authoring two keys.
  if(out.keys.length===1)out.keys=[{...out.keys[0],t:0},{...out.keys[0]}];
  if(out.keys.length&&out.keys[out.keys.length-1].t===out.keys[0].t)out.keys[out.keys.length-1].t=out.keys[0].t+1;
  return out;
}

// Generic key sampler over a normalized track. `vectors` names the vector channels to
// interpolate, `scalars` the numeric ones. Returns the state at time t plus the segment
// index and the cut flag of the segment ENTERED at t (a cut key hard-breaks continuity).
export function sampleTrack(track,t,vectors,scalars){
  const keys=track.keys;
  let i=0;
  while(i<keys.length-2&&keys[i+1].t<=t)i++;
  const a=keys[Math.max(0,i)],b=keys[Math.min(keys.length-1,i+1)];
  const span=b.t-a.t;
  const u=span>0?Math.min(1,Math.max(0,(t-a.t)/span)):0;
  const e=ease(u);
  const state={segment:i,cut:Boolean(b.cut)};
  for(const c of vectors){
    const av=a[c]??track[c]??[0,0,0],bv=b[c]??track[c]??[0,0,0];
    state[c]=lerp3(av,bv,e);
  }
  for(const c of scalars){
    const av=a[c]??track[c],bv=b[c]??track[c];
    if(av!==undefined||bv!==undefined)state[c]=lerp(Number(av??0),Number(bv??0),e);
  }
  state.rot=lerp(Number(a.rot??0),Number(b.rot??0),e);
  // flip is discrete (a silhouette mirror), taken from the segment's start key.
  state.flip=a.flip!==undefined?a.flip:1;
  // Hinge params (wing, legs, head…): lerp per named param found on either key, so a
  // pose authored on one key eases into the next key's pose. Missing on both = 0.
  state.params={};
  const pa=a.params??{},pb=b.params??{};
  for(const name of new Set([...Object.keys(pa),...Object.keys(pb)]))state.params[name]=lerp(Number(pa[name]??0),Number(pb[name]??0),e);
  return state;
}

// World state at time t for the whole scene — the player draws exactly this, the wording
// generator reads exactly this, and the headless frame renderer asks for frame indices.
export function sampleAt(scene,t){
  const camera=sampleTrack(scene.camera,t,['pos','look'],['fov']);
  const actors=scene.actors.map((a)=>({id:a.id,shape:a.shape,color:a.color,scale:a.scale,billboard:a.billboard,poly:a.poly,...sampleTrack(a,t,['pos'],[])}));
  return {t,camera,actors,props:scene.props};
}
export const frameTime=(scene,i)=>i/scene.fps;
export const frameCount=(scene)=>Math.round(scene.duration_s*scene.fps)+1;

// ---------------------------------------------------------------------------
// Camera + movement wording. Turns the sampled path back into the plain English
// phrases the H3 prompt needs ("slow dolly in, panning left as she turns"), so the
// generated scene follows the SAME staging the human approved. Thresholds below are
// heuristics for naming, never limits on what renders.
// ---------------------------------------------------------------------------
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const sign=(v)=>v>0?1:v<0?-1:0;

// One phrase row per camera segment: [{t0,t1,camera:"dolly in + pan left",actors:[ids moving]}].
export function cameraWording(scene){
  const rows=[];
  const keys=scene.camera.keys;
  for(let i=0;i<keys.length-1;i++){
    const a=keys[i],b=keys[i+1];
    const pa=a.pos??[0,0,0],pb=b.pos??[0,0,0];
    const la=a.look??[0,0,0],lb=b.look??[0,0,0];
    const words=[];
    const d0=dist(pa,la),d1=dist(pb,lb),moved=dist(pa,pb);
    const dy=pb[1]-pa[1];
    if(Math.abs(d1-d0)>Math.max(0.05*d0,0.02))words.push(d1<d0?'dolly in':'dolly out');
    else if(Math.abs(dy)>Math.max(0.08,0.05*moved))words.push(dy>0?'crane up':'crane down');
    else if(moved>0.05)words.push(trackPhrase(pa,pb,la,lb,scene));
    const f0=a.fov??scene.camera.fov,f1=b.fov??scene.camera.fov;
    if(f0&&f1&&Math.abs(f1-f0)>0.5)words.push(f1<f0?'zoom in':'zoom out');
    // Look-vector yaw change independent of position = a pan.
    const yaw0=Math.atan2(la[0]-pa[0],la[2]-pa[2]),yaw1=Math.atan2(lb[0]-pb[0],lb[2]-pb[2]);
    let dyaw=yaw1-yaw0;while(dyaw>Math.PI)dyaw-=2*Math.PI;while(dyaw<-Math.PI)dyaw+=2*Math.PI;
    if(Math.abs(dyaw)>0.08)words.push(`panning ${dyaw>0?'left':'right'}`);
    if(!words.length)words.push('static frame');
    const movers=scene.actors.filter((act)=>{
      const ka=(act.keys??[])[Math.min(i,(act.keys??[]).length-1)],kb=(act.keys??[])[Math.min(i+1,(act.keys??[]).length-1)];
      return ka&&kb&&dist(ka.pos??[0,0,0],kb.pos??[0,0,0])>0.02;
    }).map((act)=>act.id);
    rows.push({t0:a.t,t1:b.t,camera:words.filter(Boolean).join(' + '),actors:movers,cut:!!b.cut});
  }
  return rows;
}
// Side-to-side vs toward/away relative to where the camera is looking:
// build the camera's screen basis at segment start and project the position delta.
function trackPhrase(pa,pb,la,lb,scene){
  const fwd=[la[0]-pa[0],la[1]-pa[1],la[2]-pa[2]];
  const fl=Math.hypot(...fwd)||1;
  const f=fwd.map((v)=>v/fl);
  const up=[0,1,0];
  let right=[f[1]*up[2]-f[2]*up[1],f[2]*up[0]-f[0]*up[2],f[0]*up[1]-f[1]*up[0]];
  const rl=Math.hypot(...right)||1;right=right.map((v)=>v/rl);
  const d=[pb[0]-pa[0],pb[1]-pa[1],pb[2]-pa[2]];
  const along=d[0]*f[0]+d[1]*f[1]+d[2]*f[2];
  const side=d[0]*right[0]+d[1]*right[1]+d[2]*right[2];
  if(Math.abs(side)>=Math.abs(along))return `tracking ${side>0?'left':'right'}`;
  return along>0?'push in':'pull back';
}

// The compact block the h3-prompt-writing skill pastes into detailed_description.
export function previzPromptNotes(scene){
  const rows=cameraWording(scene);
  return rows.map((r)=>`${r.t0.toFixed(2)}–${r.t1.toFixed(2)}s: camera ${r.camera}${r.actors.length?`; ${r.actors.join(', ')} moving`:''}${r.cut?' [HARD CUT]':''}`).join('\n');
}
