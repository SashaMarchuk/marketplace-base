// tools/tests/resolve-real.test.mjs: tools/kit/resolve.mjs in real mode on real temp dirs and git repos
// plus `set`/`unset`. Temp dirs come from os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit');
const RESOLVE = path.join(KIT_SRC, 'resolve.mjs');
const WIN = process.platform === 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-resolve-real-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const LAYERS = ['skill-defaults', 'org', 'team', 'project', 'user', 'project-local'];
let n = 0;
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

/** A fresh sandbox T with a kit dir T/k (kit.json + optional policy/schema) and a home T/h. */
function sandbox({ defaults = { maxItems: 5, style: { tone: 'neutral' } }, org, schema } = {}) {
  const T = path.join(TMP, `t${++n}`);
  const k = path.join(T, 'k');
  write(path.join(k, 'kit.json'), JSON.stringify({ defaults, layers: LAYERS, marketplace: 'acme', plugin: 'p', skill: 's', specVersion: 1 }));
  if (org) write(path.join(k, 'policy', 'org.json'), org);
  if (schema) write(path.join(k, 'config.schema.json'), JSON.stringify(schema));
  fs.mkdirSync(path.join(T, 'h'), { recursive: true });
  const userFile = WIN ? path.join(T, 'a', 'acme', 'config.json') : path.join(T, 'h', '.config', 'acme', 'config.json');
  return { T, k, userFile };
}
function gitInit(dir) { fs.mkdirSync(dir, { recursive: true }); assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0); }

