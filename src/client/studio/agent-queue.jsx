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
/* Human ruling (2026-11-23): NO fullscreen promotion — the pull-down itself must be readable. */
/* ponytail: fixed ceiling sizing (viewport-relative, not a content clamp); list + log scroll inside. */
.dsh-agent-panel{background:#fffdf8;border:1px solid #c8beac;border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.18);padding:.55rem .65rem;width:min(46rem,calc(100vw - 2rem));max-height:min(72vh,46rem);display:flex;flex-direction:column;gap:.4rem;position:relative;}
.dsh-agent-head{display:flex;align-items:center;justify-content:space-between;font-weight:700;}
.dsh-agent-close{border:1px solid #c8beac;background:#f4efe6;border-radius:8px;padding:.2rem .8rem;cursor:pointer;font-weight:700;}
.dsh-agent-body{position:relative;flex:1;min-height:0;display:flex;}
/* padding-right: keeps row buttons clear of the list scrollbar (human: ≡ was behind it). */
.dsh-agent-list{flex:1;min-width:0;display:flex;flex-direction:column;gap:.35rem;overflow:auto;min-height:0;padding-right:.45rem;}
.dsh-agent-row{display:flex;align-items:center;gap:.45rem;}
.dsh-agent-label{flex:1;min-width:0;white-space:normal;word-break:break-word;}
.dsh-agent-cancel{border:none;background:#c0392b;color:#fff;border-radius:6px;width:1.35rem;height:1.35rem;cursor:pointer;font-weight:700;line-height:1;flex:0 0 auto;}
/* The log covers the task rows INSIDE this same window (absolute overlay, own scroll) — head + Close ✕ stay visible above it. */
.dsh-agent-log{position:absolute;inset:0;background:#fffdf8;border:1px solid #c8beac;border-radius:8px;display:flex;flex-direction:column;min-height:0;}
.dsh-agent-log-head{display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;border-bottom:1px solid #eee5d6;font-weight:700;}
.dsh-agent-log-body{white-space:pre-wrap;overflow:auto;padding:.5rem .6rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;line-height:1.45;min-height:0;flex:1;}
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
  useEffect(()=>{
    if(!open)return undefined;
    // Esc closes the log overlay first, then the panel — no fullscreen anywhere.
    const onKey=(e)=>{if(e.key!=='Escape')return;if(showResult!==null)setShowResult(null);else setOpen(false);};
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[open,showResult]);
  const active=list.filter((t)=>t.status==='running'||t.status==='pending').length;
  const logTask=showResult!==null?list.find((t)=>t.id===showResult)??{}:null;
  return <div className="dsh-agent-window">
    <style>{WINDOW_STYLE}</style>
    {open?<div className="dsh-agent-panel">
      <div className="dsh-agent-head"><span>DSH queue</span><button className="dsh-agent-close" onClick={()=>setOpen(false)}>Close ✕</button></div>
      <div className="dsh-agent-body">
        <div className="dsh-agent-list">
          {!list.length?<span className="dsh-agent-pending">Queue empty — studio requests run as background DSH workers.</span>:null}
          {[...list].reverse().map((t)=><div key={t.id} className={`dsh-agent-row dsh-agent-${t.status}`}>
            <span>{t.status==='pending'?'⏳':t.status==='running'?'⚙':t.status==='done'?'✓':t.status==='cancelled'?'∅':'✗'}</span>
            <span className="dsh-agent-label" title={t.preview??t.label}>{t.label}</span>
            {t.status==='pending'?<button className="dsh-agent-cancel" title="cancel" onClick={()=>cancelAgentTask(t.id)}>✕</button>:null}
            {(t.status==='done'||t.status==='failed')&&<button className="dsh-agent-cancel" style={{background:'#8a9ba8'}} title="show result" onClick={()=>setShowResult(showResult===t.id?null:t.id)}>≡</button>}
          </div>)}
        </div>
        {logTask&&<div className="dsh-agent-log">
          <div className="dsh-agent-log-head"><button className="dsh-agent-cancel" style={{background:'#8a9ba8'}} title="back to queue" onClick={()=>setShowResult(null)}>‹</button><span className="dsh-agent-label">{logTask.label??''}</span></div>
          <div className="dsh-agent-log-body">{logTask.result??''}</div>
        </div>}
      </div>
    </div>:null}
    <button className={`dsh-agent-toggle${active?' busy':''}`} onClick={()=>setOpen(!open)}>{active?`DSH workers: ${active} active`:'DSH queue'}</button>
  </div>;
}
