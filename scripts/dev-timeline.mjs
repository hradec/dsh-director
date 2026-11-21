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
const doc = await store.newProjectDoc('dev-cut');
const poolId = '66666666-6666-4666-8666-666666666666';
const vid = '77777777-7777-4777-8777-777777777777';
doc.media_pool[poolId] = { id: poolId, label: null, path_abs: 'A.mp4', path_rel: null, kind: 'Video', metadata: { duration_us: 5000000, video: null, audio: null, container_format: null }, file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '', decode_route: { route: 'bypass' }, conform_path: null };
doc.media_pool[vid] = { id: vid, label: null, path_abs: 'B.mp4', path_rel: null, kind: 'Video', metadata: { duration_us: 4000000, video: null, audio: null, container_format: null }, file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '', decode_route: { route: 'bypass' }, conform_path: null };
const entry = await store.create({ name: 'dev-cut', doc });
const ROOT = doc.root_id;
const tr1 = await store.command(entry.id, 'add_track', { compositionId: ROOT });
const trackId = store.snapshot(entry.id).compositions[ROOT].tracks[0].id;
const ml1 = await store.command(entry.id, 'add_media_layer', { trackId, mediaId: poolId, tStartUs: 0 });
const ml2 = await store.command(entry.id, 'add_media_layer', { trackId, mediaId: vid, tStartUs: 5000000 });
await store.command(entry.id, 'update_layer', { layerId: ml1.value, patch: { metadata: { dsh: { shot_id: 'c1', episode_id: 'e1' } } } });
console.log('seeded edit', entry.id, 'tracks', store.snapshot(entry.id).compositions[ROOT].tracks.length, 'layers', ml1.ok, ml2.ok);

const engine = await readFile(join(process.cwd(), 'lib/timeline-engine.js'));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
  if (p === '/engine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(engine); return; }
  if (p === '/api/file') { res.writeHead(404); res.end(''); return; }
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