/** Run resolve.mjs with a clean env: HOME/APPDATA in T, MB_KIT=T/k, no XDG unless given. */
function resolve(sb, args, { cwd, xdg, kit = sb.k, script = RESOLVE } = {}) {
  const env = { PATH: process.env.PATH, HOME: path.join(sb.T, 'h'), USERPROFILE: path.join(sb.T, 'h'), GIT_CEILING_DIRECTORIES: TMP };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (WIN) env.APPDATA = path.join(sb.T, 'a');
  if (xdg !== undefined) env.XDG_CONFIG_HOME = xdg;
  if (kit) env.MB_KIT = kit;
  const r = spawnSync(process.execPath, [script, ...args], { cwd: cwd ?? sb.T, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* asserted by callers */ }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

test('realmode fixture (FALLBACK 8b): decoy below the git root is ignored; byte-equal output', { skip: !hasGit && 'git missing' }, () => {
  const fx = JSON.parse(fs.readFileSync(path.join(KIT_SRC, 'realmode', 'fixture.json'), 'utf8'));
  const T = path.join(TMP, 'realmode');
  for (const [rel, text] of Object.entries(fx.kitFiles)) write(path.join(T, 'k', ...rel.split('/')), text);
  gitInit(path.join(T, 'r'));
  for (const [rel, text] of Object.entries(fx.repoFiles)) write(path.join(T, 'r', ...rel.split('/')), text);
  const sb = { T, k: path.join(T, 'k') };
  write(WIN ? path.join(T, 'a', 'acme', 'config.json') : path.join(T, 'h', '.config', 'acme', 'config.json'), fx.userFile);
  const r = resolve(sb, [], { cwd: path.join(T, 'r', 'sub') });
  assert.equal(r.stdout, fs.readFileSync(path.join(KIT_SRC, 'realmode', 'expected.json'), 'utf8'));
  assert.equal(String(r.code), fs.readFileSync(path.join(KIT_SRC, 'realmode', 'expected.exit'), 'utf8').trim());
});

test('no git root: the project file is read from cwd', () => {
  const sb = sandbox();
  const w = path.join(sb.T, 'w');
  write(path.join(w, '.acme', 'config.json'), '{"settings":{"maxItems":8}}');
  const r = resolve(sb, [], { cwd: w });
  assert.equal(r.code, 0);
  assert.equal(r.out.settings.maxItems, 8);
  assert.equal(r.out.provenance['/maxItems'], 'project');
});

test('absolute XDG_CONFIG_HOME is used; a relative one falls back to HOME/.config', { skip: WIN && 'posix only' }, () => {
  const sb = sandbox();
  write(path.join(sb.T, 'x', 'acme', 'config.json'), '{"settings":{"maxItems":1}}');
  write(sb.userFile, '{"settings":{"maxItems":2}}');
  assert.equal(resolve(sb, [], { xdg: path.join(sb.T, 'x') }).out.settings.maxItems, 1);
  assert.equal(resolve(sb, [], { xdg: 'x' }).out.settings.maxItems, 2);
  assert.equal(resolve(sb, [], { xdg: '' }).out.settings.maxItems, 2);
});

test('unreadable user file: FILE_UNREADABLE, treated as absent', { skip: (WIN || ROOT_USER) && 'needs POSIX permissions as non-root' }, () => {
  const sb = sandbox();
  write(sb.userFile, '{"settings":{"maxItems":2}}');
  fs.chmodSync(sb.userFile, 0o000);
  const r = resolve(sb, []);
  fs.chmodSync(sb.userFile, 0o600);
  assert.equal(r.code, 0);
  assert.equal(r.out.settings.maxItems, 5);
  assert.deepEqual(r.out.warnings, [{ code: 'FILE_UNREADABLE', layer: 'user' }]);
});

test('unreadable org policy fails closed (exit 3)', { skip: (WIN || ROOT_USER) && 'needs POSIX permissions as non-root' }, () => {
  const sb = sandbox({ org: '{"access":{"deny":["p"]}}' });
  const org = path.join(sb.k, 'policy', 'org.json');
  fs.chmodSync(org, 0o000);
  const r = resolve(sb, []);
  fs.chmodSync(org, 0o600);
  assert.equal(r.code, 3);
  assert.deepEqual(r.out.errors, [{ code: 'POLICY_INVALID', layer: 'org' }]);
});

test('invalid UTF-8 in a user file is skipped (bytes reach the parser)', () => {
  const sb = sandbox();
  write(sb.userFile, Buffer.from([0x7b, 0x22, 0x73, 0x65, 0x74, 0x74, 0x69, 0x6e, 0x67, 0x73, 0x22, 0x3a, 0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d, 0x7d]));
  const r = resolve(sb, []);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.warnings, [{ code: 'FILE_SKIPPED', layer: 'user' }]);
});

test('vendored layout: kit next to resolve.mjs (no MB_KIT); --plugin accepted, mismatch is exit 2', () => {
  const sb = sandbox();
  for (const f of ['resolve.mjs', 'json.mjs']) fs.copyFileSync(path.join(KIT_SRC, f), path.join(sb.k, f));
  const script = path.join(sb.k, 'resolve.mjs');
  const ok = resolve(sb, ['--plugin', 'p'], { kit: null, script });
  assert.equal(ok.code, 0);
  assert.equal(ok.out.plugin, 'p');
  const bad = resolve(sb, ['--plugin', 'q'], { kit: null, script });
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.out.errors, [{ code: 'USAGE' }]);
  assert.equal(resolve(sb, ['--bogus'], { kit: null, script }).code, 2);
});

test('missing kit.json: exit 3 KIT_INVALID with JSON', () => {
  const sb = sandbox();
  const r = resolve(sb, [], { kit: path.join(sb.T, 'nokit') });
  assert.equal(r.code, 3);
  assert.deepEqual(r.out.errors, [{ code: 'KIT_INVALID' }]);
});

test('kit.json is parsed like the merge envelope; a forbidden-key plugin name is rejected', () => {
  const sb = sandbox();
  write(path.join(sb.k, 'kit.json'), JSON.stringify({ defaults: { ratio: 0.5 }, layers: LAYERS, marketplace: 'acme', plugin: 'p', skill: 's', specVersion: 1 }));
  assert.equal(resolve(sb, []).code, 0);
  write(path.join(sb.k, 'kit.json'), JSON.stringify({ defaults: {}, layers: LAYERS, marketplace: 'acme', plugin: 'constructor', skill: 's', specVersion: 1 }));
  assert.deepEqual(resolve(sb, ['set', '--layer', 'user', '/a', '1']).out.errors, [{ code: 'KIT_INVALID' }]);
  assert.ok(!fs.existsSync(sb.userFile));
});

