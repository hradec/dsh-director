import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubmitComfyVideo} from '../src/submit-comfy-video.mjs';
import {Config} from '../src/index.mjs';
import {createServer} from 'node:http';

test('handoff mode is a live setting with the original shared-GPU default',()=>{
  const defaultConfig=Config({}),externalConfig=Config({llmHandoffMode:'comfy-only'});
  assert.equal(defaultConfig.llmHandoffMode.get(),'llama-swap');
  assert.equal(externalConfig.llmHandoffMode.get(),'comfy-only');
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
