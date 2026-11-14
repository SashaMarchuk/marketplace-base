import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, gitInit, git, write } from './_fixture.mjs';

const src = (v) => JSON.stringify({ name: 'demo', version: v, description: 'Demo plugin.' }) + '\n';

function repoWithCommit(edit) {
  const root = gitInit(makeRepo());
  edit(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  return root;
}

test('CHK-15 passes: evals/** and README.md changes need no bump (--base HEAD^1)', async () => {
  const root = repoWithCommit((r) => {
    write(r, 'plugins/demo/evals/demo-trigger/prompt.md', 'changed\n');
    write(r, 'plugins/demo/README.md', '# Demo\n');
  });
  assert.deepEqual(await runRule('CHK-15', root, { base: 'HEAD^1' }), []);
});

test('CHK-15 passes when the version increased', async () => {
  const root = repoWithCommit((r) => {
    write(r, 'plugins/demo/skills/demo/references/guide.md', 'new\n');
    write(r, 'plugins/demo/plugin.src.json', src('0.1.1'));
  });
  assert.deepEqual(await runRule('CHK-15', root, { base: 'HEAD^1' }), []);
});

test('CHK-15 fails: a SKILL.md change without a bump, compared against HEAD^1', async () => {
  const root = repoWithCommit((r) => write(r, 'plugins/demo/skills/demo/references/guide.md', 'new\n'));
  const r = errors(await runRule('CHK-15', root, { base: 'HEAD^1' }));
  assert.equal(r.length, 1);
  assert.equal(r[0].fix, './mb bump demo');
  assert.match(r[0].message, /version 0\.1\.0 did not increase/);
});

test('CHK-15 sees uncommitted and untracked changes against the base ref', async () => {
  const root = gitInit(makeRepo());
  write(root, 'plugins/demo/skills/demo/references/new.md', 'x\n');
  assert.equal(errors(await runRule('CHK-15', root, { base: 'HEAD' })).length, 1);
});

test('CHK-15 is skipped (info) when no comparison commit exists', async () => {
  const root = gitInit(makeRepo());
  const r = await runRule('CHK-15', root);
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'info');
});
