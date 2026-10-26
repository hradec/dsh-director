import test from 'node:test'
import assert from 'node:assert/strict'
import {createSubmitComfyVideo} from '../src/submit-comfy-video.mjs'

const GiB = 1024 ** 3
const graph = {1: {class_type: 'Test', inputs: {}}}
const idle = {queue_running: [], queue_pending: []}
function stats(free = 23 * GiB, reserved = 0) {
  return {devices: [{name: 'cuda:0', type: 'cuda', index: 0, vram_total: 24 * GiB,
    vram_free: free, torch_vram_total: reserved, torch_vram_free: 0}]}
}
async function run({history, queue = () => idle, memory = () => stats(), freeStatus = 200, llmHandoffMode = 'llama-swap'} = {}) {
  let hooks, clock = 0
  const calls = []
  const submit = createSubmitComfyVideo({
    llmHandoffMode,
    startJob(spec) {hooks = spec.run(); return 'j'},
    now: () => clock, releaseTimeoutMs: 5, historyPollIntervalMs: 1, handoffRetryIntervalMs: 1,
    sleep: async ms => {clock += ms},
    fetchImpl: async (url, init = {}) => {
      const path = new URL(url).pathname
      calls.push({path, method: init.method ?? 'GET', body: init.body})
      if (path === '/prompt') return Response.json({prompt_id: 'p'})
      if (path === '/history/p') return Response.json({p: history ?? {
        status: {completed: true, status_str: 'success'},
        outputs: {1: {videos: [{filename: 'clip.mp4', type: 'output'}]}}}})
      if (path === '/queue') return Response.json(queue())
      if (path === '/system_stats') return Response.json(memory())
      if (path === '/free') return new Response('', {status: freeStatus})
      if (path === '/api/models/unload' || path === '/running') return Response.json({})
      throw new Error(`Unexpected ${path}`)
    },
  })
  await submit({workflow: graph}, {agent: {id: 's'}, concludeTurn() {calls.push({path: 'conclude'})}})
  return {outcome: await hooks.done, calls}
}

test('completion waits for idle queue and actual VRAM headroom, not just /free 200', async () => {
  let queues = 0, samples = 0
  const {outcome, calls} = await run({
    queue: () => ++queues === 1 ? {queue_running: [[0, 'other']], queue_pending: []} : idle,
    // Dynamic VRAM can be outside Torch's allocator: reserved=0 alone is not proof.
    memory: () => ++samples === 1 ? stats(8 * GiB, 0) : stats(),
  })
  assert.equal(outcome.status, 'completed')
  const result = JSON.parse(outcome.output)
  assert.ok(result.comfy_release, 'completion must include memory release evidence')
  assert.equal(result.comfy_release.verified, true)
  assert.equal(result.output_files[0], 'clip.mp4')
  assert.ok(samples >= 2)
  const paths = calls.map(c => c.path)
  assert.ok(paths.indexOf('/free') > paths.indexOf('conclude'))
  assert.ok(paths.indexOf('/free') > paths.indexOf('/queue'))
  assert.deepEqual(JSON.parse(calls.find(c => c.path === '/free').body), {unload_models: true, free_memory: true})
  assert.equal(calls.filter(c => c.path === '/prompt').length, 1)
  assert.equal(calls.some(c => c.path === '/interrupt'), false)
})

test('comfy-only completion skips memory release verification and settles at terminal history', async () => {
  const {outcome, calls} = await run({llmHandoffMode: 'comfy-only'})
  assert.equal(outcome.status, 'completed')
  const result = JSON.parse(outcome.output)
  assert.deepEqual(result.comfy_release, {skipped: true, reason: 'external_llm'})
  assert.equal(calls.some(call => call.path === '/free'), false)
  assert.equal(calls.some(call => call.path === '/system_stats'), false)
})

