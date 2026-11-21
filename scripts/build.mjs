import {build} from 'esbuild';
import {readdir,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
const root=resolve(import.meta.dirname,'..');
const version=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;
await mkdir(resolve(root,'lib'),{recursive:true});
const runtime=(await readdir(resolve(root,'src'))).filter(name=>name.endsWith('.mjs')&&!name.endsWith('.test.mjs'));
for(const name of await readdir(resolve(root,'lib')))if(name.endsWith('.mjs')&&!runtime.includes(name))await rm(resolve(root,'lib',name));
for(const name of runtime)await copyFile(resolve(root,'src',name),resolve(root,'lib',name));
const result=await build({absWorkingDir:root,entryPoints:['src/client/index.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',jsx:'automatic',loader:{'.css':'text'},define:{__DSH_VERSION__:JSON.stringify(version)},external:['react','react/jsx-runtime','react-dom','react-dom/client'],inject:['src/client/studio/fetch-inject.mjs'],minify:false});
// timeline core: the vendored WeftCut state machine (headless) as one ESM bundle
await build({absWorkingDir:root,entryPoints:['scripts/core-entry.ts'],bundle:true,outfile:'lib/timeline-core.mjs',format:'esm',platform:'node',target:'node20',logLevel:'warning'});
const code=result.outputFiles[0].text;
await writeFile(resolve(root,'lib/client.js'),`window.__ModuleLoader__.load({id:"dsh-director",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
