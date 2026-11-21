import {build} from 'esbuild';
import {readdir,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const version=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;
await mkdir(resolve(root,'lib'),{recursive:true});
const runtime=(await readdir(resolve(root,'src'))).filter(name=>name.endsWith('.mjs')&&!name.endsWith('.test.mjs'));
for(const name of await readdir(resolve(root,'lib')))if(name.endsWith('.mjs')&&!runtime.includes(name))await rm(resolve(root,'lib',name));
for(const name of runtime)await copyFile(resolve(root,'src',name),resolve(root,'lib',name));
const result=await build({absWorkingDir:root,entryPoints:['src/client/index.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',jsx:'automatic',loader:{'.css':'text'},define:{__DSH_VERSION__:JSON.stringify(version)},external:['react','react/jsx-runtime','react-dom','react-dom/client'],inject:['src/client/studio/fetch-inject.mjs'],minify:false});
// timeline core: the vendored WeftCut state machine (headless) as one ESM bundle
await build({absWorkingDir:root,entryPoints:['scripts/core-entry.ts'],bundle:true,outfile:'lib/timeline-core.mjs',format:'esm',platform:'node',target:'node20',logLevel:'warning'});
// timeline engine: the vendored WeftCut Timeline renderer as one self-contained
// IIFE (its OWN React 19 from vendor/react19 — the host plugin keeps React 18).
// vendor/react19 ships no node_modules in git; install on first build.
try{readFileSync(resolve(root,'vendor/react19/node_modules/react/package.json'));}
catch{execFileSync('npm',['i','react@19','react-dom@19','@pixi/react'],{cwd:resolve(root,'vendor/react19')});}
execFileSync(resolve(root,'node_modules/.bin/tailwindcss'),['-i','src/renderer/app.css','-o','/tmp/codex/tw.css','--content','src/renderer/**/*.{tsx,ts}','scripts/*.{tsx,ts}'],{cwd:root});
const legacy=await build({absWorkingDir:root,entryPoints:['src/renderer/styles.css'],bundle:true,write:false,loader:{'.css':'css'}});
await writeFile(resolve(root,'scripts/timeline-css.generated.mjs'),'export default '+JSON.stringify(readFileSync('/tmp/codex/tw.css','utf8')+'\n'+legacy.outputFiles[0].text)+';\n');
await build({absWorkingDir:root,entryPoints:['scripts/engine-mount.tsx'],bundle:true,outfile:'lib/timeline-engine.js',format:'iife',platform:'browser',target:'es2021',jsx:'automatic',jsxDev:false,define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false','import.meta.env.VITE_WEFTCUT_E2E':'"1"'},loader:{'.css':'text','.svg':'text','.png':'text','.ttf':'dataurl','.woff2':'dataurl'},alias:{'@':resolve(root,'src/renderer'),'react':resolve(root,'vendor/react19/node_modules/react'),'react/jsx-runtime':resolve(root,'vendor/react19/node_modules/react/jsx-runtime'),'react-dom':resolve(root,'vendor/react19/node_modules/react-dom'),'react-dom/client':resolve(root,'vendor/react19/node_modules/react-dom/client'),'@pixi/react':resolve(root,'vendor/react19/node_modules/@pixi/react'),'pixi.js':resolve(root,'node_modules/pixi.js'),'react-i18next':resolve(root,'src/renderer/shims/i18next-shim.jsx'),'i18next':resolve(root,'src/renderer/shims/i18next-shim.jsx')},logLevel:'warning'});
const code=result.outputFiles[0].text;
await writeFile(resolve(root,'lib/client.js'),`window.__ModuleLoader__.load({id:"dsh-director",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
