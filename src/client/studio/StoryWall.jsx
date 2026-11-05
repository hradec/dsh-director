import {useEffect,useMemo,useState} from 'react';
import {fetch as apiFetch} from './fetch-inject.mjs';

// Story wall (Phase 2): third Studio area. Visual-first: kind-color columns, canon as an immovable gray floor,
// big keyword handles on card faces, sentences behind the drawer. Same store rules as the DSH tool — a drag is a PATCH.
const KIND_COLORS={open:'#d9902f',proposed:'#e0b53c',decided:'#3d7eb8',superseded:'#9a938a',canon:'#6b6f76'};
const BOARD_COLUMNS=['open','proposed','decided','superseded'];
const LINK_COLORS={supports:'#8a9ba8',conflicts:'#c0392b',supersedes:'#7f5fc0',requires:'#2e8b57',touches:'#b0a89a'};

const jsonFetch=(path,options)=>apiFetch(path,options).then((r)=>r.json().then((v)=>({ok:r.ok,status:r.status,value:v})));
const postJson=(path,body)=>jsonFetch(path,{method:body.__delete?'DELETE':body.__patch?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k])=>!k.startsWith('__'))))});

function useStory(){
  const [story,setStory]=useState(null);
  const [error,setError]=useState('');
  const reload=()=>jsonFetch('/api/story').then(({ok,value})=>{if(!ok)throw Error(value?.detail||'story API failed');setStory(value);setError('');}).catch((e)=>setError(String(e.message||e)));
  useEffect(()=>{reload();},[]);
  return {story,error,reload,setStory};
}

function issuesFor(story,id){return (story?.issues??[]).filter((issue)=>issue.from===id||issue.to===id);}

function CardFace({story,item,onOpen,onDragStart,draggable}){
  const issues=issuesFor(story,item.id);
  const year=typeof item.story_year==='number'?`Y${item.story_year}`:'';
  return <div draggable={draggable} onDragStart={draggable?(e)=>{e.dataTransfer.setData('text/plain',item.id);onDragStart?.(item.id);}:undefined}
    onClick={()=>onOpen(item)} title={issues.map((i)=>i.detail).join('\n')||item.body}
    className={`dsh-story-card${item.kind==='superseded'?' struck':''}${issues.length?' conflicted':''}${draggable?' grab':''}`}
    style={{borderLeft:`6px solid ${KIND_COLORS[item.kind]}`}}>
    <div className="dsh-story-handle">{item.handle}</div>
    <div className="dsh-story-badges">
      {item.arc?<span className="dsh-story-badge">{item.arc}</span>:null}
      {year?<span className="dsh-story-badge">{year}</span>:null}
      {item.kind==='proposed'?<span className="dsh-story-badge amber">proposed</span>:null}
      {item.kind==='canon'?<span className="dsh-story-badge gray">canon · locked</span>:null}
      {issues.length?<span className="dsh-story-badge red">⚠ {issues.length}</span>:null}
    </div>
  </div>;
}

