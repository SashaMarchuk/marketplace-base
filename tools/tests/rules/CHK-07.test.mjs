import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors } from './_fixture.mjs';

test('CHK-07 passes with <skill-dir>-relative paths', async () => {
  const root = makeRepo({ 'plugins/demo/skills/demo/references/guide.md': 'Run `sh <skill-dir>/scripts/x.sh`.\n' });
  assert.deepEqual(await runRule('CHK-07', root), []);
});

test('CHK-07 fails on host variables and home paths under skills/', async () => {
  const text = 'node ${CLAUDE_PLUGIN_ROOT}/x\n$CODEX_HOME/y\ncat /' + 'home/alice/notes\n';
  const r = errors(await runRule('CHK-07', makeRepo({ 'plugins/demo/skills/demo/references/guide.md': text })));
  assert.equal(r.length, 3);
  assert.equal(r[0].fix, 'use `<skill-dir>/…`');
});

test('CHK-07 does not scan outside skills/', async () => {
  assert.deepEqual(await runRule('CHK-07', makeRepo({ 'plugins/demo/README.md': '${CLAUDE_PLUGIN_ROOT}\n' })), []);
});