// ---- set / unset ----
const ORG_LOCK = '{"enforced":{"settings":{"style":{"tone":"formal"}}}}';

test('set user: atomic write, pretty canonical, unknown keys preserved, new output printed', () => {
  const sb = sandbox();
  write(sb.userFile, '{"zz-custom":{"keep":1},"settings":{"other":true}}');
  const r = resolve(sb, ['set', '--plugin', 'p', '--layer', 'user', '/maxItems', '9']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.settings.maxItems, 9);
  assert.equal(r.out.provenance['/maxItems'], 'user');
  assert.equal(fs.readFileSync(sb.userFile, 'utf8'),
    '{\n  "plugins": {\n    "p": {\n      "settings": {\n        "maxItems": 9\n      }\n    }\n  },\n  "settings": {\n    "other": true\n  },\n  "zz-custom": {\n    "keep": 1\n  }\n}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(sb.userFile)), ['config.json'], 'no temp file left');
});

test('set creates the directory (0700) and --shared targets top-level settings', () => {
  const sb = sandbox();
  const r = resolve(sb, ['set', '--layer', 'user', '--shared', '/style/tone', '"casual"']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.userFile, 'utf8')), { settings: { style: { tone: 'casual' } } });
  if (!WIN) assert.equal(fs.statSync(path.dirname(sb.userFile)).mode & 0o777, 0o700);
});

test('set refuses a locked pointer, its ancestor and its descendant (exit 3 LOCKED, nothing written)', () => {
  const sb = sandbox({ org: ORG_LOCK });
  for (const ptr of ['/style/tone', '/style', '/style/tone/x']) {
    const r = resolve(sb, ['set', '--layer', 'user', ptr, '1']);
    assert.equal(r.code, 3, ptr);
    assert.deepEqual(r.out.errors, [{ code: 'LOCKED', path: ptr }]);
    assert.equal(r.out.ok, false);
  }
  assert.equal(resolve(sb, ['unset', '--layer', 'user', '/style']).code, 3);
  assert.ok(!fs.existsSync(sb.userFile));
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/styles', '1']).code, 0, 'sibling prefix is not an overlap');
});

test('invalid pointer segments, values and layers are usage errors (exit 2)', () => {
  const sb = sandbox();
  for (const args of [['/__proto__', '1'], ['/a/constructor', '1'], ['/a b', '1'], ['noslash', '1'], ['/', '1'], ['/a//b', '1'],
    ['/a', '1.5'], ['/a', '1e3'], ['/a', '{"__proto__":1}'], ['/a', '{"x":1,"x":2}'], ['/a']]) {
    const r = resolve(sb, ['set', '--layer', 'user', ...args]);
    assert.equal(r.code, 2, args.join(' '));
    assert.deepEqual(r.out.errors, [{ code: 'USAGE' }]);
  }
  assert.equal(resolve(sb, ['set', '--layer', 'org', '/a', '1']).code, 2);
  assert.equal(resolve(sb, ['set', '/a', '1']).code, 2);
  assert.ok(!fs.existsSync(sb.userFile));
});

test('set validates against config.schema.json (subset)', () => {
  const sb = sandbox({ schema: { type: 'object', properties: { maxItems: { type: 'integer', minimum: 1, maximum: 10 }, style: { type: 'object', properties: { tone: { enum: ['neutral', 'casual'] } } } } } });
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/maxItems', '11']).code, 3);
  assert.deepEqual(resolve(sb, ['set', '--layer', 'user', '/maxItems', '"x"']).out.errors, [{ code: 'SCHEMA_INVALID', path: '/maxItems' }]);
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/style/tone', '"loud"']).code, 3);
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/style', '{"tone":"loud"}']).code, 3);
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/maxItems', '10']).code, 0);
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/free', '"anything"']).code, 0, 'paths outside the schema are free');
  assert.deepEqual(resolve(sb, ['set', '--layer', 'user', '/maxItems/x', '1']).out.errors, [{ code: 'SCHEMA_INVALID', path: '/maxItems/x' }], 'no bypass below a typed scalar');
  write(path.join(sb.k, 'config.schema.json'), '{"type":');
  assert.deepEqual(resolve(sb, ['set', '--layer', 'user', '/maxItems', '1']).out.errors, [{ code: 'KIT_INVALID' }]);
});