function Drawer({story,item,onClose,onSaved}){
  const [body,setBody]=useState(item.body??'');
  const [handle,setHandle]=useState(item.handle??'');
  const [linkTo,setLinkTo]=useState('');
  const [linkType,setLinkType]=useState('supports');
  const targets=useMemo(()=>{
    const all=[...(story.decisions??[]).filter(d=>d.id!==item.id).map(d=>({id:d.id,label:`card · ${d.handle}`})),
      ...(story.entities??[]).map(e=>({id:e.id,label:`${e.kind} · ${e.name}`})),
      ...(story.beats??[]).map(b=>({id:b.id,label:`beat · ${b.handle}`}))];
    return all;
  },[story,item.id]);
  const nameOf=(id)=>targets.find((t)=>t.id===id)?.label??story.decisions?.find?.((d)=>d.id===id)?.handle??id;
  const save=(patch)=>postJson(`/api/story/decision/${item.id}`,{__patch:1,...patch}).then(({ok,value})=>{if(!ok){setBody(value?.detail||String(value));return;}onSaved();});
  const issues=issuesFor(story,item.id);
  const isCanoni=item.kind==='canon';
  return <div className="dsh-story-drawer">
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <span className="dsh-story-badge" style={{background:KIND_COLORS[item.kind],color:'#fff'}}>{item.kind}</span>
      <button className="btn ghost sm" onClick={onClose}>✕</button>
    </div>
    <input className="dsh-story-input" value={handle} disabled={isCanoni} onChange={(e)=>setHandle(e.target.value)}/>
    <textarea className="dsh-story-input" rows={5} value={body} disabled={isCanoni} onChange={(e)=>setBody(e.target.value)}/>
    {issues.length?<div className="dsh-story-issues">{issues.map((issue,i)=><div key={i} className="dsh-story-issue">⚠ {issue.detail}</div>)}</div>:null}
    {!isCanoni&&<div style={{display:'flex',gap:'.4rem',flexWrap:'wrap'}}>
      <button className="btn primary sm" onClick={()=>save({kind:'decided'})}>Accept</button>
      <button className="btn ghost sm" onClick={()=>save({kind:'open'})}>Reopen</button>
      <button className="btn ghost sm" onClick={()=>save({kind:'superseded'})}>Strike</button>
      <button className="btn ghost sm" onClick={()=>save({body,handle})}>Save text</button>
      <button className="btn ghost sm" style={{color:'#c0392b'}} onClick={()=>postJson(`/api/story/decision/${item.id}`,{__delete:1}).then(onSaved)}>Delete</button>
    </div>}
    <div className="dsh-story-links">
      <div className="dsh-story-subhead">Links</div>
      {(item.links??[]).map((link,i)=><div key={i} className="dsh-story-link">
        <span style={{color:LINK_COLORS[link.type]}}>●</span> {link.type} → {nameOf(link.to)}
        {!isCanoni&&<button className="btn ghost sm" onClick={()=>save({links:item.links.filter((_,j)=>j!==i)})}>✕</button>}
      </div>)}
      {!isCanoni&&<div style={{display:'flex',gap:'.3rem',marginTop:'.4rem'}}>
        <select className="dsh-story-input" value={linkTo} onChange={(e)=>setLinkTo(e.target.value)}>{['',...targets].map((t,i)=><option key={i} value={t?.id??''}>{t?t.label:'link to…'}</option>)}</select>
        <select className="dsh-story-input" value={linkType} onChange={(e)=>setLinkType(e.target.value)}>{Object.keys(LINK_COLORS).map((t)=><option key={t}>{t}</option>)}</select>
        <button className="btn ghost sm" disabled={!linkTo} onClick={()=>save({links:[...(item.links??[]),{to:linkTo,type:linkType}]})}>Add</button>
      </div>}
    </div>
    <div className="dsh-story-prov">from {item.provenance?.source||'the wall'} · {String(item.created_at||'').slice(0,10)}</div>
  </div>;
}

function Board({story,onOpen,mutated}){
  const [note,setNote]=useState('');
  const [adding,setAdding]=useState('');
  const [newHandle,setNewHandle]=useState('');
  const drop=(kind)=>(e)=>{
    e.preventDefault();
    const id=e.dataTransfer.getData('text/plain');
    postJson(`/api/story/decision/${id}`,{__patch:1,kind}).then(({ok,value})=>{if(!ok){setNote(value?.detail||'move refused');return;}setNote('');mutated();});
  };
  const addCard=(kind)=>{if(!newHandle.trim())return;postJson('/api/story/decision',{handle:newHandle.trim(),kind,arc:''}).then(({ok,value})=>{if(!ok){setNote(value?.detail||'add refused');return;}setNote('');setAdding('');setNewHandle('');mutated();});};
  return <div className="dsh-story-boardwrap">
    <div className="dsh-story-board">
      {BOARD_COLUMNS.map((kind)=>{
        const cards=(story.decisions??[]).filter((d)=>d.kind===kind);
        const byArc=new Map();for(const c of cards){const key=c.arc||'';if(!byArc.has(key))byArc.set(key,[]);byArc.get(key).push(c);}
        return <div key={kind} className="dsh-story-col" onDragOver={(e)=>e.preventDefault()} onDrop={drop(kind)} style={{borderTop:`4px solid ${KIND_COLORS[kind]}`}}>
          <div className="dsh-story-colhead" style={{color:KIND_COLORS[kind]}}>{kind} · {cards.length}
            <button className="btn ghost sm" onClick={()=>{setAdding(kind);setNewHandle('');}}>+ card</button>
          </div>
          {adding===kind&&<div style={{display:'flex',gap:'.3rem'}}><input autoFocus className="dsh-story-input" placeholder="short handle…" value={newHandle} onChange={(e)=>setNewHandle(e.target.value)} onKeyDown={(e)=>e.key==='Enter'&&addCard(kind)}/><button className="btn primary sm" onClick={()=>addCard(kind)}>add</button></div>}
          {[...byArc.entries()].map(([arc,list])=><div key={arc||'-'} className="dsh-story-arc">
            {arc?<div className="dsh-story-arclabel">{arc}</div>:null}
            {list.map((item)=><CardFace key={item.id} story={story} item={item} onOpen={onOpen} draggable/>)}
          </div>)}
        </div>;
      })}
    </div>
    <div className="dsh-story-canon" onDragOver={(e)=>e.preventDefault()}>
      <div className="dsh-story-colhead" style={{color:'#8d949e'}}>canon floor · locked — corpus truth cannot be dragged, by you or by DSH</div>
      <div style={{display:'flex',gap:'.5rem',flexWrap:'wrap'}}>{(story.decisions??[]).filter((d)=>d.kind==='canon').map((item)=><CardFace key={item.id} story={story} item={item} onOpen={onOpen} draggable={false}/>)}</div>
    </div>
    {note?<div className="dsh-story-note">{note}</div>:null}
  </div>;
}

