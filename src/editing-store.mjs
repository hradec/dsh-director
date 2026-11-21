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
import { join } from 'node:path';
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
    this.core = core;
    this.actors = new Map();
    this.ready = this.#init();
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
      compositions: { [ROOT]: { id: ROOT, label: null, ordinal: 0, width: 1920, height: 1080, fps: { num: 24, den: 1 }, duration_us: 60000000, duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709', background: { r: 0, g: 0, b: 0, a: 255 }, tracks: [], markers: [], transitions: [], links: [] } },
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
    return { entry, doc: await readJson(join(this.dir, entry.path), null) };
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
      return { ok: true, value: res.value, tags: EditingStore.docTags(doc), checkpoint: wrapped.handle.listCheckpoints() };
    }
    return res;
  }

  snapshot(id) {
    const w = this.actors.get(id);
    return w ? w.handle.snapshot() : null;
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
      return { ok: true, tags: EditingStore.docTags(w.handle.snapshot()) };
    }
    return res;
  }
  async checkpoint(id, label) {
    const w = this.actors.get(id);
    if (!w) return { ok: false, error: { code: 'not_found' } };
    return { ok: true, id: w.handle.checkpoint(label) };
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
