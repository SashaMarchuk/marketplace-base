// Tests for the generator: tools/cmd/gen.mjs, tools/lib/gen/*.mjs, tools/lib/rules/CHK-10.mjs.
//
// Fixture: tools/tests/fixtures/gen/repo (a self-contained mini repo with a STUB kit and stub rules,
// so kit edits never break the goldens). Goldens: tools/tests/fixtures/gen/expected/tree.
// Marker-bearing outputs are stored with their marker bodies EMPTIED, and each body is stored
// separately as `<path>.<id>.body`: the lock hash rule empties whole-line marker bodies in every file,
// so a golden with filled bodies would hide golden changes from base-update.
// Regenerate goldens after an intended change: MB_UPDATE_GOLDEN=1 node --test tools/tests/gen.test.mjs
// Host checks (claude validate --strict, codex marketplace/plugin add) run only with MB_HOST_TESTS=1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../mb.mjs';
import { parse } from '../kit/json.mjs';
import { walk, fromPosix } from '../lib/fsx.mjs';
import { findMarkers, emptyMarkers } from '../lib/markers.mjs';
import { validate, loadSchema, assertSupported } from '../lib/schema-lite.mjs';
import { sha256Concat } from '../lib/hash.mjs';
import { vectorsKey } from '../lib/gen/vendor-kit.mjs';
import { mbTreeHash } from '../lib/gen/version-stamp.mjs';
import { parseFrontmatter } from '../lib/gen/repo.mjs';
import { firstSentence } from '../lib/gen/catalog.mjs';
import * as chk10 from '../lib/rules/CHK-10.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.dirname(TOOLS);
const FIXTURE = path.join(TOOLS, 'tests', 'fixtures', 'gen', 'repo');
const GOLDEN = path.join(TOOLS, 'tests', 'fixtures', 'gen', 'expected', 'tree');
const CMD_DIR = path.join(TOOLS, 'cmd');

