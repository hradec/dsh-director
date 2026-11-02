import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStudioStore,createStudioRegistry,StudioStoreError,studioAssetDigest,studioMediaMetadata} from '../src/studio-store.mjs';

const png=Buffer.from('89504e470d0a1a0a00000000','hex');
const wav=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVE'),Buffer.alloc(8)]);
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dsh-studio-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('projects, assets, shots persist across store instances',async t=>{
  const root=await fixture(t),first=createStudioStore({root});
  const project=await first.createProject({name:'  Pilot  ',script_text:'Story'});
  const asset=await first.saveAsset({kind:'actors',name:'Mira',project_id:project.id,filename:'mira.png',bytes:png});
  const shot=await first.saveShot(project.id,{title:'Opening',duration_s:4,dialogue:['Hello']});
  await first.patchShot(shot.id,{feedback:'Keep the door visible'});
  const second=createStudioStore({root});
  assert.equal((await second.listProjects())[0].name,'Pilot');
  assert.equal((await second.listAssets({kind:'actors',project_id:project.id}))[0].id,asset.id);
  assert.equal((await second.getProject(project.id)).shots[0].feedback,'Keep the door visible');
  assert.deepEqual(await second.readMedia(await second.getMedia(asset.files.master)),png);
});

test('Production shot metadata persists, patches, and rejects non-text values',async t=>{
  const root=await fixture(t),store=createStudioStore({root}),project=await store.createProject({name:'P'});
  const shot=await store.saveShot(project.id,{title:'Opening',scene_id:'sc01',shot_type:'wide',camera_angle:'eye-level',camera_motion:'locked',composition:'Subject on left third'});
  const updated=await store.patchShot(shot.id,{shot_type:'medium',camera_motion:'slow push'});
  assert.equal(updated.scene_id,'sc01');assert.equal(updated.shot_type,'medium');assert.equal(updated.camera_angle,'eye-level');assert.equal(updated.camera_motion,'slow push');assert.equal(updated.composition,'Subject on left third');
  await assert.rejects(store.patchShot(shot.id,{camera_motion:12}),/camera_motion must be a string/);
  assert.equal((await store.getShot(shot.id)).camera_motion,'slow push');
});

test('Production shots link only project-available layout and video masters',async t=>{
  const root=await fixture(t),store=createStudioStore({root}),project=await store.createProject({name:'P'}),other=await store.createProject({name:'Other'});
  const layout=await store.saveAsset({kind:'layouts',name:'Hall layout',project_id:project.id,filename:'hall.png',bytes:png});
  const actor=await store.saveAsset({kind:'actors',name:'Mira',project_id:project.id,filename:'mira.png',bytes:png});
  const foreign=await store.saveAsset({kind:'layouts',name:'Other layout',project_id:other.id,filename:'other.png',bytes:png});
  const video=await store.saveAsset({kind:'layouts',name:'H3 result',project_id:project.id,filename:'result.mp4',bytes:Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(8)])});
  const shot=await store.saveShot(project.id,{title:'Entrance'});
  assert.equal((await store.patchShot(shot.id,{layout_asset_id:layout.id})).layout_asset_id,layout.id);
  assert.equal((await store.patchShot(shot.id,{video_asset_id:video.id})).video_asset_id,video.id);
  await assert.rejects(store.patchShot(shot.id,{layout_asset_id:actor.id}),/project-available layout asset/);
  await assert.rejects(store.patchShot(shot.id,{layout_asset_id:foreign.id}),/project-available layout asset/);
  await assert.rejects(store.patchShot(shot.id,{video_asset_id:layout.id}),/video master file/);
  await assert.rejects(store.deleteAsset('layouts',video.id),/referenced by a Production shot/);
  await store.patchShot(shot.id,{video_asset_id:null,layout_asset_id:null});
  assert.deepEqual(await store.deleteAsset('layouts',video.id),{deleted:true,id:video.id});
});

test('parallel writes are serialized and project membership is checked',async t=>{
  const root=await fixture(t),store=createStudioStore({root});
  const created=await Promise.all(Array.from({length:12},(_,i)=>store.createProject({name:`Project ${i}`})));
  assert.equal((await store.listProjects()).length,12);
  await assert.rejects(store.saveAsset({kind:'actors',name:'orphan',project_id:'missing'}),/Project not found/);
  assert.equal((await store.snapshot()).assets.length,0);
  assert.equal(created.length,12);
});

test('metadata operations preserve identities and reject unknown records',async t=>{
  const root=await fixture(t),store=createStudioStore({root}),project=await store.createProject({name:'P'});
  const asset=await store.saveAsset({kind:'voices',name:'Voice',project_id:project.id,filename:'line.wav',bytes:wav});
  assert.equal(asset.kind,'voices');
  assert.equal((await store.updateAsset('voices',asset.id,{name:'Voice edited',notes:'sample'})).name,'Voice edited');
  assert.equal((await store.assignAsset('voices',asset.id,null)).project_id,null);
  await assert.rejects(store.updateAsset('voices','missing',{name:'No'}),error=>error instanceof StudioStoreError&&error.status===404);
  assert.deepEqual(await store.deleteAsset('voices',asset.id),{deleted:true,id:asset.id});
  await assert.rejects(store.getMedia(asset.files.master),error=>error instanceof StudioStoreError&&error.status===404);
});

