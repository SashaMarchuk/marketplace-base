import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, warnings } from './_fixture.mjs';

const src = (o) => JSON.stringify({ name: 'demo', version: '0.1.0', description: 'Demo plugin.', ...o });

test('CHK-03 passes on a valid plugin.src.json', async () => {
  assert.deepEqual(await runRule('CHK-03', makeRepo()), []);
});

test('CHK-03 fails: name != dir, schema violation, clash with an included example', async () => {
  let r = errors(await runRule('CHK-03', makeRepo({ 'plugins/demo/plugin.src.json': src({ name: 'other' }) })));
  assert.match(r[0].message, /differs from its directory/);
  assert.equal(r[0].fix, 'rename dir or name');
  r = errors(await runRule('CHK-03', makeRepo({ 'plugins/demo/plugin.src.json': src({ description: 'no period' }) })));
  assert.equal(r.length, 1);
  r = errors(await runRule('CHK-03', makeRepo({ 'examples/plugins/demo/plugin.src.json': src() })));
  assert.equal(r.length, 2); // reported on both sides
});

test('CHK-03 ignores a clash with an example that is not included', async () => {
  const root = makeRepo({
    'marketplace.config.json': JSON.stringify({ name: 'acme-skills', displayName: 'A', description: 'A.', owner: { name: 'Alice' }, includeExamples: false }),
    'examples/plugins/demo/plugin.src.json': src(),
  });
  assert.deepEqual(await runRule('CHK-03', root), []);
});

test('CHK-03 warns on an unverified codex authentication value', async () => {
  const r = await runRule('CHK-03', makeRepo({ 'plugins/demo/plugin.src.json': src({ codex: { policy: { authentication: 'NEVER' } } }) }));
  assert.equal(errors(r).length, 0);
  assert.equal(warnings(r).length, 1);
});

test('CHK-03 rejects the reserved plugin names constructor and prototype (O13)', async () => {
  for (const n of ['constructor', 'prototype']) {
    const r = errors(await runRule('CHK-03', makeRepo({ [`plugins/${n}/plugin.src.json`]: src({ name: n }) })));
    assert.ok(r.some((e) => e.path === `plugins/${n}/plugin.src.json`), n);
  }
});
