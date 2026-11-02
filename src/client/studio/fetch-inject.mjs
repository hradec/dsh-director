export const fetch=(input,init)=>{
  if(typeof input==='string'&&input.startsWith('/api/'))input='/director-studio'+input;
  else if(input instanceof URL&&input.pathname.startsWith('/api/')){const url=new URL(input);url.pathname='/director-studio'+url.pathname;input=url;}
  const target=typeof input==='string'?input:input instanceof URL?input.pathname:'';
  const session=globalThis.__DSH_DIRECTOR_SESSION__;
  // The session workspace folder is the Director Studio project; every request identifies its owning session.
  if(session&&target.startsWith('/director-studio/api/')){const headers=new Headers(init&&init.headers?init.headers:undefined);headers.set('X-Director-Session',session);return globalThis.fetch(input,{...init,headers});}
  return globalThis.fetch(input,init);
};