test('unparsable or skipped target file: exit 3 FILE_INVALID, file untouched', () => {
  const sb = sandbox();
  for (const text of ['{"settings":', '{"settings":[1]}', '{"a":1.5}']) {
    write(sb.userFile, text);
    const r = resolve(sb, ['set', '--layer', 'user', '/maxItems', '1']);
    assert.equal(r.code, 3, text);
    assert.deepEqual(r.out.errors, [{ code: 'FILE_INVALID', layer: 'user' }]);
    assert.equal(fs.readFileSync(sb.userFile, 'utf8'), text);
  }
});

test('unset removes a key; unset of a missing key writes nothing', () => {
  const sb = sandbox();
  assert.equal(resolve(sb, ['unset', '--layer', 'user', '/maxItems']).code, 0);
  assert.ok(!fs.existsSync(sb.userFile));
  write(sb.userFile, '{"plugins":{"p":{"settings":{"maxItems":3,"x":1}}}}');
  const r = resolve(sb, ['unset', '--layer', 'user', '/maxItems']);
  assert.equal(r.code, 0);
  assert.equal(r.out.settings.maxItems, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.userFile, 'utf8')), { plugins: { p: { settings: { x: 1 } } } });
});

test('project and project-local layers write under the git root, not cwd', { skip: !hasGit && 'git missing' }, () => {
  const sb = sandbox();
  const r = path.join(sb.T, 'r');
  gitInit(r);
  fs.mkdirSync(path.join(r, 'sub'));
  assert.equal(resolve(sb, ['set', '--layer', 'project-local', '/maxItems', '4'], { cwd: path.join(r, 'sub') }).code, 0);
  assert.ok(fs.existsSync(path.join(r, '.acme', 'config.local.json')));
  assert.ok(!fs.existsSync(path.join(r, 'sub', '.acme')));
});

test('project-local write keeps the file out of git: .gitignore created or appended, never duplicated', { skip: !hasGit && 'git missing' }, () => {
  const sb = sandbox();
  const r = path.join(sb.T, 'r'), gi = path.join(r, '.acme', '.gitignore');
  gitInit(r);
  assert.equal(resolve(sb, ['set', '--layer', 'project-local', '/maxItems', '4'], { cwd: r }).code, 0);
  assert.equal(fs.readFileSync(gi, 'utf8'), 'config.local.json\n');
  assert.equal(spawnSync('git', ['check-ignore', '-q', path.join('.acme', 'config.local.json')], { cwd: r }).status, 0);
  assert.equal(resolve(sb, ['set', '--layer', 'project-local', '/maxItems', '3'], { cwd: r }).code, 0);
  assert.equal(fs.readFileSync(gi, 'utf8'), 'config.local.json\n', 'no duplicate line');
  fs.writeFileSync(gi, '# mine\n*.bak');
  assert.equal(resolve(sb, ['unset', '--layer', 'project-local', '/maxItems'], { cwd: r }).code, 0);
  assert.equal(fs.readFileSync(gi, 'utf8'), '# mine\n*.bak\nconfig.local.json\n', 'appended, existing lines kept');
  // project and user writes do not touch .gitignore; no git repo needed for project-local.
  const w = path.join(sb.T, 'w');
  fs.mkdirSync(w);
  assert.equal(resolve(sb, ['set', '--layer', 'project', '/maxItems', '4'], { cwd: w }).code, 0);
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/maxItems', '4'], { cwd: w }).code, 0);
  assert.ok(!fs.existsSync(path.join(w, '.acme', '.gitignore')));
  assert.ok(!fs.existsSync(path.join(path.dirname(sb.userFile), '.gitignore')));
  assert.equal(resolve(sb, ['set', '--layer', 'project-local', '/maxItems', '2'], { cwd: w }).code, 0);
  assert.equal(fs.readFileSync(path.join(w, '.acme', '.gitignore'), 'utf8'), 'config.local.json\n');
});

