import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors } from './_fixture.mjs';

test('CHK-22 passes: LF files; scripts run via sh; a plain path reference is fine', async () => {
  const root = makeRepo({ 'plugins/demo/skills/demo/references/guide.md': 'Run `sh <skill-dir>/scripts/x.sh`.\nSee `scripts/x.sh`.\nEvery save goes through `<skill-dir>/scripts/write.mjs`; run it as `node <skill-dir>/scripts/write.mjs`.\n```\nnode <skill-dir>/scripts/y.mjs\n```\n' });
  assert.deepEqual(await runRule('CHK-22', root), []);
});

test('CHK-22 fails: CRLF file and a script run directly', async () => {
  const root = makeRepo({
    'plugins/demo/skills/demo/references/guide.md': 'Run `<skill-dir>/scripts/x.sh --fast`.\n```sh\n./scripts/y.sh\n```\nThen run `./scripts/z.sh`.\n',
    'examples/plugins/ex/notes.txt': 'a\r\nb\r\n',
  });
  const r = errors(await runRule('CHK-22', root));
  assert.equal(r.length, 4);
  assert.ok(r.some((x) => x.fix === 'git add --renormalize'));
});
