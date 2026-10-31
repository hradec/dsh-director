const DEFAULT_TTL_MS=24*60*60*1000;
const DEFAULT_MAX_ENTRIES=2048;
const cardIdPattern=/^[A-Za-z0-9_-]{1,128}$/;

export function createCardPresentationRegistry({ttlMs=DEFAULT_TTL_MS,maxEntries=DEFAULT_MAX_ENTRIES,now=Date.now}={}){
  if(!Number.isFinite(ttlMs)||ttlMs<1)throw new TypeError('ttlMs must be positive.');
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1)throw new TypeError('maxEntries must be a positive safe integer.');
  const entries=new Map();
  const key=(sessionId,cardId)=>`${sessionId}\u0000${cardId}`;
  const valid=(sessionId,cardId)=>typeof sessionId==='string'&&sessionId.length>0&&sessionId.length<=256&&typeof cardId==='string'&&cardIdPattern.test(cardId);
  const prune=()=>{
    const time=now();
    for(const [id,entry] of entries)if(entry.expiresAt<=time)entries.delete(id);
    while(entries.size>maxEntries)entries.delete(entries.keys().next().value);
  };
  const touch=(id,entry)=>{entries.delete(id);entries.set(id,{...entry,expiresAt:now()+ttlMs});prune();};
  return {
    register(sessionId,cardId){
      if(!valid(sessionId,cardId))return false;
      prune();
      const id=key(sessionId,cardId),previous=entries.get(id);
      touch(id,{presentedAt:previous?.presentedAt??0});
      return true;
    },
    acknowledge(sessionId,cardId){
      if(!valid(sessionId,cardId))return false;
      prune();
      const id=key(sessionId,cardId),entry=entries.get(id);
      if(!entry)return false;
      const presentedAt=entry.presentedAt||now();
      touch(id,{presentedAt});
      return presentedAt;
    },
    isPresented(sessionId,cardId,at){
      if(!valid(sessionId,cardId))return false;
      prune();
      const presentedAt=entries.get(key(sessionId,cardId))?.presentedAt??0;
      return presentedAt>0&&(at===undefined||Number.isFinite(at)&&at>=presentedAt);
    },
    presentedAt(sessionId,cardId){
      if(!valid(sessionId,cardId))return undefined;
      prune();
      const value=entries.get(key(sessionId,cardId))?.presentedAt;
      return value||undefined;
    },
  };
}
// ponytail: bounded process-local acknowledgements expire after 24 hours; a restart or expiry requires the card to be rendered again before ordinary approval.
export const cardPresentationLimits=Object.freeze({ttlMs:DEFAULT_TTL_MS,maxEntries:DEFAULT_MAX_ENTRIES});
