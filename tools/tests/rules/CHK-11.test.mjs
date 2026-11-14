import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors } from './_fixture.mjs';

const SCHEMA = JSON.stringify({ type: 'object', properties: { maxItems: { type: 'integer', minimum: 1, maximum: 50 }, labels: { type: 'array', items: { type: 'string', maxLength: 10 } } } });

test('CHK-11 passes: defaults are an object and validate against a subset schema', async () => {
  const root = makeRepo({ 'plugins/demo/config.defaults.json': '{"maxItems":10,"labels":["a"]}', 'plugins/demo/config.schema.json': SCHEMA });
  assert.deepEqual(await runRule('CHK-11', root), []);
});

test('CHK-11 fails: float in defaults (config-text rules)', async () => {
  const r = errors(await runRule('CHK-11', makeRepo({ 'plugins/demo/config.defaults.json': '{"ratio":0.5}' })));
  assert.equal(r.length, 1);
  assert.equal(r[0].fix, 'see docs/base/config.md#schema');
});

test('CHK-11 fails: schema outside the subset, and defaults that do not validate', async () => {
  let r = errors(await runRule('CHK-11', makeRepo({ 'plugins/demo/config.defaults.json': '{}', 'plugins/demo/config.schema.json': '{"type":"object","required":["x"]}' })));
  assert.match(r[0].message, /outside the schema subset/);
  r = errors(await runRule('CHK-11', makeRepo({ 'plugins/demo/config.defaults.json': '{"maxItems":99}', 'plugins/demo/config.schema.json': SCHEMA })));
  assert.match(r[0].message, /does not match config.schema.json at \/maxItems/);
});
