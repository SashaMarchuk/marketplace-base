import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, runRule, errors } from './_fixture.mjs';

test('CHK-08 passes: ../ inside the plugin is fine; a JSON $schema hint is exempt', async () => {
  const root = makeRepo({
    'plugins/demo/skills/demo/references/a.md': 'See [guide](../references/guide.md).\n',
    'plugins/demo/plugin.src.json': '{\n  "$schema": "../../tools/schemas/plugin-src.schema.json",\n  "name": "demo", "version": "0.1.0", "description": "Demo plugin."\n}\n',
  });
  assert.deepEqual(await runRule('CHK-08', root), []);
});

test('CHK-08 fails on a ../ escape from the plugin dir', async () => {
  const root = makeRepo({ 'plugins/demo/skills/demo/references/a.md': 'See [x](../../../../shared/x.md).\n' });
  const r = errors(await runRule('CHK-08', root));
  assert.equal(r.length, 1);
  assert.match(r[0].message, /escapes the plugin dir/);
});

test('CHK-08 fails on a symlink', { skip: process.platform === 'win32' }, async () => {
  const root = makeRepo();
  fs.symlinkSync('guide.md', path.join(root, 'plugins/demo/skills/demo/references/link.md'));
  const r = errors(await runRule('CHK-08', root));
  assert.equal(r.length, 1);
  assert.equal(r[0].fix, 'copy the file into the plugin');
});
