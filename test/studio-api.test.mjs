import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {realpathSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve as pathResolve,basename} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createStudioRegistry,createStudioStore} from '../src/studio-store.mjs';
import {createStudioApiHandler} from '../src/studio-api.mjs';
import {createStudioTools} from '../src/studio-tools.mjs';

const png=Buffer.from('89504e470d0a1a0a00000000','hex');
// The DSH session workspace folder IS the project; tests resolve every session id to one temporary workspace.
async function setup(t,{reject,fetchImpl,sessionIndex,agentTasks}={}){
  const root=await mkdtemp(join(tmpdir(),'dsh-studio-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const registry=createStudioRegistry();const server=createServer(createStudioApiHandler({resolveSession:()=>registry(root),requestRejection:()=>reject,comfyHosts:()=>['http://comfy.test'],sessionIndex:sessionIndex??(()=>[]),agentTasks:agentTasks??createFakeAgentQueue(),fetchImpl:fetchImpl??(async()=>new Response('{}'))}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {store,project}=await registry(root);
  return {store,project,root,base:`http://127.0.0.1:${server.address().port}/director-studio`};
}
const json=(base,path,init={})=>fetch(base+path,{...init,headers:{'content-type':'application/json','x-director-session':'session-a',...init.headers}});
// In-memory DSH queue for tests: submitJob runs the job promise immediately;
// latest() serves job-status polling. Mirrors agent-task.mjs semantics.
function createFakeAgentQueue(){
  const rows=[];let n=0;
  return {
    async submit(){throw Error('agents not wired in tests');},
    async submitJob({label,run,meta}){
      const t={id:'j-'+(++n),label,kind:'job',status:'pending',progress:null,meta:meta??null,result:null};
      rows.push(t);
      (async()=>{t.status='running';try{const r=await run((p)=>{t.progress=p;});t.result=(r&&r.detail)||'done';t.status=r&&r.ok===false?'failed':'done';}catch(e){t.status='failed';t.result=String(e&&e.message||e);}})();
      return {id:t.id,label:t.label,kind:'job',status:t.status,progress:null};
    },
    latest(meta){for(let i=rows.length-1;i>=0;i--){const t=rows[i];if(t.meta&&Object.entries(meta).every(([k,v])=>t.meta[k]===v))return {id:t.id,label:t.label,kind:t.kind,status:t.status,progress:t.progress??null,result:t.result};}return null;},
    list(){return rows;},cancel(){return null;},
  };
}
async function waitJob(base,ed,kind){for(let i=0;i<200;i++){const st=await (await json(base,`/api/editing/${ed}/job-status?kind=${kind}`)).json();if(st.task&&st.task.status!=='pending'&&st.task.status!=='running')return st.task;await new Promise((r)=>setTimeout(r,50));}throw new Error('job timeout: '+kind);}

test('timeline board routes serve sequences, arc tags and story episodes for the Timeline tab',async t=>{
  const {base,store,project}=await setup(t);
  const episode=await (await json(base,'/api/story/episode',{method:'POST',body:JSON.stringify({title:'Pilot',season:1,order:1})})).json();
  const sequence=await (await json(base,'/api/library/sequence',{method:'POST',body:JSON.stringify({name:'Cold open',episode_id:episode.id,order:1})})).json();
  const shot=await store.saveShot(project.id,{title:'S01',sequence_id:sequence.id,arcs:['arc1']});
  const board=await (await json(base,'/api/library/timeline')).json();
  assert.equal(board.sequences[0].name,'Cold open');assert.equal(board.shots[0].title,'S01');assert.deepEqual(board.shots[0].arcs,['arc1']);
  assert.equal(board.clips[shot.id],null);assert.deepEqual(board.takes,[]);assert.equal(board.episodes[0].title,'Pilot');
  const moved=await (await json(base,`/api/shots/${shot.id}`,{method:'PATCH',body:JSON.stringify({sequence_id:sequence.id,arcs:['arc2','arc2'],duration_s:7.5})})).json();
  assert.deepEqual(moved.arcs,['arc2']);assert.equal(moved.duration_s,7.5);
  const removed=await json(base,`/api/library/sequence/${sequence.id}`,{method:'DELETE'});assert.equal(removed.status,200);
  assert.equal((await store.getShot(shot.id)).sequence_id,'');
});

test('footage routes: auto-library, play urls, single add, recursive folder import, tag, group create/delete',async t=>{
  const {base,root,store,project}=await setup(t);
  await store.saveAsset({kind:'actors',name:'Nelare',project_id:project.id,filename:'sheet.png',bytes:png});
  const mp4=Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.from('major')]);
  await store.saveAsset({kind:'layouts',name:'Flight',project_id:project.id,filename:'fly.mp4',bytes:mp4});
  let board=await (await json(base,'/api/footage')).json();
  assert.deepEqual(board.files.map(f=>f.path),['flight/fly.mp4'],'asset videos auto-land in the footage library');
  assert.ok(board.files[0].url.startsWith('/director-studio/api/file?path='),'browser-reachable play url');
  assert.ok(board.assets.some(a=>a.name==='Nelare'));
  assert.ok(!board.assets.some(a=>a.name==='Flight'),'layout/clip assets stay in Production, never as Footage groups');
  assert.equal((await json(base,'/api/footage/group',{method:'POST',body:JSON.stringify({name:'chicken'})})).status,200);
  const ungroup=await (await json(base,'/api/footage/group',{method:'DELETE',body:JSON.stringify({name:'chicken'})})).json();
  assert.deepEqual(ungroup.groups,[]);
  const ordered=await (await json(base,'/api/footage/order',{method:'PUT',body:JSON.stringify({order:['g:chicken','a:Nelare','other','zz extra']})})).json();
  assert.deepEqual(ordered.order,['g:chicken','a:Nelare','other','zz extra'],'the drag-reordered layout round-trips');
  assert.deepEqual((await (await json(base,'/api/footage')).json()).order,['g:chicken','a:Nelare','other','zz extra'],'stored order reaches the Footage board payload');
  const opened=await (await json(base,'/api/footage/open',{method:'PUT',body:JSON.stringify({id:'a:Nelare',expanded:true})})).json();
  assert.equal(opened.open['a:Nelare'],true);
  assert.equal((await (await json(base,'/api/footage')).json()).open['a:Nelare'],true,'expand state survives to the next board load');
  const closed=await (await json(base,'/api/footage/open',{method:'PUT',body:JSON.stringify({id:'a:Nelare',expanded:false})})).json();
  assert.ok(!('a:Nelare' in closed.open),'collapse returns the group to the default state');
  // Deletion = OS trash (XDG): file lands in Trash/files with a .trashinfo, vanishes from media/ and footage.json; missing paths report, never throw.
  process.env.XDG_DATA_HOME=join(root,'trash-home');
  await mkdir(join(root,'media'),{recursive:true});await writeFile(join(root,'media','gone.mp4'),mp4);
  await json(base,'/api/footage',{method:'POST',body:JSON.stringify({path:'gone.mp4'})});
  const del=await (await json(base,'/api/footage/delete',{method:'POST',body:JSON.stringify({paths:['gone.mp4','never-was.mp4']})})).json();
  assert.equal(del.results[0].path,'gone.mp4');assert.ok(String(del.results[0].trashed_to).includes('trash-home/Trash/files/gone.mp4'));
  await stat(del.results[0].trashed_to);
  const info=await readFile(join(root,'trash-home','Trash','info','gone.mp4.trashinfo'),'utf8');
  assert.ok(info.includes('Path=')&&info.includes('gone.mp4')&&info.includes('DeleteTime='),'trashinfo keeps the original path for restore');
  await stat(join(root,'media','gone.mp4')).then(()=>assert.fail('file still in media/'),()=>{});
  assert.ok(!(await store.footageList()).files.some((f)=>f.path==='gone.mp4'),'footage.json entry removed too');
  assert.match(del.results[1].error,/not found/i,'missing file reports, batch continues');
  const tagged=await (await json(base,'/api/footage/refs',{method:'PUT',body:JSON.stringify({path:'flight/fly.mp4',tags_add:['nelare','flying']})})).json();
  assert.deepEqual(tagged.tags.slice().sort(),['flight','flying','nelare']);
  assert.ok(board.files[0].mtime>0,'file mtimes reach the client for [last hour]-style filters');
  const nelareGroup=(await (await json(base,'/api/footage')).json()).assets.find((a)=>a.name==='Nelare');
  assert.ok(nelareGroup.id&&nelareGroup.kind==='actors','asset groups carry kind+id (agents delete via the library API, never from Footage)');
  assert.equal((await json(base,`/api/library/actors/${nelareGroup.id}`,{method:'DELETE'})).status,200);
  const afterDelete=await (await json(base,'/api/footage')).json();
  assert.ok(!afterDelete.assets.some((a)=>a.name==='Nelare'));
  assert.ok(afterDelete.files.some((f)=>f.path==='flight/fly.mp4'),'asset deletion never removes media/ clips');
  await writeFile(join(root,'outside.mp4'),Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.from('outside-clip')]));
  const added=await (await json(base,'/api/footage',{method:'POST',body:JSON.stringify({path:'outside.mp4',tags:['extra']})})).json();
  assert.equal(added.path,'outside.mp4');
  const dup=await (await json(base,'/api/footage',{method:'POST',body:JSON.stringify({path:'outside.mp4'})})).json();
  assert.equal(dup.skipped,'same bytes');
  await mkdir(join(root,'episodes','episode1'),{recursive:true});
  await writeFile(join(root,'episodes','episode1','c1.mp4'),Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.from('crowd')]));
  const folder=await (await json(base,'/api/footage/folder',{method:'POST',body:JSON.stringify({path:'episodes',tags:['speardrive-episode-1']})})).json();
  assert.equal(folder.added,1);
  board=await (await json(base,'/api/footage')).json();
  assert.ok(board.files.some(f=>f.path==='episodes/episode1/c1.mp4'&&f.tags.includes('speardrive-episode-1')),'recursive import mirrors the tree');
});