test('keys may contain ":" (tool identities); "." and proto keys stay rejected', () => {
  const sb = sandbox();
  const r = resolve(sb, ['set', '--layer', 'user', '/veto/mcp:bar', 'true']);
  assert.equal(r.code, 0);
  assert.equal(r.out.settings.veto['mcp:bar'], true);
  assert.equal(r.out.provenance['/veto/mcp:bar'], 'user');
  for (const ptr of ['/a.b', '/__proto__/x', '/veto/constructor']) assert.equal(resolve(sb, ['set', '--layer', 'user', ptr, '1']).code, 2, ptr);
});

test('write denied on a read-only dir: exit 3 WRITE_DENIED', { skip: (WIN || ROOT_USER) && 'needs POSIX permissions as non-root' }, () => {
  const sb = sandbox();
  const w = path.join(sb.T, 'w');
  fs.mkdirSync(path.join(w, '.acme'), { recursive: true });
  fs.chmodSync(path.join(w, '.acme'), 0o555);
  const r = resolve(sb, ['set', '--layer', 'project', '/maxItems', '4'], { cwd: w });
  fs.chmodSync(path.join(w, '.acme'), 0o755);
  assert.equal(r.code, 3);
  assert.deepEqual(r.out.errors, [{ code: 'WRITE_DENIED', layer: 'project' }]);
  assert.match(r.stderr, /project-local/);
  // A failed project-local write never suggests project-local again.
  fs.writeFileSync(path.join(w, '.acme', '.gitignore'), 'config.local.json\n');
  fs.chmodSync(path.join(w, '.acme'), 0o555);
  const l = resolve(sb, ['set', '--layer', 'project-local', '/maxItems', '4'], { cwd: w });
  fs.chmodSync(path.join(w, '.acme'), 0o755);
  assert.equal(l.code, 3);
  assert.deepEqual(l.out.errors, [{ code: 'WRITE_DENIED', layer: 'project-local' }]);
  assert.match(l.stderr, /approval/);
  assert.doesNotMatch(l.stderr, /project-local/);
});

test('project writes refuse repo-controlled symlinks (.<mkt> dir, config file, .gitignore, dangling too)', { skip: WIN && 'posix symlinks' }, () => {
  const sb = sandbox();
  const outside = path.join(sb.T, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const victim = path.join(outside, 'victim.txt');
  const cases = [
    // [name, layer, set up <w>/.acme]
    ['dir link', 'project', (a) => fs.symlinkSync(outside, a)],
    ['config file link', 'project', (a) => { fs.mkdirSync(a); fs.writeFileSync(victim, '{}'); fs.symlinkSync(victim, path.join(a, 'config.json')); }],
    ['local file link', 'project-local', (a) => { fs.mkdirSync(a); fs.writeFileSync(victim, '{}'); fs.symlinkSync(victim, path.join(a, 'config.local.json')); }],
    ['.gitignore link', 'project-local', (a) => { fs.mkdirSync(a); fs.writeFileSync(victim, 'keep\n'); fs.symlinkSync(victim, path.join(a, '.gitignore')); }],
    ['dangling .gitignore link', 'project-local', (a) => { fs.mkdirSync(a); fs.symlinkSync(path.join(outside, 'new.txt'), path.join(a, '.gitignore')); }],
  ];
  for (const [name, layer, setup] of cases) {
    const w = path.join(sb.T, `w-${name.replace(/\W+/g, '-')}`);
    fs.mkdirSync(w, { recursive: true });
    setup(path.join(w, '.acme'));
    const before = fs.readdirSync(outside).map((f) => [f, fs.readFileSync(path.join(outside, f), 'utf8')]);
    const r = resolve(sb, ['set', '--layer', layer, '/maxItems', '4'], { cwd: w });
    assert.equal(r.code, 3, name);
    assert.deepEqual(r.out.errors, [{ code: 'WRITE_DENIED', layer }], name);
    assert.match(r.stderr, /symlink/, name);
    assert.deepEqual(fs.readdirSync(outside).map((f) => [f, fs.readFileSync(path.join(outside, f), 'utf8')]), before, `${name}: outside untouched`);
    if (fs.existsSync(victim)) fs.rmSync(victim);
  }
  // The user layer may be a symlink (dotfile managers): still written.
  const real = path.join(sb.T, 'dotfiles', 'acme');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(path.join(sb.T, 'dotfiles'), path.dirname(path.dirname(sb.userFile)));
  assert.equal(resolve(sb, ['set', '--layer', 'user', '/maxItems', '4']).code, 0);
  assert.ok(fs.existsSync(path.join(real, 'config.json')));
});

test('set reports the written file on stderr; a bad value hints at JSON quoting', () => {
  const sb = sandbox();
  const w = path.join(sb.T, 'w');
  fs.mkdirSync(w);
  const r = resolve(sb, ['set', '--layer', 'project', '/style/tone', '"dry"'], { cwd: w });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, `resolve.mjs: wrote ${path.join(w, '.acme', 'config.json')}\n`);
  const bad = resolve(sb, ['set', '--layer', 'project', '/style/tone', 'dry'], { cwd: w });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /bad value: .*quote strings, e\.g\. '"table"'/);
  assert.equal(resolve(sb, ['unset', '--layer', 'project', '/nothing'], { cwd: w }).stderr, '', 'no write, no line');
});

