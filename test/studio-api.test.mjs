import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {join,resolve as pathResolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createStudioRegistry} from '../src/studio-store.mjs';
import {createStudioApiHandler} from '../src/studio-api.mjs';
import {createStudioTools} from '../src/studio-tools.mjs';

const png=Buffer.from('89504e470d0a1a0a00000000','hex');
// The DSH session workspace folder IS the project; tests resolve every session id to one temporary workspace.
async function setup(t,{reject,fetchImpl}={}){
  const root=await mkdtemp(join(tmpdir(),'dsh-studio-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const registry=createStudioRegistry();const server=createServer(createStudioApiHandler({resolveSession:()=>registry(root),requestRejection:()=>reject,comfyHosts:()=>['http://comfy.test'],fetchImpl:fetchImpl??(async()=>new Response('{}'))}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {store,project}=await registry(root);
  return {store,project,root,base:`http://127.0.0.1:${server.address().port}/director-studio`};
}
const json=(base,path,init={})=>fetch(base+path,{...init,headers:{'content-type':'application/json','x-director-session':'session-a',...init.headers}});

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
  const {base}=await setup(t,{fetchImpl:async(url)=>url.includes('comfy.test')?new Response('BYTES',{status:200,headers:{'content-type':'video/mp4'}}):new Response('nope',{status:404})});
  const ok=await json(base,'/api/comfy-view?host=http%3A%2F%2Fcomfy.test&filename=shot%2001.mp4&subfolder=rnd');
  assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'video/mp4');assert.equal(await ok.text(),'BYTES');
  const denied=await json(base,'/api/comfy-view?host=https%3A%2F%2Fevil.example&filename=x');
  assert.equal(denied.status,400);assert.match((await denied.json()).detail,/not in the configured endpoint list/);
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
