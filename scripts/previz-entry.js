// Standalone previz entry — bundled by scripts/build.mjs into lib/previz-player.js (one
// minified IIFE with three + the format + the UI glue) and inlined verbatim into every
// baked .previz.html. Also hosts window.PREVIZ, the exact seek API the headless
// frame-capture driver calls, so a rendered mp4 frame and a scrubbed preview frame are
// the same sampleAt() state.
import {createStage} from '../src/client/studio/previz-player.js';
import {normalizeScene,frameCount,frameTime} from '../src/previz-format.mjs';

function boot(){
  const sceneEl=document.getElementById('previz-scene');
  const scene=normalizeScene(JSON.parse(sceneEl.textContent));
  const canvas=document.getElementById('previz-canvas');
  const stage=createStage(canvas);
  stage.setScene(scene);
  stage.resize(scene.width,scene.height);
  let t=0,playing=false,raf=0,last=0;
  const slider=document.getElementById('previz-scrub');
  slider.max=String(frameCount(scene)-1);
  const timeLabel=document.getElementById('previz-time');
  const playBtn=document.getElementById('previz-play');
  function show(){
    stage.setT(t);
    slider.value=String(Math.round(t*scene.fps));
    timeLabel.textContent=`${t.toFixed(2)}s / ${scene.duration_s.toFixed(2)}s  ·  f${Math.round(t*scene.fps)}/${frameCount(scene)-1}`;
  }
  function tick(now){
    if(!playing)return;
    if(last)t=Math.min(scene.duration_s,t+(now-last)/1000);
    last=now;
    if(t>=scene.duration_s){t=0;} // previz loops; a hard stop mid-review is worse than a wrap
    show();raf=requestAnimationFrame(tick);
  }
  slider.addEventListener('input',()=>{t=frameTime(scene,Number(slider.value));show();});
  playBtn.addEventListener('click',()=>{playing=!playing;playBtn.textContent=playing?'❚❚ Pause':'▶ Play';last=0;if(playing)raf=requestAnimationFrame(tick);else cancelAnimationFrame(raf);});
  document.title=`PREVIZ — ${scene.shot_id||'shot'} ${scene.title}`.trim();
  window.PREVIZ={
    ready:true,scene,stage,show,
    frameCount:()=>frameCount(scene),
    setFrame:(i)=>{t=frameTime(scene,i);show();},
    seek:(s)=>{t=s;show();},
  };
  show();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