test('media signature checks reject mislabeled or unsupported uploads',async t=>{
  const root=await fixture(t),store=createStudioStore({root});
  await assert.rejects(store.saveAsset({kind:'actors',name:'bad',filename:'bad.png',bytes:Buffer.from('not a png')}),/signature/);
  await assert.rejects(store.saveAsset({kind:'actors',name:'bad key',filename:'good.png',bytes:png,file_key:'../outside'}),/file_key/);
  assert.throws(()=>studioMediaMetadata('bad.svg',Buffer.from('<svg/>')),/Unsupported media/);
  assert.deepEqual(studioMediaMetadata('clip.mov',Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(8)])),['video','video/quicktime']);
  assert.equal(studioAssetDigest(png).length,64);
  assert.equal((await store.snapshot()).assets.length,0);
});

test('shot references must use existing project-scoped assets and unique Picture/Audio indices',async t=>{
  const root=await fixture(t),store=createStudioStore({root}),project=await store.createProject({name:'P'}),other=await store.createProject({name:'Other'});
  const actor=await store.saveAsset({kind:'actors',name:'Mira',project_id:project.id,filename:'mira.png',bytes:png});
  const voice=await store.saveAsset({kind:'voices',name:'Mira voice',project_id:project.id,filename:'line.wav',bytes:wav});
  const refs=[{role:'actor',asset_id:actor.id,picture_index:1}],voice_refs=[{asset_id:voice.id,audio_index:1,file_key:'master',speaker:'Mira'}];
  const shot=await store.saveShot(project.id,{title:'Opening',refs,voice_refs,prompt_sections:{summary:'A quiet doorway.'}});
  assert.equal(shot.refs[0].asset_id,actor.id);assert.equal(shot.voice_refs[0].speaker,'Mira');assert.equal(shot.prompt_sections.summary,'A quiet doorway.');
  await assert.rejects(store.saveShot(other.id,{title:'Wrong project',refs}),/missing, belongs to another project/);
  await assert.rejects(store.assignAsset('actors',actor.id,other.id),/another project shot references it/);
  await assert.rejects(store.patchShot(shot.id,{refs:[...refs,{...refs[0],picture_index:1}]}),/unique integers/);
  await assert.rejects(store.patchShot(shot.id,{voice_refs:[{...voice_refs[0],file_key:'missing'}]}),/no matching media file/);
  await assert.rejects(store.patchShot(shot.id,{prompt_sections:{summary:'safe',unknown:'bad'}}),/Unknown prompt section/);
});

test('duration bounds and malformed shot arrays are rejected',async t=>{
  const root=await fixture(t),store=createStudioStore({root}),project=await store.createProject({name:'P'});
  const shot=await store.saveShot(project.id,{title:'First'});
  await assert.rejects(store.patchShot(shot.id,{duration_s:3601}),/duration/);
  await assert.rejects(store.patchShot(shot.id,{refs:{invalid:true}}),/array/);
  assert.equal((await store.listShots(project.id))[0].duration_s,4);
});

test('asset regeneration replaces media in place without changing the asset id',async t=>{
  const root=await fixture(t),store=createStudioStore({root}),project=await store.createProject({name:'P'});
  const asset=await store.saveAsset({kind:'actors',name:'Mira',project_id:project.id,filename:'a.png',bytes:png});
  const previousPath=asset.files.master;
  const replaced=await store.saveAsset({kind:'actors',project_id:project.id,asset_id:asset.id,job_id:'tok-1',filename:'b.png',bytes:png});
  assert.equal(replaced.id,asset.id);assert.equal(replaced.file_names.master,'b.png');assert.equal(replaced.job_id,'tok-1');
  assert.deepEqual(await store.readMedia(await store.getMedia(replaced.files.master)),png);
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(stat(previousPath),{code:'ENOENT'});
  await assert.rejects(store.saveAsset({kind:'scenes',project_id:project.id,asset_id:asset.id,filename:'x.png',bytes:png}),/Asset not found/);
});

test('the workspace registry auto-creates one hidden-folder project and caches it',async t=>{
  const cwd=await fixture(t),registry=createStudioRegistry();
  const {store,project}=await registry(cwd);
  assert.equal(project.name,process.platform==='win32'?cwd.split(/[\\/]+/).pop():cwd.split('/').pop());
  assert.equal((await store.listProjects()).length,1);
  const again=await registry(cwd);assert.equal(again.store,store);assert.equal(again.project.id,project.id);
  const fresh=await createStudioRegistry()(cwd);assert.equal(fresh.project.id,project.id);assert.equal((await fresh.store.listProjects()).length,1);
  await stat(join(cwd,'.director-studio','studio.json'));
  await assert.rejects(registry(''),/workspace folder/);
  await assert.rejects(registry(undefined),StudioStoreError);
});

// ponytail: the first store keeps a single JSON index; tests lock in stable IDs, serialized writes, and strict media identity checks before a sharded backend is justified.
