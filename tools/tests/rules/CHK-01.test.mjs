import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors } from './_fixture.mjs';

test('CHK-01 passes: floats allowed, D JSON (.vscode) not scanned', async () => {
  const root = makeRepo({
    'marketplace.config.json': JSON.stringify({ name: 'acme-skills', displayName: 'A', description: 'A.', owner: { name: 'Alice' }, evals: { threshold: 0.6 } }),
    '.vscode/settings.json': '{ "a": 1, "a": 2, // comment\n}',
  });
  assert.deepEqual(await runRule('CHK-01', root), []);
});

test('CHK-01 fails: duplicate key in a plugin source file, with line', async () => {
  const root = makeRepo({ 'plugins/demo/plugin.src.json': '{\n  "name": "demo",\n  "name": "demo"\n}\n' });
  const r = errors(await runRule('CHK-01', root));
  assert.equal(r.length, 1);
  assert.equal(r[0].path, 'plugins/demo/plugin.src.json');
  assert.match(r[0].message, /:3:/);
  assert.equal(r[0].fix, 'fix JSON at plugins/demo/plugin.src.json:3');
});

test('CHK-01 fails: forbidden key in policy/**', async () => {
  const root = makeRepo({ 'policy/teams/pay.json': '{"settings":{"__proto__":{}}}' });
  assert.equal(errors(await runRule('CHK-01', root)).length, 1);
});
