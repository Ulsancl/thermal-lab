import test from 'node:test';
import assert from 'node:assert/strict';
import { autosaveLockName, createBrowserAutosave, writeIfUnchanged, readTabDraft, writeTabDraft, clearTabDraft } from '../src/browser-autosave.js';

const key = 'lab-project-v1';
function fixture(base = 'baseline') {
  const rows = new Map([[key, base]]), writes = [];
  return { rows, writes, storage: () => ({
    getItem: name => rows.get(name) ?? null,
    setItem: (name, contents) => { writes.push(contents); rows.set(name, contents); },
  }) };
}

test('tab draft storage is independent, validates the envelope and fails closed if it is unavailable', () => {
  const records = new Map();
  const session = () => ({
    getItem: name => records.get(name) ?? null,
    setItem: (name, value) => records.set(name, value),
    removeItem: name => records.delete(name),
  });
  const denied = () => { throw new Error('session quota or permissions'); };
  const record = { expected: 'old bytes', contents: 'unsaved bytes', interrupted: false };
  assert.equal(writeTabDraft(denied, key, record), false);
  assert.equal(readTabDraft(denied, key), null);
  assert.doesNotThrow(() => clearTabDraft(denied, key));
  assert.equal(writeTabDraft(session, key, record), true);
  assert.deepEqual(readTabDraft(session, key), { version: 1, ...record });
  clearTabDraft(session, key, 'a different tab snapshot');
  assert.equal(readTabDraft(session, key).contents, record.contents);
  clearTabDraft(session, key, record.contents);
  assert.equal(readTabDraft(session, key), null);
  for (const bad of ['{', JSON.stringify({ ...record, version: 99 }), JSON.stringify({ ...record, version: 1, expected: 42 }),
    JSON.stringify({ ...record, version: 1, interrupted: 'yes' }), JSON.stringify({ ...record, version: 1, extra: true })]) {
    records.set(`${key}:tab-draft`, bad);
    assert.equal(readTabDraft(session, key), null);
  }
});

test('compare and write keeps divergent disk bytes and avoids redundant writes', () => {
  const { storage, writes } = fixture('other tab');
  assert.equal(writeIfUnchanged(storage(), key, 'baseline', 'new contents'), false);
  assert.deepEqual(writes, []);
  assert.equal(writeIfUnchanged(storage(), key, 'baseline', 'other tab'), true);
  assert.deepEqual(writes, []);
});

test('requests while waiting coalesce to the latest capture, with the read inside the exclusive lock', async () => {
  const { storage, writes } = fixture(), held = [];
  const locks = { request: (name, options, task) => new Promise(resolve => held.push({ name, options, release: () => resolve(task()) })) };
  let current = 'edit 1';
  const states = [];
  const autosave = createBrowserAutosave({ key, storage, locks, expected: 'baseline', baseline: 'baseline',
    capture: () => current, onStatus: status => states.push(status) });
  const first = autosave.flush();
  current = 'edit 2';
  assert.equal(autosave.flush(), first);
  assert.equal(held.length, 1);
  assert.equal(held[0].name, autosaveLockName(key));
  assert.equal(held[0].options.mode, 'exclusive');
  assert.deepEqual(writes, []);
  assert.equal(autosave.hasUnsavedChanges(), true);
  held.shift().release();
  await first;
  assert.deepEqual(writes, ['edit 2']);
  assert.deepEqual(states, ['saved']);
  assert.equal(autosave.hasUnsavedChanges(), false);
});

test('an edit arriving during a successful lock release gets another critical section', async () => {
  const { storage, writes } = fixture(), grants = [];
  const locks = { request: (_name, _options, task) => new Promise(resolve => grants.push(() => {
    const result = task();
    return () => resolve(result);
  })) };
  let current = 'first';
  const autosave = createBrowserAutosave({ key, storage, locks, expected: 'baseline', baseline: 'baseline',
    capture: () => current, onStatus: () => {} });
  const first = autosave.flush();
  const releaseFirst = grants.shift()();
  assert.deepEqual(writes, ['first']);
  current = 'second';
  assert.equal(autosave.flush(), first);
  assert.equal(grants.length, 0);
  releaseFirst();
  await new Promise(resolve => setImmediate(resolve)); // Drain microtasks, independent of a time delay.
  assert.equal(grants.length, 1);
  grants.shift()()();
  await first;
  assert.deepEqual(writes, ['first', 'second']);
  assert.equal(autosave.hasUnsavedChanges(), false);
});

test('on conflict the unsaved snapshot remains exportable and later changes do not touch shared bytes', async () => {
  const { storage, writes, rows } = fixture();
  let current = 'edit', release;
  const locks = { request: (_name, _options, task) => new Promise(resolve => { release = () => resolve(task()); }) };
  const states = [];
  const autosave = createBrowserAutosave({ key, storage, locks, expected: 'baseline', baseline: 'baseline',
    capture: () => current, onStatus: status => states.push(status) });
  const pending = autosave.flush();
  rows.set(key, 'changed while waiting');
  release(); await pending;
  assert.deepEqual(states, ['conflict']);
  assert.equal(autosave.canSave(), false);
  assert.equal(autosave.hasUnsavedChanges(), true);
  autosave.markExported(current);
  assert.equal(autosave.hasUnsavedChanges(), false);
  current = 'edit after export';
  assert.equal(autosave.hasUnsavedChanges(), true);
  await autosave.flush();
  assert.equal(rows.get(key), 'changed while waiting');
  assert.deepEqual(writes, []);
});

test('absent or denied Web Locks never fall back to an unlocked storage read/write', async () => {
  for (const locks of [null, { request: () => Promise.reject(new Error('denied')) }]) {
    let accesses = 0;
    const states = [];
    const autosave = createBrowserAutosave({ key, storage: () => { accesses++; throw new Error('storage must not be touched'); },
      locks, expected: 'baseline', baseline: 'baseline', capture: () => 'edit', onStatus: status => states.push(status) });
    await autosave.flush();
    assert.equal(autosave.canSave(), false);
    assert.equal(autosave.hasUnsavedChanges(), true);
    assert.equal(accesses, 0);
    assert.deepEqual(states, locks ? ['unavailable'] : []);
  }
});

test('quota failure remains exportable and a later attempt can save', async () => {
  const { storage, writes, rows } = fixture();
  let denied = true, current = 'edit';
  const states = [];
  const autosave = createBrowserAutosave({
    key, storage: () => denied ? { ...storage(), setItem: () => { throw new Error('quota'); } } : storage(),
    locks: { request: async (_name, _options, task) => task() }, expected: 'baseline', baseline: 'baseline',
    capture: () => current, onStatus: status => states.push(status),
  });
  await autosave.flush();
  assert.deepEqual(states, ['failed']);
  assert.equal(rows.get(key), 'baseline');
  assert.equal(autosave.hasUnsavedChanges(), true);
  assert.equal(autosave.canSave(), true);
  denied = false;
  await autosave.flush();
  assert.deepEqual(states, ['failed', 'saved']);
  assert.deepEqual(writes, ['edit']);
  current = 'next edit';
  await autosave.flush();
  assert.deepEqual(writes, ['edit', 'next edit']);
});
