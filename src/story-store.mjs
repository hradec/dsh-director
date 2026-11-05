import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';

// Story Room (Phase 2): decisions, entities, beats, episodes for the Story wall.
// Capability parity: the studio client and director_studio tool call THESE methods; every rule lives here, so neither hand can bypass a check.
const clone=value=>JSON.parse(JSON.stringify(value));
const safeText=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const stamp=()=>new Date().toISOString();
const id=()=>randomUUID();

const KINDS=new Set(['canon','proposed','decided','open','superseded']);
const LINK_TYPES=new Set(['supports','conflicts','supersedes','requires','touches']);
const BEAT_STATUS=new Set(['draft','decided']);

function kindOf(value,allowed=KINDS){const kind=safeText(value,20).toLowerCase();if(!allowed.has(kind))throw new Error(`Story kind must be one of: ${[...allowed].join(', ')}.`);return kind;}
function linkList(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>40)throw new Error('links must be an array with at most 40 entries.');
  const seen=new Set(),links=[];
  for(const link of value){
    if(!link||typeof link!=='object'||typeof link.to!=='string'||!link.to||!LINK_TYPES.has(link.type))throw new Error('Each link needs {to,type} with a supported type.');
    const key=`${link.to}:${link.type}`;if(seen.has(key))continue;seen.add(key);
    links.push({to:link.to.slice(0,128),type:link.type});
  }
  return links;
}

function initialState(){return {version:1,decisions:[],entities:[],beats:[],episodes:[]};}

// issues = what the wall paints red; computed on every read so tool and UI always show the same conflicts.
function storyIssues(s){
  const issues=[];
  const byId=new Map([...s.decisions,...s.entities,...s.beats].map(item=>[item.id,item]));
  for(const d of s.decisions)for(const link of d.links){
    if(link.type!=='conflicts')continue;
    const other=byId.get(link.to);
    issues.push({kind:'conflict',from:d.id,to:link.to,detail:`"${d.handle}" conflicts with ${other?`"${other.handle}"`:'a removed card'}`});
  }
  const entities=new Map(s.entities.map(e=>[e.id,e]));
  for(const beat of s.beats){
    if(typeof beat.story_year!=='number'||!Number.isFinite(beat.story_year))continue;
    for(const entity of (beat.entity_ids??[]).map(eid=>entities.get(eid)).filter(Boolean)){
      if(entity.death_year!=null&&beat.story_year>entity.death_year)issues.push({kind:'chronology',from:beat.id,to:entity.id,detail:`"${beat.handle}" happens in Y${beat.story_year}, after ${entity.name} died in Y${entity.death_year}`});
      else if(entity.birth_year!=null&&beat.story_year<entity.birth_year)issues.push({kind:'chronology',from:beat.id,to:entity.id,detail:`"${beat.handle}" happens in Y${beat.story_year}, before ${entity.name} was born in Y${entity.birth_year}`});
    }
  }
  return issues;
}