// Map: same lane layout as the board, plus the typed link lines — one store, two projections.
function MapView({story,onOpen}){
  const [hover,setHover]=useState('');
  const layout=useMemo(()=>{
    const lanes=BOARD_COLUMNS.filter((k)=>(story.decisions??[]).some((d)=>d.kind===k));
    const all=[...lanes,'canon'];
    const nodes=new Map();
    all.forEach((kind,ci)=>{
      let y=26;
      for(const item of (story.decisions??[]).filter((d)=>d.kind===kind)){
        const w=Math.max(90,item.handle.length*7.5+24);
        nodes.set(item.id,{x:20+ci*210,y,width:w,height:38,item});
        y+=48+((kind!=='canon'&&!item.arc)?0:0);
      }
    });
    return {nodes,width:20+all.length*210,height:Math.max(...[...nodes.values()].map((n)=>n.y+n.height),120)+30};
  },[story]);
  const edges=[];
  for(const d of story.decisions??[])for(const link of d.links??[]){
    const a=layout.nodes.get(d.id),b=layout.nodes.get(link.to);
    if(!a||!b)continue;
    edges.push({x1:a.x+a.width,y1:a.y+19,x2:b.x,y2:b.y+19,color:LINK_COLORS[link.type],dash:link.type==='supersedes'?'5 4':link.type==='touches'?'2 3':undefined,id:`${d.id}:${link.to}`});
  }
  return <div className="dsh-story-map">
    <svg width={layout.width} height={layout.height} style={{minWidth:layout.width}}>
      {edges.map((edge)=><line key={edge.id} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke={edge.color} strokeWidth="2" strokeDasharray={edge.dash} opacity={hover&&edge.id.startsWith(hover+':')?1:.55}/>)}
      {[...layout.nodes.values()].map(({x,y,width,height,item})=><g key={item.id} onClick={()=>onOpen(item)} onMouseEnter={()=>setHover(item.id)} style={{cursor:'pointer'}}>
        <rect x={x} y={y} width={width} height={height} rx="8" fill={item.kind==='superseded'?'#efece7':'#fff'} stroke={KIND_COLORS[item.kind]} strokeWidth={issuesFor(story,item.id).length?3:2}/>
        {item.kind==='superseded'&&<line x1={x+6} y1={y+height/2} x2={x+width-6} y2={y+height/2} stroke="#9a938a" strokeWidth="2"/>}
        <text x={x+10} y={y+24} fontSize="14" fontWeight="650" fill="#2c2a26">{item.handle.length>26?item.handle.slice(0,25)+'…':item.handle}</text>
      </g>)}
    </svg>
    <div className="dsh-story-legend">{Object.entries(LINK_COLORS).map(([type,color])=><span key={type}><span style={{color}}>●</span> {type}</span>)}</div>
  </div>;
}

