// Editing library — the shared edit spine for Director Studio.
// One and the same code path serves the human editor UI AND agent tools:
// every mutation is an actor command; tags are DERIVED from the document
// (layer.metadata.dsh stamps), never hand-maintained — so add/remove of shots,
// sequences or episodes keeps catalog tags truthful no matter who did it.
//
// Files (filesystem-first, hand-editable like footage.json):
//   <workspace>/editing/<id>.json        — the authoritative timeline document (WeftCut Project schema)
//   <workspace>/editing/editing.json     — catalog: {id: {name, path, tags, note, updated_at}}
//
// ponytail: one actor per editing id cached in-process; concurrent DSH sessions
// share this server so that is safe within one process. Upgrade path: actor per
// request + file lock if the harness ever runs multiple server processes.
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const CATALOG = 'editing.json';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}
async function writeAtomic(path, text) {
  const tmp = path + '.tmp';
  await writeFile(tmp, text);
  await rename(tmp, path);
}


// ---- core loading + per-workspace singleton (API and agent tools share ONE instance,
// so ONE actor cache and ONE tag-maintenance path exist process-wide) ----
let corePromise = null;
export function loadCore() {
  if (!corePromise) corePromise = (async () => {
    for (const p of ['./timeline-core.mjs', '../lib/timeline-core.mjs']) {
      try { return await import(p); } catch (err) { if (err && err.code !== 'ERR_MODULE_NOT_FOUND') throw err; }
    }
    throw new Error('timeline-core.mjs not built — run node scripts/build.mjs');
  })();
  return corePromise;
}
const stores = new Map();
export function editingStoreFor(workspaceDir) {
  let s = stores.get(workspaceDir);
  if (!s) { s = new EditingStore(workspaceDir, null); stores.set(workspaceDir, s); }
  return s;
}