test('footage smart filter: unset endpoint answers 400; configured LLM paths are validated against the catalog',async t=>{
  const {base,root,store}=await setup(t,{fetchImpl:async(url,init)=>{
    if(String(url)==='http://llm.test/v1/chat/completions')return new Response(JSON.stringify({choices:[{message:{content:`["fire.mp4","ghost-not-in-catalog.mp4"]`}}]}),{headers:{'content-type':'application/json'}});
    return new Response('{}',{status:500});
  }});
  await writeFile(join(root,'fire.mp4'),Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.from('flames')]));
  await store.addFootage({path:'fire.mp4',tags:['fire','night']});
  assert.equal((await json(base,'/api/footage/smart',{method:'POST',body:JSON.stringify({query:'burning at night'})})).status,400,'no smart url configured → actionable 400');
  await json(base,'/api/library/app-settings',{method:'PUT',body:JSON.stringify({smart:{url:'http://llm.test/v1',model:'tester'}})});
  const out=await (await json(base,'/api/footage/smart',{method:'POST',body:JSON.stringify({query:'burning at night'})})).json();
  assert.deepEqual(out.paths,['fire.mp4'],'hallucinated paths are dropped');
});

test('footage tag-ai: the model WATCHES a preview clip; with no session model the endpoint qwen is chosen',async t=>{
  const seen=[];
  const {base,root,store}=await setup(t,{fetchImpl:async(url,init)=>{
    if(String(url)==='http://llm.test/v1/models')return new Response(JSON.stringify({data:[{id:'deepseek-flash'},{id:'qwen3.8-flash-next-iq3_s'}]}),{headers:{'content-type':'application/json'}});
    if(String(url)==='http://llm.test/v1/chat/completions'){seen.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:'["nelare","flying","night sky","crowd"]'}}]}),{headers:{'content-type':'application/json'}});}
    return new Response('{}',{status:500});
  }});
  const clip=join(root,'tagme.mp4');
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=red:s=64x64:d=1:r=10','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',clip]);
  await store.addFootage({path:'tagme.mp4'});
  await json(base,'/api/footage/group',{method:'POST',body:JSON.stringify({name:'crowd'})});
  await json(base,'/api/library/app-settings',{method:'PUT',body:JSON.stringify({smart:{url:'http://llm.test/v1'}})});
  const out=await (await json(base,'/api/footage/tag-ai',{method:'POST',body:JSON.stringify({path:'tagme.mp4'})})).json();
  assert.equal(out.model,'qwen3.8-flash-next-iq3_s','no session model on the test route → the endpoint qwen is used');
  const call=seen[0];
  assert.equal(call.messages[0].content[1].type,'video_url','the clip travels as a native video part, not a frame strip');
  assert.ok(call.messages[0].content[1].video_url.url.startsWith('data:video/mp4;base64,')&&call.messages[0].content[1].video_url.url.length>100,'a real preview body was sent');
  assert.match(call.messages[0].content[0].text,/Library groups \(collapsibles\): \[[^\]]*"crowd"/,'every group name is offered to the tagger so all [] collapsibles update together');
  assert.ok(out.tags.includes('crowd'),'the group tag lands — the clip joins the collapsible group');
  assert.equal(out.resolution,'480p');assert.ok(out.tags.includes('480p'),'the REAL file height is probed, not guessed from the 480p preview');
});

test('temporary [job …] request-references placeholders are garbage-collected when the store opens',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-gc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const scratch=join(root,'scratch.png');await writeFile(scratch,png);
  const seed={version:1,projects:[],assets:[
    {id:'a1',kind:'layouts',name:'[job j1] request references',job_id:'j1',files:{front:scratch},project_id:null,meta:{temporary_job_refs:true}},
    {id:'a2',kind:'actors',name:'Nelare',files:{},project_id:null}],
    shots:[],files:[{id:'f1',kind:'layouts',filename:'scratch.png',path:scratch,type:'image',mime:'image/png',size:png.length,sha256:'',created_at:'',key:'front'}],
    jobs:[{id:'j1',kind:'actors',status:'queued',ref_asset_id:'a1',created_at:'',updated_at:''}],sequences:[],takes:[]};
  await writeFile(join(root,'studio.json'),JSON.stringify(seed));
  const store=createStudioStore({root,workspaceRoot:root});
  assert.deepEqual((await store.listAssets({include_unassigned:true})).map((a)=>a.name),['Nelare'],'queued-zombie request scratch is gone on open');
  await assert.rejects(stat(scratch),{code:'ENOENT'},'its staged file was unlinked too');
  const jobs=await store.listGenerationJobs({});
  assert.equal(jobs[0].ref_asset_id,null,'the dead job no longer points at a deleted asset');
});

test('footage open-in-comfyui: embedded SaveVideo metadata detected; probe, extraction, upload into the first answering comfy host',async t=>{
  const {base,root}=await setup(t);   // comfyHosts()=[http://comfy.test]; default stub fetch answers ok everywhere
  await mkdir(join(root,'media'),{recursive:true});
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=red:s=64x64:d=0.2:r=10','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+use_metadata_tags','-metadata','prompt={"1":{"class_type":"KSampler","inputs":{}}}',join(root,'media','wfdemo.mp4')]);
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:d=0.2:r=10','-c:v','libx264','-pix_fmt','yuv420p',join(root,'media','nowfdemo.mp4')]);
  assert.equal((await (await json(base,'/api/footage/comfy',{method:'POST',body:JSON.stringify({path:'wfdemo.mp4',probe:true})})).json()).has,true,'embedded prompt tag detected');
  assert.equal((await (await json(base,'/api/footage/comfy',{method:'POST',body:JSON.stringify({path:'nowfdemo.mp4',probe:true})})).json()).has,false,'plain video stays greyed out in the menu');
  const v=await (await json(base,'/api/footage/comfy',{method:'POST',body:JSON.stringify({path:'wfdemo.mp4'})})).json();
  assert.equal(v.kind,'prompt');assert.ok(v.json.includes('KSampler'));assert.equal(v.host,'http://comfy.test');assert.equal(v.uploaded,'workflows/dsh/wfdemo.json');
  assert.ok(v.ui,'stub object_info still yields a UI-format conversion');
  const ui=JSON.parse(v.ui);
  assert.ok(Array.isArray(ui.nodes)&&Array.isArray(ui.links)&&ui.nodes.some((node)=>node.widgets_values!==undefined),'editor-format clipboard payload');
  assert.equal((await json(base,'/api/footage/comfy',{method:'POST',body:JSON.stringify({path:'../../etc/passwd'})})).status,404,'containment enforced');
});

test('images library (0.2.57): PNG import, tag, group, comfy tEXt probe/extraction, delete to OS trash',async t=>{
  const {base,root}=await setup(t);
  const trash=join(root,'trash-home');process.env.XDG_DATA_HOME=trash;t.after(()=>{delete process.env.XDG_DATA_HOME;});
  // ComfyUI SaveImage embeds the graph as PNG tEXt chunks; inject one the same way (ffprobe cannot see these).
  const crc32=buf=>{let crc=0xFFFFFFFF;for(const b of buf){crc^=b;for(let k=0;k<8;k++)crc=crc&1?0xEDB88329^(crc>>>1):crc>>>1;}return (crc^0xFFFFFFFF)>>>0;};
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=green:s=64x64:d=1','-frames:v','1',join(root,'demo.png')]);
  const png=readFileSync(join(root,'demo.png')),text=Buffer.from('prompt\0'+JSON.stringify({12:{class_type:'KSampler',inputs:{}}})),head=Buffer.concat([Buffer.from('tEXt'),text]);
  const len=Buffer.alloc(4);len.writeUInt32BE(text.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(head));
  writeFileSync(join(root,'demo.png'),Buffer.concat([png.subarray(0,33),len,head,crc,png.subarray(33)]));
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:d=0.2:r=10','-c:v','libx264','-pix_fmt','yuv420p',join(root,'clip.mp4')]);
  assert.equal((await json(base,'/api/images',{method:'POST',body:JSON.stringify({path:'demo.png',tags:['nelare']})})).status,201,'png accepted');
  assert.equal((await json(base,'/api/images',{method:'POST',body:JSON.stringify({path:'clip.mp4'})})).status,400,'video rejected from the images library');
  const list=await (await json(base,'/api/images')).json();
  assert.deepEqual(list.files.map(f=>f.path),['demo.png']);assert.equal(list.files[0].thumb,null,'images serve their own bytes as thumbnail');
  assert.equal((await (await json(base,'/api/images/comfy',{method:'POST',body:JSON.stringify({path:'demo.png',probe:true})})).json()).has,true,'embedded tEXt prompt chunk detected');
  const v=await (await json(base,'/api/images/comfy',{method:'POST',body:JSON.stringify({path:'demo.png'})})).json();
  assert.equal(v.kind,'prompt');assert.ok(v.json.includes('KSampler'));assert.equal(v.host,'http://comfy.test');assert.equal(v.uploaded,'workflows/dsh/demo.json');
  assert.equal((await json(base,'/api/images/group',{method:'POST',body:JSON.stringify({name:'Episode 1'})})).status,200,'group created');
  assert.equal((await (await json(base,'/api/images/refs',{method:'PUT',body:JSON.stringify({path:'demo.png',tags_add:['episode-1']})})).json()).tags.join(','),'nelare,episode-1','tags overlay');
  assert.equal((await json(base,'/api/images/refs',{method:'PUT',body:JSON.stringify({path:'../../etc/passwd',tags_add:['x']})})).status,404,'containment enforced');
  const del=await (await json(base,'/api/images/delete',{method:'POST',body:JSON.stringify({paths:['demo.png']})})).json();
  assert.equal(del.results[0].path,'demo.png');assert.ok(del.results[0].trashed_to.includes('trash-home/Trash/files/demo.png'),'image went to the OS trash');
  assert.equal(readdirSync(join(trash,'Trash','files')).includes('demo.png'),true);
  assert.deepEqual((await (await json(base,'/api/images')).json()).files,[],'catalog empty after delete');
});

