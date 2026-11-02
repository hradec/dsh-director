import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {createRequire} from 'node:module';
test('built lazy browser factory exposes activation without executing UI side effects',async()=>{
  execFileSync(process.execPath,['scripts/build.mjs']);
  let factory;const require=createRequire(import.meta.url);
  vm.runInNewContext(await readFile('lib/client.js','utf8'),{window:{__ModuleLoader__:{load(row){assert.equal(row.id,'dsh-director');factory=row.factory;}}}});
  const client=factory(require);assert.equal(typeof client.apply,'function');assert.deepEqual(Array.from(client.inject),['slots','conversation','connection','sessions','sidebarRightTabs']);
});

test('Assets request bridge sends to its DSH session only after connection and GPU checks',async()=>{
  execFileSync(process.execPath,['scripts/build.mjs']);
  let factory;const require=createRequire(import.meta.url),sent=[],registrations=[],effects=[];
  let connection='connected',blocked=false,fetches=0;
  vm.runInNewContext(await readFile('lib/client.js','utf8'),{window:{__ModuleLoader__:{load(row){factory=row.factory;}}},URL,fetch:async()=>{fetches++;return {ok:true,json:async()=>({blocked})};},AbortSignal:{timeout:()=>new AbortController().signal},console});
  const client=factory(require),ctx={
    effect(fn,label){if(label?.startsWith('director Studio'))effects.push(fn);},
    inject(){},
    slots:{inject(_seat,register){register();},register(definition,component){registrations.push({definition,component});return ()=>{};}},
    sidebarRightTabs:{register(definition){registrations.push({tab:definition});return ()=>{};}},
    connection:{state:{getSnapshot:()=>connection}},
    sessions:{scope(id){return id==='session-a'?{get(name){return name==='conversation'?{send:async text=>sent.push([id,text])}:undefined;}}:undefined;}},
  };
  client.apply(ctx);for(const effect of effects)effect();
  const body=registrations.find(item=>item.definition?.key==='dsh-director-studio-assets');assert.ok(body);
  const sender=body.definition.inject('session-a').sendDshRequest;
  await sender('Create an actor');await sender('Prepare a Production shot');assert.deepEqual(sent,[['session-a','Create an actor'],['session-a','Prepare a Production shot']]);
  blocked=true;await assert.rejects(sender('Blocked request'),/GPU handoff/);assert.equal(sent.length,2);
  blocked=false;connection='disconnected';const before=fetches;await assert.rejects(sender('Offline request'),/Reconnect/);assert.equal(fetches,before);
});
