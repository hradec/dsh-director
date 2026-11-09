import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStudioStore} from '../src/studio-store.mjs';

// Minimal fake MP4: mediaType() only sniffs the ftyp box.
const mp4=()=>Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.from('isom')]);

async function seeded(){
  const store=createStudioStore({root:mkdtempSync(join(tmpdir(),'dsh-hierarchy-'))});
  const project=await store.createProject({name:'Spear Drive'});
  const sequence=await store.saveSequence(project.id,{name:'Cold open',episode_id:'ep-1',order:1});
  const shot=await store.saveShot(project.id,{title:'S01',sequence_id:sequence.id,arcs:['arc1','B-plot','arc1']});
  const video=await store.saveAsset({kind:'layouts',project_id:project.id,name:'clip v1',file_key:'master',filename:'v1.mp4',bytes:mp4(),job_id:'job_v1'});
  return {store,project,sequence,shot,video};
}

test('sequences group shots and arcs ride as tags',async ()=>{
  const {store,project,sequence,shot}=await seeded();
  assert.equal(shot.sequence_id,sequence.id);
  assert.deepEqual(shot.arcs,['arc1','B-plot']);
  const listed=await store.listSequences(project.id);
  assert.equal(listed.length,1);assert.equal(listed[0].name,'Cold open');assert.equal(listed[0].episode_id,'ep-1');
  await assert.rejects(store.saveShot(project.id,{title:'bad',sequence_id:'nope'}),/Sequence not found|sequence_id/);
  const moved=await store.patchShot(shot.id,{sequence_id:null,arcs:['arc3']});
  assert.equal(moved.sequence_id,'');assert.deepEqual(moved.arcs,['arc3']);
  const second=await store.saveShot(project.id,{title:'S02'});
  assert.deepEqual(second.arcs,[]);
  const afterDelete=await store.deleteSequence(sequence.id);
  assert.equal(afterDelete.deleted,sequence.id);
  assert.equal((await store.listSequences(project.id)).length,0);
});

test('binding a clip auto-registers a take holding prompt+refs for later guidance',async ()=>{
  const {store,shot,video}=await seeded();
  const withPrompt=await store.patchShot(shot.id,{prompt_sections:{summary:'A quiet entrance.',overall_soundscape:'rain'},refs:[]});
  assert.ok(withPrompt);
  const bound=await store.patchShot(shot.id,{video_asset_id:video.id});
  assert.equal(bound.video_asset_id,video.id);
  const takes=await store.listTakes({shot_id:shot.id});
  assert.equal(takes.length,1);
  assert.equal(takes[0].kind,'generation');assert.equal(takes[0].status,'selected');assert.equal(takes[0].video_asset_id,video.id);
  assert.equal(takes[0].prompt_sections.summary,'A quiet entrance.');
  // Re-binding the same video must not duplicate the take.
  await store.patchShot(shot.id,{video_asset_id:video.id});
  assert.equal((await store.listTakes({shot_id:shot.id})).length,1);
});

test('takes chain generation to upscale and selecting one rebinds the shot',async ()=>{
  const {store,shot,video}=await seeded();
  await store.patchShot(shot.id,{video_asset_id:video.id});
  const [first]=await store.listTakes({shot_id:shot.id});
  const upscaled=await store.saveAsset({kind:'layouts',project_id:shot.project_id,name:'clip x2',file_key:'master',filename:'v2.mp4',bytes:mp4(),job_id:'job_v2'});
  const take=await store.saveTake({shot_id:shot.id,label:'x2 upscale',kind:'upscale',parent_take_id:first.id,workflow_path:'/w/upscale.json',canvas:{width:3840,height:2160},video_asset_id:upscaled.id});
  assert.equal(take.kind,'upscale');assert.equal(take.parent_take_id,first.id);assert.equal(take.status,'ready');
  await assert.rejects(store.saveTake({shot_id:shot.id,parent_take_id:'ghost'}),/parent_take_id/);
  const {take:selected,shot:rebound}=await store.selectTake(take.id);
  assert.equal(selected.status,'selected');
  assert.equal(rebound.video_asset_id,upscaled.id);assert.equal(rebound.video_job_id,'job_v2');
  const after=await store.listTakes({shot_id:shot.id});
  assert.equal(after.filter(item=>item.status==='selected').length,1);
  assert.equal(after.find(item=>item.id===first.id).status,'ready');
  const reselected=await store.selectTake(first.id);
  assert.equal(reselected.shot.video_asset_id,video.id);
});
