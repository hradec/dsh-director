import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {createRequire} from 'node:module';
test('built lazy browser factory exposes activation without executing UI side effects',async()=>{
  execFileSync(process.execPath,['scripts/build.mjs']);
  let factory;const require=createRequire(import.meta.url);
  vm.runInNewContext(await readFile('lib/client.js','utf8'),{window:{__ModuleLoader__:{load(row){assert.equal(row.id,'dsh-director');factory=row.factory;}}}});
  const client=factory(require);assert.equal(typeof client.apply,'function');assert.deepEqual(Array.from(client.inject),['slots','conversation','connection','sessions','sidebarRight','sidebarRightTabs','documentPreviews']);
});

test('declared sidebar service activates every Studio tab and opens ComfyUI after activation',async()=>{
  execFileSync(process.execPath,['scripts/build.mjs']);
  let factory,active=true;const require=createRequire(import.meta.url),opened=[],tabs=[],disposers=[];
  const sandbox={window:{__ModuleLoader__:{load(row){factory=row.factory;}}}};
  vm.runInNewContext(await readFile('lib/client.js','utf8'),sandbox);
  const client=factory(require);
  const sidebarRight={openTab(kind,options){assert.equal(this,sidebarRight);opened.push({kind,options});}};
  const ctx=new Proxy({
    effect(fn,label){if(label==='director ComfyUI tab opener'||label?.startsWith('director Studio'))disposers.push(fn());},
    inject(){},
    slots:{inject(_seat,register){return register();},register(){return ()=>{};}},
    sidebarRight,
    sidebarRightTabs:{register(definition){tabs.push(definition.kind);return ()=>{};}},
  },{get(target,name){
    if(name!=='effect'&&name!=='inject'){
      assert.ok(client.inject.includes(name),`cannot get property "${name}" without inject`);
      assert.ok(active,`cannot get required service "${name}" in inactive context`);
    }
    return target[name];
  }});
  client.apply(ctx);active=false;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(tabs.length,7);assert.ok(tabs.includes('director-studio-comfy'));
  assert.equal(sandbox.__DSH_COMFY_BRIDGE__({type:'load-workflow',workflow:{nodes:[]}}),true);
  assert.deepEqual(JSON.parse(JSON.stringify(opened)),[{kind:'director-studio-comfy',options:{params:{}}}]);
  for(const dispose of disposers.reverse())dispose?.();
  assert.equal(sandbox.__DSH_COMFY_BRIDGE__({type:'load-workflow',workflow:{nodes:[]}}),false,'disposed plugin must release its sidebar opener');
});

test('the single Director Studio ask door queues every request as an agent task with no connection or GPU gates',async()=>{
  execFileSync(process.execPath,['scripts/build.mjs']);
  let factory;const require=createRequire(import.meta.url),posted=[],registrations=[],effects=[];
  let connection='connected';
  vm.runInNewContext(await readFile('lib/client.js','utf8'),{window:{__ModuleLoader__:{load(row){factory=row.factory;}}},URL,fetch:async(input,init)=>{if(init?.body)posted.push({url:String(input),body:JSON.parse(init.body)});return {ok:true,json:async()=>[]};},AbortSignal:{timeout:()=>new AbortController().signal},setInterval:()=>0,clearInterval:()=>0,console});
  const client=factory(require),ctx={
    effect(fn,label){if(label?.startsWith('director Studio'))effects.push(fn);},
    inject(){},
    slots:{inject(_seat,register){register();},register(definition,component){registrations.push({definition,component});return ()=>{};}},
    sidebarRightTabs:{register(definition){registrations.push({tab:definition});return ()=>{};}},
    connection:{state:{getSnapshot:()=>connection}},
    sessions:{scope(id){return id==='session-a'?{get(name){return name==='conversation'?{send:async text=>posted.push({url:'main-chat',body:{prompt:text}})}:undefined;}}:undefined;}},
  };
  client.apply(ctx);for(const effect of effects)effect();
  const body=registrations.find(item=>item.definition?.key==='dsh-director-studio-assets');assert.ok(body);
  const sender=body.definition.inject('session-a').sendDshRequest;
  await sender('Create an actor','asset creation');await sender('Prepare a Production shot');
  connection='disconnected';await sender('Even offline the door keeps queueing');
  assert.equal(posted.length,3,'nothing went to the main chat');
  for(const row of posted)assert.equal(row.url,'/director-studio/api/agent-task');
  assert.deepEqual(posted.map((row)=>row.body.label),['asset creation',undefined,undefined]);
  assert.deepEqual(posted.map((row)=>row.body.prompt),['Create an actor','Prepare a Production shot','Even offline the door keeps queueing']);
});
