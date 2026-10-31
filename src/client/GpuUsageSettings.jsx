import React,{useCallback,useState,useSyncExternalStore} from 'react';

const workflowFields=[
  {key:'workflowTextToImage',label:'Text to image'},
  {key:'workflowImageEdit',label:'Image edit'},
  {key:'workflowReferenceToVideo',label:'Reference to Video'},
  {key:'workflowFirstLastFrameToVideo',label:'First and/or last frame to Video'},
  {key:'workflowVideoEdit',label:'Video Edit'},
];

export function GpuUsageSettings({form}){
  const subscribe=useCallback(listener=>form.subscribe(listener),[form]);
  const snapshot=useCallback(()=>form.getSnapshot(),[form]);
  const settings=useSyncExternalStore(subscribe,snapshot,snapshot);
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const [drafts,setDrafts]=useState({}),[savingNames,setSavingNames]=useState(false);
  const [workflowError,setWorkflowError]=useState(''),[workflowSaved,setWorkflowSaved]=useState('');
  const enabled=settings.value?.llmHandoffMode==='llama-swap';
  const ready=settings.status==='ready';
  const hasWorkflowChanges=workflowFields.some(({key})=>drafts[key]!==undefined&&String(drafts[key]).trim()!==String(settings.value?.[key]??'').trim());
  const setEnabled=async next=>{
    if(!ready||!settings.writable||saving)return;
    setSaving(true);setError('');
    try{
      if(!await form.set('llmHandoffMode',next?'llama-swap':'comfy-only'))setError('Could not save this setting. Refresh Settings and try again.');
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not save this setting.');}
    finally{setSaving(false);}
  };
  const saveWorkflowNames=async()=>{
    if(!ready||!settings.writable||savingNames)return;
    const changed=workflowFields.filter(({key})=>drafts[key]!==undefined).map(field=>({...field,value:String(drafts[field.key]).trim()}));
    const pending=changed.filter(({key,value})=>value!==String(settings.value?.[key]??'').trim());
    if(!pending.length){setDrafts({});return;}
    setSavingNames(true);setWorkflowError('');setWorkflowSaved('');
    const saved=[];
    try{
      for(const field of pending){
        if(!await form.set(field.key,field.value)){setWorkflowError(`Could not save ${field.label}; refresh Settings and try again.`);break;}
        saved.push(field.key);
      }
      if(saved.length){
        setDrafts(previous=>{const next={...previous};for(const key of saved)delete next[key];return next;});
        setWorkflowSaved(`${saved.length} workflow name${saved.length===1?'':'s'} saved.`);
      }
    }catch(cause){setWorkflowError(cause instanceof Error?cause.message:'Could not save the workflow names.');}
    finally{setSavingNames(false);}
  };
  return <div className="dsh-director-settings">
    <h2>Director</h2>
    <div className="dsh-director-gpu-setting">
      <div>
        <label className="dsh-director-gpu-setting-title" htmlFor="director-gpu-usage">Manage Local LLM/ComfyUI GPU Usage</label>
        <p>Enabled uses llama-swap and verified VRAM handoff. Disabled skips local-LLM handoff; use this only when the LLM does not share ComfyUI’s GPU.</p>
      </div>
      <label className="dsh-director-gpu-setting-control">
        <input id="director-gpu-usage" type="checkbox" role="switch" aria-label="Manage Local LLM/ComfyUI GPU Usage" checked={enabled} disabled={!ready||!settings.writable||saving} onChange={event=>void setEnabled(event.currentTarget.checked)}/>
        <span>{saving?'Saving…':enabled?'Enabled':'Disabled'}</span>
      </label>
    </div>
    <section className="dsh-director-workflow-settings" aria-labelledby="director-workflow-settings-title">
      <h3 id="director-workflow-settings-title">ComfyUI workflow names</h3>
      <p>Use the exact saved name returned by <code>director_workflows list</code>, including its <code>.json</code> suffix. A blank field leaves workflow choice unrestricted.</p>
      {workflowFields.map(field=><label className="dsh-director-workflow-field" key={field.key}>
        <span>{field.label}</span>
        <input type="text" aria-label={`${field.label} ComfyUI workflow name`} placeholder="Leave blank for normal selection" value={drafts[field.key]??settings.value?.[field.key]??''} disabled={!ready||!settings.writable||savingNames} onChange={event=>{const value=event.currentTarget.value;setDrafts(previous=>({...previous,[field.key]:value}));}}/>
      </label>)}
      <button type="button" className="dsh-director-workflow-save" disabled={!ready||!settings.writable||savingNames||!hasWorkflowChanges} onClick={()=>void saveWorkflowNames()}>{savingNames?'Saving…':'Save workflow names'}</button>
      {savingNames&&<p role="status">Saving workflow names…</p>}
      {workflowSaved&&<p role="status">{workflowSaved}</p>}
      {workflowError&&<p className="dsh-director-gpu-setting-error" role="alert">{workflowError}</p>}
    </section>
    {!ready&&<p role="status">Loading Director settings…</p>}
    {ready&&!settings.writable&&<p role="status">Settings are read-only in this profile.</p>}
    {error&&<p className="dsh-director-gpu-setting-error" role="alert">{error}</p>}
  </div>;
}