test('a live mode change affects new submissions but not an active monitor',async()=>{
  let mode='comfy-only',promptCount=0,hooks,releaseFirstHistory;
  const firstHistory=new Promise(resolve=>{releaseFirstHistory=resolve}),calls=[];
  const submit=createSubmitComfyVideo({llmHandoffMode:()=>mode,startJob(spec){hooks=spec.run();return `job-${promptCount}`;},sleep:async()=>{},fetchImpl:async url=>{
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/prompt')return Response.json({prompt_id:`p${++promptCount}`});
    if(path==='/api/models/unload'||path==='/running'||path==='/free')return Response.json({});
    if(path==='/queue')return Response.json(idle);
    if(path==='/system_stats')return Response.json(stats());
    if(path.startsWith('/history/')){const id=path.split('/').at(-1);if(id==='p1')await firstHistory;return Response.json({[id]:{status:{completed:true},outputs:{}}});}
    throw Error(`Unexpected ${path}`);
  }});
  const first=await submit({workflow:graph},{agent:{id:'s'},concludeTurn(){}});
  assert.equal(first.llm_handoff_mode,'comfy-only');
  mode='llama-swap';releaseFirstHistory();
  const firstOutcome=await hooks.done;assert.deepEqual(JSON.parse(firstOutcome.output).comfy_release,{skipped:true,reason:'external_llm'});
  assert.equal(calls.includes('/api/models/unload'),false);assert.equal(calls.includes('/free'),false);
  const second=await submit({workflow:graph},{agent:{id:'s'},concludeTurn(){}});
  assert.equal(second.llm_handoff_mode,'llama-swap');assert.equal(second.llm_unloaded,true);
  const secondOutcome=await hooks.done;assert.equal(JSON.parse(secondOutcome.output).comfy_release.verified,true);
  assert.equal(calls.includes('/api/models/unload'),true);assert.equal(calls.includes('/free'),true);
});

test('a failed Comfy execution also releases memory before settling', async () => {
  const {outcome, calls} = await run({history: {
    status: {completed: false, status_str: 'error', messages: [['execution_error', {exception_message: 'CUDA OOM'}]]}, outputs: {},
  }})
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /CUDA OOM/)
  assert.ok(outcome.output, 'failed execution must retain cleanup evidence')
  assert.equal(JSON.parse(outcome.output).comfy_release.verified, true)
  assert.equal(calls.filter(c => c.path === '/free').length, 1)
})

// Unverified-release cases live in handoff-wait.test.mjs: they now stay pending
// and expose saved outputs through the real Harness registry, not hooks.done.

test('status observer sees unload and verified release phases without changing handoff order',async()=>{
  let hooks;const states=[];
  const submit=createSubmitComfyVideo({onGpuState:s=>states.push(s),startJob(spec){hooks=spec.run();return 'j';},sleep:async()=>{},fetchImpl:async url=>{
    const path=new URL(url).pathname;
    if(path==='/prompt')return Response.json({prompt_id:'p'});
    if(path==='/history/p')return Response.json({p:{status:{completed:true},outputs:{}}});
    if(path==='/queue')return Response.json(idle);
    if(path==='/system_stats')return Response.json(stats());
    return Response.json({});
  }});
  await submit({workflow:graph},{concludeTurn(){}});await hooks.done;
  assert.deepEqual(states.map(s=>s.phase),['unloading_llm','generating','waiting_for_vram','ready_for_review']);
  assert.equal(states[1].llm_unloaded,true);assert.equal(states.at(-1).comfy_release.verified,true);
});
test('a faulty optional UI observer cannot prevent unload, monitoring or concludeTurn',async()=>{
  let concluded=0,hooks;const calls=[];
  const submit=createSubmitComfyVideo({onGpuState(){throw Error('bad observer');},startJob(spec){hooks=spec.run();return 'j';},sleep:async()=>{},fetchImpl:async url=>{
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/prompt')return Response.json({prompt_id:'p'});
    if(path==='/history/p')return Response.json({p:{status:{completed:true},outputs:{}}});
    if(path==='/queue')return Response.json(idle);if(path==='/system_stats')return Response.json(stats());return Response.json({});
  }});
  const result=await submit({workflow:graph},{concludeTurn(){concluded++;}});
  assert.equal(result.llm_unloaded,true);assert.equal(concluded,1);assert.equal((await hooks.done).status,'completed');assert.ok(calls.includes('/api/models/unload'));
});

test('fast completion cannot settle before initial LLM unload and concludeTurn', async () => {
  let hooks, finishUnload, settled = false
  const unloading = new Promise(resolve => {finishUnload = resolve})
  const events = []
  const submit = createSubmitComfyVideo({
    startJob(spec) {hooks = spec.run(); hooks.done.then(() => {settled = true}); return 'j'},
    sleep: async () => {},
    fetchImpl: async url => {
      const path = new URL(url).pathname
      if (path === '/prompt') return Response.json({prompt_id: 'p'})
      if (path === '/api/models/unload') {await unloading; return Response.json({})}
      if (path === '/history/p') return Response.json({p: {status: {completed: true}, outputs: {}}})
      if (path === '/queue') return Response.json(idle)
      if (path === '/system_stats') return Response.json(stats())
      if (path === '/free') {events.push('free'); return Response.json({})}
      if (path === '/running') return Response.json({})
      throw new Error(path)
    },
  })
  const submission = submit({workflow: graph}, {concludeTurn() {events.push('conclude')}})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  finishUnload()
  await submission
  await hooks.done
  assert.ok(events.indexOf('free') > events.indexOf('conclude'))
})