test('library refs by tag (0.2.58): library files tagged with the asset name join the asset; approved wins over brainstorming',async t=>{
  const {base,root,project}=await setup(t);
  const form=new FormData();form.set('kind','actors');form.set('name','Widgeon');form.set('project_id',project.id);form.set('file',new Blob([png],{type:'image/png'}),'widgeon.png');
  const created=await fetch(`${base}/api/library/import`,{method:'POST',headers:{'x-director-session':'session-a'},body:form});assert.equal(created.status,201);const asset=await created.json();
  const form2=new FormData();form2.set('kind','actors');form2.set('name','Mira');form2.set('project_id',project.id);form2.set('file',new Blob([png],{type:'image/png'}),'mira.png');
  assert.equal((await fetch(`${base}/api/library/import`,{method:'POST',headers:{'x-director-session':'session-a'},body:form2})).status,201);
  await writeFile(join(root,'widge-hero.png'),png);await writeFile(join(root,'widge-study.png'),Buffer.concat([png,Buffer.from('study')]));await writeFile(join(root,'widge-plain.png'),Buffer.concat([png,Buffer.from('plain')]));// distinct bytes — the library dedupes identical files by design
  assert.equal((await json(base,'/api/images',{method:'POST',body:JSON.stringify({path:'widge-hero.png',tags:['widgeon','approved','body']})})).status,201);
  assert.equal((await json(base,'/api/images',{method:'POST',body:JSON.stringify({path:'widge-study.png',tags:['widgeon','brainstorming']})})).status,201);
  assert.equal((await json(base,'/api/images',{method:'POST',body:JSON.stringify({path:'widge-plain.png',tags:['widgeon']})})).status,201);
  const list=await (await json(base,'/api/library?kind=actors')).json();
  const widgeon=list.find(item=>item.id===asset.id),mira=list.find(item=>item.name==='Mira');
  assert.deepEqual(widgeon.library_refs.map(r=>r.path),['widge-hero.png','widge-study.png'],'approved first, both linked by the name tag');
  assert.equal(widgeon.library_refs[0].approved,true);assert.ok(widgeon.library_refs[0].tags.includes('body'));assert.ok(widgeon.library_refs[0].url.includes('/api/file?path='+encodeURIComponent(join(root,'images','widge-hero.png'))),'Assets board gets a playable url at the true library path');
  assert.equal(widgeon.library_refs[1].approved,false);assert.equal(widgeon.library_refs[1].brainstorming,true);
  assert.deepEqual(mira.library_refs,[],'untagged library files connect to nothing');
  assert.ok(!widgeon.library_refs.some(r=>r.path==='widge-plain.png'),'asset-name tag alone groups in the tab but does not link the board — needs approved or brainstorming');
});

test('footage playback: suffix Range 206, moov-at-end served faststart, ffmpeg poster thumb',async t=>{
  const {base,root}=await setup(t);
  await mkdir(join(root,'media','ep1'),{recursive:true});
  // Real one-second h264 clips; default mp4 muxing puts moov at the END — exactly what makes browser tiles black and players stall.
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=red:s=64x64:d=1:r=10','-c:v','libx264','-pix_fmt','yuv420p',join(root,'media','ep1','late.mp4')]);
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:d=1:r=10','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',join(root,'media','ep1','fast.mp4')]);
  const lateAbs=encodeURIComponent(join(root,'media','ep1','late.mp4')),fastAbs=encodeURIComponent(join(root,'media','ep1','fast.mp4'));
  const suffix=await fetch(`${base}/api/file?path=${fastAbs}&session=session-a`,{headers:{range:'bytes=-100'}});
  assert.equal(suffix.status,206);
  const fastSize=(await stat(join(root,'media','ep1','fast.mp4'))).size;
  assert.equal(suffix.headers.get('content-range'),`bytes ${fastSize-100}-${fastSize-1}/${fastSize}`);
  assert.equal((await suffix.arrayBuffer()).byteLength,100);
  const remuxed=Buffer.from(await (await fetch(`${base}/api/file?path=${lateAbs}&session=session-a`)).arrayBuffer());
  assert.ok(remuxed.indexOf('moov')>=0&&remuxed.indexOf('mdat')>=0&&remuxed.indexOf('moov')<remuxed.indexOf('mdat'),'moov-at-end served as faststart remux');
  assert.ok(readdirSync(join(root,'.director-studio','transcode-cache')).some(n=>n.includes('late.mp4.faststart.mp4')),'remux cache lives in the workspace (.director-studio), never RAM /tmp');
  const thumbUrl=`${base}/api/footage/thumb?path=${lateAbs}&session=session-a`;
  const first=await fetch(thumbUrl);
  assert.equal(first.status,200);assert.equal(first.headers.get('content-type'),'image/jpeg');
  assert.equal(Buffer.from(await first.arrayBuffer()).subarray(0,3).toString('hex'),'ffd8ff','jpeg magic');
  assert.equal((await fetch(thumbUrl)).status,200,'second call served from cache');
  const board=await (await json(base,'/api/footage')).json();
  assert.ok(board.files.find(f=>f.path==='ep1/late.mp4')?.thumb?.startsWith('/director-studio/api/footage/thumb?path='),'listing exposes per-file poster url');
  await writeFile(join(root,'media','ep1','empty.mp4'),Buffer.alloc(0));
  const board2=await (await json(base,'/api/footage')).json();
  const zero=board2.files.find(f=>f.path==='ep1/empty.mp4');
  assert.equal(zero?.size,0);assert.equal(zero?.empty,true);assert.equal(zero?.thumb,null,'0-byte clip: flagged, no poster request');
});

test('story wall routes round-trip decisions, drag rules and chronology lint',async t=>{
  const {base}=await setup(t);
  const logged=await (await json(base,'/api/story/decision',{method:'POST',body:JSON.stringify({handle:'Catten dies in act 1',kind:'decided',arc:'Act 1',body:'ngokang kills him'})})).json();
  assert.equal(logged.kind,'decided');
  const canon=await (await json(base,'/api/story/decision',{method:'POST',body:JSON.stringify({handle:'Founded Y31',kind:'canon'})})).json();
  const refuse=await json(base,`/api/story/decision/${canon.id}`,{method:'PATCH',body:JSON.stringify({kind:'decided'})});
  assert.equal(refuse.status,400);assert.match((await refuse.json()).detail,/immutable/);
  const dragged=await (await json(base,`/api/story/decision/${logged.id}`,{method:'PATCH',body:JSON.stringify({kind:'open'})})).json();
  assert.equal(dragged.kind,'open');
  await json(base,'/api/story/entity',{method:'POST',body:JSON.stringify({name:'Catten Craftsilver',legends_id:'690',birth_year:14,death_year:45})});
  const snap=await (await json(base,'/api/story')).json();
  assert.equal(snap.decisions.length,2);assert.equal(snap.entities.length,1);
  const beat=await (await json(base,'/api/story/beat',{method:'POST',body:JSON.stringify({handle:'Late feast',story_year:50,entity_ids:[snap.entities[0].id]})})).json();
  const lint=await (await json(base,'/api/story')).json();
  assert.match(lint.issues[0].detail,/died in Y45/);
  await json(base,`/api/story/beat/${beat.id}`,{method:'DELETE'});
  assert.equal((await (await json(base,'/api/story')).json()).beats.length,0);
});

