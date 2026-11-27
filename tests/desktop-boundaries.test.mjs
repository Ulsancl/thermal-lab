import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureProfile } from '../desktop/profile.cjs';
import { readProjectBytes } from '../desktop/read-project.cjs';

test('an opened handle returns at most the requested byte limit plus the sentinel byte', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thermal-read-'));
  const file = path.join(dir, 'project.json');
  await fs.writeFile(file, '1234');
  const handle = await fs.open(file, 'r');
  t.after(async () => {
    await handle.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal((await readProjectBytes(handle, 4)).toString(), '1234');
  const initial = await handle.stat();
  await fs.appendFile(file, 'more');
  const reads = [];
  const fragmentedReader = { read(buffer, offset, amount, position) {
    reads.push({ offset, amount });
    return handle.read(buffer, offset, Math.min(2, amount), position);
  } };
  await assert.rejects(readProjectBytes(fragmentedReader, initial.size), /1 MiB/);
  assert.deepEqual(reads, [{ offset: 0, amount: 5 }, { offset: 2, amount: 3 }, { offset: 4, amount: 1 }]);
});

test('test profile accepts local directories and rejects linked parents', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thermal-profile-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'normal'), target = path.join(dir, 'test', 'profile'), linked = path.join(dir, 'linked');
  assert.equal(configureProfile(local), local);
  assert.equal(configureProfile(local, target), target);
  await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => configureProfile(local, path.join(linked, 'child')), /real directories/);
  assert.deepEqual(await fs.readdir(target), []);
  assert.throws(() => configureProfile(local, 'relative'), /absolute local path/);
  if (process.platform === 'win32') assert.throws(() => configureProfile(local, '//example.invalid/share'), /absolute local path/);
});
