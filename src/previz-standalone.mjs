// Previz standalone bake — turns a scene JSON into ONE self-contained .previz.html:
// the scene in a tagged block + the player bundle inlined (three.js and all), exactly
// in the spirit of ComfyUI embedding its workflow in a PNG. The file double-clicks into
// a working player anywhere; the scene block stays hand-editable, and every playblast
// mp4 carries the same JSON in its metadata so a clip can be recovered back to a file.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const SCENE_BLOCK_RE=/<script type="application\/previz"[^>]*>([\s\S]*?)<\/script>/;

// '</script' inside the JSON would close the block early; escape it (standard trick).
const safeJson=(obj)=>JSON.stringify(obj).replaceAll('</script','<\\/script');

export function bakeStandaloneHtml(scene){
  const player=readFileSync(resolve(import.meta.dirname,'..','lib','previz-player.js'),'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PREVIZ</title>
<style>
 body{margin:0;background:#0a0d14;color:#cfd6e4;font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px}
 #previz-canvas{border:1px solid #2c3546;image-rendering:auto;max-width:100%}
 .bar{display:flex;align-items:center;gap:10px;width:min(100%,1280px)}
 #previz-play{padding:4px 12px;cursor:pointer}
 #previz-scrub{flex:1}
 #previz-time{font-variant-numeric:tabular-nums;white-space:nowrap}
 .meta{width:min(100%,1280px);opacity:.7;font-size:12px}
</style></head><body>
<script type="application/previz" id="previz-scene">${safeJson(scene)}</script>
<div class="bar"><button id="previz-play">▶ Play</button><input id="previz-scrub" type="range" min="0" max="0" step="1"><span id="previz-time">0s</span></div>
<canvas id="previz-canvas"></canvas>
<div class="meta">Single-file previz — the scene JSON lives in this document; the playblast mp4 carries a copy in its metadata. Edit the JSON block or the Director Studio Previz tab; render from the tab or the agent.</div>
<script>${player}</script>
</body></html>`;
}

// Extract the scene from a baked html file (the tab's editor and the recovery route).
export function readEmbeddedScene(htmlText){
  const m=SCENE_BLOCK_RE.exec(htmlText);
  if(!m)throw Error('No <script type="application/previz"> block found — is this a baked .previz.html?');
  return JSON.parse(m[1]);
}
