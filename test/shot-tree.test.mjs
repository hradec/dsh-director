// Production tree grouping: shots reach Season▸Episode▸Sequence through their SEQUENCE
// (the timeline API never sends shot.episode_id — 0.2.20 bug put everything in Unassigned).
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import vm from 'node:vm';

async function load(){
  const built=await build({entryPoints:['src/client/studio/vendor/shared/shot-tree.ts'],bundle:true,write:false,format:'cjs',platform:'node'});
  const module={exports:{}};
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url)});
  return module.exports.buildShotTree;
}

test('shots nest under season/episode/sequence via sequence_id; homeless shots stay loose',async()=>{
  const buildShotTree=await load();
  const episodes=[{id:'ep1',title:'Pilot',season:1,order:1},{id:'ep2',title:'S1E2',season:1,order:2},{id:'ep9',title:'S2E1',season:2,order:1}];
  const sequences=[
    {id:'q1',name:'Cold open',episode_id:'ep1',order:1},
    {id:'q2',name:'Development',episode_id:'ep1',order:2},
    {id:'q9',name:'Later',episode_id:'ep9',order:1},
  ];
  const shots=[
    {id:'s1',sequence_id:'q1'},                    // normal: no episode_id field at all
    {id:'s2',sequence_id:'q1'},
    {id:'s3',sequence_id:'q2'},
    {id:'s4',sequence_id:'gone'},                  // unknown sequence, no episode → loose
    {id:'s5',sequence_id:null,episode_id:'ep2'},   // legacy direct episode link → episode's unsequenced group
    {id:'s6'},                                     // homeless → loose
  ];
  // vm realm arrays break strict deepEqual; normalize through JSON.
  const tree=JSON.parse(JSON.stringify(buildShotTree(shots,episodes,sequences)));
  assert.deepEqual(tree.seasons.map(([season,nodes])=>[season,nodes.map(n=>n.episode.id)]),[[1,['ep1','ep2']],[2,['ep9']]]);
  const ep1=tree.seasons[0][1][0];
  assert.deepEqual(ep1.groups.map(g=>[g.sequence?.name??null,g.shots.map(s=>s.id)]),[['Cold open',['s1','s2']],['Development',['s3']]]);
  const ep2=tree.seasons[0][1][1];
  assert.deepEqual(ep2.groups.map(g=>[g.sequence?.name??null,g.shots.map(s=>s.id)]),[[null,['s5']]]);
  assert.deepEqual(tree.loose.map(s=>s.id),['s4','s6']);
});
