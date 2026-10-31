import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createBundledProvider} from '../src/skills.mjs';
import {apply as registerSubmit} from '../src/submit-comfy-video.mjs';
import {proposalSchema} from '../src/shot-proposal.mjs';

test('Director submit tools expose continuity routes and configured workflow selection',()=>{
  const tools=[];
  registerSubmit({jobs:{},effect:fn=>fn(),tools:{register:tool=>tools.push(tool)}});
  for(const tool of tools){
    assert.deepEqual(tool.parameters.properties.continuity_requirement.enum,['sampler_latent','video_frames']);
    assert.deepEqual(tool.parameters.properties.workflow_kind.enum,['text_to_image','image_edit','reference_to_video','first_last_frame_to_video','video_edit','other']);
    assert.equal(tool.parameters.properties.workflow_name.type,'string');
  }
  assert.match(String(tools.find(tool=>tool.name==='submit_comfy_job').description),/workflow_requirements/);
  assert.deepEqual(proposalSchema.properties.clip_workflows.items.properties.continuity_mode.enum,['none','video_frames','sampler_latent']);
});

test('bundled and workspace guidance removes frame extraction fallback and keeps latent handoff',async()=>{
  const base=resolve(import.meta.dirname,'../skills/director');
  for(const name of ['SKILL.md','references/continuity.md']){
    const text=await readFile(resolve(base,name),'utf8');
    assert.doesNotMatch(text,/reviewed tail frame|Layouts or tail frames|take the last frame|A decoded-tail route replaces|offer the available decoded-video route/iu);
    assert.match(text,/continuity_requirement[^\n]*sampler_latent/);
    assert.match(text,/video_frames/);
    assert.doesNotMatch(text,/not a supported Director continuation option|not offered as a production route|or use decoded frames as a continuation fallback/);
    if(name==='SKILL.md'){
      assert.match(text,/workflow_requirements/);assert.match(text,/exact saved `workflow_name`/);assert.match(text,/workflow_kind/);assert.match(text,/Do not substitute/);
      assert.match(text,/When asked to show local image, video, or audio files, use `director_show_media`/);
      assert.match(text,/Do not substitute a bare `<path>` link or `present` call for a media card/);
      assert.match(text,/does not change DSH's generic file-link or sidebar behavior/);
    }
    const workspace=resolve(base,'../../../../.agents/skills/director',name);
    if(await access(workspace).then(()=>true,()=>false))assert.equal(await readFile(workspace,'utf8'),text);
  }
});

async function continuityResource(content,base){
  const targets=[...content.matchAll(/\]\(([^)]+)\)/g)].map(m=>m[1]);
  assert.ok(targets.includes('references/continuity.md'),'director must route dependent clips to its continuity reference');
  const path=resolve(base,'references/continuity.md');
  assert.equal(await access(path).then(()=>true,()=>false),true,'linked continuity guidance must be readable');
  assert.ok((await readFile(path,'utf8')).trim().length>0,'a routed reference must not be empty');
}

test('bundled director can resolve its dependent-clip guidance through its resource base',async()=>{
  const provider=await createBundledProvider();const {candidates}=await provider.list();
  const skill=await provider.get(candidates.find(c=>c.name==='director'));
  await continuityResource(skill.content,skill.resourceBase.path);
});
