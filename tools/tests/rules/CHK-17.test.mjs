import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeRepo, runRule, warnings, write } from './_fixture.mjs';
import { hashFile } from '../../lib/hash.mjs';

test('CHK-17 passes: local workflow outside mb-*, the local denylist is allowed', async () => {
  const root = makeRepo({ '.github/workflows/deploy.yml': 'on: push\n', '.mb/leak-denylist.txt': 'x\n' });
  assert.deepEqual(await runRule('CHK-17', root), []);
});

test('CHK-17 warns: D file under .mb/ in the base; unlocked file under tools/ in a derived repo', async () => {
  const root = makeRepo({ '.mb/notes.json': '{}', 'tools/mine.mjs': 'x\n' });
  const lock = { adopted: [], base: { url: 'u', tag: 'v0.1.0', commit: null }, files: { '.mb/ownership.json': hashFile(path.join(root, '.mb/ownership.json')) }, lockVersion: 1 };
  write(root, '.mb-lock.json', JSON.stringify(lock));
  const r = warnings(await runRule('CHK-17', root));
  assert.deepEqual(r.map((x) => x.path), ['.mb/notes.json', 'tools/mine.mjs']);
  assert.equal(r[0].fix, 'put local CI in .github/workflows/<name>.yml');
});
