import React,{useEffect,useRef,useState} from 'react';
import {parseMediaResult} from './media-result.mjs';
import {keepCompletedMediaVisible} from './media-visibility.mjs';
import {MediaDialog} from './MediaDialog.jsx';
import {entriesFromChat,proposalState,proposalConfirmationText} from '../proposal-state.mjs';
import {clipReferenceLists} from '../shot-proposal.mjs';
const chatSnapshot=s=>s;
const statusLabels={confirmed:'Confirmed',auto_authorized:'Authorized for unattended continuation',awaiting_display:'Waiting for card display acknowledgement',superseded:'Superseded',invalid_references:'Invalid references',references_pending:'References pending',changes_requested:'Changes requested',unverified:'Confirmation unverified',awaiting_confirmation:'Awaiting confirmation'};

function MediaItem({item,onEnlarge}){
  const player=useRef(null);const [failed,setFailed]=useState(false);
  const enlarge=event=>{player.current?.pause();onEnlarge({item,inline:player.current,opener:event.currentTarget,startTime:player.current?.currentTime||0});};
  return <figure className={`dsh-director-item dsh-director-${item.type}`}>
    {item.type==='video'?<video ref={player} src={item.url} controls playsInline preload="metadata" onError={()=>setFailed(true)}/>:
      item.type==='audio'?<audio src={item.url} controls preload="metadata" onError={()=>setFailed(true)}/>:
      <button className="dsh-director-image-button" data-action="enlarge" onClick={enlarge} aria-label={`Enlarge ${item.label||item.filename}`}><img loading="lazy" src={item.url} alt={item.label||item.filename} onError={()=>setFailed(true)}/></button>}
    <figcaption><strong>{item.label||item.filename}</strong>
      {item.label&&item.label!==item.filename&&<span>{item.filename}</span>}
      {item.responsibility&&<span>Role: {item.responsibility}</span>}
      {item.caption&&<span>{item.caption}</span>}
      {item.shot_id&&<span>{item.shot_id}</span>}
      <div className="dsh-director-actions">{item.type==='video'&&<button data-action="enlarge" onClick={enlarge}>Enlarge</button>}<a href={item.url} download={item.filename}>Download</a></div>
    </figcaption>
    {failed&&<p role="alert">Media unavailable or unsupported. Use Download, or ask the agent to display it again.</p>}
  </figure>;
}
function containsCall(root,id){return root?.callId===id||(root?.subCalls??[]).some(child=>containsCall(child,id));}
export function MediaCard({block,sessionId,useChat,leadingIcon,turnClosed,sendConfirmation}){
  const cardRef=useRef(null);
  const snapshot=useChat?.(chatSnapshot);
  const result=parseMediaResult(block,sessionId),[selected,setSelected]=useState(null);
  const [confirming,setConfirming]=useState(false),[confirmationError,setConfirmationError]=useState('');
  const [presentation,setPresentation]=useState(null),[presentationError,setPresentationError]=useState('');
  const proposal=result.kind==='ready'?result.proposal:undefined,hasProposal=Boolean(proposal);
  const hasPresentationState=result.kind==='ready'&&typeof result.card_displayed==='boolean';
  const localPresentedAt=presentation&&presentation.card_id===result.card_id?presentation.presentedAt:undefined;
  const presentedAt=result.kind==='ready'?(result.presented_at??localPresentedAt):undefined;
  const displayAcknowledged=!hasPresentationState||result.card_displayed===true||Number.isFinite(localPresentedAt);
  useEffect(()=>{
    if(!hasProposal||!result.card_id||!sessionId||!hasPresentationState)return;
    if(result.card_displayed===true){if(Number.isFinite(result.presented_at))setPresentation({card_id:result.card_id,presentedAt:result.presented_at});return;}
    if(typeof fetch!=='function'){setPresentationError('The review card display could not be verified; its Confirm button remains unavailable.');return;}
    let active=true;
    fetch('/director-media/presented',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:sessionId,card_id:result.card_id})}).then(async response=>{
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const value=await response.json();
      if(!Number.isSafeInteger(value?.presented_at)||value.presented_at<=0)throw Error('Invalid presentation acknowledgement.');
      if(active){setPresentation({card_id:result.card_id,presentedAt:value.presented_at});setPresentationError('');}
    }).catch(()=>{if(active)setPresentationError('The review card display could not be verified; its Confirm button remains unavailable.');});
    return()=>{active=false;};
  },[hasProposal,result.card_id,result.card_displayed,result.presented_at,hasPresentationState,sessionId]);
  const owner=snapshot?.order?.map(key=>snapshot.nodes.get(key)).find(node=>node?.kind==='tool-call'&&containsCall(node.data.root,block.callId));
  const closed=turnClosed??owner?.location?.turn?.status!=='open';
  const keepVisible=result.kind==='ready'&&(Boolean(result.proposal)||result.items.some(item=>item.type==='video'));
  useEffect(()=>keepVisible&&closed?keepCompletedMediaVisible(cardRef.current):undefined,[keepVisible,closed]);
  if(result.kind==='running')return <div className="dsh-director-card" role="status">Preparing media preview…</div>;
  if(result.kind==='error')return <div className="dsh-director-card" role="alert">{result.message}</div>;
  const close=time=>{if(selected.inline&&Number.isFinite(time))try{selected.inline.currentTime=time;}catch{}setSelected(null);};
  const reviewContext={requirePresentation:hasPresentationState,isPresented:(sid,cid,time)=>sid===sessionId&&cid===result.card_id&&displayAcknowledged&&(time===undefined||Number.isFinite(time)&&Number.isFinite(presentedAt)&&time>=presentedAt)};
  const localReview=proposal?(snapshot?proposalState(entriesFromChat(snapshot),proposal.version,{seq:block.seq,callId:block.callId,card_id:result.card_id},reviewContext):{status:hasPresentationState&&!displayAcknowledged?'awaiting_display':result.review_status==='awaiting_display'?'awaiting_confirmation':result.review_status??(proposal.pending_references?.length?'references_pending':'awaiting_confirmation'),pending:proposal.pending_references??[]}):null;
  const review=result.review_status==='auto_authorized'&&['awaiting_confirmation','awaiting_display','unverified'].includes(localReview?.status)?{...localReview,status:'auto_authorized',authorization_reason:result.authorization_reason}:localReview;
  const confirm=async()=>{
    if(confirming||!displayAcknowledged||review.status!=='awaiting_confirmation')return;
    setConfirming(true);setConfirmationError('');
    try{await sendConfirmation(proposalConfirmationText(result));}
    catch(error){setConfirmationError(error?.message||'Could not send confirmation. Please try again.');}
    finally{setConfirming(false);}
  };
  const clips=proposal?clipReferenceLists(proposal):[];
  const dimensions=new Map(proposal?.clip_dimensions?.map(clip=>[clip.clip_id,clip])??[]);
  const workflows=new Map(proposal?.clip_workflows?.map(clip=>[clip.clip_id,clip])??[]);
  const bound=new Set(clips.flatMap(clip=>clip.reference_numbers));
  return <section ref={cardRef} className="dsh-director-card" aria-label={result.title}><h3>{leadingIcon}{result.title}</h3>
    {result.proposalWarning&&<p role="alert">{result.proposalWarning}</p>}
    {proposal?<div className="dsh-director-proposal" data-proposal-version={proposal.version} data-proposal-status={review.status}>
      <header className="dsh-director-review-header"><strong>Shot &amp; reference review</strong><span>{proposal.version}</span><span>{new Set(proposal.shots.map(shot=>shot.clip_id)).size} clip{new Set(proposal.shots.map(shot=>shot.clip_id)).size===1?'':'s'} / {proposal.shots.length} shot{proposal.shots.length===1?'':'s'}</span><span className="dsh-director-awaiting">{statusLabels[review.status]}</span></header>
      {review.pending.length>0&&<aside className="dsh-director-pending-refs"><h4>Pending reference changes</h4><ul>{review.pending.map((label,i)=><li key={i}>{label}</li>)}</ul></aside>}
      {proposal.clip_references&&<aside><p>All Pictures condition the whole clip. Shot references below describe relevance, not timed inputs.</p>{clips.map(clip=><section data-director-clip-order={clip.clip_id} key={clip.clip_id}><h4>{clip.clip_id} · Picture connection order</h4><ol>{clip.reference_numbers.map((number,i)=><li key={number}>Picture {i+1} → Reference #{number}: {result.items[number-1].label||result.items[number-1].filename}</li>)}</ol></section>)}</aside>}
      {bound.size>0&&<aside data-director-reference-gallery><h4>Reference images</h4><div className="dsh-director-gallery">{result.items.map((item,i)=>bound.has(i+1)&&<div className="dsh-director-bound-ref" key={item.id}><span>Reference #{i+1}</span><MediaItem item={item} onEnlarge={setSelected}/></div>)}</div></aside>}
      {workflows.size>0&&<aside data-director-workflows><h4>Inspected workflow handoff</h4>{[...workflows.values()].map(clip=><section key={clip.clip_id}><strong>{clip.clip_id}: {clip.continuity_mode}</strong><p>Workflow: {clip.workflow_path}</p>{clip.continuity_source&&<p>Source: {clip.continuity_source}</p>}</section>)}</aside>}
      {proposal.shots.map(shot=><article className="dsh-director-shot" data-shot-id={shot.shot_id} key={shot.shot_id}>
        <header><strong>{shot.shot_id}</strong><span>{shot.clip_id}</span><span>{shot.duration_seconds} s</span><span>{dimensions.has(shot.clip_id)?`Planned size: ${dimensions.get(shot.clip_id).width} × ${dimensions.get(shot.clip_id).height}`:'Size not specified'}</span></header>
        <p className="dsh-director-shot-content">{shot.content}</p>
        <dl>{[['Dialogue',shot.dialogue||'No dialogue'],['Incoming state',shot.incoming_state],['Ending state',shot.ending_state],['Transition',shot.transition]].filter(([,text])=>text!==undefined).map(([label,text])=><React.Fragment key={label}><dt>{label}</dt><dd>{text}</dd></React.Fragment>)}</dl>
        {shot.reference_numbers.length?<div className="dsh-director-shot-refs"><strong>Relevant references:</strong> {shot.reference_numbers.map((number,i)=><span key={number}>{i>0?', ':''}Reference #{number}{proposal.clip_references&&` · Picture ${clips.find(c=>c.clip_id===shot.clip_id).reference_numbers.indexOf(number)+1}`}</span>)}</div>:<p className="dsh-director-missing-ref">{proposal.clip_references?(clips.find(c=>c.clip_id===shot.clip_id).reference_numbers.length?'No shot-specific references assigned; clip-wide inputs still apply.':'No references are connected to this clip. Confirm whether any should be added.'):'No references are bound to this shot. Confirm whether any should be added.'}</p>}
      </article>)}
      {result.items.some((_,i)=>!bound.has(i+1))&&<aside><h4>Other media (not bound to these shots)</h4><div className="dsh-director-gallery">{result.items.map((item,i)=>!bound.has(i+1)&&<MediaItem key={item.id} item={item} onEnlarge={setSelected}/>)}</div></aside>}
      <p className="dsh-director-confirm-note">{review.unverifiable?.length?'A reference edit has an invalid saved baseline. Its original image bindings cannot be verified; another full card or confirmation cannot resolve it. Reconcile the intended references with the user before production.':review.status==='awaiting_display'?'The client has not verified that this card rendered. No approval request is active; confirmation remains disabled.':review.status==='auto_authorized'?`Authorized for this request (${result.authorization_reason==='active_goal'?'active goal':result.authorization_reason==='user_instruction'?'current-task instruction':'unattended instruction'}); reference, canvas, duration, workflow and H3 preflight checks still apply.`:review.status==='references_pending'?'This reference list has pending changes and cannot be submitted. Apply the requested add, replace or remove operation to the actual bound images and show a complete revised card.':review.status==='confirmed'?`Confirmed in chat: ${proposal.version}. Video submission must match these actual references.`:review.status==='superseded'?`This version was superseded by ${review.latestVersion}. Review and confirm the latest complete proposal instead.`:<>Use the visible Confirm button to approve {proposal.version}, or describe changes. The button appears only after the client acknowledges this card rendered.</>}</p>
      {result.card_id&&sendConfirmation&&displayAcknowledged&&review.status==='awaiting_confirmation'&&<button type="button" data-action="confirm-proposal" disabled={confirming} onClick={confirm}>{confirming?'Sending confirmation…':`Confirm ${proposal.version}`}</button>}
      {confirmationError&&<p role="alert">{confirmationError}</p>}
    </div>:<div className="dsh-director-gallery">{result.items.map(item=><MediaItem key={item.id} item={item} onEnlarge={setSelected}/>)}</div>}
    {selected&&<MediaDialog item={selected.item} startTime={selected.startTime} opener={selected.opener} onClose={close}/>}</section>;
}
