import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, SKILL_MD } from './_fixture.mjs';

const REL = 'plugins/demo/skills/demo/SKILL.md';

test('CHK-06 passes: existing links, URLs, anchors, and fenced examples are ignored', async () => {
  const md = SKILL_MD + '\n[web](https://example.com) [top](#demo) `[Title](missing.md)`\n```\n[x](missing.md) `scripts/none.sh`\n```\n';
  assert.deepEqual(await runRule('CHK-06', makeRepo({ [REL]: md })), []);
});

test('CHK-06 fails: missing link target, missing backticked script, escape, too long', async () => {
  const md = SKILL_MD + '\n[x](references/missing.md) `scripts/run.sh` [up](../../../README.md) [`code`](gone.md)\n';
  const r = errors(await runRule('CHK-06', makeRepo({ [REL]: md })));
  assert.equal(r.length, 4);
  const long = errors(await runRule('CHK-06', makeRepo({ [REL]: SKILL_MD + 'x\n'.repeat(500) })));
  assert.match(long[0].message, /lines \(max 500\)/);
  assert.equal(long[0].fix, 'move detail to references/');
});
