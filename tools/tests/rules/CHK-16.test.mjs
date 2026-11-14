import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeRepo, runRule, errors, write } from './_fixture.mjs';
import { hashFile } from '../../lib/hash.mjs';

function derived(extra = {}) {
  const root = makeRepo({ 'CONTRIBUTING.md': '# Contributing\n', 'tools/x.mjs': 'export {};\n', ...extra });
  const files = {};
  for (const rel of ['CONTRIBUTING.md', 'tools/x.mjs', '.mb/ownership.json']) files[rel] = hashFile(path.join(root, rel));
  const lock = { adopted: [], base: { url: 'https://example.com/base.git', tag: 'v0.1.0', commit: null }, files, lockVersion: 1 };
  write(root, '.mb-lock.json', JSON.stringify(lock, null, 2) + '\n');
  return root;
}

test('CHK-16 passes: base repo is skipped; derived files match the lock', async () => {
  assert.deepEqual(await runRule('CHK-16', makeRepo()), []);
  assert.deepEqual(await runRule('CHK-16', derived()), []);
});

test('CHK-16 passes: a marker body edit is not drift (hash rule)', async () => {
  const root = derived({ 'CONTRIBUTING.md': '# C\n<!-- mb:x:begin -->\nbase\n<!-- mb:x:end -->\n' });
  write(root, 'CONTRIBUTING.md', '# C\n<!-- mb:x:begin -->\nderived\n<!-- mb:x:end -->\n');
  assert.deepEqual(await runRule('CHK-16', root), []);
});

test('CHK-16 fails: edited B file, deleted B file, B path with no lock entry', async () => {
  const root = derived();
  write(root, 'CONTRIBUTING.md', '# Edited\n');
  write(root, 'SECURITY.md', '# local\n');
  write(root, 'tools/x.mjs', 'export const y = 1;\n');
  const r = errors(await runRule('CHK-16', root));
  assert.deepEqual(r.map((x) => x.path), ['CONTRIBUTING.md', 'SECURITY.md', 'tools/x.mjs']);
  assert.equal(r[0].fix, 'revert, or upstream a PR; `base-update --force` to reset');
});