test('set refuses while policy is broken (fail closed)', () => {
  const sb = sandbox({ org: '{"settings":' });
  const r = resolve(sb, ['set', '--layer', 'user', '/maxItems', '4']);
  assert.equal(r.code, 3);
  assert.deepEqual(r.out.errors, [{ code: 'POLICY_INVALID', layer: 'org' }]);
  assert.ok(!fs.existsSync(sb.userFile));
});

test('runtime guard: node < 20 exits 9 RUNTIME_UNSUPPORTED before any work; bun passes via its node version', async () => {
  const { main, runtimeSupported } = await import(pathToFileURL(RESOLVE).href);
  assert.equal(runtimeSupported({ node: '18.17.1' }), false);
  assert.equal(runtimeSupported({ node: '20.0.0' }), true);
  assert.equal(runtimeSupported({ node: '24.3.0', bun: '1.3.14' }), true);
  const r = main(['--plugin', 'p'], { node: '18.17.1' });
  assert.equal(r.exit, 9);
  assert.deepEqual(JSON.parse(r.text).errors, [{ code: 'RUNTIME_UNSUPPORTED' }]);
  assert.equal(JSON.parse(r.text).ok, false);
});

test('static: no require, no network, no eval; the only child process is git rev-parse', (t) => {
  const src = fs.readFileSync(RESOLVE, 'utf8');
  // Simplicity cap: counts code lines only (blank lines and `//` comment lines are free).
  const codeLines = (text) => text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//')).length;
  const code = codeLines(src);
  assert.ok(code <= 450, `resolve.mjs has ${code} code lines (cap 450, blank and comment lines excluded)`);
  // Report the size metric (BUILD-PLAN): code lines of the resolver and of all non-test tooling .mjs.
  const tools = path.dirname(KIT_SRC);
  const files = fs.readdirSync(tools, { recursive: true }).map(String)
    .filter((f) => f.endsWith('.mjs') && !f.split(path.sep).includes('tests'));
  const total = files.reduce((sum, f) => sum + codeLines(fs.readFileSync(path.join(tools, f), 'utf8')), 0);
  t.diagnostic(`size: resolve.mjs ${code} code lines (cap 450); tools/**/*.mjs without tests: ${total} code lines in ${files.length} files`);
  assert.doesNotMatch(src, /\brequire\s*\(|node:(http|https|net|dgram|tls|dns|vm|worker_threads)|\beval\s*\(|new Function|import\s*\(/);
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./json.mjs', 'node:child_process', 'node:fs', 'node:os', 'node:path', 'node:url']);
  const calls = src.match(/\b(execFileSync|execSync|spawnSync|spawn|exec|execFile|fork)\s*\(/g);
  assert.deepEqual(calls, ['execFileSync(']);
  assert.match(src, /execFileSync\('git', \['rev-parse', '--show-toplevel'\]/);
});