export function createStoryStore({root,now=Date.now}={}){
  if(!root||typeof root!=='string')throw new TypeError('A persistent Story data root is required.');
  root=resolve(root);const statePath=join(root,'story.json');let state,tail=Promise.resolve();
  async function load(){
    if(state)return state;
    await mkdir(root,{recursive:true,mode:0o700});
    try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;state=initialState();}
    if(!state||state.version!==1||!Array.isArray(state.decisions)||!Array.isArray(state.entities)||!Array.isArray(state.beats)||!Array.isArray(state.episodes))throw new Error('Director Story data file is invalid; it was left untouched.');
    return state;
  }
  async function change(mutator){
    const operation=tail.then(async()=>{
      const current=await load(),next=clone(current),result=await mutator(next);
      const temporary=statePath+'.'+randomUUID()+'.part';let handle;
      try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(next));await handle.sync();await handle.close();handle=undefined;await rename(temporary,statePath);state=next;}
      finally{await handle?.close();await unlink(temporary).catch(()=>{});}
      return result;
    });
    tail=operation.catch(()=>{});return operation;
  }
  function decision(input,s,{forceProposed=false}={}){
    const handle=safeText(input.handle,80);if(!handle)throw new Error('A decision needs a short handle (the card title).');
    let kind=kindOf(input.kind??'open');
    if(forceProposed)kind='proposed';// harvested candidates are always PROPOSED: the human decides on the wall.
    const existing=s.decisions.find(d=>d.handle.toLowerCase()===handle.toLowerCase()&&d.kind!=='superseded');
    if(existing)throw new Error(`A card "${existing.handle}" already exists (id ${existing.id}). Update it instead of duplicating.`);
    return {id:id(),handle,body:safeText(input.body,4000),kind,arc:safeText(input.arc,80),links:linkList(input.links),
      provenance:{source:safeText(input.provenance?.source,200),date:input.provenance?.date||stamp()},created_at:stamp(),updated_at:stamp()};
  }
  function needDecision(s,decisionId){const item=s.decisions.find(d=>d.id===decisionId);if(!item)throw new Error('Decision card not found.');return item;}

  return {
    root,
    async story(){const s=await load();return {decisions:clone(s.decisions),entities:clone(s.entities),beats:clone(s.beats),episodes:clone(s.episodes),issues:storyIssues(s)};},
    async logDecision(input={}){return change(s=>{const item=decision(input,s);s.decisions.push(item);return clone(item);});},
    async harvest(items=[]){
      if(!Array.isArray(items)||!items.length||items.length>60)throw new Error('harvest needs 1-60 candidate decisions.');
      return change(s=>{const created=[],skipped=[];
        for(const input of items){
          try{created.push(decision(input,s,{forceProposed:true}));}
          catch(error){skipped.push({handle:safeText(input?.handle,80),reason:error.message});}
        }
        s.decisions.push(...created);return {created:clone(created),skipped};
      });
    },
    async updateDecision(decisionId,input={}){
      return change(s=>{
        const item=needDecision(s,decisionId);
        if(item.kind==='canon')throw new Error('Canon cards are immutable — that rule applies to your drag and to DSH alike.');
        if(input.handle!==undefined){const handle=safeText(input.handle,80);if(!handle)throw new Error('A decision needs a handle.');item.handle=handle;}
        if(input.body!==undefined)item.body=safeText(input.body,4000);
        if(input.arc!==undefined)item.arc=safeText(input.arc,80);
        if(input.kind!==undefined){
          const kind=kindOf(input.kind);
          if(kind==='canon')throw new Error('Canon is only set at creation, never by editing.');
          item.kind=kind;// proposed→decided (accept), decided↔open, any→superseded (strike) all allowed for both hands.
        }
        if(input.links!==undefined)item.links=linkList(input.links);
        if(input.supersedes)item.links=linkList([...item.links,{to:String(input.supersedes),type:'supersedes'}]);
        item.updated_at=stamp();return clone(item);
      });
    },
    async deleteDecision(decisionId){
      return change(s=>{const item=needDecision(s,decisionId);
        if(item.kind==='canon')throw new Error('Canon cards cannot be deleted.');
        s.decisions=s.decisions.filter(d=>d.id!==decisionId);
        for(const d of s.decisions)d.links=d.links.filter(link=>link.to!==decisionId);
        for(const beat of s.beats)beat.decision_ids=(beat.decision_ids??[]).filter(x=>x!==decisionId);
        return {deleted:decisionId};
      });
    },
    async saveEntity(input={}){
      const name=safeText(input.name,160);if(!name)throw new Error('An entity needs a name.');
      const year=value=>value===null||value===undefined||value===''?null:(Number.isSafeInteger(Number(value))?Number(value):(()=>{throw new Error('Entity years must be integers.');})());
      return change(s=>{
        if(input.entity_id){
          const item=s.entities.find(e=>e.id===input.entity_id);if(!item)throw new Error('Entity not found.');
          item.name=name;item.kind=input.kind==='site'||input.kind==='civ'||input.kind==='thread'?input.kind:'figure';
          item.legends_id=input.legends_id===undefined?item.legends_id:safeText(String(input.legends_id),32);
          item.birth_year=input.birth_year!==undefined?year(input.birth_year):item.birth_year;
          item.death_year=input.death_year!==undefined?year(input.death_year):item.death_year;
          item.updated_at=stamp();return clone(item);
        }
        const item={id:input.entity_id||id(),name,kind:input.kind==='site'||input.kind==='civ'||input.kind==='thread'?input.kind:'figure',
          legends_id:safeText(input.legends_id===undefined?'':String(input.legends_id),32)||null,birth_year:year(input.birth_year),death_year:year(input.death_year),
          notes:safeText(input.notes,2000),created_at:stamp(),updated_at:stamp()};
        s.entities.push(item);return clone(item);
      });
    },
    async deleteEntity(entityId){return change(s=>{s.entities=s.entities.filter(e=>e.id!==entityId);for(const b of s.beats)b.entity_ids=(b.entity_ids??[]).filter(x=>x!==entityId);return {deleted:entityId};});},
    async saveBeat(input={}){
      const handle=safeText(input.handle,80);if(!handle)throw new Error('A beat needs a short handle.');
      const year=input.story_year===null||input.story_year===undefined||input.story_year===''?null:Number(input.story_year);
      if(year!==null&&!Number.isFinite(year))throw new Error('story_year must be a number.');
      return change(s=>{
        const base={handle,body:safeText(input.body,4000),story_year:year,story_seconds:Number.isSafeInteger(Number(input.story_seconds))?Number(input.story_seconds):null,
          episode_id:safeText(input.episode_id,128)||null,order:Number.isSafeInteger(Number(input.order))?Number(input.order):null,
          entity_ids:Array.isArray(input.entity_ids)?input.entity_ids.map(x=>String(x).slice(0,128)).slice(0,40):[],
          decision_ids:Array.isArray(input.decision_ids)?input.decision_ids.map(x=>String(x).slice(0,128)).slice(0,40):[],
          status:BEAT_STATUS.has(input.status)?input.status:'draft'};
        if(input.beat_id){const item=s.beats.find(b=>b.id===input.beat_id);if(!item)throw new Error('Beat not found.');Object.assign(item,base,{updated_at:stamp()});return clone(item);}
        const item={id:input.beat_id||id(),...base,created_at:stamp(),updated_at:stamp()};s.beats.push(item);return clone(item);
      });
    },
    async deleteBeat(beatId){return change(s=>{s.beats=s.beats.filter(b=>b.id!==beatId);return {deleted:beatId};});},
    async saveEpisode(input={}){
      const title=safeText(input.title,160);if(!title)throw new Error('An episode needs a title.');
      return change(s=>{
        const base={title,season:Number.isSafeInteger(Number(input.season))?Number(input.season):1,order:Number.isSafeInteger(Number(input.order))?Number(input.order):s.episodes.length+1};
        if(input.episode_id){const item=s.episodes.find(e=>e.id===input.episode_id);if(!item)throw new Error('Episode not found.');Object.assign(item,base,{updated_at:stamp()});return clone(item);}
        const item={id:input.episode_id||id(),...base,created_at:stamp(),updated_at:stamp()};s.episodes.push(item);return clone(item);
      });
    },
    async deleteEpisode(episodeId){return change(s=>{s.episodes=s.episodes.filter(e=>e.id!==episodeId);for(const b of s.beats)if(b.episode_id===episodeId)b.episode_id=null;return {deleted:episodeId};});},
  };
}

// One story store per workspace root, shared by the API handler and the tools so both hands hit identical state.
const stores=new Map();
export function storyStoreFor(studioStore,{DSH_HOME}={}){
  const root=join(studioStore.root,'story');
  let store=stores.get(root);
  if(!store){store=createStoryStore({root});stores.set(root,store);}
  return store;
}
