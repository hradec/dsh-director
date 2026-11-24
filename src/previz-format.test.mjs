// Previz format + standalone bake tests: interpolation semantics, cut handling,
// wording heuristics, and the html scene-block roundtrip (what the mp4 embed reuses).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeScene,sampleTrack,sampleAt,cameraWording,previzPromptNotes,frameCount} from './previz-format.mjs';
import {bakeStandaloneHtml,readEmbeddedScene} from './previz-standalone.mjs';
import {SHAPE_KIT,partsFor,partAngle} from './previz-shapes.mjs';

const scene=normalizeScene({
  shot_id:'c1',fps:24,duration_s:6,width:1280,height:720,
  camera:{fov:40,keys:[{t:0,pos:[0,1,10],look:[0,1,0]},{t:3,pos:[0,1,5],look:[0,1,0]},{t:6,pos:[0,1,5],look:[5,1,0],cut:true}]},
  actors:[{id:'nelare',shape:'wyvern',scale:3,keys:[{t:0,pos:[-5,0,0],params:{legs:0}},{t:6,pos:[5,0,0],params:{legs:2}}]}],
  props:[{shape:'box',pos:[2,0,-3],size:[1,2,1]}],
});

test('defaults fill without capping anything',()=>{
  const d=normalizeScene({camera:{keys:[{t:0,pos:[1,2,3],look:[0,0,0]}]},actors:[{id:'a',keys:[{t:0,pos:[0,0,0]}]}]});
  assert.equal(d.fps,24);assert.equal(d.width,1280);
  assert.equal(d.camera.keys.length,2,'single-key track repeats to a static span');
  assert.equal(d.duration_s,1,'duration derives from the last key');
});

test('sampleTrack lands exactly on keys and eases between',()=>{
  const track=scene.camera;
  assert.deepEqual(sampleTrack(track,0,['pos'],['fov']).pos,[0,1,10]);
  assert.deepEqual(sampleTrack(track,3,['pos'],['fov']).pos,[0,1,5]);
  // At u=0.25 a smootherstep curve is well BEHIND the linear midpoint (0.25→0.104).
  const early=sampleTrack(track,0.75,['pos'],['fov']).pos;
  assert.ok(Math.abs(early[2]-9.482)<0.05,`eased ${early[2]}`);
});

test('a cut key flags the segment that ends on it',()=>{
  assert.equal(sampleTrack(scene.camera,2.9,['pos'],[]).cut,false);
  assert.equal(sampleTrack(scene.camera,3.1,['pos'],[]).cut,true);
  assert.equal(sampleTrack(scene.camera,5.9,['pos'],[]).cut,true);
});

test('actor params interpolate and hinge modes resolve',()=>{
  const s=sampleAt(scene,3);
  const nelare=s.actors.find((a)=>a.id==='nelare');
  assert.deepEqual(nelare.pos,[0,0,0]);
  assert.equal(nelare.params.legs,1);
  const leg=SHAPE_KIT.wyvern.parts.find((p)=>p.mode==='osc');
  assert.ok(Math.abs(partAngle(leg,{legs:0}))<1e-9,'osc at phase zero lands at sin(0)=0');
  assert.ok(partAngle(leg,{legs:.75})>0,'three-quarter cycle swings out');
});

test('partsFor: kits, custom poly, honest fallback',()=>{
  assert.ok(partsFor({shape:'wyvern'}).length>4);
  assert.equal(partsFor({shape:'poly',poly:[[0,0],[1,0],[1,1]]}).length,1);
  assert.ok(partsFor({shape:'mystery'}).length===1,'unknown shape = visible rectangle proxy, not a crash');
});

test('wording names camera moves and marks hard cuts',()=>{
  const rows=cameraWording(scene);
  assert.equal(rows.length,2);
  assert.match(rows[0].camera,/dolly in/);
  assert.match(rows[1].camera,/panning right/);
  assert.equal(rows[1].cut,true);
  assert.match(previzPromptNotes(scene),/nelare moving/);
  const stat=cameraWording(normalizeScene({camera:{keys:[{t:0,pos:[0,1,5],look:[0,1,0]},{t:4,pos:[0,1,5],look:[0,1,0]}]}}));
  assert.match(stat[0].camera,/static frame/);
});

test('frame math: inclusive last frame',()=>{
  assert.equal(frameCount(scene),145);
});

test('bake embeds the scene and reading it back roundtrips — even with </script> in data',()=>{
  const tricky={...scene,title:'a </script> bomb (harmless)'};
  const html=bakeStandaloneHtml(tricky);
  assert.match(html,/type="application\/previz"/);
  const back=readEmbeddedScene(html);
  assert.equal(back.title,'a </script> bomb (harmless)');
  assert.deepEqual(back.camera.keys[0].pos,[0,1,10]);
});
