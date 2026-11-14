import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, runRule, errors, tmpDir, write } from './_fixture.mjs';

// A tool root with small pinned codex schemas, so the test does not depend on the generator's.
function toolRoot() {
  const t = tmpDir('mb-tool-');
  write(t, 'tools/schemas/codex-plugin.schema.json', JSON.stringify({ type: 'object', required: ['name', 'version'], properties: { name: { type: 'string' }, version: { type: 'string' } } }));
  write(t, 'tools/schemas/codex-marketplace.schema.json', JSON.stringify({ type: 'object', required: ['name', 'plugins'] }));
  fs.mkdirSync(path.join(t, '.mb'));
  return t;
}

const MKT = '{"name":"acme-skills","plugins":[]}';

test('CHK-19 passes when generated Codex files match the schemas', async () => {
  const root = makeRepo({ '.agents/plugins/marketplace.json': MKT, 'plugins/demo/.codex-plugin/plugin.json': '{"name":"demo","version":"0.1.0"}' });
  assert.deepEqual(await runRule('CHK-19', root, { toolRoot: toolRoot() }), []);
});

test('CHK-19 fails on a schema violation and on a missing file', async () => {
  const root = makeRepo({ '.agents/plugins/marketplace.json': MKT, 'plugins/demo/.codex-plugin/plugin.json': '{"name":"demo"}' });
  let r = errors(await runRule('CHK-19', root, { toolRoot: toolRoot() }));
  assert.equal(r.length, 1);
  assert.equal(r[0].fix, './mb gen');
  r = errors(await runRule('CHK-19', makeRepo({ '.agents/plugins/marketplace.json': MKT }), { toolRoot: toolRoot() }));
  assert.match(r[0].message, /missing/);
});
