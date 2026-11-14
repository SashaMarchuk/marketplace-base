// tools/tests/fallback-guard.test.mjs: the tier-b hash guard of tools/kit/FALLBACK.md step 5 (POSIX).
// The command is taken verbatim from FALLBACK.md and run under /bin/sh against a stub merger:
// it must run the merger only when the saved sha256 matches, and print HASH_MISMATCH otherwise.
// (The PowerShell variant is not tested here.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FALLBACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit', 'FALLBACK.md');
// Same probe as FALLBACK step 6: python3 must print 3 (rejects the macOS install stub).
const py = spawnSync('python3', ['-c', 'import json,sys;print(sys.version_info[0])'], { encoding: 'utf8' });
const skip = process.platform === 'win32' ? 'POSIX only' : !fs.existsSync('/bin/sh') ? 'no /bin/sh'
  : py.status !== 0 || py.stdout.trim() !== '3' ? 'no python3' : false;

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fallback-guard-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** The single POSIX guarded command of step 5 (the backticked line after "POSIX (`K.py`):"). */
function guardCommand() {
  const text = fs.readFileSync(FALLBACK, 'utf8');
  const step5 = text.slice(text.indexOf('## 5.'), text.indexOf('## 6.'));
  const found = [...step5.matchAll(/POSIX \(`K\.py`\):\s*\n\s*`(.+)`\s*\n/g)].map((m) => m[1]);
  assert.equal(found.length, 1, 'FALLBACK.md step 5 must hold exactly one POSIX guarded command');
  assert.match(found[0], /HASH_MISMATCH/);
  return found[0];
}

// Stub merger: records that it ran (with its env and argv) and prints a tier-b result.
const STUB = [
  'import json, os, sys',
  "open(os.environ['MARKER'], 'w').write(json.dumps({'tier': os.environ.get('MB_TIER'), 'kit': os.environ.get('MB_KIT'), 'argv': sys.argv[1:]}))",
  'print(json.dumps({"ok": True, "tier": "b"}))',
  '',
].join('\n');

function run(cmd, cwd, marker) {
  return spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, MARKER: marker } });
}

test('FALLBACK step 5 POSIX guard: runs the saved merger only on a hash match', { skip }, () => {
  const skillDir = path.join(TMP, 'skill dir'); // a space, as in real home paths
  const cmd = guardCommand().replaceAll('<skill-dir>', skillDir);
  // The command names the merger "M/K.py"; run it from a dir that holds M/K.py and M/K.py.sha256.
  const cwd = path.join(TMP, 'w');
  fs.mkdirSync(path.join(cwd, 'M'), { recursive: true });
  const merger = path.join(cwd, 'M', 'K.py');
  fs.writeFileSync(merger, STUB);
  fs.writeFileSync(`${merger}.sha256`, crypto.createHash('sha256').update(STUB).digest('hex') + '\n');

  const marker = path.join(TMP, 'ran.json');
  const ok = run(cmd, cwd, marker);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, tier: 'b' });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { tier: 'b', kit: `${skillDir}/_mb`, argv: ['resolve'] });
  fs.rmSync(marker);

  // One appended byte: the guard refuses and the merger never runs.
  fs.appendFileSync(merger, '#');
  const bad = run(cmd, cwd, marker);
  assert.equal(bad.stdout.trim(), 'HASH_MISMATCH');
  assert.ok(!fs.existsSync(marker), 'a tampered merger must not run');

  // A missing hash file is a mismatch too.
  fs.writeFileSync(merger, STUB);
  fs.rmSync(`${merger}.sha256`);
  const none = run(cmd, cwd, marker);
  assert.equal(none.stdout.trim(), 'HASH_MISMATCH');
  assert.ok(!fs.existsSync(marker));
});
