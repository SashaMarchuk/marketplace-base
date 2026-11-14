import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, runRule, errors, gitInit, git, tmpDir, write } from './_fixture.mjs';

// Fake secrets are assembled at runtime so this file never contains one.
const FAKE_GH = 'gh' + 'p_' + 'A1b2C3d4'.repeat(5);
const FAKE_JWT = 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTYifQ';
const HOME = '/' + 'Users' + '/' + 'someone' + '/project';
// No gitleaks and no denylist env: deterministic regardless of the machine.
const env = { PATH: '', MB_LEAK_DENYLIST: '' };

test('CHK-20 passes on a clean repo', async () => {
  assert.deepEqual(await runRule('CHK-20', makeRepo(), { env }), []);
});

test('CHK-20 fails on a JWT-shaped string and a GitHub token, without printing them', async () => {
  const root = makeRepo({ 'plugins/demo/skills/demo/references/guide.md': `token ${FAKE_JWT}\nx ${FAKE_GH}\n` });
  const r = errors(await runRule('CHK-20', root, { env }));
  assert.deepEqual(r.map((x) => x.message).sort(), [
    'plugins/demo/skills/demo/references/guide.md:1: JWT-shaped token',
    'plugins/demo/skills/demo/references/guide.md:2: GitHub token',
  ]);
});

test('CHK-20 allowlist marker exempts a built-in hit', async () => {
  const root = makeRepo({ 'docs/x.md': `${FAKE_JWT} mb-allow-leak: documented example\n` });
  assert.deepEqual(await runRule('CHK-20', root, { env }), []);
});

test('CHK-20 home paths only matter in spikes/** and tools/tests/fixtures/**', async () => {
  const ok = makeRepo({ 'docs/x.md': `${HOME}\n` });
  assert.deepEqual(await runRule('CHK-20', ok, { env }), []);
  const bad = makeRepo({ 'tools/tests/fixtures/run.jsonl': `{"cwd":"${HOME}"}\n` });
  assert.equal(errors(await runRule('CHK-20', bad, { env })).length, 1);
});

test('CHK-20 private denylist from $MB_LEAK_DENYLIST (outside the repo); hits do not echo the pattern', async () => {
  const outside = tmpDir('mb-deny-');
  const list = path.join(outside, 'deny.txt');
  fs.writeFileSync(list, '# private words\nzork[a-z]*corp\n');
  const root = makeRepo({ 'docs/x.md': 'made for ZorkleCorp\n' });
  const r = errors(await runRule('CHK-20', root, { env: { ...env, MB_LEAK_DENYLIST: list } }));
  assert.equal(r.length, 1);
  assert.equal(r[0].message, 'docs/x.md:1: matches private denylist pattern #2');
  assert.doesNotMatch(JSON.stringify(r), /zork/i);
});

test('CHK-20 "!" allow lines strip a public substring before deny patterns run', async () => {
  const outside = tmpDir('mb-deny-');
  const list = path.join(outside, 'deny.txt');
  fs.writeFileSync(list, 'zorkcorp\n!github\\.com/zorkcorp/public-repo\n');
  const ok = makeRepo({ 'docs/x.md': 'see https://github.com/zorkcorp/public-repo\n' });
  assert.deepEqual(await runRule('CHK-20', ok, { env: { ...env, MB_LEAK_DENYLIST: list } }), []);
  const bad = makeRepo({ 'docs/x.md': 'see https://github.com/zorkcorp/public-repo and ZorkCorp inc\n' });
  assert.equal(errors(await runRule('CHK-20', bad, { env: { ...env, MB_LEAK_DENYLIST: list } })).length, 1);
});

test('CHK-20 reads the gitignored local .mb/leak-denylist.txt and does not scan it', async () => {
  const root = gitInit(makeRepo({ 'docs/x.md': 'quuxword\n' }));
  write(root, '.mb/leak-denylist.txt', 'quuxword\n');
  const r = errors(await runRule('CHK-20', root, { env }));
  assert.deepEqual(r.map((x) => x.path), ['docs/x.md']);
});

test('CHK-20 fails on a tracked .mb/leak-denylist.txt', async () => {
  const root = gitInit(makeRepo());
  write(root, '.mb/leak-denylist.txt', 'nothing-matches-this-xyz\n');
  git(root, 'add', '-f', '.mb/leak-denylist.txt');
  const r = errors(await runRule('CHK-20', root, { env }));
  assert.deepEqual(r.map((x) => x.path), ['.mb/leak-denylist.txt']);
});

test('CHK-20 fails closed on a bad pattern or an unreadable denylist', async () => {
  const outside = tmpDir('mb-deny-');
  const list = path.join(outside, 'deny.txt');
  fs.writeFileSync(list, 'ok\n(unclosed\n');
  const root = makeRepo();
  const r1 = errors(await runRule('CHK-20', root, { env: { ...env, MB_LEAK_DENYLIST: list } }));
  assert.match(r1[0].message, /invalid pattern on line 2/);
  const r2 = errors(await runRule('CHK-20', root, { env: { ...env, MB_LEAK_DENYLIST: path.join(outside, 'missing.txt') } }));
  assert.match(r2[0].message, /cannot read the private denylist/);
});

test('CHK-20 gitleaks findings fail (fake gitleaks on PATH)', { skip: process.platform === 'win32' }, async () => {
  const bin = tmpDir('mb-bin-');
  fs.writeFileSync(path.join(bin, 'gitleaks'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = errors(await runRule('CHK-20', makeRepo(), { env: { ...env, PATH: bin } }));
  assert.match(r[0].message, /gitleaks reported findings/);
});
