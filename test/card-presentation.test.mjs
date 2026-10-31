import test from 'node:test';
import assert from 'node:assert/strict';
import {createCardPresentationRegistry} from '../src/card-presentation.mjs';

test('a rendered-card acknowledgement is session- and card-scoped with a stable time',()=>{
  let now=100;
  const registry=createCardPresentationRegistry({now:()=>now,ttlMs:500,maxEntries:8});
  assert.equal(registry.register('session-a','card-a'),true);
  assert.equal(registry.isPresented('session-a','card-a'),false);
  assert.equal(registry.acknowledge('session-b','card-a'),false);
  assert.equal(registry.acknowledge('session-a','card-b'),false);
  assert.equal(registry.acknowledge('session-a','card-a'),100);
  assert.equal(registry.isPresented('session-a','card-a'),true);
  assert.equal(registry.isPresented('session-a','card-a',99),false);
  assert.equal(registry.isPresented('session-a','card-a',100),true);
  now=200;
  assert.equal(registry.acknowledge('session-a','card-a'),100,'retry does not move the display time after a possible reply');
  assert.equal(registry.presentedAt('session-a','card-a'),100);
});

test('expired and evicted registrations cannot acknowledge an unseen card',()=>{
  let now=1;
  const registry=createCardPresentationRegistry({now:()=>now,ttlMs:10,maxEntries:2});
  registry.register('s','a');registry.acknowledge('s','a');
  now=12;
  assert.equal(registry.isPresented('s','a'),false);
  assert.equal(registry.acknowledge('s','a'),false);
  registry.register('s','b');registry.register('s','c');registry.register('s','d');
  assert.equal(registry.acknowledge('s','b'),false,'oldest bounded record was evicted');
  assert.equal(registry.acknowledge('s','d'),12);
});

test('invalid identities are rejected before registry access',()=>{
  const registry=createCardPresentationRegistry();
  for(const [session,card] of [['','card'],['s',''],['s','card\\nconfirm'],['x'.repeat(257),'card']]){
    assert.equal(registry.register(session,card),false);
    assert.equal(registry.acknowledge(session,card),false);
    assert.equal(registry.isPresented(session,card),false);
  }
});