// Timeline: two clocks — episode rails on top, world years below; the same beat appears in both, joined.
function Timeline({story,onOpen}){
  const beats=(story.beats??[]).filter((b)=>typeof b.story_year==='number');
  const episodes=(story.episodes??[]).slice().sort((a,b)=>a.order-b.order);
  const byEpisode=new Map();for(const b of (story.episodes??[]).length?story.beats??[]:[]){if(!b.episode_id)continue;(byEpisode.get(b.episode_id)??byEpisode.set(b.episode_id,[]).get(b.episode_id)).push(b);}
  const min=Math.min(...beats.map((b)=>b.story_year),0),max=Math.max(...beats.map((b)=>b.story_year),1);
  const width=Math.max(760,(max-min)*14+120);
  const xOf=(year)=>70+(year-min)*14;
  return <div className="dsh-story-map">
    <svg width={width} height={150+episodes.length*56} style={{minWidth:width}}>
      <text x={10} y={16} fontSize="11" fill="#7d766b">episode order</text>
      {episodes.map((ep,i)=>{
        const y=30+i*56;
        const items=(byEpisode.get(ep.id)??[]).slice().sort((a,b)=>(a.order??0)-(b.order??0));
        return <g key={ep.id}>
          <rect x={70} y={y} width={Math.max(120,items.length*150)} height={40} rx="8" fill="#f4efe6" stroke="#c8beac"/>
          <text x={80} y={y+24} fontSize="12" fill="#514a3d">S{ep.season}E{ep.order} · {ep.title}</text>
          {items.map((beat,j)=>{
            const cx=86+j*150;
            return <g key={beat.id} style={{cursor:'pointer'}} onClick={()=>onOpen(beat)}>
              <rect x={cx-4} y={y+8} width={140} height={24} rx="6" fill="#fff" stroke={issuesFor(story,beat.id).length?'#c0392b':'#8fa6bd'}/>
              <text x={cx+2} y={y+24} fontSize="11" fill="#2c2a26">{beat.handle.length>20?beat.handle.slice(0,19)+'…':beat.handle}</text>
              <line x1={cx+66} y1={y+40} x2={xOf(beat.story_year)} y2={110+episodes.length*56-30} stroke="#b0a89a" strokeDasharray="3 3"/>
            </g>;
          })}
        </g>;
      })}
      <text x={10} y={110+episodes.length*56-40} fontSize="11" fill="#7d766b">world clock (years)</text>
      <line x1={60} y1={110+episodes.length*56-24} x2={width-20} y2={110+episodes.length*56-24} stroke="#8d8474"/>
      {beats.map((beat)=><g key={`w${beat.id}`} style={{cursor:'pointer'}} onClick={()=>onOpen(beat)}>
        <circle cx={xOf(beat.story_year)} cy={110+episodes.length*56-24} r={7} fill={issuesFor(story,beat.id).length?'#c0392b':'#3d7eb8'}/>
        <text x={xOf(beat.story_year)} y={110+episodes.length*56-8} fontSize="10" textAnchor="middle" fill="#514a3d">Y{beat.story_year}</text>
      </g>)}
    </svg>
    {!(story.beats??[]).length?<div className="dsh-story-note">No beats yet — sessions file them with story.beat (handle + story_year + episode), or draw them here next round.</div>:null}
  </div>;
}

export function StoryWall(){
  const {story,error,reload}=useStory();
  const [view,setView]=useState('board');
  const [open,setOpen]=useState(null);
  if(!story)return <div className="app dsh-director-studio-app"><style>{STYLE}</style><WorkspaceNotice text={error||'Loading story wall…'}/></div>;
  const openItem=open?((story.decisions??[]).find((d)=>d.id===open.id)??(story.beats??[]).find((b)=>b.id===open.id)??open):null;
  return <div className="app dsh-director-studio-app dsh-story">
    <style>{STYLE}</style>
    <div className="dsh-story-bar">
      <div className="brand-title">Story wall</div>
      <div className="dsh-story-counts">
        <span style={{color:KIND_COLORS.open}}>open {story.decisions.filter((d)=>d.kind==='open').length}</span>
        <span style={{color:KIND_COLORS.proposed}}>proposed {story.decisions.filter((d)=>d.kind==='proposed').length}</span>
        <span style={{color:KIND_COLORS.decided}}>decided {story.decisions.filter((d)=>d.kind==='decided').length}</span>
        <span style={{color:KIND_COLORS.canon}}>canon {story.decisions.filter((d)=>d.kind==='canon').length}</span>
        {story.issues.length?<span style={{color:'#c0392b'}}>⚠ {story.issues.length}</span>:null}
      </div>
      <div style={{display:'flex',gap:'.35rem'}}>{['board','map','timeline'].map((v)=><button key={v} className={view===v?'btn primary sm':'btn ghost sm'} onClick={()=>setView(v)}>{v}</button>)}</div>
    </div>
    {error?<div className="banner error" role="alert">{error}</div>:null}
    {view==='board'&&<Board story={story} onOpen={setOpen} mutated={reload}/>}
    {view==='map'&&<MapView story={story} onOpen={setOpen}/>}
    {view==='timeline'&&<Timeline story={story} onOpen={setOpen}/>}
    {openItem&&(openItem.handle?true:false)&&<Drawer story={story} item={openItem} onClose={()=>setOpen(null)} onSaved={()=>{setOpen(null);reload();}}/>}
  </div>;
}

