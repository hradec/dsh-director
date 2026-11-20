/* Publish the Director Studio library into ComfyUI's input/dsh/ so the
dsh-studio-link nodes (Asset / Image) list REAL assets instead of an empty combo.

Layout written (all under <comfy input>/dsh/):
  asset_<slug>.json        sidecar: {slug,description,notes,images[],videos[],audio[]}
  <slug>/<staged-name>     every asset-bound media file
  libimg-<name>.<ext>      every images-library picture (flat: DSStudioImage globs one level)

Files are copied byte-cheap: same size at destination = skip (ponytail: mtime/size
not hash; upgrade path = sha256 sidecar if edits-in-place ever bite).
No gates: every asset kind and every images-library file publishes.
*/
import {copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {basename, extname, join} from 'node:path';

const IMAGE_EXT=new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp']);
const VIDEO_EXT=new Set(['.mp4','.webm','.mov','.mkv','.avi']);
const AUDIO_EXT=new Set(['.wav','.mp3','.flac','.ogg','.m4a']);

function resolveReadable(p,roots){
  // Library paths may name an alternate mount of the same disk (/net/... , /home/..., /NVME/...).
  if(existsSync(p))return p;
  for(const r of roots){const q=p.replace(/^\/net\/192\.168\.10\.52\/RAID\/atomo\/home\/rhradec/,r);if(q!==p&&existsSync(q))return q;}
  return null;
}
function safeName(s){return String(s).replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,140)||'file';}
async function copyInto(src,dst){
  try{const [a,b]=await Promise.all([stat(src),stat(dst).catch(()=>null)]);
    if(b&&b.size===a.size)return false;   // already published, bytes unchanged
  }catch{}
  await mkdir(join(dst,'..'),{recursive:true});
  await copyFile(src,dst);return true;
}
function classify(name){const e=extname(name).toLowerCase();
  if(IMAGE_EXT.has(e))return 'images';if(VIDEO_EXT.has(e))return 'videos';if(AUDIO_EXT.has(e))return 'audio';return null;}

export async function publishLibrary({workspace,inputDsh,log=()=>{}}={}){
  const storeFile=join(workspace,'.director-studio','studio.json');
  if(!existsSync(storeFile))throw new Error(`no studio.json under ${workspace}/.director-studio`);
  const store=JSON.parse(await readFile(storeFile,'utf8'));
  const roots=['/home/rhradec','/NVME','workspace'].filter(r=>r!=='workspace');
  let assetsOut=0,filesCopied=0,filesSkipped=0;
  // Clean previous asset staging first so deleted assets/keys don't haunt the combos.
  for(const f of await readdir(inputDsh).catch(()=>[]))
    if(f.startsWith('asset_')&&f.endsWith('.json'))await rm(join(inputDsh,f));
  for(const item of store.assets??[]){
    const slug=safeName(item.folder||item.name);if(!item.files)continue;
    const groups={images:[],videos:[],audio:[]};let touched=false;
    for(const [key,path] of Object.entries(item.files)){
      const src=resolveReadable(path,roots);
      if(!src){log(`skip ${slug}/${key}: file not found: ${path}`);continue;}
      const group=classify(basename(src));if(!group){continue;}
      const staged=`${slug}__${safeName(key)}${extname(basename(src)).toLowerCase()}`;
      const rel=item.folder?`${slug}/${staged}`:staged;
      if(await copyInto(src,join(inputDsh,rel)))filesCopied++;else filesSkipped++;
      const meta=item.ref_meta?.[key]??{};
      groups[group].push({key,file:rel,tags:meta.tags??[],note:meta.note??''});
      touched=true;
    }
    if(!touched)continue;
    await writeFile(join(inputDsh,`asset_${slug}.json`),JSON.stringify({
      slug,description:item.description??'',notes:item.notes??'',...groups},null,1));
    assetsOut++;log(`asset ${slug}: ${groups.images.length}i/${groups.videos.length}v/${groups.audio.length}a`);
  }
  // library_refs: files in images//media/ tagged with the asset name ride into that asset's sidecar.
  const libs=[['images',join(workspace,'images','images.json')],['footage',join(workspace,'media','footage.json')]];
  const byAsset=new Map();
  for(const [kind,catalog] of libs){
    let doc;try{doc=JSON.parse(await readFile(catalog,'utf8'));}catch{continue;}
    const root=kind==='images'?join(workspace,'images'):join(workspace,'media');
    for(const [rel,meta] of Object.entries(doc.files??{})){
      const tags=Array.isArray(meta?.tags)?meta.tags:[];
      const src=resolveReadable(join(root,rel),roots);
      if(!src)continue;
      const group=classify(basename(rel));if(!group)continue;
      for(const item of store.assets??[]){
        const slug=safeName(item.folder||item.name);
        const needles=[slug,safeName(item.name),String(item.name??'').toLowerCase()].filter(Boolean);
        if(!tags.some(t=>needles.includes(String(t).toLowerCase())))continue;
        const staged=`${slug}__lib-${safeName(basename(rel))}`;
        const dest=kind==='images'?join(inputDsh,staged):join(inputDsh,`${slug}/${staged}`);
        const file=kind==='images'?staged:`${slug}/${staged}`;
        if(await copyInto(src,dest))filesCopied++;else filesSkipped++;
        if(!byAsset.has(slug))byAsset.set(slug,{images:[],videos:[],audio:[]});
        byAsset.get(slug)[group].push({key:`lib:${rel}`,file,tags,note:meta?.note??''});
      }
    }
  }
  for(const [slug,groups] of byAsset){
    const side=join(inputDsh,`asset_${slug}.json`);
    let doc={slug,description:'',notes:'',images:[],videos:[],audio:[]};
    if(existsSync(side))doc=JSON.parse(await readFile(side,'utf8'));
    for(const g of ['images','videos','audio'])doc[g]=[...(doc[g]??[]),...groups[g]];
    await writeFile(side,JSON.stringify(doc,null,1));
    if(!doc._counted){assetsOut=Math.max(assetsOut,assetsOut);log(`asset ${slug} library_refs: +${groups.images.length}i/+${groups.videos.length}v`);}
  }
  // Images library (flat pictures the human registered) -> DSStudioImage combos.
  const imgRoot=join(workspace,'images');
  if(existsSync(imgRoot)){
    const walk=async(d,prefix='')=>{for(const e of await readdir(d,{withFileTypes:true})){
      if(e.isDirectory())await walk(join(d,e.name),`${prefix}${e.name}-`);
      else if(IMAGE_EXT.has(extname(e.name).toLowerCase())){
        const staged=`libimg-${prefix}${safeName(e.name)}`;
        if(await copyInto(join(d,e.name),join(inputDsh,staged)))filesCopied++;else filesSkipped++;
      }}};
    await walk(imgRoot);
  }
  return {assetsOut,filesCopied,filesSkipped};
}

if(process.argv[1]&&process.argv[1].includes('library-publish.mjs')){
  const workspace=process.argv[2]??'/NVME/Videos/ai-production';
  const inputDsh=process.argv[3]??'/smb/240.1.0.100/comfyui/ComfyUI/user/rhradec_dca419fb-b99d-48da-93f4-fba215ab90a7/input/dsh';   // multi-user: node INPUT_TYPES reads the PER-USER input dir
  await mkdir(inputDsh,{recursive:true});
  const r=await publishLibrary({workspace,inputDsh,log:(m)=>console.log(m)});
  console.log(JSON.stringify(r));
}
