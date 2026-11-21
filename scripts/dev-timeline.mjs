// Dev-only harness (not shipped): serves the timeline-engine bundle + a live
// EditingStore over the exact /director-studio/api routes the client transport
// expects, so the engine can be driven in a real browser BEFORE the harness
// restart activates the server half. Run: node scripts/dev-timeline.mjs [port].
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditingStore } from '../src/editing-store.mjs';

const port = Number(process.argv[2] || 8791);
const ws = await mkdtemp(join(tmpdir(), 'dsh-tldev-'));
const store = new EditingStore(ws, null);
await store.ready;

// Seed one edit with a media pool + two layers through the REAL command path.
// Real decodable clips for the preview-surface proof.
import { execFileSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
const CLIP_DIR = '/tmp/codex/tlclips';
mkdirSync(CLIP_DIR, { recursive: true });
const CLIP_A = CLIP_DIR + '/A.mp4', CLIP_B = CLIP_DIR + '/B.mp4';
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', CLIP_A]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=3', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', CLIP_B]);
const probeDur = (f) => Math.round(Number(execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim()) * 1e6);
const DUR_A = probeDur(CLIP_A), DUR_B = probeDur(CLIP_B);
function serveFile(req, res, url) {
  const f = url.searchParams.get('path') || '';
  if (f !== CLIP_A && f !== CLIP_B) { res.writeHead(404); res.end(''); return; }
  const size = statSync(f).size;
  const range = req.headers.range;
  if (range && range.startsWith('bytes=')) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-type': 'video/mp4' });
    createReadStream(f, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes', 'content-type': 'video/mp4' });
  createReadStream(f).pipe(res);
}
const doc = await store.newProjectDoc('dev-cut');
const poolId = '66666666-6666-4666-8666-666666666666';
const vid = '77777777-7777-4777-8777-777777777777';
doc.media_pool[poolId] = { id: poolId, label: 'A.mp4', path_abs: CLIP_A, path_rel: 'A.mp4', kind: 'Video', metadata: { duration_us: DUR_A, video: null, audio: null, container_format: null }, file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '', decode_route: { route: 'bypass' }, conform_path: null };
doc.media_pool[vid] = { id: vid, label: 'B.mp4', path_abs: CLIP_B, path_rel: 'B.mp4', kind: 'Video', metadata: { duration_us: DUR_B, video: null, audio: null, container_format: null }, file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '', decode_route: { route: 'bypass' }, conform_path: null };
const entry = await store.create({ name: 'dev-cut', doc });
const ROOT = doc.root_id;
const tr1 = await store.command(entry.id, 'add_track', { compositionId: ROOT });
const trackId = store.snapshot(entry.id).compositions[ROOT].tracks[0].id;
const ml1 = await store.command(entry.id, 'add_media_layer', { trackId, mediaId: poolId, tStartUs: 0 });
const ml2 = await store.command(entry.id, 'add_media_layer', { trackId, mediaId: vid, tStartUs: DUR_A });
await store.command(entry.id, 'update_layer', { layerId: ml1.value, patch: { metadata: { dsh: { shot_id: 'c1', episode_id: 'e1' } } } });
console.log('seeded edit', entry.id, 'tracks', store.snapshot(entry.id).compositions[ROOT].tracks.length, 'layers', ml1.ok, ml2.ok);

const engineRoute = async () => readFile(join(process.cwd(), 'lib/timeline-engine.js')); // fresh per request in dev
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
  if (p === '/engine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await engineRoute()); return; }
  if (p === '/api/file') { serveFile(req, res, url); return; }
  const m = /^\/api\/editing\/([a-f0-9-]{36})(?:\/(publication|command|undo|redo|checkpoint))?$/.exec(p);
  if (m) {
    const id = m[1], sub = m[2];
    if (!sub && req.method === 'GET') return void json(200, { entry: (await store.get(id)).entry });
    if (!sub) return void json(405, { detail: 'method not allowed' });
    if (sub === 'publication') { const pub = await store.publication(id); return pub ? json(200, pub) : json(404, { detail: 'no doc' }); }
    if (req.method !== 'POST') return void json(405, { detail: 'method not allowed' });
    const body = await new Promise((r) => { let s = ''; req.on('data', (c) => s += c); req.on('end', () => r(s ? JSON.parse(s) : {})); });
    if (sub === 'command') return void json(200, await store.command(id, String(body.channel), body.args || {}, 'user'));
    if (sub === 'undo') return void json(200, await store.undo(id));
    if (sub === 'redo') return void json(200, await store.redo(id));
    return void json(200, await store.checkpoint(id, String(body.label || 'cp')));
  }
  if (p === '/api/editing') return void json(200, { editing: Object.values(await store.catalog()) });
  // index
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html class="dark"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0b0e14;color:#e6e6e6;font:13px system-ui}#tl{position:fixed;inset:0}</style></head><body><div id="tl"></div><script src="/engine.js"></script><script>DSH_TIMELINE.mount(document.getElementById('tl'),{editingId:${JSON.stringify(entry.id)},apiBase:'',session:'dev'});</script></body></html>`);
});
server.listen(port, '127.0.0.1', () => console.log('dev timeline on http://127.0.0.1:' + port + ' (edit ' + entry.id + ')'));
