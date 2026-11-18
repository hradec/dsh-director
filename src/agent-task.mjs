// The single DSH door (0.2.65): every Director Studio request spawns a headless agent worker
// (`dsh --profile headless --json`) that runs in the requesting session's workspace and copies that
// session's provider/model/reasoningEffort, so studio work never blocks the main chat.
// ponytail: strict FIFO (one worker at a time); the headless profile's default-model patch is rewritten
// per run, which is race-free only because of the single-flight queue. Upgrade path: N-worker pool +
// per-run profile copies. Cancel is offered for waiting tasks only (a running worker may be killed by
// whoever owns the machine; not exposed here per the request).
import {spawn,execFileSync} from 'node:child_process';
import {readdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';

const dshHome=()=>process.env.DSH_HOME||join(homedir(),'.dsh');
const PROFILE='headless';
const tasks=[];
const pending=[];
let running=null;
let seq=0;
const statePath=()=>join(dshHome(),'director-agent-tasks.json');

function load(){
  try{const rows=JSON.parse(readFileSync(statePath(),'utf8'));
    for(const row of rows){if(row.status==='running'||row.status==='pending'){row.status='failed';row.result='interrupted by server restart';}tasks.push(row);const n=+String(row.id).replace(/\D/g,'');if(n>seq)seq=n;}
    for(const row of tasks)if(row.status==='pending')pending.push(row);
  }catch{}
}
function persist(){
  try{writeFileSync(statePath(),JSON.stringify(tasks.slice(-20)));}catch{}
}
function credentialEnv(){
  // pi-ai providers resolve their apiKeyEnv (e.g. ROUTER_API_KEY) from the environment; the shared
  // credentials file keeps the same values under refs: so workers authenticate exactly like the GUI.
  const env={};
  try{const text=readFileSync(join(dshHome(),'.credentials.yaml'),'utf8');const m=/^refs:\n((?:[ \t]+\S[^\n]*\n?)+)/m.exec(text);
    if(m)for(const line of m[1].split('\n')){const kv=/^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim());if(kv)env[kv[1]]=kv[2];}}catch{}
  return env;
}
export function sessionModelRoute(sessionId){
  // newest provider/model and effort recorded in the session log — the worker runs the SAME model as the main session.
  try{const root=join(dshHome(),'sessions');
    for(const store of readdirSync(root)){const log=join(root,store,String(sessionId),'session.v4.jsonl.zstd');if(!existsSync(log))continue;
      const text=execFileSync('zstd',['-dc',log],{maxBuffer:1024*1024*1024}).toString();
      let route=null,effort=null;
      for(const m of text.matchAll(/"provider":"([^"]+)","model":"([^"]+)"/g))route={provider:m[1],model:m[2]};
      for(const m of text.matchAll(/"reasoningEffort":"([^"]+)"/g))effort=m[1];
      if(route)return {provider:route.provider,model:route.model,effort:effort||'high'};
    }}catch{}
  try{const text=readFileSync(join(dshHome(),'profiles','web','cordis.patch.yml'),'utf8');
    const block=/- id: agent-default-model\n([\s\S]*?)(?=- id: |[\s]*$)/.exec(text);
    if(block){const get=k=>{const m=new RegExp(k+':\\s*(\\S+)').exec(block[1]);return m&&m[1];};
      if(get('provider')&&get('model'))return {provider:get('provider'),model:get('model'),effort:get('reasoningEffort')||'high'};}
  }catch{}
  return null;
}
function patchHeadlessDefault(route){
  const p=join(dshHome(),'profiles',PROFILE,'cordis.patch.yml');
  let text='';try{text=readFileSync(p,'utf8');}catch{}
  text=text.replace(/- id: agent-default-model\n(?:  [^\n]*\n)*/g,'').trim();
  if(text==='[]'||text==='')text='# profile patch maintained by dsh-director (model parity for agent workers)\n';
  const entry=`- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: ${route.provider}\n    model: ${route.model}\n    reasoningEffort: ${route.effort}\n`;
  writeFileSync(p,text.replace(/\n*$/,'\n')+entry);
}
function pump(){
  if(running||!pending.length)return;
  const task=pending.shift();
  running=task;task.status='running';task.started_at=Date.now();persist();
  if(process.env.DSH_AGENT_TASK_FAKE){setTimeout(()=>settle(task,{ok:true,result:'fake worker: '+String(task.prompt).slice(0,120),code:0}),20);return;}
  const route=task.model;
  if(route)patchHeadlessDefault(route);
  const child=spawn(join(dshHome(),'runtime','bin','dsh'),['--profile',PROFILE,'--json',String(task.prompt)],
    {cwd:task.cwd,env:{...process.env,DSH_HOME:dshHome(),...credentialEnv()}});
  let stdout='',stderr='';
  child.stdout.on('data',(d)=>{stdout+=d;let i;while((i=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,i);stdout=stdout.slice(i+1);
    try{const ev=JSON.parse(line);
      if(ev.type==='session')task.worker_session_id=ev.sessionId;
      else if(ev.type==='final')task.result=ev.text;
      else if(ev.type==='error')task.error=ev.message||JSON.stringify(ev);
    }catch{}}});
  child.stderr.on('data',(d)=>{stderr=(stderr+d).slice(-4000);});
  child.on('error',(e)=>settle(task,{ok:false,code:-1,error:String(e.message||e)}));
  child.on('close',(code)=>settle(task,{ok:code===0&&String(task.result??'').length>0,code,error:code!==0?(stderr.trim().split('\n').pop()||`exit ${code}`):task.error}));
}
function settle(task,{ok,result,code,error}){
  if(result!==undefined)task.result=result;
  task.status=ok?'done':'failed';
  if(!ok)task.result=String(error||task.result||`worker exited ${code}`).trim();
  task.finished_at=Date.now();running=null;persist();pump();
}
export function createAgentTasks(){
  if(!tasks.length&&!pending.length)load();
  return {
    async submit({prompt,label,sessionId,cwd}){
      const task={id:'task-'+(++seq),label:String(label||'task').slice(0,120),prompt:String(prompt),status:'pending',created_at:Date.now(),session_id:sessionId,worker_session_id:null,cwd:cwd?resolve(cwd):undefined,model:sessionModelRoute(sessionId)};
      tasks.push(task);pending.push(task);persist();pump();return task;
    },
    list(){return tasks.map(({prompt,...t})=>({...t,preview:String(prompt).split('\n')[0].slice(0,120)}));},
    cancel(id){const i=pending.findIndex((t)=>t.id===id);if(i<0)return null;const [task]=pending.splice(i,1);task.status='cancelled';task.finished_at=Date.now();persist();return task;},
  };
}
export function agentTaskStoreRootFor(store){return store&&store.workspaceRoot?store.workspaceRoot:dirname(store.root);}
load();
