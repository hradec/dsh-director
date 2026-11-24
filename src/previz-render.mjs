// Previz playblast render — baked .previz.html → exact PNG frames → tagged mp4.
// Frame capture drives the SAME player the human watched: a tiny embedded Playwright
// (python, already installed on this box) opens the standalone file, seeks frame by
// frame through window.PREVIZ.setFrame(i), and screenshots the canvas 1:1. ffmpeg then
// encodes and — ComfyUI-style — embeds the scene JSON into the mp4 metadata so any
// playblast can be recovered back into an editable file later.
import {spawn} from 'node:child_process';
import {writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {frameCount} from './previz-format.mjs';

// Written per call to a scratch dir; the whole driver is this one small script.
const DRIVER=`
import sys,json
from playwright.sync_api import sync_playwright
html,frames_dir=sys.argv[1],sys.argv[2]
with sync_playwright() as p:
    b=p.chromium.launch(args=['--no-sandbox','--disable-gpu'])
    pg=b.new_page()
    pg.goto('file://'+html)
    pg.wait_for_function('window.PREVIZ&&window.PREVIZ.ready')
    size=pg.evaluate('()=>({w:window.PREVIZ.scene.width,h:window.PREVIZ.scene.height})')
    pg.set_viewport_size({'width':size['w'],'height':size['h']})
    # capture at exact canvas pixels: strip the player page's responsive padding/limits
    pg.add_style_tag(content='html,body{margin:0;padding:0;background:#000}#previz-canvas{max-width:none}')
    n=pg.evaluate('()=>window.PREVIZ.frameCount()')
    for i in range(n):
        pg.evaluate('i=>window.PREVIZ.setFrame(i)',i)
        pg.locator('#previz-canvas').screenshot(path=f'{frames_dir}/f{i:05d}.png')
    b.close()
print(json.dumps({'frames':n}))
`;

const run=(cmd,args)=>new Promise((done,fail)=>{
  const child=spawn(cmd,args);const out=[];
  child.stdout.on('data',(d)=>out.push(String(d)));
  child.stderr.on('data',(d)=>out.push(String(d)));
  child.on('error',fail);
  child.on('close',(code)=>code===0?done(out.join('')):fail(Error(`${cmd} exit ${code}: ${out.join('').slice(-2000)}`)));
});

// Render one scene file into <outDir>/<stem>.previz.mp4 (+ frame0 png). fps/size come
// from the scene itself; overrides pass through untouched — no clamping here.
export async function renderPlayblast({html,outDir,scene}){
  mkdirSync(outDir,{recursive:true});
  const scratch=join(tmpdir(),`previz-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(scratch,'frames'),{recursive:true});
  const driver=join(scratch,'driver.py');
  writeFileSync(driver,DRIVER);
  await run('python3',[driver,html,join(scratch,'frames')]);
  const fps=scene.fps;
  const mp4=join(outDir,stemOf(html)+'.previz.mp4');
  const frame0=join(outDir,stemOf(html)+'.frame0.png');
  // use_metadata_tags makes ffmpeg write the custom key as a real mdta atom ffprobe can read.
  await run('ffmpeg',['-y','-framerate',String(fps),'-i',join(scratch,'frames','f%05d.png'),
    '-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart+use_metadata_tags',
    '-metadata',`previz=${JSON.stringify(scene)}`,mp4]);
  await run('ffmpeg',['-y','-i',mp4,'-frames:v','1',frame0]);
  rmSync(scratch,{recursive:true,force:true});
  return {mp4,frame0,frames:frameCount(scene)};
}

// Recover the embedded scene from any previz mp4 (the ComfyUI "open the PNG's workflow" moment).
export async function extractSceneFromMp4(mp4){
  const jsonOut=await run('ffprobe',['-v','quiet','-print_format','json','-show_format',mp4]);
  const tags=JSON.parse(jsonOut)?.format?.tags??{};
  const raw=tags.previz??tags.PREVIZ;
  if(!raw)throw Error(`No embedded previz scene in ${mp4} — was it rendered by previz-render?`);
  return JSON.parse(raw);
}

const stemOf=(file)=>file.split('/').pop().replace(/\.previz\.html$/,'').replace(/\.html$/,'');

// In-process job registry for the studio-api: start() returns immediately, status() polls.
// ponytail: state lives in this server process; a harness restart drops finished rows —
// the mp4s on disk remain the truth.
export function createPrevizRenderJobs(){
  const jobs=new Map();
  return {
    start({html,outDir,scene}){
      const id=`previz-${Date.now().toString(36)}-${jobs.size}`;
      const job={id,status:'running',started_at:new Date().toISOString(),result:null,error:null};
      jobs.set(id,job);
      renderPlayblast({html,outDir,scene}).then(
        (result)=>{job.result=result;job.status='done';job.finished_at=new Date().toISOString();},
        (error)=>{job.error=String(error?.message??error);job.status='failed';job.finished_at=new Date().toISOString();},
      );
      return job;
    },
    status(id){return jobs.get(id)??null;},
    list(){return [...jobs.values()];},
  };
}
