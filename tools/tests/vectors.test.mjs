// tools/tests/vectors.test.mjs: conformance vectors against tools/kit/resolve.mjs (byte + exit),
// run as a real process (`<node> resolve.mjs merge < input.json`), plus engine cases no vector covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { core } from '../kit/resolve.mjs';
import { canonical } from '../kit/json.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit');
const RESOLVE = path.join(KIT, 'resolve.mjs');
const VDIR = path.join(KIT, 'vectors');
const vectors = fs.readdirSync(VDIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

test('all 58 required vectors are present, each with its 3 files', () => {
  assert.ok(vectors.length >= 58);
  for (const v of vectors) for (const f of ['input.json', 'expected.json', 'expected.exit']) assert.ok(fs.existsSync(path.join(VDIR, v, f)), `${v}/${f}`);
});

for (const v of vectors) {
  test(`vector ${v}`, () => {
    const d = path.join(VDIR, v);
    const r = spawnSync(process.execPath, [RESOLVE, 'merge'], { input: fs.readFileSync(path.join(d, 'input.json')) });
    assert.equal(r.status, Number(fs.readFileSync(path.join(d, 'expected.exit'), 'utf8').trim()), `exit of ${v}`);
    assert.equal(r.stdout.toString('utf8'), fs.readFileSync(path.join(d, 'expected.json'), 'utf8'));
  });
}

// ---- engine cases not covered by a vector ----
const env = { platform: 'posix', cwd: '/r', gitRoot: '/r', home: '/h', XDG_CONFIG_HOME: null, APPDATA: null };
const LAYERS = ['skill-defaults', 'org', 'team', 'project', 'user', 'project-local'];
function run(defaults, files, plugin = 'p') {
  const I = { specVersion: 1, request: { plugin, tier: 'a' }, kit: { marketplace: 'acme', plugin, skill: 's', layers: LAYERS, defaults }, env };
  const r = core(I, (p) => files[p]);
  return { ...r, settings: r.settings && JSON.parse(canonical(r.settings)), provenance: r.provenance && JSON.parse(canonical(r.provenance)) };
}
const USER = '/h/.config/acme/config.json';
const ORG = '$KIT/policy/org.json';

test('inherited Object.prototype names are ordinary setting keys', () => {
  const r = run({ toString: 1, hasOwnProperty: 'x' }, { [USER]: '{"settings":{"valueOf":{"isPrototypeOf":true},"toString":2}}' });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.settings, { hasOwnProperty: 'x', toString: 2, valueOf: { isPrototypeOf: true } });
  assert.equal({}.isPrototypeOf, Object.prototype.isPrototypeOf, 'no prototype pollution');
});

test('plugin named like a prototype member does not read inherited entries', () => {
  for (const name of ['constructor', 'tostring', 'valueof']) {
    const r = run({ a: 1 }, { [USER]: '{"plugins":{"other":{"enabled":false}}}', [ORG]: '{"enforced":{"plugins":{"x":{"enabled":false}}}}' }, name);
    assert.equal(r.exit, 0, name);
    assert.deepEqual(r.settings, { a: 1 });
  }
});

test('provenance on a type change lists exactly the current leaves', () => {
  // scalar -> object
  let r = run({ a: 1 }, { [USER]: '{"settings":{"a":{"b":2}}}' });
  assert.deepEqual(r.provenance, { '/a/b': 'user' });
  // object -> scalar
  r = run({ a: { b: 1, c: 2 } }, { [USER]: '{"settings":{"a":3}}' });
  assert.deepEqual(r.provenance, { '/a': 'user' });
  // null deletes a subtree with its provenance
  r = run({ a: { b: 1 }, k: 1 }, { [USER]: '{"settings":{"a":null}}' });
  assert.deepEqual(r.provenance, { '/k': 'skill-defaults' });
});

test('access glob is linear on hostile patterns', () => {
  const pat = '*'.repeat(30) + 'a' + '*'.repeat(30) + 'z';
  const t0 = Date.now();
  const r = run({}, { [ORG]: JSON.stringify({ access: { allow: [pat] } }) }, 'b'.repeat(64));
  assert.equal(r.exit, 4);
  assert.ok(Date.now() - t0 < 1000);
});

test('glob semantics: whole-name match, * matches the empty run', () => {
  assert.equal(run({}, { [ORG]: '{"access":{"deny":["p*"]}}' }).exit, 4);
  assert.equal(run({}, { [ORG]: '{"access":{"deny":["*p*"]}}' }).exit, 4);
  assert.equal(run({}, { [ORG]: '{"access":{"deny":["x*"]}}' }).exit, 0);
  assert.equal(run({}, { [ORG]: '{"access":{"allow":["p-*"]}}' }, 'p-a-b').exit, 0);
});

test('team value is never used as a path unless it is a valid name', () => {
  const asked = [];
  const I = { specVersion: 1, request: { plugin: 'p', tier: 'a' }, kit: { marketplace: 'acme', plugin: 'p', skill: 's', layers: LAYERS, defaults: {} }, env };
  const r = core(I, (p) => { asked.push(p); return p === USER ? '{"team":"a/../b"}' : undefined; });
  assert.equal(r.exit, 0);
  assert.ok(!asked.some((p) => p.includes('teams')));
  assert.deepEqual(r.warnings, [{ code: 'KEY_IGNORED', layer: 'user' }]);
});

test('only candidate paths are requested (no walk-up)', () => {
  const asked = [];
  const I = { specVersion: 1, request: { plugin: 'p', tier: 'a' }, kit: { marketplace: 'acme', plugin: 'p', skill: 's', layers: LAYERS, defaults: {} },
    env: { ...env, cwd: '/r/a/b' } };
  core(I, (p) => { asked.push(p); });
  assert.deepEqual(asked.sort(), ['$KIT/policy/org.json', '/h/.config/acme/config.json', '/r/.acme/config.json', '/r/.acme/config.local.json']);
});
