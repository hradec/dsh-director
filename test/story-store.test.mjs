import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStoryStore} from '../src/story-store.mjs';

async function fresh(){return createStoryStore({root:join(await mkdtemp(join(tmpdir(),'story-')))});}

test('log, duplicate guard, harvest forces proposed', async () => {
  const s = await fresh();
  const d = await s.logDecision({handle: 'Catten dies in act 1', body: 'ngokang kills him Y45.', kind: 'decided', arc: 'Act 1'});
  assert.equal(d.kind, 'decided');
  await assert.rejects(() => s.logDecision({handle: 'catten dies in act 1', kind: 'open'}), /already exists/);
  const {created, skipped} = await s.harvest([{handle: 'Who finds the bone?', body: 'open since Nov 4 chat', kind: 'decided'}, {handle: 'Catten dies in act 1'}]);
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'proposed'); // harvest never imports decided or canon; the human decides on the wall
  assert.equal(skipped.length, 1);
});

test('canon cards are immutable for both hands', async () => {
  const s = await fresh();
  const c = await s.logDecision({handle: 'Towergrove founded Y31', kind: 'canon'});
  await assert.rejects(() => s.updateDecision(c.id, {body: 'edited'}), /immutable/);
  await assert.rejects(() => s.updateDecision(c.id, {kind: 'decided'}), /immutable/);
  await assert.rejects(() => s.deleteDecision(c.id), /cannot be deleted/);
  const open = await s.logDecision({handle: 'Wrong claim', kind: 'open', links: [{to: c.id, type: 'conflicts'}]});
  const updated = await s.updateDecision(open.id, {kind: 'superseded', supersedes: c.id});
  assert.ok(updated.links.some(l => l.type === 'supersedes' && l.to === c.id));
});

test('editing never promotes to canon; delete scrubs references', async () => {
  const s = await fresh();
  const d = await s.logDecision({handle: 'Movable', kind: 'open'});
  await assert.rejects(() => s.updateDecision(d.id, {kind: 'canon'}), /only set at creation/);
  await s.updateDecision(d.id, {kind: 'decided'});
  const beat = await s.saveBeat({handle: 'Siege starts', decision_ids: [d.id]});
  await s.deleteDecision(d.id);
  const snap = await s.story();
  assert.deepEqual(snap.beats[0].decision_ids, []);
  assert.equal(snap.decisions.length, 0);
  assert.equal(beat.handle, 'Siege starts');
});

test('chronology lint compares beats to entity life spans', async () => {
  const s = await fresh();
  const e = await s.saveEntity({name: 'Catten Craftsilver', legends_id: '690', birth_year: 14, death_year: 45});
  await s.saveBeat({handle: 'Catten at feast', story_year: 50, entity_ids: [e.id]});
  await s.saveBeat({handle: 'Catten born', story_year: 5, entity_ids: [e.id]});
  await s.saveBeat({handle: 'Fine', story_year: 40, entity_ids: [e.id]});
  const snap = await s.story();
  assert.equal(snap.issues.length, 2);
  assert.match(snap.issues[0].detail, /after Catten Craftsilver died in Y45/);
  assert.match(snap.issues[1].detail, /before Catten Craftsilver was born/);
});

test('episode projections order beats', async () => {
  const s = await fresh();
  const ep = await s.saveEpisode({title: 'The Ashen Bone', season: 1, order: 1});
  await s.saveBeat({handle: 'Cold open', episode_id: ep.id, order: 1});
  await s.saveBeat({handle: 'Title card', episode_id: ep.id, order: 2});
  const snap = await s.story();
  assert.equal(snap.episodes.length, 1);
  assert.deepEqual(snap.beats.filter(b => b.episode_id === ep.id).map(b => b.order), [1, 2]);
  await s.deleteEpisode(ep.id);
  assert.equal((await s.story()).beats.every(b => b.episode_id === null), true);
});