test('comfy-view streams only configured hosts through the GUI origin',async t=>{
  let upstreamUrl='';
  const {base}=await setup(t,{fetchImpl:async(url,init)=>{upstreamUrl=url;return url.includes('comfy.test')?(init?.headers?.range?new Response('BY',{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-1/4','accept-ranges':'bytes'}}):new Response('BYTES',{status:200,headers:{'content-type':'video/mp4'}})):new Response('nope',{status:404})}});
  const ok=await json(base,'/api/comfy-view?host=http%3A%2F%2Fcomfy.test&filename=shot%2001.mp4&subfolder=rnd');
  assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'video/mp4');assert.equal(await ok.text(),'BYTES');
  const seek=await json(base,'/api/comfy-view?host=http%3A%2F%2Fcomfy.test&filename=shot.mp4',{headers:{range:'bytes=0-1'}});
  assert.equal(seek.status,206);assert.equal(seek.headers.get('content-range'),'bytes 0-1/4');assert.equal(await seek.text(),'BY');
  const denied=await json(base,'/api/comfy-view?host=https%3A%2F%2Fevil.example&filename=x');
  assert.equal(denied.status,400);assert.match((await denied.json()).detail,/not in the configured endpoint list/);
  // Legacy fences carry joined filenames ("nelare/ph3.png"); the upstream Comfy only serves split filename+subfolder params.
  const joined=await json(base,'/api/comfy-view?host=http%3A%2F%2Fcomfy.test&filename=nelare%2Fph3.png');
  assert.equal(joined.status,200);
  assert.match(upstreamUrl,/filename=ph3\.png&subfolder=nelare/);
});

test('file route streams local media with deny and range rules',async t=>{
  const {base,root}=await setup(t);
  await writeFile(join(root,'shot.png'),png);
  const rel=await json(base,'/api/file?path=shot.png');
  assert.equal(rel.status,200);assert.equal(rel.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await rel.arrayBuffer()),png);
  const abs=await json(base,`/api/file?path=${encodeURIComponent(join(root,'shot.png'))}`);assert.equal(abs.status,200);
  const range=await json(base,'/api/file?path=shot.png',{headers:{range:'bytes=0-3'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,4);
  const outside=await json(base,'/api/file?path=%2Fetc%2Fhostname');assert.equal(outside.status,403);
  const secret=await json(base,`/api/file?path=${encodeURIComponent(join(homedir(),'.dsh','settings.yaml.imported'))}`);assert.equal(secret.status,403);
  const nope=await json(base,'/api/file?path=missing.png');assert.equal(nope.status,404);
});

test('session-less file URLs gain roots from the session index',async t=>{
  const dir='/BACKUP/home/rhradec/.dsh/custom-plugins',file=join(dir,'studio-api-test.png');
  await writeFile(file,png);t.after(()=>rm(file,{force:true}));
  const withIndex=await setup(t,{sessionIndex:()=>[{id:'session-b',cwd:dir}]});
  const hit=await fetch(`${withIndex.base}/api/file?path=${encodeURIComponent(file)}`);
  assert.equal(hit.status,200);assert.equal(hit.headers.get('content-type'),'image/png');
  const without=await setup(t);
  const miss=await fetch(`${without.base}/api/file?path=${encodeURIComponent(file)}`);assert.equal(miss.status,403);
  const rel=await fetch(`${without.base}/api/file?path=shot.png`);assert.equal(rel.status,400);
  // A session-index root that happens to be ~/.dsh itself must still deny secret files there.
  const smuggle=await setup(t,{sessionIndex:()=>[{id:'session-c',cwd:join(realpathSync(homedir()),'.dsh')}]});
  const secret=await fetch(`${smuggle.base}/api/file?path=${encodeURIComponent(join(homedir(),'.dsh','settings.yaml.imported'))}`);
  assert.equal(secret.status,403);
});

test('the session workspace auto-creates one project and extra projects are refused',async t=>{
  const {base,project,root}=await setup(t);
  assert.equal(project.name,basename(root));
  const created=await json(base,'/api/projects',{method:'POST',body:JSON.stringify({name:'Short film'})});assert.equal(created.status,409);
  const listed=await json(base,'/api/projects');assert.deepEqual((await listed.json()).map(item=>item.id),[project.id]);
  const detail=await (await json(base,`/api/projects/${project.id}`)).json();assert.equal(detail.project.id,project.id);assert.equal(detail.project.assets,undefined);assert.equal(JSON.stringify(detail).includes('/media/'),false);
  const missing=await json(base,`/api/projects/${'f'.repeat(36)}`);assert.equal(missing.status,404);assert.match((await missing.json()).detail,/session workspace project/);
});

test('requests without a session identity are rejected',async t=>{
  const {base}=await setup(t);const response=await fetch(base+'/api/projects');assert.equal(response.status,400);
});

test('Production stores uploaded and prior-shot videos as validated continuation sources',async t=>{
  const {base,store,project}=await setup(t);
  const first=await store.saveShot(project.id,{title:'First'}),next=await store.saveShot(project.id,{title:'Next'});
  const mp4=Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(8)]);
  const upload=new FormData();upload.set('file',new Blob([mp4],{type:'video/mp4'}),'walk.mp4');
  const uploaded=await fetch(`${base}/api/projects/${project.id}/video-context/uploads`,{method:'POST',headers:{'x-director-session':'session-a'},body:upload});assert.equal(uploaded.status,201);const record=await uploaded.json();
  const external=await json(base,`/api/shots/${next.id}/video-context`,{method:'PUT',body:JSON.stringify({mode:'external_upload',upload_id:record.upload_id,context_frames:22,carry_audio:true})});assert.equal(external.status,200);assert.equal((await external.json()).video_context.mode,'external_upload');
  const uploadStatus=await (await json(base,`/api/shots/${next.id}/video-context`)).json();assert.equal(uploadStatus.mode,'external_upload');assert.equal(uploadStatus.carry_audio,true);
  const uploadMedia=await fetch(`${base}/api/files/library/layouts/${record.upload_id}/master`);assert.equal(uploadMedia.status,400);// <img>-style URL without a session must be refused...
  const sessionMedia=await fetch(`${base}/api/files/library/layouts/${record.upload_id}/master?session=session-a`);assert.equal(sessionMedia.status,200);assert.deepEqual(Buffer.from(await sessionMedia.arrayBuffer()),mp4);// ...while the server-issued ?session= URL plays in media tags.
  const video=await store.saveAsset({kind:'layouts',name:'First shot video',project_id:project.id,job_id:'job_first',filename:'first.mp4',bytes:mp4});await store.patchShot(first.id,{video_asset_id:video.id});
  const previous=await json(base,`/api/shots/${next.id}/video-context`,{method:'PUT',body:JSON.stringify({mode:'previous_shot',source_shot_id:first.id,context_frames:39,carry_audio:false})});assert.equal(previous.status,200);
  const previousStatus=await (await json(base,`/api/shots/${next.id}/video-context`)).json();assert.equal(previousStatus.source_job_id,'job_first');assert.equal(previousStatus.context_frames,39);
  const job=await (await json(base,'/api/h3-ref2va/jobs/job_first')).json();assert.equal(job.status,'succeeded');assert.equal(job.outputs.master.url,`/director-studio/api/files/library/layouts/${video.id}/master?session=session-a`);
  const source=await fetch(new URL(job.outputs.master.url,base));assert.equal(source.status,200);assert.deepEqual(Buffer.from(await source.arrayBuffer()),mp4);
});

test('library import verifies file type, persists bytes, and returns a session-scoped playable URL',async t=>{
  const {base,project}=await setup(t);
  const form=new FormData();form.set('kind','voices');form.set('name','Demo voice');form.set('notes','Generated with local ComfyUI');form.set('project_id',project.id);form.set('file',new Blob([png],{type:'image/png'}),'voice.wav');
  const imported=await fetch(base+'/api/library/import',{method:'POST',headers:{'x-director-session':'session-a'},body:form});assert.equal(imported.status,400);
  const form2=new FormData();form2.set('kind','actors');form2.set('name','Mira');form2.set('file',new Blob([png],{type:'image/png'}),'mira.png');
  const response=await fetch(base+'/api/library/import',{method:'POST',headers:{'x-director-session':'session-a'},body:form2});assert.equal(response.status,201);const asset=await response.json();
  assert.equal(asset.kind,'actors');assert.equal(asset.project_id,project.id);assert.equal(asset.files.master,'mira.png');assert.equal(asset.urls.master,`/director-studio/api/files/library/actors/${asset.id}/master?session=session-a`);
  const media=await fetch(new URL(asset.urls.master,base));assert.equal(media.status,200);assert.deepEqual(Buffer.from(await media.arrayBuffer()),png);
  const list=await json(base,'/api/library?kind=actors');assert.equal((await list.json()).length,1);
});

test('asset metadata updates and assignment stays inside the session workspace project',async t=>{
  const {base,store,project}=await setup(t);const asset=await store.saveAsset({kind:'props',name:'Key'});
  const patch=await json(base,`/api/library/props/${asset.id}`,{method:'PATCH',body:JSON.stringify({name:'Old key',notes:'Brass'})});assert.equal((await patch.json()).name,'Old key');
  const assign=await json(base,`/api/library/props/${asset.id}/project`,{method:'PATCH',body:JSON.stringify({project_id:project.id})});assert.equal((await assign.json()).project_id,project.id);
  const deletion=await fetch(base+`/api/library/props/${asset.id}`,{method:'DELETE',headers:{'x-director-session':'session-a'}});assert.deepEqual(await deletion.json(),{deleted:true,id:asset.id});
});

test('Production edits work but the UI cannot bypass Director review to queue generation',async t=>{
  const {base,store,project}=await setup(t);const shot=await store.saveShot(project.id,{title:'Open'});
  const update=await json(base,`/api/shots/${shot.id}`,{method:'PATCH',body:JSON.stringify({title:'Opening',duration_s:5,dialogue:['Hello']})});const changed=await update.json();assert.equal(changed.title,'Opening');assert.deepEqual(changed.dialogue,['Hello']);
  const submitted=await json(base,`/api/shots/${shot.id}/submit`,{method:'POST',body:JSON.stringify({h3_provider:'local'})});assert.equal(submitted.status,409);assert.match((await submitted.json()).detail,/confirm.*submit_comfy_job/i);
});

test('Actors studio page queues a DSH job whose refs persist and which completes when the agent imports with the job token',async t=>{
  const {base,store,project}=await setup(t);
  const form=new FormData();form.set('name','Mira');form.set('description','Professional actor casting reference');form.set('fixed_seed','false');form.set('project_id',project.id);form.set('actor_image',new Blob([png],{type:'image/png'}),'face.png');form.set('reference_image_1',new Blob([png],{type:'image/png'}),'pose.png');form.set('reference_labels',JSON.stringify({actor_image:'Face look',reference_image_1:'Armor pose'}));
  const queued=await fetch(base+'/api/actors/generate',{method:'POST',headers:{'x-director-session':'session-a'},body:form});assert.equal(queued.status,200);
  const job=await queued.json();assert.equal(job.status,'queued');assert.equal(job.name,'Mira');assert.deepEqual(Object.keys(job.input_previews).sort(),['actor_image','reference_image_1']);
  assert.equal(job.input_labels.reference_image_1,'Armor pose');assert.equal(job.input_files.actor_image,'face.png');
  const posePreview=await fetch(new URL(job.input_previews.reference_image_1,base));assert.equal(posePreview.status,200);
  const preview=await fetch(new URL(job.input_previews.actor_image,base));assert.equal(preview.status,200);assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
  assert.equal((await (await json(base,'/api/actors/jobs?limit=5')).json())[0].id,job.id);
  const blocked=await json(base,`/api/actors/jobs/${job.id}/save`,{method:'POST',body:'{}'});assert.equal(blocked.status,409);
  const imported=await store.saveAsset({kind:'actors',name:'Mira',project_id:project.id,job_id:job.id,filename:'mira.png',bytes:png,file_key:'master'});
  await store.saveAsset({kind:'actors',project_id:project.id,asset_id:imported.id,filename:'bust.png',bytes:png,file_key:'bust_threeview'});
  const done=await (await json(base,`/api/actors/jobs/${job.id}`)).json();assert.equal(done.status,'succeeded');assert.equal(done.actor_id,imported.id);assert.deepEqual(Object.keys(done.outputs).sort(),['bust_threeview','master']);
  const saved=await (await json(base,`/api/actors/jobs/${job.id}/save`,{method:'POST',body:JSON.stringify({name:'Mira V2'})})).json();assert.equal(saved.id,imported.id);assert.equal(saved.name,'Mira V2');
  const listed=await (await json(base,'/api/actors')).json();assert.deepEqual(listed.items.map(item=>item.id),[imported.id]);
  assert.equal(listed.items[0].form.description,'Professional actor casting reference');assert.equal(listed.items[0].form.fixed_seed,false);
  assert.equal(listed.items[0].form.ref_labels.actor_image,'Face look');
  assert.equal(listed.items[0].references.actor_image.filename,'face.png');assert.equal(listed.items[0].references.actor_image.label,'Face look');
  assert.match(listed.items[0].references.reference_image_1.url,/\/api\/files\/library\/layouts\/[A-Za-z0-9-]+\/reference_image_1\?session=session-a$/);
  const second=new FormData();second.set('name','Spare');second.set('project_id',project.id);
  const queuedAgain=await (await fetch(base+'/api/props/generate',{method:'POST',headers:{'x-director-session':'session-a'},body:second})).json();
  const cancelled=await (await json(base,`/api/props/jobs/${queuedAgain.id}/cancel`,{method:'POST',body:'{}'})).json();assert.equal(cancelled.status,'cancelled');
});

test('studio settings panel values feed meta defaults, job instructions, and literal newlines normalize',async t=>{
  const {base,project}=await setup(t);
  const saved=await (await json(base,'/api/library/app-settings',{method:'PUT',body:JSON.stringify({instructions:{scenes:'use turbo'},scene_defaults:{angle_prompts:'top\nbottom'},actor_defaults:{description:'sheet'},crew:{director:'no handheld cams',continuity:'track the bucket'},comfy:{urls:'http://a:8188\nhttp://b:8188'},workflows:{reference_to_video:'h3_ref2av.json'}})})).json();assert.equal(saved.instructions.scenes,'use turbo');assert.equal(saved.scene_defaults.angle_prompts,'top\nbottom');assert.equal(saved.crew.director,'no handheld cams');assert.equal(saved.crew.continuity,'track the bucket');assert.match(saved.crew.producer,/Producer of an AI film production/);assert.equal(saved.comfy.urls,'http://a:8188\nhttp://b:8188');assert.equal(saved.workflows.reference_to_video,'h3_ref2av.json');assert.equal(saved.workflows.video_edit,'');assert.equal((await (await json(base,'/api/library/app-settings')).json()).crew.cinematographer.startsWith('You are the Cinematographer'),true);
  const meta=await (await json(base,'/api/meta/scene-defaults')).json();assert.equal(meta.default_angles,'top\nbottom');
  const actor=await (await json(base,'/api/meta/actor-defaults')).json();assert.equal(actor.default_description,'sheet');
  const fd=new FormData();fd.set('name','S');fd.set('project_id',project.id);
  const queued=await (await fetch(base+'/api/scenes/generate',{method:'POST',headers:{'x-director-session':'session-a'},body:fd})).json();assert.equal(queued.generation_instructions,'use turbo');
  const fd2=new FormData();fd2.set('name','N');fd2.set('project_id',project.id);fd2.set('angle_prompts','front view\\nwide view');
  const queued2=await (await fetch(base+'/api/scenes/generate',{method:'POST',headers:{'x-director-session':'session-a'},body:fd2})).json();assert.equal(queued2.angle_prompts,'front view\nwide view');
});

test('gear panel generation settings persist and snapshot into queued jobs',async t=>{
  const {base,project}=await setup(t);
  const before=await (await json(base,'/api/library/generation-settings')).json();assert.match(before.scenes,/qwen image turbo 2\.1/);assert.match(before.actors,/Multiple-Angles-LoRA/);
  const saved=await (await json(base,'/api/library/generation-settings',{method:'PUT',body:JSON.stringify({kind:'scenes',instructions:'Use the Qwen-Edit Multiple-angles LoRA with the WWAA camera builder'})})).json();assert.equal(saved.scenes,'Use the Qwen-Edit Multiple-angles LoRA with the WWAA camera builder');
  const fd=new FormData();fd.set('name','Gears');fd.set('project_id',project.id);
  const queued=await (await fetch(base+'/api/scenes/generate',{method:'POST',headers:{'x-director-session':'session-a'},body:fd})).json();
  assert.equal(queued.generation_instructions,'Use the Qwen-Edit Multiple-angles LoRA with the WWAA camera builder');
  const listed=await (await json(base,'/api/library/generation-settings')).json();assert.equal(listed.scenes,'Use the Qwen-Edit Multiple-angles LoRA with the WWAA camera builder');
});

test('a stored asset file key can be deleted without removing the asset',async t=>{  const {base,store,project}=await setup(t);
  const asset=await store.saveAsset({kind:'scenes',name:'Del',project_id:project.id,filename:'master.png',bytes:png,file_key:'master'});
  await store.saveAsset({kind:'scenes',project_id:project.id,asset_id:asset.id,filename:'wide.png',bytes:png,file_key:'angle_01'});
  const removed=await json(base,`/api/library/scenes/${asset.id}/files/angle_01`,{method:'DELETE',body:'{}'});assert.equal(removed.status,200);
  const listed=await (await json(base,'/api/scenes')).json();assert.deepEqual(Object.keys(listed.items[0].files),['master']);
  const gone=await fetch(new URL(`/api/files/library/scenes/${asset.id}/angle_01?session=session-a`,base));assert.equal(gone.status,404);
  const again=await json(base,`/api/library/scenes/${asset.id}/files/angle_01`,{method:'DELETE',body:'{}'});assert.equal(again.status,404);
});

test('authenticated request rejection runs before data access',async t=>{
  const {base}=await setup(t,{reject:403});const response=await json(base,'/api/projects');assert.equal(response.status,403);
});

test('Director session tool manages the one workspace project, shots, and Comfy audio imports',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-studio-tool-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const audioPath=join(root,'line.wav');await writeFile(audioPath,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVE'),Buffer.alloc(8)]));
  const fs={resolve:async(path,{cwd})=>pathResolve(cwd,path),contains:(parent,path)=>path===parent||path.startsWith(parent+'/'),stat:async path=>{const info=await stat(path);return {type:info.isFile()?'file':'dir',size:info.size};},processPath:path=>path,processPathFromHostPath:path=>path};
  const registry=createStudioRegistry(),tool=createStudioTools({registry,fs}),exec={agent:{session:{header:{cwd:root}}},signal:new AbortController().signal};
  const {project}=await registry(root);assert.equal(project.name,basename(root));
  const shot=await tool.execute({action:'shot.create',title:'Opening',scene_id:'sc01',shot_type:'wide',camera_angle:'eye-level',camera_motion:'locked',composition:'Subject left third',duration_s:5,dialogue:['Come in.'],prompt_sections:{summary:'A quiet entrance.'}},exec);
  assert.equal(shot.shot.title,'Opening');assert.equal(shot.shot.duration_s,5);assert.equal(shot.shot.shot_type,'wide');
  const edited=await tool.execute({action:'shot.update',shot_id:shot.shot.id,camera_motion:'slow push',composition:'Centered subject'},exec);
  assert.equal(edited.shot.camera_motion,'slow push');assert.equal(edited.shot.composition,'Centered subject');
  const {store}=await registry(root);
  const layout=await store.saveAsset({kind:'layouts',name:'Entrance layout',project_id:project.id,filename:'layout.png',bytes:png});
  const layoutUpdate=await tool.execute({action:'shot.update',shot_id:shot.shot.id,layout_asset_id:layout.id},exec);
  assert.equal(layoutUpdate.shot.layout_asset_id,layout.id);
  const video=await store.saveAsset({kind:'layouts',name:'Approved H3',project_id:project.id,filename:'approved.mp4',bytes:Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(8)])});
  const videoUpdate=await tool.execute({action:'shot.update',shot_id:shot.shot.id,video_asset_id:video.id},exec);assert.equal(videoUpdate.shot.video_asset_id,video.id);
  const voice=await tool.execute({action:'asset.create',kind:'voices',name:'Mira voice',media_path:'line.wav'},exec);
  assert.equal(voice.stored_media,true);assert.equal((await store.listAssets({kind:'voices',project_id:project.id})).length,1);
  const assetList=await tool.execute({action:'asset.list',kind:'voices'},exec);
  assert.equal(assetList.assets[0].files[0].filename,'line.wav');assert.equal((await stat(assetList.assets[0].files[0].source_path)).isFile(),true);
  const shotList=await tool.execute({action:'shot.list'},exec);assert.equal(shotList.shots[0].prompt_sections.summary,'A quiet entrance.');assert.equal(shotList.shots[0].scene_id,'sc01');assert.equal(shotList.shots[0].shot_type,'wide');assert.equal(shotList.shots[0].camera_angle,'eye-level');assert.equal(shotList.shots[0].camera_motion,'slow push');assert.equal(shotList.shots[0].composition,'Centered subject');assert.equal(shotList.shots[0].layout_asset_id,layout.id);assert.equal(shotList.shots[0].video_asset_id,video.id);
  await assert.rejects(tool.execute({action:'asset.create',kind:'voices',name:'Outside',media_path:join(tmpdir(),'outside.wav')},exec),/inside the current DSH session workspace/);
  await assert.rejects(tool.execute({action:'project.create',project_name:'Second'}),/no workspace folder|unsupported action/);
  const listed=await tool.execute({action:'project.list'},exec);assert.deepEqual(listed.projects.map(item=>item.id),[project.id]);
});

test('director_studio configures an earlier linked video as shot continuation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-studio-continuity-tool-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const registry=createStudioRegistry(),tool=createStudioTools({registry}),exec={agent:{session:{header:{cwd:root}}}};
  const {store,project}=await registry(root);
  const source=await store.saveShot(project.id,{title:'Source'}),target=await store.saveShot(project.id,{title:'Continuation'});
  const video=await store.saveAsset({kind:'layouts',name:'Source video',project_id:project.id,job_id:'comfy_source',filename:'source.mp4',bytes:Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(8)])});
  await tool.execute({action:'shot.update',shot_id:source.id,video_asset_id:video.id},exec);
  const configured=await tool.execute({action:'shot.update',shot_id:target.id,video_context:{mode:'previous_shot',source_shot_id:source.id,context_frames:39,carry_audio:true}},exec);
  assert.equal(configured.shot.video_context.source_job_id,'comfy_source');assert.equal(configured.shot.video_context.context_frames,39);assert.equal(configured.shot.video_context.carry_audio,true);
  const listed=await tool.execute({action:'shot.list'},exec);assert.equal(listed.shots[1].video_context.source_shot_id,source.id);assert.equal(listed.shots[0].video_job_id,'comfy_source');
});

