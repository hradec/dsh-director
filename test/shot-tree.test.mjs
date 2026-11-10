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
  return module.exports;
}

test('filter matches title/beat/type/camera motion/arc tag; empty text passes everything',async()=>{
  const {filterShots}=await load();
  const shots=[
    {id:'a',title:'Crane silhouette',script_beat:'Opening',shot_type:'extreme wide',camera_motion:'tilt up',arcs:['arc1']},
    {id:'b',title:'Whip-pan bridge',script_beat:'',shot_type:'bridge',camera_motion:'whip pan',arcs:['test']},
  ];
  assert.deepEqual(filterShots(shots,'').map(s=>s.id),['a','b']);
  assert.deepEqual(filterShots(shots,'CRANE').map(s=>s.id),['a']);
  assert.deepEqual(filterShots(shots,'whip').map(s=>s.id),['b']);
  assert.deepEqual(filterShots(shots,'arc1').map(s=>s.id),['a']);
  assert.deepEqual(filterShots(shots,'tilt up').map(s=>s.id),['a']);
  assert.deepEqual(filterShots(shots,'zzz').map(s=>s.id),[]);
});

test('shots nest under season/episode/sequence via sequence_id; homeless shots stay loose',async()=>{
  const {buildShotTree}=await load();
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

const FIXTURE=()=>{
  const episodes=[{id:'ep1',title:'Pilot',season:1,order:1},{id:'ep2',title:'S1E2',season:1,order:2},{id:'ep9',title:'S2E1',season:2,order:1}];
  const sequences=[{id:'q1',name:'Cold open',episode_id:'ep1',order:1},{id:'q2',name:'Development',episode_id:'ep1',order:2},{id:'q9',name:'Later',episode_id:'ep9',order:1}];
  const shots=[
    {id:'s1',title:'Splash',sequence_id:'q1'},{id:'s2',sequence_id:'q1'},{id:'s3',sequence_id:'q2'},
    {id:'s5',episode_id:'ep2'},{id:'s4'},{id:'s6',sequence_id:'gone'},
  ];
  return {episodes,sequences,shots};
};
const shape=tree=>tree.seasons.map(([s,nodes])=>[s,nodes.map(n=>[n.episode.id,n.groups.filter(g=>g.shots.length).map(g=>g.shots.map(x=>x.id))])]);

test('prune: plain word matches a node name (whole subtree) or shot fields',async()=>{
  const {buildShotTree,pruneShotTree}=await load();
  const {episodes,sequences,shots}=FIXTURE();
  const tree=buildShotTree(shots,episodes,sequences);
  const seasonWord=JSON.parse(JSON.stringify(pruneShotTree(tree,'Season').seasons.map(([s,nodes])=>[s,nodes.map(n=>n.episode.id)])));
  assert.deepEqual(seasonWord,[[1,['ep1','ep2']],[2,['ep9']]]);
  assert.equal(JSON.stringify(shape(pruneShotTree(tree,'Season'))),'[[1,[["ep1",[["s1","s2"],["s3"]]],["ep2",[["s5"]]]]],[2,[["ep9",[]]]]]');
  assert.deepEqual(JSON.parse(JSON.stringify(shape(pruneShotTree(tree,'Cold')))),[[1,[['ep1',[['s1','s2']]]]]]);
  assert.deepEqual(JSON.parse(JSON.stringify(pruneShotTree(tree,'Splash').loose)),[]);
  assert.equal(pruneShotTree(tree,'Splash').seasons[0][1][0].groups[0].shots.length,1);
});

test('prune: slash paths align Season/Episode/Sequence/Shot, empty segment skips a level',async()=>{
  const {buildShotTree,pruneShotTree}=await load();
  const {episodes,sequences,shots}=FIXTURE();
  const tree=buildShotTree(shots,episodes,sequences);
  assert.deepEqual(JSON.parse(JSON.stringify(shape(pruneShotTree(tree,'Season 1/E1')))),[[1,[['ep1',[['s1','s2'],['s3']]]]]]);
  assert.deepEqual(JSON.parse(JSON.stringify(shape(pruneShotTree(tree,'Season 1//cold')))),[[1,[['ep1',[['s1','s2']]]]]]);
  assert.deepEqual(JSON.parse(JSON.stringify(shape(pruneShotTree(tree,'Season 1//cold/splash')))),[[1,[['ep1',[['s1']]]]]]);
  assert.deepEqual(JSON.parse(JSON.stringify(pruneShotTree(tree,'zzz/qqq').seasons)),[]);
});

test('buildShotTree sorts group shots by explicit order',async()=>{
  const {buildShotTree}=await load();
  const episodes=[{id:'ep1',title:'Pilot',season:1,order:1}];
  const sequences=[{id:'q1',name:'Cold open',episode_id:'ep1',order:1}];
  const tree=buildShotTree([{id:'s1',sequence_id:'q1',order:5},{id:'s2',sequence_id:'q1',order:1}],episodes,sequences);
  assert.equal(JSON.stringify(tree.seasons[0][1][0].groups[0].shots.map(s=>s.id)),'["s2","s1"]');
});