function WorkspaceNotice({text}){return <div style={{padding:'1rem'}}>{text}</div>;}

const STYLE=`
.dsh-story-bar{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;padding:.6rem .8rem;border-bottom:1px solid var(--border,#c8beac);}
.dsh-story-counts{display:flex;gap:.8rem;font-size:.85rem;font-weight:650;}
.dsh-story-boardwrap{padding:.7rem;}
.dsh-story-board{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:.7rem;}
.dsh-story-col{background:rgba(255,255,255,.45);border:1px solid #c8beac;border-radius:10px;padding:.5rem;min-height:9rem;display:flex;flex-direction:column;gap:.5rem;}
.dsh-story-colhead{font-weight:700;font-size:.8rem;text-transform:lowercase;display:flex;justify-content:space-between;align-items:center;}
.dsh-story-arc{display:flex;flex-direction:column;gap:.4rem;margin-top:.3rem;}
.dsh-story-arclabel{font-size:.7rem;color:#7d766b;letter-spacing:.04em;}
.dsh-story-card{background:#fff;border:1px solid #d4cbbb;border-radius:8px;padding:.45rem .55rem;box-shadow:0 1px 3px rgba(0,0,0,.08);}
.dsh-story-card.grab{cursor:grab;}
.dsh-story-card.struck .dsh-story-handle{text-decoration:line-through;color:#9a938a;}
.dsh-story-card.conflicted{border-color:#c0392b;box-shadow:0 0 0 2px rgba(192,57,43,.25);}
.dsh-story-handle{font-size:1.05rem;font-weight:700;line-height:1.25;}
.dsh-story-badges{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.3rem;}
.dsh-story-badge{font-size:.65rem;padding:.1rem .4rem;border-radius:999px;background:#efece7;color:#514a3d;}
.dsh-story-badge.amber{background:#f6e3b4;color:#7a5c12;}
.dsh-story-badge.gray{background:#e3e5e8;color:#4a4f57;}
.dsh-story-badge.red{background:#f6d3ce;color:#8f2a1e;}
.dsh-story-canon{margin-top:.9rem;padding:.6rem;background:#e8eaee;border:1px dashed #9aa1ab;border-radius:10px;}
.dsh-story-note{margin-top:.6rem;color:#8f2a1e;font-size:.85rem;}
.dsh-story-drawer{position:fixed;top:4rem;right:.8rem;width:min(24rem,92%);max-height:82%;overflow:auto;background:var(--bg-panel,#fffdf8);border:1px solid #c8beac;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:1rem;z-index:50;display:flex;flex-direction:column;gap:.55rem;}
.dsh-story-input{font:inherit;padding:.3rem .45rem;border:1px solid #c8beac;border-radius:6px;background:#fff;color:#2c2a26;}
.dsh-story-issues{display:flex;flex-direction:column;gap:.3rem;}
.dsh-story-issue{color:#8f2a1e;font-size:.85rem;background:#f6d3ce;border-radius:6px;padding:.3rem .5rem;}
.dsh-story-links{border-top:1px solid #ddd3c2;padding-top:.5rem;}
.dsh-story-subhead{font-size:.75rem;color:#7d766b;margin-bottom:.3rem;}
.dsh-story-link{font-size:.85rem;display:flex;align-items:center;gap:.35rem;}
.dsh-story-prov{font-size:.7rem;color:#948b7c;}
.dsh-story-map{padding:.7rem;overflow:auto;}
.dsh-story-legend{display:flex;gap:.9rem;font-size:.75rem;color:#514a3d;margin-top:.4rem;}
`;