test('agent imports only Comfy output artifacts from its configured origin',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-studio-comfy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const wave=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVE'),Buffer.alloc(8)]);let downloaded;
  const registry=createStudioRegistry(),tool=createStudioTools({registry,comfyBaseUrl:'http://comfy.example:8188',fetchImpl:async(url,options)=>{downloaded={url:new URL(url),options};return new Response(wave,{headers:{'content-length':String(wave.length)}});}});
  const {store,project}=await registry(root),exec={agent:{session:{header:{cwd:root}}},signal:new AbortController().signal};
  const viewUrl='http://comfy.example:8188/view?filename=theme.wav&subfolder=director%2Fvoice&type=output';
  const imported=await tool.execute({action:'asset.create',kind:'voices',name:'Theme',job_id:'job_42',comfy_view_url:viewUrl},exec);
  assert.equal(imported.stored_media,true);assert.equal(downloaded.url.href,viewUrl);assert.equal(downloaded.options.redirect,'error');
  assert.equal(imported.asset.files[0].filename,'theme.wav');assert.equal((await stat(imported.asset.files[0].source_path)).isFile(),true);
  const saved=(await store.listAssets({kind:'voices',project_id:project.id}))[0];assert.equal(saved.job_id,'job_42');
  await assert.rejects(tool.execute({action:'asset.create',kind:'voices',name:'Wrong host',job_id:'job_43',comfy_view_url:viewUrl.replace('comfy.example','attacker.example')},exec),/configured ComfyUI origin/);
  await assert.rejects(tool.execute({action:'asset.create',kind:'voices',name:'Input file',job_id:'job_43',comfy_view_url:viewUrl.replace('type=output','type=input')},exec),/output \/view URL/);
});

