import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, gitInit, git, tmpDir, write } from './_fixture.mjs';
import { newer } from '../../lib/rules/CHK-24.mjs';

// A local "base" repo with tags v0.1.0, v0.2.0 and v0.3.0-rc.1 (never "latest").
function baseRepo() {
  const b = gitInit(makeRepo());
  git(b, 'tag', 'v0.1.0');
  write(b, 'x.txt', '1\n'); git(b, 'add', '-A'); git(b, 'commit', '-q', '-m', 'two');
  git(b, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');
  write(b, 'x.txt', '2\n'); git(b, 'add', '-A'); git(b, 'commit', '-q', '-m', 'rc');
  git(b, 'tag', 'v0.3.0-rc.1');
  return b;
}

const derived = (url, tag) => makeRepo({ '.mb-lock.json': JSON.stringify({ adopted: [], base: { url, tag, commit: null }, files: {}, lockVersion: 1 }) });

test('CHK-24 passes (no result) when the lock is on the newest stable tag; rc tags ignored', async () => {
  const base = baseRepo();
  assert.deepEqual(await runRule('CHK-24', derived(base, 'v0.2.0')), []);
});

test('CHK-24 reports (info) a newer stable tag; --offline skips', async () => {
  const base = baseRepo();
  const r = await runRule('CHK-24', derived(base, 'v0.1.0'));
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'info');
  assert.match(r[0].message, /base v0\.2\.0 is available/);
  assert.equal(r[0].fix, './mb base-update');
  assert.deepEqual(await runRule('CHK-24', derived(base, 'v0.1.0'), { offline: true }), []);
});

test('CHK-24 version order', () => {
  assert.equal(newer('v1.0.0', 'v1.0.0-rc.1'), true);
  assert.equal(newer('v1.0.0-rc.2', 'v1.0.0'), false);
  assert.equal(newer('v1.10.0', 'v1.9.9'), true);
  assert.ok(tmpDir());
});
