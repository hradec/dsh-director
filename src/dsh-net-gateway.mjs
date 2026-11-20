#!/usr/bin/env node
// dsh-net-gateway: ZeroTier-facing bridge in front of the DSH director-studio server.
// Purpose: remote ComfyUI nodes (hosts .100/.242/.243) speak plain workspace NAMES —
// no opaque session ids, no CLI digging. It also stays a transparent proxy for
// everything else so the browser tab and the bridge keep working on one port.
//
//   GET /director-studio/api/workspaces      -> [{name, cwd, session, mtime}] (NEW)
//   any request with ?session=<name|path>    -> rewritten to the matching session id
//   everything else                          -> piped to 127.0.0.1:3081 untouched
//
// Session index source: ~/.dsh/storages/session_projcache/sessions/session-*.json
// (identity.cwd). Newest session wins on duplicate names — matches the human's
// mental model (the workspace they are working in now). realpath-tolerant for
// symlinked homes; ponytail: index cached 60s like studio-api does.
import {readdirSync,readFileSync,statSync,realpathSync,existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {basename} from 'node:path';
import {request as upstream} from 'node:http';

const BIND='240.0.0.10', PORT=3081, TARGET={host:'127.0.0.1',port:3081};
const DIR=(process.env.DSH_HOME||process.env.HOME)+'/.dsh/storages/session_projcache/sessions';
let cache=null; // {at, rows:[{id,cwd,mtime}]} newest-first

function index(){
  if(cache&&Date.now()-cache.at<60000)return cache.rows;
  const rows=[];
  try{for(const e of readdirSync(DIR)){
    if(!e.startsWith('session-')||!e.endsWith('.json'))continue;
    try{const cwd=JSON.parse(readFileSync(DIR+'/'+e,'utf8'))?.record?.identity?.cwd;
      if(cwd)rows.push({id:e.slice(0,-5),cwd,mtime:statSync(DIR+'/'+e).mtimeMs});}catch{}
  }rows.sort((a,b)=>b.mtime-a.mtime);}catch{}
  cache={at:Date.now(),rows};return rows;
}

function mapSession(value){
  // session-... ids pass through; names and absolute paths resolve to the newest matching session.
  if(!value||value.startsWith('session-'))return value;
  const rows=index();
  const v=String(value).replace(/\/+$/,'');
  const real=(p)=>{try{return realpathSync(p);}catch{return p;}};
  for(const r of rows){
    const cwd=r.cwd.replace(/\/+$/,'');
    if(cwd===v||basename(cwd)===v||real(cwd)===v||real(cwd)===real(v))return r.id;
  }
  return value; // unknown: let the real server 404 verbatim (no local gatekeeping)
}

const server=createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname==='/director-studio/api/workspaces'){
    // only workspaces that actually hold a Director Studio library — no session noise
    // order by ACTUAL library activity (studio.json mtime), not by which session is newest —
    // the workspace you're producing in floats to the top of the node's combo.
    const rows=index().filter(r=>existsSync(r.cwd+'/.director-studio')).map(r=>{
      let lm=r.mtime;try{lm=statSync(r.cwd+'/.director-studio/studio.json').mtimeMs;}catch{}
      return {name:basename(r.cwd),cwd:r.cwd,session:r.id,mtime:lm};
    }).sort((a,b)=>b.mtime-a.mtime);
    // dedupe by name keeping newest; expose the friendly name as the handle
    const seen=new Set(),out=[];
    for(const w of rows){if(!seen.has(w.name)){seen.add(w.name);out.push(w);}}
    res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'});
    res.end(JSON.stringify(out));return;
  }
  const s=u.searchParams.get('session');
  if(s&&s!=='session-'){const m=mapSession(s);if(m!==s)u.searchParams.set('session',m);}
  const preq=upstream({host:TARGET.host,port:TARGET.port,method:req.method,path:u.pathname+(u.searchParams.toString()?'?'+u.searchParams.toString():''),headers:{...req.headers,host:TARGET.host+':'+TARGET.port}},pres=>{
    res.writeHead(pres.statusCode||502,pres.headers);pres.pipe(res);
  });
  preq.on('error',e=>{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json'});}res.end(JSON.stringify({detail:'dsh unreachable: '+e.message}));});
  req.pipe(preq);
});
server.listen(PORT,BIND,()=>console.log('dsh-net-gateway on',BIND+':'+PORT));
