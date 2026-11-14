import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, SKILL_MD } from './_fixture.mjs';

test('CHK-05 passes with unique skill names', async () => {
  assert.deepEqual(await runRule('CHK-05', makeRepo({ 'plugins/other/skills/other/SKILL.md': SKILL_MD.replace('name: demo', 'name: other') })), []);
});

test('CHK-05 fails when two plugins ship the same skill name', async () => {
  const r = errors(await runRule('CHK-05', makeRepo({ 'plugins/other/skills/demo/SKILL.md': SKILL_MD })));
  assert.equal(r.length, 2);
  assert.equal(r[0].fix, 'rename skill');
});
