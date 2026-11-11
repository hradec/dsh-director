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
