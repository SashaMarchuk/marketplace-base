import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors } from './_fixture.mjs';

const cfg = (extra) => JSON.stringify({ name: 'acme-skills', displayName: 'A', description: 'A.', owner: { name: 'Alice' }, ...extra });

test('CHK-02 passes: valid config, reordered layers are a data edit', async () => {
  const root = makeRepo({ 'marketplace.config.json': cfg({ config: { layers: ['skill-defaults', 'org', 'user', 'project'] } }) });
  assert.deepEqual(await runRule('CHK-02', root), []);
});

test('CHK-02 fails: layers not starting with skill-defaults, unknown key, missing file', async () => {
  let r = errors(await runRule('CHK-02', makeRepo({ 'marketplace.config.json': cfg({ config: { layers: ['org', 'skill-defaults'] } }) })));
  assert.ok(r.length >= 1);
  assert.equal(r[0].fix, 'see docs/base/config.md#layers');
  r = errors(await runRule('CHK-02', makeRepo({ 'marketplace.config.json': cfg({ colour: 'red' }) })));
  assert.equal(r.length, 1);
  r = errors(await runRule('CHK-02', makeRepo({ 'marketplace.config.json': null })));
  assert.match(r[0].message, /missing/);
});
