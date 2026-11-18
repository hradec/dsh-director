import {useEffect,useState} from 'react';
import {fetch as apiFetch} from './fetch-inject.mjs';

// One door for every Director Studio → DSH request (0.2.65): the server queues them FIFO and each
// runs as a headless agent worker on the session's own model; this window shows the queue with a red
// ✕ to cancel a waiting task. State is a module singleton so every studio tab shows the same queue.
// ponytail: 1.5 s polling (not SSE); cancel only covers waiting tasks by design.

let tasks=[];
const subs=new Set();
let timer=null;
const emit=()=>{for(const fn of subs)fn(tasks.slice());};
async function refresh(){try{const r=await apiFetch('/api/agent-tasks');if(r.ok){tasks=await r.json();emit();}}catch{}}
function ensurePolling(){if(!timer)timer=setInterval(refresh,1500);}

export function askDshAgent(prompt,label){
  ensurePolling();
  return apiFetch('/api/agent-task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt,label})})
    .then((r)=>{if(!r.ok)return r.json().then((e)=>{throw Error(e.detail||('HTTP '+r.status));});void refresh();});
}
export function cancelAgentTask(id){return apiFetch('/api/agent-task/'+id,{method:'DELETE'}).then(()=>refresh());}
export function subscribeAgentTasks(fn){subs.add(fn);fn(tasks.slice());ensurePolling();if(!tasks.length)void refresh();return ()=>subs.delete(fn);}

const WINDOW_STYLE=`
.dsh-agent-window{position:fixed;right:1rem;bottom:1rem;z-index:80;display:flex;flex-direction:column;gap:.4rem;font-size:.82rem;}
.dsh-agent-toggle{border:none;border-radius:999px;padding:.35rem .8rem;background:#e8b64a;color:#2c2a26;font-weight:700;cursor:pointer;}
.dsh-agent-toggle.busy{background:#d98c2f;color:#fff;}
.dsh-agent-panel{background:#fffdf8;border:1px solid #c8beac;border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.18);padding:.55rem .65rem;min-width:20rem;max-width:28rem;max-height:50vh;overflow:auto;display:flex;flex-direction:column;gap:.4rem;}
.dsh-agent-row{display:flex;align-items:center;gap:.45rem;}
.dsh-agent-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-agent-cancel{border:none;background:#c0392b;color:#fff;border-radius:6px;width:1.35rem;height:1.35rem;cursor:pointer;font-weight:700;line-height:1;}
.dsh-agent-result{white-space:pre-wrap;background:#f4efe6;border-radius:6px;padding:.4rem .5rem;max-height:14rem;overflow:auto;}
.dsh-agent-pending .dsh-agent-label{color:#7d766b;}
.dsh-agent-running .dsh-agent-label{color:#b07414;font-weight:650;}
.dsh-agent-done .dsh-agent-label{color:#2e6b3f;}
.dsh-agent-failed .dsh-agent-label{color:#c0392b;}
`;

export function AgentTaskWindow(){
  const [list,setList]=useState([]);
  const [open,setOpen]=useState(false);
  const [showResult,setShowResult]=useState(null);
  useEffect(()=>subscribeAgentTasks(setList),[]);
  const active=list.filter((t)=>t.status==='running'||t.status==='pending').length;
  return <div className="dsh-agent-window">
    <style>{WINDOW_STYLE}</style>
    {open?<div className="dsh-agent-panel">
      {!list.length?<span className="dsh-agent-pending">Queue empty — studio requests run as background DSH workers.</span>:null}
      {[...list].reverse().map((t)=><div key={t.id} className={`dsh-agent-row dsh-agent-${t.status}`}>
        <span>{t.status==='pending'?'⏳':t.status==='running'?'⚙':t.status==='done'?'✓':t.status==='cancelled'?'∅':'✗'}</span>
        <span className="dsh-agent-label" title={t.preview??t.label}>{t.label}</span>
        {t.status==='pending'?<button className="dsh-agent-cancel" title="cancel" onClick={()=>cancelAgentTask(t.id)}>✕</button>:null}
        {(t.status==='done'||t.status==='failed')&&<button className="dsh-agent-cancel" style={{background:'#8a9ba8'}} title="show result" onClick={()=>setShowResult(showResult===t.id?null:t.id)}>≡</button>}
      </div>)}
      {showResult&&<div className="dsh-agent-result">{(list.find((t)=>t.id===showResult)||{}).result??''}</div>}
    </div>:null}
    <button className={`dsh-agent-toggle${active?' busy':''}`} onClick={()=>setOpen(!open)}>{active?`DSH workers: ${active} active`:'DSH queue'}</button>
  </div>;
}
