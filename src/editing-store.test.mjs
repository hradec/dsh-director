// Editing library: the tag-derivation invariant on the SHARED command path.
// Same actor, same save, same recompute — user or agent makes no difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditingStore } from './editing-store.mjs';

const core = await import('../lib/timeline-core.mjs');

function emptyDoc() {
  const ROOT = '11111111-1111-4111-8111-111111111111';
  const VID = '22222222-2222-4222-8222-222222222222';
  return {
    ROOT, VID,
    doc: {
      schema_version: core.SCHEMA_VERSION, project_id: '33333333-3333-4333-8333-333333333333',
      metadata: { name: 't', created_at: '', modified_at: '', description: null },
      compositions: { [ROOT]: { id: ROOT, label: null, ordinal: 0, width: 1920, height: 1080, fps: { num: 24, den: 1 }, duration_us: 10000000, duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709', background: { r: 0, g: 0, b: 0, a: 255 }, tracks: [], markers: [], transitions: [], links: [] } },
      root_id: ROOT, next_group_ordinal: 1,
      media_pool: { [VID]: { id: VID, label: null, path_abs: 'x.mp4', path_rel: null, kind: 'Video', metadata: { duration_us: 5000000, video: null, audio: null, container_format: null }, file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '', decode_route: { route: 'bypass' }, conform_path: null } },
      audio_roles: {},
      settings: { preview_width: 1280, preview_height: 720, autosave_interval_secs: null, history_capacity: 50, auto_pair_audio_on_import: false, prefer_proxies: false, proxy_overrides: {}, shot_review: null, pause_review: null },
      motifs: {},
    },
  };
}

test('editing store: commands mutate, tags derive, undo re-derives, find-by-tag opens the edit', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-editing-'));
  try {
    const store = new EditingStore(ws, core);
    const { ROOT, VID, doc } = emptyDoc();
    const entry = await store.create({ name: 'ep1-seq1', note: null, doc });
    assert.equal(entry.tags.length, 0);

    const tr = await store.command(entry.id, 'add_track', { compositionId: ROOT });
    assert.equal(tr.ok, true, JSON.stringify(tr.error));
    const track = store.snapshot(entry.id).compositions[ROOT].tracks;
    const trackId = track[track.length - 1].id;

    const layer = await store.command(entry.id, 'add_media_layer', { trackId, mediaId: VID, tStartUs: 0 });
    assert.equal(layer.ok, true, JSON.stringify(layer.error));
    const layerId = layer.value;

    // stamp shot identity through the SAME channel the UI uses
    const stamp = await store.command(entry.id, 'update_layer', { layerId, patch: { metadata: { dsh: { shot_id: 'c12', sequence_id: 's3', episode_id: 'e1', take_id: 'v2' } } } });
    assert.equal(stamp.ok, true, JSON.stringify(stamp.error));
    assert.deepEqual(stamp.tags, ['episode-e1', 'sequence-s3', 'shot-c12', 'take-v2']);

    const cat = await store.catalog();
    assert.deepEqual(cat[entry.id].tags, ['episode-e1', 'sequence-s3', 'shot-c12', 'take-v2']);

    // open the editing of a shot / sequence / episode = tag query
    const hits = await store.find(['shot-c12']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, entry.id);
    assert.equal((await store.find(['episode-e1', 'sequence-s3'])).length, 1);
    assert.equal((await store.find(['shot-c99'])).length, 0);

    // undo the stamp: tags recompute — maintenance is derived, never stale
    const und = await store.undo(entry.id);
    assert.equal(und.ok, true, JSON.stringify(und.error));
    assert.deepEqual(und.tags, []);
    const cat2 = await store.catalog();
    assert.deepEqual(cat2[entry.id].tags, []);

    // the document on disk IS the state after commands (hand-inspectable)
    const saved = await store.get(entry.id);
    const layers = saved.doc.compositions[ROOT].tracks[0].layers;
    assert.equal(layers.length, 1);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('A/B roll skeleton: new edits get role-stamped lanes, seed lands on A roll, legacy docs migrate on open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-editing-ab-'));
  try {
    const store = new EditingStore(dir, core);
    const created = await store.create({ name: 'ab' });
    const got = await store.get(created.id);
    const comp = got.doc.compositions[got.doc.root_id];
    assert.deepEqual(comp.tracks.map((t) => t.role), ['ARoll', 'BRoll'], 'reserved skeleton like model.ts newComposition');
    const seed = await store.seedShots(created.id, [{ shot_id: 'x1', path: 'media/x.mp4', duration_us: 4000000 }]);
    assert.ok(seed.ok, JSON.stringify(seed.error ?? seed));
    const sc = store.snapshot(created.id).compositions[got.doc.root_id];
    assert.equal(sc.tracks[0].layers.length, 1, 'seeded shots land on the A roll');
    assert.equal(sc.tracks[1].layers.length, 0);
    // Legacy documents (round-5 seeds) carry no role fields at all: the first
    // read stamps the first two lanes and persists, so AbRoll view is not empty.
    const legacy = emptyDoc();
    legacy.doc.compositions[legacy.ROOT].tracks = [{ id: '44444444-4444-4444-8444-444444444444', label: 't1', enabled: true, locked: false, muted: false, solo: false, removable: true, transient: false, height_px: 64, layers: [] }];
    const old = await store.create({ name: 'old', doc: legacy.doc });
    assert.equal((await store.get(old.id)).doc.compositions[legacy.ROOT].tracks[0].role, 'ARoll');
    assert.equal((await store.get(old.id)).doc.compositions[legacy.ROOT].tracks[0].role, 'ARoll', 'migration persisted, not just in-memory');
    const reopened = new EditingStore(dir, core); // fresh process view: roles are on disk
    assert.equal((await reopened.get(old.id)).doc.compositions[legacy.ROOT].tracks[0].role, 'ARoll');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