// ponytail: these routes intentionally expose the stable subset used by Assets/Production first; unported managed generation endpoints return explicit errors instead of silently simulating a ComfyUI job.

test('reference routes: source folders, scan, approved/brainstorming tags, story description patch',async t=>{
  const {base,root,store,project}=await setup(t);
  const asset=await store.saveAsset({kind:'actors',name:'Nelare',project_id:project.id,filename:'sheet.png',bytes:png});
  await mkdir(join(root,'designs'),{recursive:true});
  await writeFile(join(root,'designs','roar.png'),Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(11)]));
  const attached=await (await json(base,`/api/library/actors/${asset.id}/source`,{method:'POST',body:JSON.stringify({path:'designs'})})).json();
  assert.equal(attached.added,1);
  const key=Object.keys(attached.asset.files).find(k=>k!=='master');
  const tagged=await (await json(base,`/api/library/actors/${asset.id}/refs/${key}`,{method:'PUT',body:JSON.stringify({tags_add:['approved','roaring']})})).json();
  assert.deepEqual(tagged.tags.slice().sort(),['approved','roaring']);
  const back=await (await json(base,`/api/library/actors/${asset.id}/refs/${key}`,{method:'PUT',body:JSON.stringify({tags_add:['brainstorming']})})).json();
  assert.ok(!back.tags.includes('approved'),'approval retires when the image goes back to the brainstorm pile');
  const patched=await (await json(base,`/api/library/actors/${asset.id}`,{method:'PATCH',body:JSON.stringify({description:'a dragon whose arms are wings'})})).json();
  assert.equal(patched.description,'a dragon whose arms are wings');
  const scanned=await (await json(base,`/api/library/actors/${asset.id}/scan`,{method:'POST'})).json();
  assert.equal(scanned.added,0);
  const listed=await (await json(base,'/api/library?kind=actors')).json();
  assert.equal(listed[0].description,'a dragon whose arms are wings');
  assert.ok(listed[0].ref_meta[key].tags.includes('brainstorming'));
});

test('director_studio asset.folder, asset.scan and asset.tag give the agent the same reference model',async t=>{
  const {store,project,root}=await setup(t);
  const tools=createStudioTools({registry:()=>Promise.resolve({store,project}),comfyBaseUrl:'http://comfy.test'});
  const exec={agent:{session:{header:{cwd:root}}}};
  const asset=await store.saveAsset({kind:'actors',name:'Nelare',project_id:project.id,filename:'sheet.png',bytes:png});
  await mkdir(join(root,'designs'),{recursive:true});
  await writeFile(join(root,'designs','roar.png'),Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(11)]));
  const folder=await tools.execute({action:'asset.folder',kind:'actors',asset_id:asset.id,path:join(root,'designs')},exec);
  assert.equal(folder.added,1);
  const key=folder.asset.files.map(f=>f.key).find(k=>k!=='master');
  const tagged=await tools.execute({action:'asset.tag',kind:'actors',asset_id:asset.id,file_key:key,tags_add:['roaring','frontal']},exec);
  assert.ok(tagged.ref.tags.includes('brainstorming'),'descriptive tags never retire the default pile tag');
  const approved=await tools.execute({action:'asset.tag',kind:'actors',asset_id:asset.id,file_key:key,tags_add:['approved']},exec);
  assert.ok(approved.ref.tags.includes('approved')&&!approved.ref.tags.includes('brainstorming'));
  const scanned=await tools.execute({action:'asset.scan',kind:'actors',asset_id:asset.id},exec);
  assert.equal(scanned.added,0);
});
test('agent-task door: every Director Studio DSH ask rides one server queue with waiting-task cancel',async t=>{
  const queue=[];
  const fakeTasks={async submit(input){const task={id:'task-'+(queue.length+1),status:'pending',...input};queue.push(task);return task;},
    list(){return queue.map(({prompt,...row})=>({...row,preview:String(prompt).split('\n')[0]}));},
    cancel(id){const i=queue.findIndex((row)=>row.id===id&&row.status==='pending');if(i<0)return null;queue[i].status='cancelled';return queue[i];}};
  const {base,root}=await setup(t,{agentTasks:fakeTasks});
  const created=await json(base,'/api/agent-task',{method:'POST',body:JSON.stringify({prompt:'fix the nelare notes',label:'asset Nelare \u00b7 notes'})});
  assert.equal(created.status,201);
  const task=await created.json();assert.equal(task.status,'pending');
  assert.equal((await json(base,'/api/agent-task',{method:'POST',body:JSON.stringify({})})).status,400);
  const list=await (await json(base,'/api/agent-tasks')).json();
  assert.equal(list.length,1);assert.equal(list[0].label,'asset Nelare \u00b7 notes');assert.equal(list[0].preview,'fix the nelare notes');
  const cancelled=await json(base,`/api/agent-task/${task.id}`,{method:'DELETE'});assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).status,'cancelled');
  assert.equal((await json(base,`/api/agent-task/${task.id}`,{method:'DELETE'})).status,409,'a cancelled task cannot be cancelled again');
  assert.equal(list[0].cwd,pathResolve(root),'worker runs in the session workspace, where the same Director Studio store lives');
});
test('asset character_name: separate in-story name persists through PATCH and asset.json',async t=>{
  const {base,root,store,project}=await setup(t);
  const created=await store.saveAsset({kind:'actors',name:'Mia Voss',project_id:project.id,filename:'sheet.png',bytes:png});
  const updated=await (await json(base,`/api/library/actors/${created.id}`,{method:'PATCH',body:JSON.stringify({character_name:'Nelare Dawnwhisper'})})).json();
  assert.equal(updated.character_name,'Nelare Dawnwhisper','patch returns the character name');
  const raw=JSON.parse(await readFile(join(root,'assets','mia-voss','asset.json'),'utf8'));
  assert.equal(raw.character_name,'Nelare Dawnwhisper','asset.json is the database of record for it');
  const listed=await (await json(base,'/api/library?kind=actors')).json();
  assert.equal(listed.find((a)=>a.id===created.id).character_name,'Nelare Dawnwhisper');
});

test('tag-ai on an asset reference (asset mode): vision tags land in the asset ref_meta, not the library',async t=>{
  const seen=[];
  const {base,root,store,project}=await setup(t,{fetchImpl:async(url,init)=>{
    if(String(url)==='http://llm.test/v1/chat/completions'){seen.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:'[\u0022dragon\u0022,\u0022creature\u0022,\u0022studio shot\u0022]'}}]}),{headers:{'content-type':'application/json'}});}
    return new Response('{}',{status:500});
  }});
  const a=await store.saveAsset({kind:'actors',name:'Test Dragon',project_id:project.id,filename:'master.png',bytes:png,file_key:'master'});
  await json(base,'/api/library/app-settings',{method:'PUT',body:JSON.stringify({smart:{url:'http://llm.test/v1',model:'test-llm'}})});
  const out=await (await json(base,'/api/images/tag-ai',{method:'POST',body:JSON.stringify({asset:{kind:'actors',asset_id:a.id,key:'master'}})})).json();
  assert.ok(out.tags.includes('dragon'),'tags returned');
  assert.equal(seen[0].messages[0].content[1].type,'image_url','the asset picture traveled as an image part');
  const assets=await (await json(base,'/api/library?kind=actors')).json();
  assert.ok((assets.find((v)=>v.id===a.id).ref_meta?.master?.tags??[]).includes('studio shot'),'ref_meta persisted on the asset');
});

test('comfy api→ui converter: schema widgets, hidden inputs skipped, links by slot name, layered layout',async t=>{
  const {apiToUi}=await import('../src/comfy-api-to-ui.mjs');
  const objectInfo={KSampler:{input:{required:{seed:['INT',{default:42}],steps:['INT',{default:20}]},optional:{latent_image:['LATENT']},hidden:{foo:'*'}},output:['LATENT'],output_name:['LATENT']},VAELoader:{input:{required:{vae:[['taesd']]},hidden:{}},output:['LATENT'],output_name:['LATENT']},Mystery:{input:{hidden:{}}}};
  const prompt={'1':{class_type:'VAELoader',inputs:{vae:'taesd'}},'2':{class_type:'KSampler',inputs:{seed:7,steps:30,latent_image:['1',0],not_declared:['1',0]}},'3':{class_type:'Mystery',inputs:{some_text:'hello'}}};
  const ui=apiToUi(prompt,objectInfo);
  assert.ok(ui&&Array.isArray(ui.nodes));
  const k=ui.nodes.find((node)=>node.type==='KSampler');
  assert.deepEqual(k.widgets_values,[7,30],'prompt values win over schema defaults, hidden inputs are not widgets');
  assert.ok(ui.nodes.find((node)=>node.type==='VAELoader').widgets_values[0]==='taesd');
  const fed=k.inputs.filter((input)=>input.link!==null).map((input)=>input.name);
  assert.ok(fed.includes('latent_image')&&fed.includes('not_declared'),'declared and undeclared fed inputs both get sockets');
  const link=ui.links.find((l)=>l[4]==='latent_image');
  assert.ok(link&&link[5]==='LATENT','link carries the source output type');
  const m=ui.nodes.find((node)=>node.type==='Mystery');
  assert.deepEqual(m.widgets_values,['hello'],'unknown classes still get a loadable node with the prompt constants');
  assert.ok(ui.nodes.find((node)=>node.type==='VAELoader').pos[0]<k.pos[0],'producers placed left of consumers');
});

