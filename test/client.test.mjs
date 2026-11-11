import test from 'node:test';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {createRequire} from 'node:module';import vm from 'node:vm';
import {JSDOM} from 'jsdom';import React,{act} from 'react';import {createRoot} from 'react-dom/client';

test('real media card enlarges, pauses both players and restores focus on close',async()=>{
  const built=await build({entryPoints:['src/client/MediaCard.jsx'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom'],jsx:'automatic'});
  const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url)});
  const {MediaCard}=module.exports;
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3080'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  let pauses=0;dom.window.HTMLMediaElement.prototype.pause=function(){pauses++;};
  const id='v'.repeat(43),url=`/director-media/${id}?session=s`;
  const result={kind:'director-media',version:1,session_id:'s',title:'Shot review',items:[{id,type:'video',mime:'video/mp4',filename:'clip.mp4',label:'My clip',caption:'Review me',responsibility:'continuity',url}]};
  const block={kind:'tool-result',isError:false,content:[{type:'text',text:JSON.stringify(result)}]};
  const root=createRoot(document.getElementById('root'));
  await act(()=>root.render(React.createElement(MediaCard,{block,sessionId:'s'})));
  assert.match(document.querySelector('figcaption').textContent,/clip\.mp4/);
  assert.match(document.querySelector('figcaption').textContent,/continuity/);
  const inline=document.querySelector('video');assert.ok(inline.controls);assert.equal(inline.autoplay,false);
  const enlarge=document.querySelector('[data-action="enlarge"]');enlarge.focus();
  await act(()=>enlarge.click());assert.ok(document.querySelector('dialog').open);assert.equal(document.querySelectorAll('video').length,2);
  await act(()=>document.querySelector('[data-action="close"]').click());
  assert.equal(document.querySelector('dialog'),null);assert.equal(document.activeElement,enlarge);assert.ok(pauses>=2);
  const malformed={...result,items:[{...result.items[0],caption:{bad:true}}]};
  await act(()=>root.render(React.createElement(MediaCard,{block:{...block,content:[{type:'text',text:JSON.stringify(malformed)}]},sessionId:'s'})));
  assert.match(document.querySelector('[role="alert"]').textContent,/metadata.*invalid|unsafe media URL/);
  await act(()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document;
});

test('multi-image card Compare button swaps gallery for tabs + wipe slider',async()=>{
  const built=await build({entryPoints:['src/client/MediaCard.jsx'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom'],jsx:'automatic'});
  const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url)});
  const {MediaCard}=module.exports;
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3080'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const a='a'.repeat(43),b='b'.repeat(43);
  const result={kind:'director-media',version:1,session_id:'s',title:'frame 60: vendor 2K vs AILab 2K',items:[
    {id:a,type:'image',mime:'image/png',filename:'vendor.png',label:'vendor streamed 2K',url:`/director-media/${a}?session=s`},
    {id:b,type:'image',mime:'image/png',filename:'ailab.png',label:'AILab node 2K',url:`/director-media/${b}?session=s`},
  ]};
  const block={kind:'tool-result',isError:false,content:[{type:'text',text:JSON.stringify(result)}]};
  const root=createRoot(document.getElementById('root'));
  await act(()=>root.render(React.createElement(MediaCard,{block,sessionId:'s'})));
  // gallery by default, no compare widget yet
  assert.ok(document.querySelector('.dsh-director-gallery'));assert.equal(document.querySelector('input[type=range]'),null);
  const compare=document.querySelector('button[data-action="compare"]');assert.ok(compare);assert.equal(compare.textContent,'Compare');
  await act(()=>compare.click());
  assert.equal(document.querySelector('.dsh-director-gallery'),null);assert.equal(document.querySelector('input[type=range]')?.value,'50');
  const tabs=[...document.querySelectorAll('.image-compare-tabs button')];assert.deepEqual(tabs.map(t=>t.textContent),['vendor streamed 2K','AILab node 2K']);
  assert.equal(tabs[0].getAttribute('aria-selected'),'true');assert.equal(tabs[1].getAttribute('aria-selected'),'false');
  const top=()=>document.querySelector('.compare-top').getAttribute('alt');
  assert.equal(top(),'vendor streamed 2K (A)');
  await act(()=>tabs[1].click());assert.equal(top(),'AILab node 2K (A)'); // tab click makes it the top image
  await act(()=>document.querySelector('[aria-label="Swap A and B"]').click());assert.equal(top(),'vendor streamed 2K (A)');
  await act(()=>document.querySelector('button[data-action="compare"]').click());
  assert.ok(document.querySelector('.dsh-director-gallery'));assert.equal(document.querySelector('input[type=range]'),null);
  // single-image cards never offer compare
  await act(()=>root.render(React.createElement(MediaCard,{block:{...block,content:[{type:'text',text:JSON.stringify({...result,items:[result.items[0]]})}]},sessionId:'s'})));
  assert.equal(document.querySelector('button[data-action="compare"]'),null);
  await act(()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document;
});

test('session media rail stacks versions, merges library and registered media, no close button standalone',async()=>{
  const built=await build({entryPoints:['src/client/studio/MediaRail.jsx'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom'],jsx:'automatic'});
  const module={exports:{}};
  const assets=[
    {kind:'actors',name:'Mia',files:{master:'v1.png'},urls:{master:'/director-studio/api/f/1'},created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'},
    {kind:'actors',name:'Mia',files:{master:'v2.png'},urls:{master:'/director-studio/api/f/2'},created_at:'2026-11-02T00:00:00Z',updated_at:'2026-11-02T00:00:00Z'},
  ];
  const media={items:[{id:'d'.repeat(43),type:'video',mime:'video/mp4',filename:'clip.mp4',size:9,url:'/director-media/d?session=s',at:'2026-11-03T00:00:00Z'}]};
  const sandbox={Headers:globalThis.Headers,Request:globalThis.Request,Response:globalThis.Response,URL:globalThis.URL,__DSH_DIRECTOR_SESSION__:'s'};
  sandbox.globalThis=sandbox;
  sandbox.fetch=async(input)=>({json:async()=>String(input).includes('director-media/list')?media:assets});
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),...sandbox});
  const {MediaRail}=module.exports;
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3080'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const root=createRoot(document.getElementById('root'));
  await act(async()=>{root.render(React.createElement(MediaRail,{}));});
  assert.equal(document.querySelector('[aria-label="Close media rail"]'),null); // standalone has no ✕
  assert.match(document.querySelector('.media-card-versions span').textContent,/v2\/2/); // newest is the face
  assert.ok(document.querySelector('.media-card video')); // registered session video renders
  const imagesFilter=[...document.querySelectorAll('.media-rail-filters button')].find((b)=>b.textContent==='Images');
  await act(()=>imagesFilter.click());
  assert.equal(document.querySelector('.media-card video'),null); // Videos hidden under Images filter
  await act(()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document;
});

test('GenUI media fence takeover: tabs per image, compare wipe toggle, mixed fences untouched',async()=>{
  const built=await build({entryPoints:['src/client/media-fence-enhancer.mjs'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom','react/jsx-runtime'],jsx:'automatic'});
  const dom=new JSDOM(`<div id="root"></div><div class="genui-dom-fence"><div>
    <figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/vendor.png" alt="vendor"><span class="x_mediaLabel">vendor 2K</span></figure>
    <figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/ailab.png" alt="ailab"><span class="x_mediaLabel">AILab 2K</span></figure>
    <figure class="x_media"><video class="x_videoPlayer" src="http://h/u/clip.mp4"></video><span class="x_mediaLabel">clip</span></figure>
  </div></div><div class="genui-dom-fence"><div><figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/one.png"></figure><p>some caption text</p></div></div>`,{url:'http://localhost:3080'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const module={exports:{}};
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),document:dom.window.document,MutationObserver:dom.window.MutationObserver,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,WeakMap,React:globalThis.React??React});
  const {startMediaFenceTakeover}=module.exports;
  const cleanup=startMediaFenceTakeover(dom.window.document);
  await act(async()=>{});
  assert.equal(dom.window.document.querySelectorAll('.dsh-fence-card').length,1); // mixed fence untouched
  assert.match(dom.window.document.querySelectorAll('.genui-dom-fence')[1].textContent,/some caption text/);
  const tabs=[...dom.window.document.querySelectorAll('.dsh-fence-tabs button')];
  assert.deepEqual(tabs.map((b)=>b.textContent),['vendor 2K','AILab 2K']);
  assert.equal(dom.window.document.querySelector('.dsh-fence-card .image-canvas img').src,'http://h/u/vendor.png');
  await act(()=>tabs[1].click());
  assert.equal(dom.window.document.querySelector('.dsh-fence-card .image-canvas img').src,'http://h/u/ailab.png');
  const compare=dom.window.document.querySelector('.dsh-fence-mode');
  await act(()=>compare.click());
  assert.ok(dom.window.document.querySelector('.dsh-fence-card .image-compare-stage'));
  assert.ok(dom.window.document.querySelector('.dsh-fence-card .image-compare-bar input[type="range"]'));
  assert.equal(dom.window.document.querySelectorAll('.dsh-fence-videos video').length,1); // video kept as player below
  await act(()=>compare.click());
  assert.equal(dom.window.document.querySelector('.dsh-fence-card .image-compare-stage'),null); // back to viewer
  cleanup();await act(async()=>{});dom.window.close();delete globalThis.window;delete globalThis.document;
});

test('dragging one chat card onto another merges images into one tabbed card; reset restores',async()=>{
  const built=await build({entryPoints:['src/client/media-fence-enhancer.mjs'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom','react/jsx-runtime'],jsx:'automatic'});
  const dom=new JSDOM(`<div id="root"></div>
    <div class="msg"><div class="genui-dom-fence"><div><figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/a.png"><span class="x_mediaLabel">vendor</span></figure></div></div></div>
    <div class="msg"><div class="genui-dom-fence"><div><figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/b.png"><span class="x_mediaLabel">AILab</span></figure></div></div></div>`,{url:'http://localhost:3080'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const module={exports:{}};
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),document:dom.window.document,MutationObserver:dom.window.MutationObserver,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,WeakMap,Set,React:globalThis.React??React});
  const {startMediaFenceTakeover}=module.exports;
  const cleanup=startMediaFenceTakeover(dom.window.document);
  await act(async()=>{});
  const [cardA,cardB]=dom.window.document.querySelectorAll('.dsh-fence-card');
  const payload={};
  const dragStart=new dom.window.Event('dragstart',{bubbles:true,cancelable:true});
  dragStart.dataTransfer={clearData(){},setData:(t,v)=>{payload[t]=v;},effectAllowed:''};
  await act(()=>cardB.dispatchEvent(dragStart));
  assert.ok(JSON.parse(payload['application/x-director-media'])[0].src.endsWith('/b.png'));
  const drop=new dom.window.Event('drop',{bubbles:true,cancelable:true});
  drop.dataTransfer={getData:(t)=>payload[t]??''};
  await act(()=>cardA.dispatchEvent(drop));
  const tabs=()=>[...cardA.querySelectorAll('.dsh-fence-tabs button')].map((b)=>b.textContent);
  assert.deepEqual(tabs(),['vendor','AILab']);
  const again=new dom.window.Event('drop',{bubbles:true,cancelable:true});
  again.dataTransfer={getData:(t)=>payload[t]??''};
  await act(()=>cardA.dispatchEvent(again));
  assert.deepEqual(tabs(),['vendor','AILab']); // dedupe by src: dropped twice stays one tab
  const reset=cardA.querySelector('.dsh-fence-reset');assert.ok(reset);
  await act(()=>reset.click());
  assert.equal(cardA.querySelector('.dsh-fence-tabs'),null); // back to the single original image
  assert.ok(cardB.isConnected); // source card untouched
  cleanup();await act(async()=>{});dom.window.close();delete globalThis.window;delete globalThis.document;
});

test('three consecutive one-image fences auto-group into one three-tab card; reset splits back',async()=>{
  const built=await build({entryPoints:['src/client/media-fence-enhancer.mjs'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom','react/jsx-runtime'],jsx:'automatic'});
  const dom=new JSDOM(`<div id="root"></div><div class="msg">
    <div class="genui-dom-fence"><div><figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/orig.png"><span class="x_mediaLabel">original</span></figure></div></div>
    <div class="genui-dom-fence"><div><figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/v1.png"><span class="x_mediaLabel">Real-ESRGAN</span></figure></div></div>
    <div class="genui-dom-fence"><div><figure class="x_media"><img class="x_mediaPlayer" src="http://h/u/v2.png"><span class="x_mediaLabel">4x-UltraSharp</span></figure></div></div>
  </div>`,{url:'http://localhost:3080'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const module={exports:{}};
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),document:dom.window.document,MutationObserver:dom.window.MutationObserver,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,WeakMap,Set,React:globalThis.React??React});
  const {startMediaFenceTakeover}=module.exports;
  const cleanup=startMediaFenceTakeover(dom.window.document);
  await act(async()=>{});
  const cards=()=>[...dom.window.document.querySelectorAll('.dsh-fence-card')];
  assert.equal(cards().length,1); // the agent split it; the plugin re-joined it
  assert.deepEqual([...cards()[0].querySelectorAll('.dsh-fence-tabs button')].map((b)=>b.textContent),['original','Real-ESRGAN','4x-UltraSharp']);
  assert.ok(cards()[0].querySelector('.dsh-fence-mode')); // compare available across the group
  await act(()=>cards()[0].querySelector('.dsh-fence-reset').click());
  assert.equal(cards().length,3); // reset restores the fence's own cards
  assert.deepEqual(cards().map((c)=>c.querySelector('.dsh-fence-title').textContent),['original','Real-ESRGAN','4x-UltraSharp']);
  cleanup();await act(async()=>{});dom.window.close();delete globalThis.window;delete globalThis.document;
});
