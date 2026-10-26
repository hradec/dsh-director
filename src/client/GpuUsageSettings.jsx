import React,{useCallback,useState,useSyncExternalStore} from 'react';

export function GpuUsageSettings({form}){
  const subscribe=useCallback(listener=>form.subscribe(listener),[form]);
  const snapshot=useCallback(()=>form.getSnapshot(),[form]);
  const settings=useSyncExternalStore(subscribe,snapshot,snapshot);
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const enabled=settings.value?.llmHandoffMode==='llama-swap';
  const ready=settings.status==='ready';
  const setEnabled=async next=>{
    if(!ready||!settings.writable||saving)return;
    setSaving(true);setError('');
    try{
      if(!await form.set('llmHandoffMode',next?'llama-swap':'comfy-only'))setError('Could not save this setting. Refresh Settings and try again.');
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not save this setting.');}
    finally{setSaving(false);}
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
    {!ready&&<p role="status">Loading Director settings…</p>}
    {ready&&!settings.writable&&<p role="status">Settings are read-only in this profile.</p>}
    {error&&<p className="dsh-director-gpu-setting-error" role="alert">{error}</p>}
  </div>;
}
