import test from 'node:test';
import assert from 'node:assert/strict';
import {h3ReferenceSet,h3ReferenceText,seedScene} from './previz-h3refs.mjs';

test('h3ReferenceSet: cast pictures keep their slots; previz files become the non-asset refs',()=>{
  const shot={id:'c1',refs:[
    {role:'costume',asset_id:'harness',picture_index:2},
    {role:'actor',asset_id:'nelare',picture_index:1,file_key:'bust_threeview'},
  ]};
  const set=h3ReferenceSet(shot,{shot_id:'c1',file:'/w/previz/c1.previz.html',playblast:'/w/previz/c1.previz.mp4',frame0:'/w/previz/c1.frame0.png'});
  assert.deepEqual(set.pictures.map((p)=>p.picture_index),[1,2],'sorted by Picture slot');
  assert.equal(set.pictures[0].file_key,'bust_threeview');
  assert.equal(set.extras[0].path,'/w/previz/c1.frame0.png');
  assert.equal(set.video.path,'/w/previz/c1.previz.mp4');
  const empty=h3ReferenceSet(shot,null);
  assert.deepEqual(empty.extras,[]);assert.equal(empty.video,null);
});
test('h3ReferenceText: every reference is named, with previz labelled as Video 1',()=>{
  const text=h3ReferenceText(h3ReferenceSet({id:'c1',refs:[{role:'actor',asset_id:'nelare',picture_index:1}]},{frame0:'/w/previz/c1.frame0.png',playblast:'/w/previz/c1.previz.mp4'}));
  assert.match(text,/Picture 1 — actor nelare/);
  assert.match(text,/Picture candidate — \/w\/previz\/c1\.frame0\.png/);
  assert.match(text,/Video 1 — \/w\/previz\/c1\.previz\.mp4/);
  assert.match(h3ReferenceText(h3ReferenceSet({id:'c1',refs:[]},null)),/Nothing cast/);
});
test('seedScene: cast drives the starter actors and props, deduped per asset',()=>{
  const scene=seedScene({id:'c1',title:'Flight',duration_s:5.5,refs:[
    {role:'actor',asset_id:'nelare',picture_index:1},
    {role:'costume',asset_id:'nelare',picture_index:2},
    {role:'scene',asset_id:'cliff',picture_index:3},
    {role:'prop',asset_id:'spear',picture_index:4},
  ]});
  assert.deepEqual(scene.actors.map((a)=>a.id),['nelare'],'actor+costume of one asset seed one actor');
  assert.deepEqual(scene.props.map((p)=>p.id),['cliff','spear']);
  assert.equal(scene.duration_s,5.5);assert.equal(scene.shot_id,'c1');
  assert.deepEqual(seedScene({id:'x'}).actors.map((a)=>a.id),['actor'],'uncast shot still gets one placeholder');
  assert.deepEqual(seedScene({id:'y',refs:[{role:'actor',asset_id:'Ast_42 X',picture_index:1}]}).actors[0].id,'ast_42-x','ids stay previz-safe');
});