const TEMP_DIRS = [];
after(() => { for (const d of TEMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function tmpRepo() {
  const dir = tmpDir('mb-gen-');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

async function mb(root, argv) {
  let out = '', err = '';
  const code = await main(argv, { root, cmdDir: CMD_DIR, stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  return { code, out, err };
}

const read = (root, rel) => fs.readFileSync(fromPosix(root, rel));
const readJ = (root, rel) => parse(read(root, rel));
const version = (root, dir) => readJ(root, `${dir}/.claude-plugin/plugin.json`).version;

/** Files gen produced: everything in the tree that is not a fixture input. */
function generatedFiles(root) {
  const inputs = new Set(walk(FIXTURE));
  return walk(root).filter((rel) => !inputs.has(rel) || !read(root, rel).equals(fs.readFileSync(fromPosix(FIXTURE, rel))));
}

/** Golden representation: { rel -> Buffer }, marker files split into emptied text + bodies. */
function goldenView(root, rels) {
  const view = new Map();
  for (const rel of rels) {
    const bytes = read(root, rel);
    const text = bytes.toString('utf8');
    const { pairs } = findMarkers(text);
    if (pairs.length === 0) { view.set(rel, bytes); continue; }
    view.set(rel, Buffer.from(emptyMarkers(text)));
    for (const p of pairs) view.set(`${rel}.${p.id}.body`, Buffer.from(text.slice(p.bodyStart, p.bodyEnd)));
  }
  return view;
}

test('gen output matches the golden files', async () => {
  const root = tmpRepo();
  const r = await mb(root, ['gen']);
  assert.equal(r.code, 0, r.err);
  const view = goldenView(root, generatedFiles(root));
  if (process.env.MB_UPDATE_GOLDEN === '1') {
    fs.rmSync(GOLDEN, { recursive: true, force: true });
    for (const [rel, bytes] of view) {
      fs.mkdirSync(path.dirname(fromPosix(GOLDEN, rel)), { recursive: true });
      fs.writeFileSync(fromPosix(GOLDEN, rel), bytes);
    }
  }
  assert.deepEqual([...view.keys()].sort(), walk(GOLDEN));
  for (const [rel, bytes] of view) {
    assert.equal(bytes.toString('utf8'), fs.readFileSync(fromPosix(GOLDEN, rel), 'utf8'), `golden mismatch: ${rel}`);
  }
});

test('gen twice gives no diff; --check is clean', async () => {
  const root = tmpRepo();
  assert.equal((await mb(root, ['gen'])).code, 0);
  const before = new Map(walk(root).map((rel) => [rel, read(root, rel)]));
  const second = await mb(root, ['gen']);
  assert.equal(second.code, 0);
  assert.match(second.out, /gen: 0 written, 0 removed/);
  assert.deepEqual(walk(root), [...before.keys()]);
  for (const [rel, bytes] of before) assert.ok(read(root, rel).equals(bytes), rel);
  const check = await mb(root, ['gen', '--check']);
  assert.equal(check.code, 0, check.err);
  assert.equal(await chk10.run({ root }).then((x) => x.length), 0);
});

test('gen --check exits 1 on one edited byte, a missing file and a stale _mb file, naming each', async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const edited = 'plugins/alpha/skills/alpha-two/_mb/kit.json';
  const kit = read(root, edited);
  kit[kit.length - 2] ^= 1;
  fs.writeFileSync(fromPosix(root, edited), kit);
  fs.rmSync(fromPosix(root, 'plugins/beta/.codex-plugin/plugin.json'));
  fs.writeFileSync(fromPosix(root, 'plugins/alpha/skills/alpha-one/_mb/extra.txt'), 'x');
  const r = await mb(root, ['gen', '--check']);
  assert.equal(r.code, 1);
  assert.match(r.err, /changed +plugins\/alpha\/skills\/alpha-two\/_mb\/kit\.json/);
  assert.match(r.err, /missing +plugins\/beta\/\.codex-plugin\/plugin\.json/);
  assert.match(r.err, /stale +plugins\/alpha\/skills\/alpha-one\/_mb\/extra\.txt/);
  assert.match(r.err, /run \.\/mb gen/);
  const results = await chk10.run({ root });
  assert.deepEqual(results.map((x) => x.path).sort(), [
    'plugins/alpha/skills/alpha-one/_mb/extra.txt',
    'plugins/alpha/skills/alpha-two/_mb/kit.json',
    'plugins/beta/.codex-plugin/plugin.json',
  ]);
  // gen repairs all three
  assert.equal((await mb(root, ['gen'])).code, 0);
  assert.equal((await mb(root, ['gen', '--check'])).code, 0);
  assert.equal(fs.existsSync(fromPosix(root, 'plugins/alpha/skills/alpha-one/_mb/extra.txt')), false);
});

test('version suffix changes only for plugins whose _mb changed', async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const dirs = ['plugins/alpha', 'plugins/beta', 'examples/plugins/ex-a'];
  const v0 = Object.fromEntries(dirs.map((d) => [d, version(root, d)]));
  assert.match(v0['plugins/alpha'], /^1\.2\.3\+mb\.[0-9a-f]{8}$/);
  assert.equal(v0['plugins/beta'], '0.1.0');

  fs.writeFileSync(fromPosix(root, 'plugins/alpha/config.defaults.json'), '{ "maxItems": 7 }\n');
  await mb(root, ['gen']);
  const v1 = Object.fromEntries(dirs.map((d) => [d, version(root, d)]));
  assert.notEqual(v1['plugins/alpha'], v0['plugins/alpha']);
  assert.equal(v1['examples/plugins/ex-a'], v0['examples/plugins/ex-a']);
  assert.equal(v1['plugins/beta'], v0['plugins/beta']);

  // A policy change re-stamps every configurable plugin, never a plain one.
  fs.writeFileSync(fromPosix(root, 'policy/teams/payments.json'), '{ "settings": { "tone": "long" } }\n');
  await mb(root, ['gen']);
  const v2 = Object.fromEntries(dirs.map((d) => [d, version(root, d)]));
  assert.notEqual(v2['plugins/alpha'], v1['plugins/alpha']);
  assert.notEqual(v2['examples/plugins/ex-a'], v1['examples/plugins/ex-a']);
  assert.equal(v2['plugins/beta'], '0.1.0');
  assert.equal(readJ(root, 'plugins/alpha/.codex-plugin/plugin.json').version, v2['plugins/alpha']);
});

test('plugin-level config is vendored into every skill of the plugin', async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const one = readJ(root, 'plugins/alpha/skills/alpha-one/_mb/kit.json');
  const two = readJ(root, 'plugins/alpha/skills/alpha-two/_mb/kit.json');
  assert.deepEqual(one.defaults, readJ(root, 'plugins/alpha/config.defaults.json'));
  assert.deepEqual({ ...one, skill: null }, { ...two, skill: null });
  assert.equal(one.skill, 'alpha-one');
  assert.equal(two.skill, 'alpha-two');
  for (const s of ['alpha-one', 'alpha-two']) {
    assert.ok(read(root, `plugins/alpha/skills/${s}/_mb/config.schema.json`).equals(read(root, 'plugins/alpha/config.schema.json')));
    assert.ok(read(root, `plugins/alpha/skills/${s}/_mb/policy/org.json`).equals(read(root, 'policy/org.json')));
    assert.ok(read(root, `plugins/alpha/skills/${s}/_mb/policy/teams/payments.json`).equals(read(root, 'policy/teams/payments.json')));
    assert.ok(read(root, `plugins/alpha/skills/${s}/_mb/resolve.mjs`).equals(read(root, 'tools/kit/resolve.mjs')));
  }
  // The block was inserted into the skill that lacked it and filled with the plugin name.
  const two_md = read(root, 'plugins/alpha/skills/alpha-two/SKILL.md').toString('utf8');
  assert.match(two_md, /^---\n[\s\S]*?\n---\n\n<!-- mb:config:begin -->\n## Configuration \(do this first\)\n/);
  assert.match(two_md, /--plugin alpha --layer user/);
  assert.equal(fs.existsSync(fromPosix(root, 'plugins/beta/skills/beta/_mb')), false);
});

test('a top-level $schema in config.defaults.json is not vendored as a setting', async () => {
  const root = tmpRepo();
  const rel = 'plugins/alpha/config.defaults.json';
  const defaults = readJ(root, rel);
  fs.writeFileSync(fromPosix(root, rel), JSON.stringify({ $schema: './config.schema.json', ...defaults }));
  assert.equal((await mb(root, ['gen'])).code, 0);
  assert.deepEqual(readJ(root, 'plugins/alpha/skills/alpha-one/_mb/kit.json').defaults, defaults);
});

test('a plugin that stops being configurable loses its _mb, config block and suffix', async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  fs.rmSync(fromPosix(root, 'plugins/alpha/config.defaults.json'));
  fs.rmSync(fromPosix(root, 'plugins/alpha/config.schema.json'));
  const r = await mb(root, ['gen']);
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(fromPosix(root, 'plugins/alpha/skills/alpha-one/_mb')), false);
  assert.equal(fs.existsSync(fromPosix(root, 'plugins/alpha/skills/alpha-two/_mb')), false);
  assert.equal(version(root, 'plugins/alpha'), '1.2.3');
  // Removal leaves the frontmatter, one blank line, then the original body.
  const two = read(root, 'plugins/alpha/skills/alpha-two/SKILL.md').toString('utf8');
  assert.match(two, /\n---\n\n# Alpha two\n\nBody without a config block yet\.\n$/);
  assert.doesNotMatch(read(root, 'plugins/alpha/skills/alpha-one/SKILL.md').toString(), /mb:config/);
  assert.equal((await mb(root, ['gen', '--check'])).code, 0);
});

test('excluded examples stay out of marketplaces; a name clash is exit 3', async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const names = readJ(root, '.claude-plugin/marketplace.json').plugins.map((p) => p.name);
  assert.deepEqual(names, ['alpha', 'beta', 'ex-a', 'legacy-notes']);
  fs.cpSync(fromPosix(root, 'examples/plugins/ex-a'), fromPosix(root, 'plugins/ex-a'), { recursive: true });
  const r = await mb(root, ['gen']);
  assert.equal(r.code, 3);
  assert.match(r.err, /name clash/);
});

test('a malformed marker is reported, the file is left untouched, and gen exits 1', async () => {
  const root = tmpRepo();
  const readme = fs.readFileSync(fromPosix(root, 'README.md'), 'utf8') + '<!-- mb:catalog:begin -->\n<!-- mb:catalog:end -->\n';
  fs.writeFileSync(fromPosix(root, 'README.md'), readme);
  const r = await mb(root, ['gen']);
  assert.equal(r.code, 1);
  assert.match(r.err, /README\.md: catalog marker/);
  assert.equal(fs.readFileSync(fromPosix(root, 'README.md'), 'utf8'), readme);
  assert.ok((await chk10.run({ root })).some((x) => x.path === 'README.md'));
});

test('invalid inputs are exit 3 with the file named', async () => {
  const root = tmpRepo();
  fs.writeFileSync(fromPosix(root, 'plugins/alpha/config.defaults.json'), '{ "a": 1.5 }\n');
  const r = await mb(root, ['gen']);
  assert.equal(r.code, 3);
  assert.match(r.err, /plugins\/alpha\/config\.defaults\.json:1:/);
  const root2 = tmpRepo();
  fs.writeFileSync(fromPosix(root2, 'plugins/beta/plugin.src.json'), '{ "name": "other", "version": "0.1.0", "description": "Mismatch." }\n');
  const r2 = await mb(root2, ['gen']);
  assert.equal(r2.code, 3);
  assert.match(r2.err, /must equal the directory name/);
  assert.equal((await mb(root2, ['gen', 'extra'])).code, 2);
});

test('vectors.sha256 = sha8 over sorted vector files + MERGE-SPEC.md (README excluded)', async () => {
  const kit = path.join(FIXTURE, 'tools', 'kit');
  const files = walk(kit).map((rel) => ({ rel, bytes: fs.readFileSync(fromPosix(kit, rel)) }));
  const want = sha256Concat(['MERGE-SPEC.md', 'vectors/001-stub/expected.exit', 'vectors/001-stub/expected.json', 'vectors/001-stub/input.json']
    .map((rel) => fs.readFileSync(fromPosix(kit, rel)))).slice(0, 8);
  assert.equal(vectorsKey(files), want);
  const root = tmpRepo();
  await mb(root, ['gen']);
  assert.equal(read(root, 'plugins/alpha/skills/alpha-one/_mb/vectors.sha256').toString(), want + '\n');
});

test('editing a vector changes vectors.sha256 and the plugin version suffix (MB-TIER-002)', async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const key = read(root, 'plugins/alpha/skills/alpha-one/_mb/vectors.sha256').toString();
  const ver = version(root, 'plugins/alpha');
  fs.appendFileSync(fromPosix(root, 'tools/kit/vectors/001-stub/expected.json'), ' ');
  await mb(root, ['gen']);
  assert.notEqual(read(root, 'plugins/alpha/skills/alpha-one/_mb/vectors.sha256').toString(), key);
  assert.notEqual(version(root, 'plugins/alpha'), ver);
});

test('_mb tree hash framing is unambiguous', () => {
  const a = mbTreeHash([{ skill: 's', files: new Map([['ab', Buffer.from('c')]]) }]);
  const b = mbTreeHash([{ skill: 's', files: new Map([['a', Buffer.from('bc')]]) }]);
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test('generated Codex files match the pinned codex schemas', async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const plugin = loadSchema(ROOT, 'codex-plugin');
  const market = loadSchema(ROOT, 'codex-marketplace');
  assertSupported(plugin);
  assertSupported(market);
  assert.deepEqual(validate(market, readJ(root, '.agents/plugins/marketplace.json')), []);
  for (const d of ['plugins/alpha', 'plugins/beta', 'plugins/legacy-notes', 'examples/plugins/ex-a']) {
    assert.deepEqual(validate(plugin, readJ(root, `${d}/.codex-plugin/plugin.json`)), [], d);
  }
});

test('frontmatter and first-sentence helpers', () => {
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: >\n  a\n  b.\nmetadata:\n  k: v\n---\nbody'), { name: 'x', description: 'a b.' });
  assert.equal(parseFrontmatter("---\ndescription: 'it''s'\n---\n").description, "it's");
  assert.equal(firstSentence('One. Two.'), 'One.');
  assert.equal(firstSentence('v1.2 is out. Next.'), 'v1.2 is out.');
});

// ---- host checks (opt-in: MB_HOST_TESTS=1) ----
const hostTests = process.env.MB_HOST_TESTS === '1';
const has = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;

test('claude plugin validate --strict passes on the generated root and every plugin', { skip: !hostTests || !has('claude') }, async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('mb-claude-') };
  for (const d of ['.', 'plugins/alpha', 'plugins/beta', 'plugins/legacy-notes', 'examples/plugins/ex-a']) {
    const r = spawnSync('claude', ['plugin', 'validate', '--strict', fromPosix(root, d)], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `${d}: ${r.stdout}${r.stderr}`);
  }
});

