import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, runRule, errors, tmpDir, write } from './_fixture.mjs';

// A fake `claude` on PATH: fails when the validated dir holds a file named BAD, and records the
// CLAUDE_CONFIG_DIR it was given.
function fakeClaude() {
  const bin = tmpDir('mb-bin-');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "$CLAUDE_CONFIG_DIR" > "$4/.config-dir-used"\nif [ -f "$4/BAD" ]; then echo "Validation failed: bad manifest"; exit 1; fi\nexit 0\n', { mode: 0o755 });
  return { PATH: `${bin}:/bin:/usr/bin` };
}

function generated() {
  return makeRepo({ '.claude-plugin/marketplace.json': '{}', 'plugins/demo/.claude-plugin/plugin.json': '{}' });
}

const posix = { skip: process.platform === 'win32' };

test('CHK-18 passes when the validator accepts root and plugins, with a temp CLAUDE_CONFIG_DIR', posix, async () => {
  const root = generated();
  assert.deepEqual(await runRule('CHK-18', root, { env: fakeClaude() }), []);
  const used = fs.readFileSync(path.join(root, '.config-dir-used'), 'utf8').trim();
  assert.match(path.basename(used), /^mb-claude-config-/);
  assert.equal(fs.existsSync(used), false); // cleaned up
});

test('CHK-18 fails with the validator message', posix, async () => {
  const root = generated();
  write(root, 'plugins/demo/BAD', 'x');
  const r = errors(await runRule('CHK-18', root, { env: fakeClaude() }));
  assert.equal(r.length, 1);
  assert.equal(r[0].path, 'plugins/demo/.claude-plugin/plugin.json');
  assert.match(r[0].message, /bad manifest/);
});

test('CHK-18 without claude: info locally, error in CI', async () => {
  const root = generated();
  const local = await runRule('CHK-18', root, { env: { PATH: '' } });
  assert.equal(local[0].severity, 'info');
  const ci = await runRule('CHK-18', root, { env: { PATH: '', CI: 'true' } });
  assert.equal(ci[0].severity, 'error');
});
