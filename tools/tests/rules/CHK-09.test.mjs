import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, warnings } from './_fixture.mjs';

test('CHK-09 passes for a skills-only plugin', async () => {
  assert.deepEqual(await runRule('CHK-09', makeRepo()), []);
});

test('CHK-09 warns in plugins/, errors in examples/', async () => {
  const root = makeRepo({
    'plugins/demo/commands/x.md': 'x\n',
    'examples/plugins/ex/plugin.src.json': JSON.stringify({ name: 'ex', version: '0.1.0', description: 'Ex.' }),
    'examples/plugins/ex/.mcp.json': '{}',
  });
  const r = await runRule('CHK-09', root);
  assert.deepEqual(warnings(r).map((x) => x.path), ['plugins/demo/commands']);
  assert.deepEqual(errors(r).map((x) => x.path), ['examples/plugins/ex/.mcp.json']);
});
