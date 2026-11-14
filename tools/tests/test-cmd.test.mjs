// Tests for tools/cmd/test.mjs file collection (plugin-own tests run in `mb test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testFiles } from '../cmd/test.mjs';

test('testFiles lists tools/tests (not fixtures) and {plugins,examples/plugins}/<p>/tests/**/*.test.mjs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-testcmd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const rel of [
    'tools/tests/a.test.mjs', 'tools/tests/fixtures/x.test.mjs',
    'plugins/demo/tests/unit/b.test.mjs', 'plugins/demo/tests/helper.mjs', 'plugins/demo/skills/s/c.test.mjs',
    'examples/plugins/ex/tests/d.test.mjs',
  ]) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  }
  assert.deepEqual(testFiles(root), ['tools/tests/a.test.mjs', 'plugins/demo/tests/unit/b.test.mjs', 'examples/plugins/ex/tests/d.test.mjs']);
});