test('new/unwatched (0.2.78): library files start unseen, seen on open, legacy entries never flagged',async t=>{
  const {base,root}=await setup(t);
  const src=join(root,'src-new');await mkdir(src,{recursive:true});
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=green:s=64x64:d=0.2:r=10','-c:v','libx264','-pix_fmt','yuv420p',join(src,'fresh.mp4')]);
  assert.equal((await json(base,'/api/footage/folder',{method:'POST',body:JSON.stringify({path:src})})).status,200);
  let list=await (await json(base,'/api/footage')).json();
  const fresh=list.files.find((f)=>f.path.endsWith('fresh.mp4'));
  assert.equal(fresh.seen,false,'newly added file is unseen → board outlines it NEW and lists it in the New section');
  assert.equal((await json(base,'/api/footage/seen',{method:'POST',body:JSON.stringify({path:fresh.path})})).status,200);
  list=await (await json(base,'/api/footage')).json();
  assert.equal(list.files.find((f)=>f.path===fresh.path).seen,true,'opening clears the NEW status for good');
  const metaPath=join(root,'media','footage.json');
  const meta=JSON.parse(await readFile(metaPath,'utf8'));delete meta.files[fresh.path].seen;
  await writeFile(metaPath,JSON.stringify(meta));
  list=await (await json(base,'/api/footage')).json();
  assert.equal(list.files.find((f)=>f.path===fresh.path).seen,true,'entries written before the flag existed count as seen — the board never retro-flags the old library');
});

test('bridge half (0.2.81): comfy-upload server relay + CORS read lanes',async t=>{
  const seen=[];
  const fetchImpl=async(u,init)=>{if(String(u)==='http://comfy.test/upload/image'){seen.push(init);return new Response(JSON.stringify({name:'x.mp4',subfolder:'dsh',type:'input'}),{status:200,headers:{'content-type':'application/json'}});}return new Response('{}');};
  const {base,root}=await setup(t,{fetchImpl});
  await mkdir(join(root,'media'),{recursive:true});await writeFile(join(root,'media','x.mp4'),Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.from('major')]));
  const rel=await (await json(base,'/api/comfy-upload',{method:'POST',body:JSON.stringify({path:'x.mp4',comfy_origin:'http://comfy.test'})})).json();
  assert.deepEqual({name:rel.name,subfolder:rel.subfolder},{name:'x.mp4',subfolder:'dsh'},'ComfyUI reply passes through verbatim');
  assert.equal(seen.length,1);
  const fd=seen[0].body;
  assert.ok(fd instanceof FormData,'multipart relay');
  assert.equal(fd.get('subfolder'),'dsh');assert.equal(fd.get('type'),'input');assert.equal(fd.get('overwrite'),'true');
  const file=fd.get('image');assert.equal(file.name,'x.mp4');
  assert.equal((await json(base,'/api/comfy-upload',{method:'POST',body:JSON.stringify({path:join(root,'media','x.mp4'),comfy_origin:'http://comfy.test'})})).status,200,'absolute paths relay too');
  assert.equal((await json(base,'/api/comfy-upload',{method:'POST',body:JSON.stringify({path:'nope.mp4',comfy_origin:'http://comfy.test'})})).status,404);
  assert.equal((await json(base,'/api/comfy-upload',{method:'POST',body:JSON.stringify({path:'x.mp4',comfy_origin:'ftp://nope'})})).status,400,'origin must be http(s)');
  // CORS: read lanes open to the ComfyUI page; everything else untouched
  for(const p of ['/api/library?kind=actors','/api/footage','/api/images','/api/footage/thumb?path=x','/api/file?path=x']){
    const r=await json(base,p);assert.equal(r.headers.get('access-control-allow-origin'),'*',`CORS GET ${p}`);}
  const opt=await fetch(base.replace('/director-studio','')+'/director-studio/api/file',{method:'OPTIONS'});
  assert.equal(opt.status,204);assert.equal(opt.headers.get('access-control-allow-origin'),'*','preflight on bridge lanes');
  const opt2=await fetch(`${base}/api/agent-task`,{method:'OPTIONS'});
  assert.equal(opt2.headers.get('access-control-allow-origin'),null,'no CORS off-lane');
});

test('bridge kind=assets shape (0.2.85)',async t=>{
  const {base,store,project}=await setup(t);
  await store.saveAsset({kind:'actors',name:'Mia',project_id:project.id,filename:'mia-bust.png',bytes:Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('x')])});
  const v=await (await json(base,'/api/library?kind=assets')).json();
  assert.ok(Array.isArray(v.assets));
  const a=v.assets.find((x)=>x.slug&&String(x.slug).startsWith('mia'));assert.ok(a,'slug present');
  assert.equal(a.images.length,1);assert.ok(a.images[0].abs&&a.images[0].file.endsWith('.png')&&!a.images[0].file.includes('/'),'bare file name + abs');
  assert.deepEqual([a.videos.length,a.audio.length],[0,0]);
});