export class EditingStore {
  // core: the module built from the vendored state core ({createActor, SCHEMA_VERSION, initEval})
  constructor(workspaceDir, core) {
    this.dir = join(workspaceDir, 'editing');
    this.workspace = workspaceDir; // media paths in docs resolve against this
    this.core = core;
    this.actors = new Map();
    // Publication identity for the renderer (WeftCut ProjectVersion semantics).
    // ponytail: revision is process-wide, not per-document — the renderer keeps
    // one document open, so one counter is enough; upgrade path is a Map.
    this.session = Math.floor(Math.random() * 1e9) || 1;
    this.revision = 0;
    this.viewSeq = 0;
    this.ready = this.#init();
    this.#migrated = new Set(); // doc ids already role-migrated this process
  }
  #migrated;
  // ffprobe for real media dimensions (the timeline's filmstrip + posters need
  // width/height; a null pair makes the renderer skip artwork entirely).
  mediaAbs(p) { const s = String(p ?? ''); return isAbsolute(s) ? s : join(this.workspace, s); }
  probeDims(source) {
    return new Promise((done) => {
      execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', source], { timeout: 20000 }, (error, stdout) => {
        const m = error ? null : /(\d+)x(\d+)/.exec(String(stdout).trim());
        done(m ? { width: Number(m[1]), height: Number(m[2]) } : null);
      });
    });
  }
  async #init() {
    await mkdir(this.dir, { recursive: true });
    if (!this.core) this.core = await loadCore();
    await this.core.initEval();
  }

  async catalog() {
    await this.ready;
    return readJson(join(this.dir, CATALOG), {});
  }

  // tags derived from the document: every layer may carry metadata.dsh =
  // {shot_id, sequence_id, episode_id} — the tag set IS those identities.
  static docTags(doc) {
    const tags = new Set();
    for (const comp of Object.values(doc.compositions || {})) {
      for (const track of comp.tracks || []) {
        for (const layer of track.layers || []) {
          const dsh = layer.metadata && layer.metadata.dsh;
          if (!dsh) continue;
          if (dsh.shot_id) tags.add('shot-' + dsh.shot_id);
          if (dsh.sequence_id) tags.add('sequence-' + dsh.sequence_id);
          if (dsh.episode_id) tags.add('episode-' + dsh.episode_id);
          if (dsh.take_id) tags.add('take-' + dsh.take_id);
        }
      }
      // nested groups referenced as layers are already in compositions above
    }
    for (const media of Object.values(doc.media_pool || {})) {
      const dsh = media.metadata && (media.metadata.dsh_tags || []);
      for (const t of dsh) tags.add(t);
    }
    return [...tags].sort();
  }

  async #save(id, entry, doc) {
    const tags = EditingStore.docTags(doc);
    const cat = await this.catalog();
    cat[id] = { ...entry, tags, updated_at: new Date().toISOString() };
    await writeAtomic(join(this.dir, entry.path), JSON.stringify(doc, null, 1));
    await writeAtomic(join(this.dir, CATALOG), JSON.stringify(cat, null, 1));
  }


  // Default document for a fresh edit (root composition at 1080p24, empty pool).
  // ponytail: fixed defaults; a new edit inherits the project canvas when the
  // Production adapter starts seeding docs.
  async newProjectDoc(name) {
    if (!this.core) this.core = await loadCore();
    const ROOT = randomUUID();
    return {
      schema_version: this.core.SCHEMA_VERSION, project_id: randomUUID(),
      metadata: { name: name || 'edit', created_at: new Date().toISOString(), modified_at: new Date().toISOString(), description: null },
      // A/B-roll skeleton, same shape as the desktop model's reserved tracks
      // (model.ts newTrack): role-stamped, non-removable, derived labels. The
      // timeline's AbRoll display mode shows ONLY role-stamped tracks, so a doc
      // without these lanes renders an empty timeline in that view.
      compositions: { [ROOT]: { id: ROOT, label: null, ordinal: 0, width: 1920, height: 1080, fps: { num: 24, den: 1 }, duration_us: 60000000, duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709', background: { r: 0, g: 0, b: 0, a: 255 }, tracks: [
        { id: randomUUID(), label: null, enabled: true, locked: false, muted: false, solo: false, removable: false, role: 'ARoll', transient: false, height_px: 64, layers: [] },
        { id: randomUUID(), label: null, enabled: true, locked: false, muted: false, solo: false, removable: false, role: 'BRoll', transient: false, height_px: 64, layers: [] },
      ], markers: [], transitions: [], links: [] } },
      root_id: ROOT, next_group_ordinal: 1, media_pool: {}, audio_roles: {},
      settings: { preview_width: 1280, preview_height: 720, autosave_interval_secs: null, history_capacity: 500, auto_pair_audio_on_import: true, prefer_proxies: false, proxy_overrides: {}, shot_review: null, pause_review: null },
      motifs: {},
    };
  }

  async create({ name, note, doc }) {
    await this.ready;
    if (!doc) doc = await this.newProjectDoc(name);
    const id = randomUUID();
    const path = id + '.json';
    const cat = await this.catalog();
    cat[id] = { id, name, path, tags: [], note: note || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await writeAtomic(join(this.dir, path), JSON.stringify(doc, null, 1));
    await writeAtomic(join(this.dir, CATALOG), JSON.stringify(cat, null, 1));
    return cat[id];
  }

  async get(id) {
    await this.ready;
    const cat = await this.catalog();
    const entry = cat[id];
    if (!entry) return null;
    const doc = await readJson(join(this.dir, entry.path), null);
    // One-pass migration for pre-role documents (round 5 seeds): every track
    // gets an explicit role field, and the first two lanes of a composition
    // take the reserved A-roll / B-roll identities so AbRoll view shows them.
    if (doc && !this.#migrated?.has(id)) {
      if (!this.#migrated) this.#migrated = new Set();
      this.#migrated.add(id);
      let dirty = false;
      for (const comp of Object.values(doc.compositions || {})) {
        const tracks = comp.tracks || [];
        for (const track of tracks) if (!('role' in track)) { track.role = null; dirty = true; }
        if (!tracks.some((t) => t.role === 'ARoll' || t.role === 'BRoll')) {
          if (tracks[0] && tracks[0].role === null) { tracks[0].role = 'ARoll'; dirty = true; }
          if (tracks[1] && tracks[1].role === null) { tracks[1].role = 'BRoll'; dirty = true; }
        }
      }
      // Backfill real video dimensions for pool entries that predate probing.
      for (const media of Object.values(doc.media_pool || {})) {
        if (media.kind !== 'Video' || (media.metadata && media.metadata.video)) continue;
        const abs = this.mediaAbs(media.path_abs);
        if (!existsSync(abs)) continue;
        const dims = await this.probeDims(abs);
        if (dims) { media.metadata = { ...(media.metadata ?? {}), video: dims }; dirty = true; }
      }
      if (dirty) await this.#save(id, entry, doc);
    }
    return { entry, doc };
  }

  // find edits by tag query: open "the editing of shot c12" = tags ⊇ [shot-c12]
  async find(tagsAll = []) {
    const cat = await this.catalog();
    const need = new Set(tagsAll);
    return Object.values(cat).filter((e) => [...need].every((t) => (e.tags || []).includes(t)));
  }

  async #actor(id, entry, doc) {
    let a = this.actors.get(id);
    if (!a) {
      let n = 0;
      a = this.core.createActor({
        initial: doc,
        idGen: () => randomUUID(),
        clock: () => new Date().toISOString(),
      });
      this.actors.set(id, { handle: a, entry });
    }
    return this.actors.get(id);
  }

  // THE shared command path — UI and agents call exactly this.
  async command(id, channel, wireArgs, by) {
    await this.ready;
    const got = await this.get(id);
    if (!got || !got.doc) return { ok: false, error: { code: 'not_found', detail: 'editing ' + id + ' has no document' } };
    const wrapped = await this.#actor(id, got.entry, got.doc);
    const res = wrapped.handle.command(channel, wireArgs || {});
    if (res.ok) {
      const doc = wrapped.handle.snapshot();
      await this.#save(id, got.entry, doc);
      this.revision++;
      return { ok: true, value: res.value, tags: EditingStore.docTags(doc), checkpoint: wrapped.handle.listCheckpoints() };
    }
    return res;
  }

  // Same persist/tag path as command(), for the ops the camelWire command
  // switch does not expose (add_media_item, update_layer_params) — the snake
  // dispatch core owns them.
  async dispatchOp(id, op, args) {
    await this.ready;
    const got = await this.get(id);
    if (!got || !got.doc) return { ok: false, error: { code: 'not_found', detail: 'editing ' + id + ' has no document' } };
    const w = await this.#actor(id, got.entry, got.doc);
    const res = w.handle.dispatch(op, args || {});
    if (res.ok) {
      const doc = w.handle.snapshot();
      await this.#save(id, got.entry, doc);
      this.revision++;
      return { ok: true, value: res.value, tags: EditingStore.docTags(doc) };
    }
    return res;
  }

  snapshot(id) {
    const w = this.actors.get(id);
    return w ? w.handle.snapshot() : null;
  }

  // The renderer projection: exactly WeftCut's ProjectPublicationReply shape.
  // The UI never reads the raw document — it gets main's own buildProjectSummary
  // output, so the timeline sees the same projection WeftCut desktop renders.
  async publication(id) {
    await this.ready;
    const got = await this.get(id);
    if (!got || !got.doc) return null;
    const w = await this.#actor(id, got.entry, got.doc);
    // ponytail: static "present" verdicts — DSH media resolves through /api/file
    // at play time; upgrade path wires createPoolFiles fs existence gating.
    const summary = this.core.buildProjectSummary(w.handle.snapshot(), w.handle.historyStatus(), () => ({ source: 'present', quick_proxy: false, full_proxy: false, conform: false }));
    return { version: { session: this.session, revision: this.revision }, viewId: ++this.viewSeq, summary };
  }
  async undo(id) { return this.#historyOp(id, 'undo'); }
  async redo(id) { return this.#historyOp(id, 'redo'); }
  async #historyOp(id, kind) {
    await this.ready;
    const w = this.actors.get(id);
    if (!w) return { ok: false, error: { code: 'not_found', detail: 'no open editing' } };
    // undo/redo channels exist on the dispatch core; route through command for parity
    const res = w.handle.dispatch(kind, {});
    if (res.ok !== false) {
      await this.#save(id, w.entry, w.handle.snapshot());
      this.revision++;
      return { ok: true, tags: EditingStore.docTags(w.handle.snapshot()) };
    }
    return res;
  }
  async checkpoint(id, label) {
    const w = this.actors.get(id);
    if (!w) return { ok: false, error: { code: 'not_found' } };
    return { ok: true, id: w.handle.checkpoint(label) };
  }

  // Media-pool entry for a library clip (shape proven by scripts/coreprobe.mjs).
  // ponytail: path_rel mirrors the absolute path — DSH resolves media through
  // /api/file?path=, the WeftCut workspace-relative scheme is unused here.
  static poolEntry(id, path, durationUs, dims) {
    const p = String(path).replace(/\\/g, '/');
    // path_rel must be project-relative for the validator; the abs path is the
    // DSH source of truth (/api/file), rel just keeps the doc valid + readable.
    const rel = p.split('/').pop();
    return { id, label: null, path_abs: p, path_rel: rel, kind: 'Video', metadata: { duration_us: durationUs ?? null, video: dims ?? null, audio: null, container_format: null }, file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: new Date().toISOString(), decode_route: { route: 'bypass' }, conform_path: null };
  }

  // Seed an edit from Production shot slots: one Video track, one layer per shot
  // laid out in order, each layer tagged metadata.dsh — the tags are the EDL's
  // identity, so take/upscale swaps relink the media without touching layers.
  async seedShots(id, shots) {
    await this.ready;
    const got = await this.get(id);
    if (!got || !got.doc) return { ok: false, error: { code: 'not_found', detail: 'editing ' + id + ' has no document' } };
    const ROOT = got.doc.root_id;
    await this.#actor(id, got.entry, got.doc); // materialize the cached actor so snapshot() answers
    let trackId = (this.snapshot(id).compositions[ROOT].tracks.find((t) => t.role === 'ARoll') || this.snapshot(id).compositions[ROOT].tracks.find((t) => t.kind === 'Video') || {}).id;
    if (!trackId) {
      const r = await this.command(id, 'add_track', { compositionId: ROOT });
      if (!r.ok) return r;
      trackId = this.snapshot(id).compositions[ROOT].tracks.slice(-1)[0].id;
    }
    const added = [];
    let tUs = 0;
    const list = Array.isArray(shots) ? shots : (shots && Array.isArray(shots.shots) ? shots.shots : []);
    for (const shot of list) {
      if (!shot || !shot.path || !shot.shot_id) continue;
      const durUs = Math.round(Number(shot.duration_us ?? Number(shot.duration_s) * 1e6) || 5e6);
      const dims = await this.probeDims(this.mediaAbs(String(shot.path)));
      const med = await this.dispatchOp(id, 'add_media_item', { media: EditingStore.poolEntry(randomUUID(), String(shot.path), durUs, dims) });
      if (!med.ok) return { ok: false, error: med.error ?? med, added };
      const layer = await this.command(id, 'add_media_layer', { trackId, mediaId: med.value, tStartUs: tUs });
      if (!layer.ok) return { ok: false, error: layer.error ?? layer, added };
      const dsh = { shot_id: String(shot.shot_id) };
      if (shot.sequence_id) dsh.sequence_id = String(shot.sequence_id);
      if (shot.episode_id) dsh.episode_id = String(shot.episode_id);
      const st = await this.command(id, 'update_layer', { layerId: layer.value, patch: { metadata: { dsh } } });
      if (!st.ok) return { ok: false, error: st.error ?? st, added };
      added.push({ shot_id: String(shot.shot_id), media_id: med.value, layer_id: layer.value, t_start_us: tUs, duration_us: durUs });
      tUs += durUs;
    }
    return { ok: true, added };
  }

  // Swap the SOURCE of every layer for a shot slot (or a media id) — the take
  // changed, the edit does not move: times, trims, tags all survive.
  async relinkMedia(id, { media_id, shot_id, path, duration_us }) {
    await this.ready;
    const got = await this.get(id);
    if (!got || !got.doc) return { ok: false, error: { code: 'not_found', detail: 'editing ' + id + ' has no document' } };
    const snap = this.snapshot(id) ?? (await this.#actor(id, got.entry, got.doc)).handle.snapshot();
    const oldIds = [];
    for (const comp of Object.values(snap.compositions)) for (const tr of comp.tracks) for (const l of tr.layers) {
      if (!l.params || !l.params.media) continue;
      if (media_id && l.params.media === media_id) oldIds.push(media_id);
      else if (shot_id && l.metadata && l.metadata.dsh && l.metadata.dsh.shot_id === String(shot_id)) oldIds.push(l.params.media);
    }
    const uniq = [...new Set(oldIds)];
    if (!uniq.length) return { ok: false, error: { code: 'not_found', detail: 'no layers reference that media id or shot slot' } };
    const durUs = duration_us != null ? Math.round(Number(duration_us)) : null;
    const relinked = [];
    for (const old of uniq) {
      const newId = randomUUID();
      const dims = await this.probeDims(this.mediaAbs(String(path)));
      const add = await this.dispatchOp(id, 'add_media_item', { media: EditingStore.poolEntry(newId, String(path), durUs, dims) });
      if (!add.ok) return { ok: false, error: add.error ?? add, relinked };
      for (const comp of Object.values(this.snapshot(id).compositions)) for (const tr of comp.tracks) for (const l of tr.layers) {
        if (!l.params || l.params.media !== old) continue;
        // fork op: times/trims untouched, src_out clamped to the new duration
        const st = await this.dispatchOp(id, 'relink_layer_media', { layer: l.id, media: newId });
        if (!st.ok) return { ok: false, error: st.error ?? st, relinked };
        relinked.push({ layer_id: l.id, old_media_id: old, new_media_id: newId });
      }
    }
    return { ok: true, relinked };
  }

  async delete(id) {
    await this.ready;
    const cat = await this.catalog();
    const entry = cat[id];
    if (!entry) return false;
    this.actors.delete(id);
    delete cat[id];
    await writeAtomic(join(this.dir, CATALOG), JSON.stringify(cat, null, 1));
    await writeFile(join(this.dir, id + '.deleted.json'), JSON.stringify(entry, null, 1));
    return true;
  }
}
