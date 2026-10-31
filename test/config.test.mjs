import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubmitComfyVideo} from '../src/submit-comfy-video.mjs';
import {Config} from '../src/index.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

test('handoff and five workflow names are live settings with safe defaults',()=>{
  const defaultConfig=Config({}),externalConfig=Config({llmHandoffMode:'comfy-only'});
  assert.equal(defaultConfig.llmHandoffMode.get(),'llama-swap');
  assert.equal(externalConfig.llmHandoffMode.get(),'comfy-only');
  const workflowKeys=['workflowTextToImage','workflowImageEdit','workflowReferenceToVideo','workflowFirstLastFrameToVideo','workflowVideoEdit'];
  for(const key of workflowKeys)assert.equal(defaultConfig[key].get(),'');
  const configured=Config({workflowTextToImage:'t2i.json',workflowImageEdit:'edit.json',workflowReferenceToVideo:'ref-video.json',workflowFirstLastFrameToVideo:'flf.json',workflowVideoEdit:'video-edit.json'});
  assert.deepEqual(workflowKeys.map(key=>configured[key].get()),['t2i.json','edit.json','ref-video.json','flf.json','video-edit.json']);
});

test('Director preset keeps questions answerable with a 180-second timed default',async()=>{
  const preset=await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8');
  assert.match(preset,/- id: tool-ask-user\n\s+name: '@deepseek-ai\/dsh-tool-ask-user'\n\s+config:\n\s+mode: timed\n\s+timeout: 180/);
});

test('configured Comfy and swap origins own every network request',async()=>{
  const urls=[];
  const submit=createSubmitComfyVideo({comfyBaseUrl:'http://comfy.example:8000',llamaSwapBaseUrl:'http://swap.example:9000',sleep:async()=>{},fetchImpl:async u=>{
    urls.push(String(u));
    return Response.json(String(u).endsWith('/prompt')?{prompt_id:'p'}:{});
  }});
  await submit({workflow:{1:{class_type:'Test',inputs:{}}}},{concludeTurn(){}});
  assert.deepEqual(urls,['http://comfy.example:8000/prompt','http://swap.example:9000/api/models/unload','http://swap.example:9000/running']);
});
test('comfy-only handoff never resolves or contacts a llama-swap origin',async()=>{
  const urls=[];let concluded=0;
  const submit=createSubmitComfyVideo({comfyBaseUrl:'http://comfy.example:8000',llamaSwapBaseUrl:'not a URL',llmHandoffMode:'comfy-only',startJob:()=> 'j',fetchImpl:async u=>{
    urls.push(String(u));return Response.json({prompt_id:'p'});
  }});
  const result=await submit({workflow:{1:{class_type:'Test',inputs:{}}}},{concludeTurn(){concluded++;}});
  assert.deepEqual(urls,['http://comfy.example:8000/prompt']);
  assert.equal(result.llm_handoff_mode,'comfy-only');assert.equal(result.llm_unload_skipped,true);assert.equal('llm_unloaded' in result,false);assert.equal(concluded,1);
});
test('service redirects cannot forward workflow bytes to another origin',async t=>{
  let forwarded=0;
  const target=createServer((req,res)=>{forwarded++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({prompt_id:'unrelated'}));});
  await new Promise(r=>target.listen(0,'127.0.0.1',r));
  const source=createServer((req,res)=>{
    if(req.url==='/prompt'){res.writeHead(307,{Location:`http://127.0.0.1:${target.address().port}/prompt`});res.end();}
    else{res.setHeader('Content-Type','application/json');res.end('{}');}
  });
  await new Promise(r=>source.listen(0,'127.0.0.1',r));
  t.after(()=>{source.closeAllConnections();source.close();target.closeAllConnections();target.close();});
  const origin=`http://127.0.0.1:${source.address().port}`;
  const submit=createSubmitComfyVideo({comfyBaseUrl:origin,llamaSwapBaseUrl:origin});
  await assert.rejects(submit({workflow:{1:{class_type:'Test',inputs:{}}}},{concludeTurn(){}}),/redirect|fetch failed/i);
  assert.equal(forwarded,0);
});
