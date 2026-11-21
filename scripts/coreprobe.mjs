import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
const root = process.cwd();
const r = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/core-entry.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  loader: { '.css': 'text', '.svg': 'text' },
  logLevel: 'silent',
});
writeFileSync('/tmp/dsh-core.mjs', r.outputFiles[0].text);
console.log('core bundle bytes:', r.outputFiles[0].text.length);
const mod = await import('/tmp/dsh-core.mjs?' + Date.now());
const { createActor, SCHEMA_VERSION, initEval } = mod;
await initEval();
const ROOT = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const rootComp = { id: ROOT, label: null, ordinal: 0, width: 1920, height: 1080, fps: { num: 24, den: 1 }, duration_us: 10000000, duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709', background: { r: 0, g: 0, b: 0, a: 255 }, tracks: [], markers: [], transitions: [], links: [] };
const project = {
  schema_version: SCHEMA_VERSION, project_id: '33333333-3333-4333-8333-333333333333',
  metadata: { name: 'probe', created_at: '', modified_at: '', description: null },
  compositions: { [ROOT]: rootComp }, root_id: ROOT, next_group_ordinal: 1,
  media_pool: { [VID]: { id: VID, label: null, path_abs: '/api/file?path=x.mp4', path_rel: null, kind: 'Video', metadata: { duration_us: 5000000, video: null, audio: null, container_format: null }, file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '', decode_route: { route: 'bypass' }, conform_path: null } },
  audio_roles: {},
  settings: { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60, history_capacity: 200, auto_pair_audio_on_import: true, prefer_proxies: false, proxy_overrides: {}, shot_review: null, pause_review: null },
  motifs: {},
};
let n = 0;
const hex = () => (n++).toString(16).padStart(12, '0');
const h = createActor({ initial: project, idGen: () => '44444444-4444-4444-8444-' + hex() });
const snap0 = h.snapshot();
console.log('snapshot tracks:', snap0.compositions[snap0.root_id].tracks.length);
const tr = h.command('add_track', { compositionId: ROOT });
console.log('add_track:', tr.ok ? 'OK ' + JSON.stringify(tr.value).slice(0, 120) : 'ERR ' + JSON.stringify(tr.error).slice(0, 160));
const tracksNow = h.snapshot().compositions[ROOT].tracks;
const trackId = tracksNow.length ? tracksNow[tracksNow.length - 1].id : null;
const res = h.command('add_media_layer', { trackId, mediaId: VID, tStartUs: 0 });
console.log('add_media_layer:', res.ok ? 'OK layer ' + res.value : 'ERR ' + JSON.stringify(res.error).slice(0, 200));
const snap1 = h.snapshot();
const rootAfter = snap1.compositions[snap1.root_id];
console.log('tracks after:', rootAfter.tracks.length, 'layers:', (rootAfter.tracks[0] && rootAfter.tracks[0].layers.length) || 0, 'duration:', rootAfter.duration_us);