test('codex marketplace add + plugin add succeed in a temp CODEX_HOME', { skip: !hostTests || !has('codex') }, async () => {
  const root = tmpRepo();
  await mb(root, ['gen']);
  const home = tmpDir('mb-codex-');
  const env = { ...process.env, CODEX_HOME: home };
  const run = (args) => spawnSync('codex', args, { encoding: 'utf8', env, cwd: home });
  let r = run(['plugin', 'marketplace', 'add', root]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const p of ['alpha', 'beta', 'ex-a']) {
    r = run(['plugin', 'add', `${p}@acme`]);
    assert.equal(r.status, 0, `${p}: ${r.stdout}${r.stderr}`);
  }
  assert.ok(fs.existsSync(path.join(home, 'plugins', 'cache', 'acme', 'alpha', version(root, 'plugins/alpha'), 'skills', 'alpha-one', '_mb', 'kit.json')));
});

test('gen prints counts by default, per-file lines with --verbose, and names plugin dirs it skips', async () => {
  const root = tmpRepo();
  fs.mkdirSync(fromPosix(root, 'plugins/bare/skills/x'), { recursive: true });
  const r = await mb(root, ['gen']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /^wrote /m);
  assert.match(r.out, /^gen: \d+ written, 0 removed \(--verbose lists them\)\n$/);
  assert.match(r.err, /skipped plugins\/bare: no plugin\.src\.json/);
  fs.rmSync(fromPosix(root, 'docs/catalog.md'));
  const v = await mb(root, ['gen', '--verbose']);
  assert.match(v.out, /^wrote {3}docs\/catalog\.md$/m);
});