test('editing routes: create (default + explicit doc), shared-path commands, derived tags, find, undo re-derives',async t=>{
  const {base}=await setup(t);
  assert.deepEqual((await (await json(base,'/api/editing')).json()).editing,[]);
  // default document factory (no doc in body)
  const fresh=await (await json(base,'/api/editing',{method:'POST',body:JSON.stringify({name:'fresh'})})).json();
  assert.ok(fresh.id);
  const freshDoc=(await (await json(base,`/api/editing/${fresh.id}`)).json()).doc;
  assert.ok(freshDoc?.compositions?.[freshDoc.root_id]);
  // explicit document with a media pool (shape proven by scripts/coreprobe.mjs)
  const ROOT='11111111-1111-4111-8111-111111111111',VID='22222222-2222-4222-8222-222222222222';
  const doc={schema_version:(await import('../lib/timeline-core.mjs')).SCHEMA_VERSION,project_id:'33333333-3333-4333-8333-333333333333',metadata:{name:'ep1',created_at:'',modified_at:'',description:null},compositions:{[ROOT]:{id:ROOT,label:null,ordinal:0,width:1920,height:1080,fps:{num:24,den:1},duration_us:10000000,duration_pinned:false,sample_rate:48000,channels:2,color_space:'Bt709',background:{r:0,g:0,b:0,a:255},tracks:[],markers:[],transitions:[],links:[]}},root_id:ROOT,next_group_ordinal:1,media_pool:{[VID]:{id:VID,label:null,path_abs:'x.mp4',path_rel:null,kind:'Video',metadata:{duration_us:5000000,video:null,audio:null,container_format:null},file_hash_blake3:'0',file_size:0,file_mtime:0,imported_at:'',decode_route:{route:'bypass'},conform_path:null}},audio_roles:{},settings:{preview_width:1280,preview_height:720,autosave_interval_secs:null,history_capacity:50,auto_pair_audio_on_import:false,prefer_proxies:false,proxy_overrides:{},shot_review:null,pause_review:null},motifs:{}};
  const e=await (await json(base,'/api/editing',{method:'POST',body:JSON.stringify({name:'ep1-cut',doc})})).json();assert.ok(e.id);
  assert.equal(e.tags.length,0);
  const tr=await (await json(base,`/api/editing/${e.id}/command`,{method:'POST',body:JSON.stringify({channel:'add_track',args:{compositionId:ROOT}})})).json();
  assert.equal(tr.ok,true,JSON.stringify(tr.error));
  const trackId=((await (await json(base,`/api/editing/${e.id}`)).json()).doc.compositions[ROOT].tracks||[]).slice(-1)[0].id;
  const ml=await (await json(base,`/api/editing/${e.id}/command`,{method:'POST',body:JSON.stringify({channel:'add_media_layer',args:{trackId,mediaId:VID,tStartUs:0}})})).json();
  assert.equal(ml.ok,true,JSON.stringify(ml.error));
  const st=await (await json(base,`/api/editing/${e.id}/command`,{method:'POST',body:JSON.stringify({channel:'update_layer',args:{layerId:ml.value,patch:{metadata:{dsh:{shot_id:'c12',sequence_id:'s3',episode_id:'e1',take_id:'v2'}}}}})})).json();
  assert.equal(st.ok,true,JSON.stringify(st.error));
  assert.deepEqual(st.tags,['episode-e1','sequence-s3','shot-c12','take-v2']);
  const found=await (await json(base,'/api/editing?tags=shot-c12')).json();
  assert.deepEqual(found.editing.map(i=>i.id),[e.id]);
  const un=await (await json(base,`/api/editing/${e.id}/undo`,{method:'POST',body:'{}'})).json();
  assert.equal(un.ok,true,JSON.stringify(un.error));
  assert.deepEqual((await (await json(base,'/api/editing?tags=shot-c12')).json()).editing,[]);
  const list=(await (await json(base,'/api/editing')).json()).editing;
  assert.deepEqual(list.map(i=>i.id).sort(),[fresh.id,e.id].sort());
  // renderer projection: the exact ProjectPublicationReply the Timeline consumes
  const pub=await (await json(base,`/api/editing/${e.id}/publication`)).json();
  assert.ok(pub.version.session>0&&pub.version.revision>=1);
  assert.ok(pub.viewId>=1);
  const comp=pub.summary.compositions[pub.summary.root_id];
  assert.equal(comp.tracks.length,1);
  assert.equal(comp.tracks[0].layers.length,1);
  assert.equal(typeof comp.fps_num,'number');
  assert.ok(pub.summary.media.length===0||pub.summary.media[0].id);
  assert.equal((await (await json(base,'/api/editing/nope000/publication')).status),404);
  // shot-slot seeding + take relink over the SAME routes the agent tools use
  const seeded=await (await json(base,'/api/editing',{method:'POST',body:JSON.stringify({name:'seeded'})})).json();
  const sr=await (await json(base,`/api/editing/${seeded.id}/seed`,{method:'POST',body:JSON.stringify({shots:[{shot_id:'c9',sequence_id:'s9',episode_id:'e9',path:'/ws/media/clipA.mp4',duration_s:4},{shot_id:'c10',episode_id:'e9',path:'/ws/media/clipB.mp4',duration_s:3}]})})).json();
  assert.ok(sr.ok&&sr.added.length===2,JSON.stringify(sr));
  const sdoc=(await (await json(base,`/api/editing/${seeded.id}`)).json()).doc;
  const slayers=sdoc.compositions[sdoc.root_id].tracks[0].layers;
  assert.deepEqual(slayers.map(l=>[l.t_start_us,l.t_end_us]),[[0,4000000],[4000000,7000000]]);
  const foundByTag=(await (await json(base,'/api/editing?tags=shot-c9')).json()).editing[0];
  assert.equal(foundByTag.id,seeded.id);
  // Picker contract: list entries carry tags so the UI can open an edit by tag.
  assert.ok(Array.isArray(foundByTag.tags)&&foundByTag.tags.includes('sequence-s9'));
  const before=slayers[0].params.media;
  const rr=await (await json(base,`/api/editing/${seeded.id}/relink`,{method:'POST',body:JSON.stringify({shot_id:'c9',path:'/ws/media/clipA_v2.mp4',duration_us:4500000})})).json();
  assert.ok(rr.ok&&rr.relinked.length===1&&rr.relinked[0].old_media_id===before,JSON.stringify(rr));
  const ndoc=(await (await json(base,`/api/editing/${seeded.id}`)).json()).doc;
  const nl=ndoc.compositions[ndoc.root_id].tracks[0].layers;
  assert.notEqual(nl[0].params.media,before);
  assert.deepEqual(nl.map(l=>[l.t_start_us,l.t_end_us]),[[0,4000000],[4000000,7000000]]);
  assert.equal(nl[0].params.src_out_us,4000000);
  assert.deepEqual(ndoc.compositions[ndoc.root_id].tracks[0].layers[1].params.media,slayers[1].params.media);
  assert.deepEqual((await (await json(base,`/api/editing/${seeded.id}`)).json()).entry.tags.sort(),['episode-e9','sequence-s9','shot-c10','shot-c9']);
});
test('GET /timeline-engine.js serves the engine bundle without a session (script tags cannot send headers)',async t=>{const {base}=await setup(t);const r=await fetch(base+'/timeline-engine.js');assert.equal(r.status,200);assert.match(r.headers.get('content-type')??'',/javascript/);assert.ok((await r.text()).includes('DSH_TIMELINE'));});
test('timeline art routes: poster data URL, filmstrip tile + art-file stream, footage import, not_ready envelope', async t => {
  const { base, root } = await setup(t);
  await mkdir(join(root, 'media'), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(root, 'media', 'arttest.mp4')]);
  const ed = await (await json(base, '/api/editing', { method: 'POST', body: JSON.stringify({ name: 'art' }) })).json();
  const seed = await (await json(base, `/api/editing/${ed.id}/seed`, { method: 'POST', body: JSON.stringify({ shots: [{ shot_id: 'a1', path: 'media/arttest.mp4', duration_s: 1 }] }) })).json();
  assert.equal(seed.ok, true, JSON.stringify(seed.error ?? seed));
  const got = await (await json(base, `/api/editing/${ed.id}`)).json();
  const mediaId = Object.keys(got.doc.media_pool)[0];
  const th = await (await json(base, `/api/editing/${ed.id}/thumbnail?mediaId=${mediaId}`)).json();
  assert.equal(th.ok, true);
  assert.ok(th.value.startsWith('data:image/jpeg;base64,'), 'poster is a data URL for MediaPosterCache');
  const tile = await (await json(base, `/api/editing/${ed.id}/tile?mediaId=${mediaId}&lod=1&index=1`)).json();
  assert.equal(tile.ok, true);
  assert.ok(String(tile.value.path).endsWith('.jpg') && tile.value.heightPx > 0, 'TileEngine shape {path,widthPx,heightPx}');
  const bytes = await json(base, `/api/editing/${ed.id}/art-file?path=${encodeURIComponent(tile.value.path)}`);
  assert.equal(bytes.status, 200);
  const buf = Buffer.from(await bytes.arrayBuffer());
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8); // JPEG magic — streamed here; dot-folder never via /api/file
  const outside = await json(base, `/api/editing/${ed.id}/art-file?path=${encodeURIComponent(join(root, 'media', 'arttest.mp4'))}`);
  assert.equal(outside.status, 404, 'art-file serves ONLY the timeline-art cache dir');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.2:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'media', 'artmore.mp4')]);
  const imp = await (await json(base, `/api/editing/${ed.id}/import-footage`, { method: 'POST', body: '{}' })).json();
  assert.equal(imp.ok, true);
  const job = await waitJob(base, ed.id, 'import-footage');
  assert.equal(job.status, 'done', JSON.stringify(job));
  const doc2 = (await (await json(base, `/api/editing/${ed.id}`)).json()).doc;
  const paths = Object.values(doc2.media_pool).map((m) => String(m.path_abs));
  assert.ok(paths.includes('media/artmore.mp4'), 'every not-yet-pooled workspace video joins the pool (queued job): ' + paths.join(','));
  await rm(join(root, 'media', 'arttest.mp4'), { force: true });
  const gone = await (await json(base, `/api/editing/${ed.id}/thumbnail?mediaId=${mediaId}`)).json();
  assert.equal(gone.ok, false); assert.equal(gone.error.code, 'not_ready', 'missing media answers honestly, never a crash');
});
test('waveform routes: pyramid levels + tile slices for audio media, not_ready for silent media', async t => {
  const { base, root } = await setup(t);
  await mkdir(join(root, 'media'), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', join(root, 'media', 'tone.mp4')]);
  const ed = await (await json(base, '/api/editing', { method: 'POST', body: JSON.stringify({ name: 'wf' }) })).json();
  const seed = await (await json(base, `/api/editing/${ed.id}/seed`, { method: 'POST', body: JSON.stringify({ shots: [{ shot_id: 'w1', path: 'media/tone.mp4', duration_s: 1 }] }) })).json();
  assert.equal(seed.ok, true);
  const got = await (await json(base, `/api/editing/${ed.id}`)).json();
  const mediaId = Object.keys(got.doc.media_pool)[0];
  const lv = await (await json(base, `/api/editing/${ed.id}/waveform-levels?mediaId=${mediaId}`)).json();
  assert.equal(lv.ok, true, JSON.stringify(lv.error));
  assert.ok(lv.value.channels >= 1 && lv.value.levels.length >= 1 && lv.value.levels[0].peakCount > 1, JSON.stringify(lv.value));
  const tile = await (await json(base, `/api/editing/${ed.id}/waveform-tile?mediaId=${mediaId}&level=0&channel=0&startPeak=0&count=64`)).json();
  assert.equal(tile.ok, true);
  assert.ok(tile.value.min.length > 0 && tile.value.min.length <= 64);
  assert.ok(tile.value.max.every((v) => v >= -1 && v <= 1) && tile.value.min.every((v) => v >= -1 && v <= 1), 'normalized samples');
  assert.ok(tile.value.max.some((v) => v > 0.1), 'a 440Hz tone must show real amplitude');
  // silent video: honest not_ready, no crash
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.5:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'media', 'silent.mp4')]);
  await (await json(base, `/api/editing/${ed.id}/import-footage`, { method: 'POST', body: '{}' })).json();
  await waitJob(base, ed.id, 'import-footage');
  const doc2 = (await (await json(base, `/api/editing/${ed.id}`)).json()).doc;
  const silentId = Object.values(doc2.media_pool).find((m) => String(m.path_abs) === 'media/silent.mp4').id;
  const lv2 = await (await json(base, `/api/editing/${ed.id}/waveform-levels?mediaId=${silentId}`)).json();
  assert.equal(lv2.ok, false); assert.equal(lv2.error.code, 'not_ready');
});
test('normalize: import pools originals (no transcode at import); normalize-pool repairs timeline-used 10-bit media', async t => {
  const { base, root } = await setup(t);
  await mkdir(join(root, 'media'), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.3:r=10', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-shortest', join(root, 'media', 'tenbit.mp4')]);
  const ed = await (await json(base, '/api/editing', { method: 'POST', body: JSON.stringify({ name: 'norm' }) })).json();
  const seed = await (await json(base, `/api/editing/${ed.id}/seed`, { method: 'POST', body: JSON.stringify({ shots: [{ shot_id: 't1', path: 'media/tenbit.mp4', duration_s: 0.3 }] }) })).json();
  assert.equal(seed.ok, true);
  const pre = (await (await json(base, `/api/editing/${ed.id}`)).json()).doc;
  const preLayer = pre.compositions[pre.root_id].tracks.find((tr) => tr.role === 'ARoll').layers[0];
  assert.equal(String(pre.media_pool[preLayer.params.media].path_abs), 'media/tenbit.mp4', 'seeding pools the original; repair is a separate queued job');
  const start = await (await json(base, `/api/editing/${ed.id}/normalize-pool`, { method: 'POST', body: '{}' })).json();
  assert.equal(start.ok, true);
  const job = await waitJob(base, ed.id, 'normalize-pool');
  assert.equal(job.status, 'done', JSON.stringify(job));
  const done = await (await json(base, `/api/editing/${ed.id}`)).json();
  const fmt = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', join(root, 'media', 'normalized', 'tenbit.mp4')]).toString().trim();
  assert.equal(fmt, 'yuv420p', 'normalized copy is browser-decodable');
  const doc2 = done.doc;
  const layer2 = doc2.compositions[doc2.root_id].tracks.find((tr) => tr.role === 'ARoll').layers[0];
  assert.equal(String(doc2.media_pool[layer2.params.media].path_abs), 'media/normalized/tenbit.mp4', 'the timeline layer relinked onto the playable copy');
});
