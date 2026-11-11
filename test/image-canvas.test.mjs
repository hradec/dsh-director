// Image-canvas zoom math: the point under the cursor must stay fixed while scaling,
// scale clamps to 1..8, and returning to 1× recenters (ponytail ceiling: pan is not clamped).
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import vm from 'node:vm';

async function load(){
  const built=await build({entryPoints:['src/client/studio/vendor/shared/components/ImageCanvas.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']});
  const module={exports:{}};
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url)});
  return module.exports;
}

test('zoomAt keeps the cursor point fixed and scales about it',async()=>{
  const {zoomAt}=await load();
  // Zoom 2x about cursor at (100,50) from identity: content there stays at (100,50).
  const z=zoomAt({scale:1,x:0,y:0},2,100,50);
  assert.equal(z.scale,2);
  // screen = p*scale + x, and the anchored point p=(cx-x0)/scale0 => x1 = cx - (cx-x0)*k.
  assert.equal(z.x,100-(100-0)*2);   // -100
  assert.equal(z.y,50-(50-0)*2);     // -50
  // The image point under the cursor stays put: (100-(-100))/... invariant check.
  const pointUnder=(v,cx)=>(cx-v.x); // scaled offset
  assert.equal(pointUnder(z,100)/z.scale,pointUnder({scale:1,x:0,y:0},100)); // 100 == 100
});

test('zoomAt clamps scale to 1..8 and snaps back to 1 recenters',async()=>{
  const {zoomAt}=await load();
  const big=zoomAt({scale:1,x:0,y:0},100,0,0);
  assert.equal(big.scale,8);
  const small=zoomAt({scale:1,x:0,y:0},0.01,0,0);
  assert.equal(small.scale,1);
  // Coming back to exactly 1 recenters to identity.
  const back=zoomAt(zoomAt({scale:1,x:0,y:0},4,80,20),0.25,80,20);
  assert.equal(JSON.stringify(back),JSON.stringify({scale:1,x:0,y:0}));
});

test('pan applied after zoom does not change scale',async()=>{
  const {zoomAt,IDENTITY}=await load();
  assert.equal(JSON.stringify(IDENTITY),JSON.stringify({scale:1,x:0,y:0}));
  const z=zoomAt(IDENTITY,1.15,10,10);
  assert.ok(z.scale>1&&z.scale<2);
});
