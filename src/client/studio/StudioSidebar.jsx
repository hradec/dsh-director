import {useEffect,useRef} from 'react';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {mountStudioFrame} from './StudioRoot.jsx';

function StudioTab({area,label,sessionId,sendDshRequest}){
  const ref=useRef(null),sender=useRef(sendDshRequest);
  sender.current=sendDshRequest;
  useEffect(()=>{
    if(!ref.current)return undefined;
    // ponytail: one sidebar realm shows one session; the bundled fetch shim reads this to scope every Studio API call.
    globalThis.__DSH_DIRECTOR_SESSION__=sessionId??'';
    return mountStudioFrame(ref.current,area,createRoot,React,text=>sender.current?.(text));
  },[area,sessionId]);
  return <iframe ref={ref} title={`Director Studio ${label}`} aria-label={`Director Studio ${label}`} style={{display:'block',width:'100%',height:'100%',minHeight:0,border:0,background:'#cfc6b9'}}/>;
}
export function AssetsTab({sessionId,sendDshRequest}={}){return <StudioTab area="assets" label="Assets" sessionId={sessionId} sendDshRequest={sendDshRequest}/>;}
export function ProductionTab({sessionId,sendDshRequest}={}){return <StudioTab area="production" label="Production" sessionId={sessionId} sendDshRequest={sendDshRequest}/>}
