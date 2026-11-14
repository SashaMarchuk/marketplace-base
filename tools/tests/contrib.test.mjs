// Tests for the contributor commands (U6): new, bump, adopt, export, try, config.
// Every test runs against a temp repo and a temp command dir that re-exports ONLY the U6 modules
// (plus stub gen/check where a test needs them), so the real gen/check never run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from '../mb.mjs';
import { parse, canonicalPretty } from '../kit/json.mjs';
import { findMarkers } from '../lib/markers.mjs';
import { validate, loadSchema } from '../lib/schema-lite.mjs';
import { changedPlugins, nextVersion } from '../cmd/bump.mjs';
import { yamlScalar, insertConfigPair } from '../cmd/new.mjs';
import { formatTable } from '../cmd/config.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(TOOLS, '..');
const U6 = ['new', 'bump', 'adopt', 'export', 'try', 'config'];
const POSIX = process.platform !== 'win32';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mb-u6-${prefix}-`));
}
function write(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}
function read(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}
function has(root, rel) {
  return fs.existsSync(path.join(root, ...rel.split('/')));
}

/** A temp command dir: re-export stubs for the U6 modules, plus extra stub modules {verb: source}. */
function makeCmdDir(extra = {}) {
  const dir = tmp('cmd');
  for (const v of U6) {
    fs.writeFileSync(path.join(dir, `${v}.mjs`), `export * from ${JSON.stringify(pathToFileURL(path.join(TOOLS, 'cmd', `${v}.mjs`)).href)};\n`);
  }
  for (const [v, src] of Object.entries(extra)) fs.writeFileSync(path.join(dir, `${v}.mjs`), src);
  return dir;
}

/** A stub command that appends "<verb> <args>" to <root>/calls.log and exits with `code`. */
function stubCmd(verb, code = 0) {
  return `import fs from 'node:fs'; import path from 'node:path';
export const name = ${JSON.stringify(verb)}; export const summary = 'stub'; export const usage = 'stub';
export const options = { json: { type: 'boolean' }, fast: { type: 'boolean' } };
export function run(argv, ctx) { fs.appendFileSync(path.join(ctx.root, 'calls.log'), ctx.verb + ' ' + argv.join(' ') + '\\n'); return ${code}; }\n`;
}

async function mb(root, argv, { cmdDir = makeCmdDir(), cwd = root } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, { root, cmdDir, cwd, stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  return { code, out, err };
}

function baseRepo() {
  const root = tmp('repo');
  write(root, 'marketplace.config.json', canonicalPretty({
    name: 'acme-skills', displayName: 'Acme Skills', description: 'Test marketplace.', owner: { name: 'Alice' }, includeExamples: true,
  }));
  return root;
}

function examplePlugin(root, p, { configurable = false } = {}) {
  write(root, `examples/plugins/${p}/plugin.src.json`,
    `{\n  "$schema": "../../../tools/schemas/plugin-src.schema.json",\n  "name": "${p}",\n  "version": "0.1.0",\n  "description": "Example."\n}\n`);
  write(root, `examples/plugins/${p}/skills/${p}/SKILL.md`, `---\nname: ${p}\ndescription: Example. Use when testing.\n---\n\n# X\n`);
  if (configurable) write(root, `examples/plugins/${p}/config.defaults.json`, '{}\n');
}

/** Minimal frontmatter reader for the generated SKILL.md / prompt.md (flat key: value lines). */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'has frontmatter');
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    out[line.slice(0, i)] = line.slice(i + 2);
  }
  return out;
}

// ------------------------------------------------------------------ discovery

test('all six U6 commands load through the dispatcher contract', async () => {
  const r = await mb(baseRepo(), ['--help']);
  assert.equal(r.code, 0);
  for (const v of U6) assert.match(r.out, new RegExp(`^  ${v} `, 'm'));
});

// ------------------------------------------------------------------ new

test('new skill demo/hello creates the plugin, SKILL.md and both eval cases (SPEC §11)', async () => {
  const root = baseRepo();
  const r = await mb(root, ['new', 'skill', 'demo/hello', 'Say hello. Use when greeted.']);
  assert.equal(r.code, 0, r.err);

  const src = parse(fs.readFileSync(path.join(root, 'plugins/demo/plugin.src.json')));
  assert.deepEqual(validate(loadSchema(REPO, 'plugin-src'), src), []);
  assert.equal(src.name, 'demo');
  assert.equal(src.version, '0.1.0');
  assert.equal(src.description, 'Say hello. Use when greeted.');

  const skill = read(root, 'plugins/demo/skills/hello/SKILL.md');
  const fm = frontmatter(skill);
  assert.deepEqual(Object.keys(fm), ['name', 'description'], 'Agent Skills frontmatter only');
  assert.equal(fm.name, 'hello');
  assert.equal(fm.description, 'Say hello. Use when greeted.');
  assert.equal(skill.split('\n').filter((l) => l.startsWith('TODO')).length, 1, 'exactly one TODO line');
  assert.equal(findMarkers(skill).pairs.length, 0, 'not configurable: no config block');

  for (const f of ['evals/hello-trigger/prompt.md', 'evals/hello-trigger/graders/skill-fired.md',
    'evals/hello-no-trigger/prompt.md', 'evals/hello-no-trigger/graders/skill-not-fired.md']) {
    assert.ok(has(root, `plugins/demo/${f}`), f);
  }
  assert.ok(!has(root, 'plugins/demo/config.defaults.json'));
  assert.ok(!has(root, 'plugins/demo/evals/config-respected'));
  // Only SKILL.md carries the TODO token (one TODO warning per new skill).
  for (const f of ['evals/hello-trigger/prompt.md', 'evals/hello-no-trigger/prompt.md']) {
    assert.doesNotMatch(read(root, `plugins/demo/${f}`), /TODO/);
  }
  assert.match(r.out, /note: \.\/mb gen is not installed/);
});

test('eval cases use the native format and satisfy CHK-14 (trigger min>=1, no-trigger 0/0/both)', async () => {
  const root = baseRepo();
  await mb(root, ['new', 'skill', 'demo/hello', 'Say hello. Use when greeted.']);
  const NATIVE_PROMPT_KEYS = new Set(['name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model',
    'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']);
  for (const c of ['hello-trigger', 'hello-no-trigger']) {
    const p = read(root, `plugins/demo/evals/${c}/prompt.md`);
    for (const k of Object.keys(frontmatter(p))) assert.ok(NATIVE_PROMPT_KEYS.has(k), `${c}: ${k}`);
    assert.ok(p.replace(/^---[\s\S]*?\n---\n/, '').trim().length > 0, 'prompt body present');
    assert.doesNotMatch(p, /TODO: describe what the agent should do/, 'not the native blank-init sentinel');
  }
  const fired = frontmatter(read(root, 'plugins/demo/evals/hello-trigger/graders/skill-fired.md'));
  assert.equal(fired.type, 'tool_used');
  assert.equal(fired.tool, 'Skill');
  assert.ok(Number(fired.min) >= 1);
  const re = new RegExp(fired.input_match.slice(1, -1));
  assert.ok(re.test('{"skill": "demo:hello"}') && re.test('{"skill":"hello"}'));
  assert.ok(!re.test('{"skill":"hello-world"}'));
  const not = frontmatter(read(root, 'plugins/demo/evals/hello-no-trigger/graders/skill-not-fired.md'));
  assert.deepEqual([not.type, not.tool, not.min, not.max, not.arm], ['tool_used', 'Skill', '0', '0', 'both']);
  assert.equal(not.input_match, fired.input_match);
});

test('new skill then runs gen and check <p> when they are installed', async () => {
  const root = baseRepo();
  const cmdDir = makeCmdDir({ gen: stubCmd('gen'), check: stubCmd('check') });
  const r = await mb(root, ['new', 'skill', 'demo/hello', 'Say hello. Use when greeted.'], { cmdDir });
  assert.equal(r.code, 0, r.err);
  assert.equal(read(root, 'calls.log'), 'gen \ncheck demo\n');
});

test('new skill returns the failing check exit code', async () => {
  const root = baseRepo();
  const cmdDir = makeCmdDir({ gen: stubCmd('gen'), check: stubCmd('check', 1) });
  const r = await mb(root, ['new', 'skill', 'demo/hello', 'Say hello. Use when greeted.'], { cmdDir });
  assert.equal(r.code, 1);
});

test('new skill --config creates plugin-level config.defaults.json, config case and config blocks', async () => {
  const root = baseRepo();
  assert.equal((await mb(root, ['new', 'skill', 'demo/first', 'First skill.'])).code, 0);
  const r = await mb(root, ['new', 'skill', 'demo/hello', 'Say hello. Use when greeted.', '--config']);
  assert.equal(r.code, 0, r.err);
  assert.equal(read(root, 'plugins/demo/config.defaults.json'), '{}\n');
  assert.ok(!has(root, 'plugins/demo/skills/hello/config.defaults.json'), 'plugin level, not skill level');
  for (const s of ['hello', 'first']) {
    const text = read(root, `plugins/demo/skills/${s}/SKILL.md`);
    const { pairs, problems } = findMarkers(text);
    assert.deepEqual(problems, []);
    assert.deepEqual(pairs.map((p) => p.id), ['config'], `${s} has exactly one config pair`);
  }
  const cfgCase = 'plugins/demo/evals/config-respected';
  assert.match(read(root, `${cfgCase}/case.yaml`), /^schema_version: "1\.0"$/m);
  assert.match(read(root, `${cfgCase}/case.yaml`), /^  scaffold_script: scaffold\.sh$/m);
  assert.match(read(root, `${cfgCase}/scaffold.sh`), /EVAL_MB_MARKETPLACE:-acme-skills/);
  assert.match(read(root, `${cfgCase}/scaffold.sh`), /\{"plugins":\{"demo":\{"settings":\{\}\}\}\}/);
  assert.match(read(root, `${cfgCase}/prompt.md`), /allowed_tools: \[Read, Glob, Grep, Skill, Bash\]/);
  assert.match(read(root, `${cfgCase}/graders/resolver-ran.md`), /tool: Bash/);
  // A later plain `new skill` in the now-configurable plugin also gets the block.
  assert.equal((await mb(root, ['new', 'skill', 'demo/third', 'Third.'])).code, 0);
  assert.deepEqual(findMarkers(read(root, 'plugins/demo/skills/third/SKILL.md')).pairs.map((p) => p.id), ['config']);
});

if (POSIX) {
  test('config-respected scaffold.sh writes the project layer in the eval workspace', async () => {
    const root = baseRepo();
    await mb(root, ['new', 'skill', 'demo/hello', 'Say hello.', '--config']);
    const ws = tmp('ws');
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('sh', [path.join(root, 'plugins/demo/evals/config-respected/scaffold.sh')], { cwd: ws, env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, String(r.stderr));
    assert.deepEqual(parse(fs.readFileSync(path.join(ws, '.acme-skills/config.json'))), { plugins: { demo: { settings: {} } } });
  });
}

test('new skill refuses clashes and bad input without writing anything', async () => {
  const root = baseRepo();
  examplePlugin(root, 'commit-message');
  assert.equal((await mb(root, ['new', 'skill', 'commit-message/x', 'X.'])).code, 1, 'example name clash');
  assert.equal((await mb(root, ['new', 'skill', 'other/commit-message', 'X.'])).code, 1, 'skill name clash (flat export)');
  assert.ok(!has(root, 'plugins/other'));
  assert.equal((await mb(root, ['new', 'skill', 'Bad/x', 'X.'])).code, 2);
  assert.equal((await mb(root, ['new', 'skill', 'constructor/x', 'X.'])).code, 2, 'reserved plugin name (O13)');
  assert.equal((await mb(root, ['new', 'plugin', 'prototype'])).code, 2, 'reserved plugin name (O13)');
  assert.equal((await mb(root, ['new', 'skill', 'demo/x'])).code, 2, 'description required');
  assert.equal((await mb(root, ['new', 'skill', 'demo/x', ''])).code, 2);
  assert.equal((await mb(root, ['new', 'skill', 'demo/x', 'X.', '--bogus'])).code, 2);
  assert.equal((await mb(root, ['new', 'widget', 'x'])).code, 2);
  assert.ok(!has(root, 'plugins'));
});

test('new plugin creates plugin.src.json (0.1.0) and skills/, with --category/--author', async () => {
  const root = baseRepo();
  const r = await mb(root, ['new', 'plugin', 'tools-kit', '--category', 'Productivity', '--author', 'Bob']);
  assert.equal(r.code, 0, r.err);
  const src = parse(fs.readFileSync(path.join(root, 'plugins/tools-kit/plugin.src.json')));
  assert.deepEqual(validate(loadSchema(REPO, 'plugin-src'), src), []);
  assert.equal(src.version, '0.1.0');
  assert.equal(src.category, 'Productivity');
  assert.deepEqual(src.author, { name: 'Bob' });
  assert.ok(fs.statSync(path.join(root, 'plugins/tools-kit/skills')).isDirectory());
  assert.equal((await mb(root, ['new', 'plugin', 'tools-kit'])).code, 1, 'exists');
  assert.equal((await mb(root, ['new', 'plugin', 'a', 'b'])).code, 2);
});

test('yamlScalar quotes descriptions that are not plain-safe; insertConfigPair is idempotent', () => {
  assert.equal(yamlScalar('Say hello. Use when greeted.'), 'Say hello. Use when greeted.');
  assert.equal(yamlScalar('Run: a "quoted" thing.'), '"Run: a \\"quoted\\" thing."');
  assert.equal(yamlScalar('- list'), '"- list"');
  assert.equal(yamlScalar('true'), '"true"');
  assert.equal(yamlScalar('Ends with colon:'), '"Ends with colon:"');
  assert.equal(yamlScalar('Has # comment'), '"Has # comment"');
  const once = insertConfigPair('---\nname: a\ndescription: b\n---\n\n# A\n\nBody.\n');
  assert.match(once, /^# A\n\n<!-- mb:config:begin -->\n<!-- mb:config:end -->\n\nBody\.\n$/m);
  assert.equal(insertConfigPair(once), null);
});

test('U6 templates hold no column-0 marker pair (ORCH O1)', () => {
  const walkAll = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = ['plugin', 'skill', 'evals'].flatMap((d) => walkAll(path.join(TOOLS, 'templates', d)));
  assert.ok(files.length >= 10);
  for (const f of files) assert.equal(findMarkers(fs.readFileSync(f, 'utf8')).pairs.length, 0, f);
});

// ------------------------------------------------------------------ bump

test('bump edits only the version string (patch default, minor, major)', async () => {
  const root = baseRepo();
  const text = '{\n  "name": "demo",\n  "description": "Has \\"version\\": \\"9.9.9\\" inside.",\n  "version":   "1.2.3"\n}\n';
  write(root, 'plugins/demo/plugin.src.json', text);
  assert.equal((await mb(root, ['bump', 'demo'])).code, 0);
  assert.equal(read(root, 'plugins/demo/plugin.src.json'), text.replace('"1.2.3"', '"1.2.4"'));
  assert.equal((await mb(root, ['bump', 'demo', 'minor'])).code, 0);
  assert.match(read(root, 'plugins/demo/plugin.src.json'), /"version":   "1\.3\.0"/);
  assert.equal((await mb(root, ['bump', 'demo', 'major'])).code, 0);
  assert.match(read(root, 'plugins/demo/plugin.src.json'), /"version":   "2\.0\.0"/);
  assert.equal((await mb(root, ['bump', 'demo', 'huge'])).code, 2);
  assert.equal((await mb(root, ['bump'])).code, 2);
  assert.equal((await mb(root, ['bump', 'nope'])).code, 1);
  assert.equal(nextVersion('0.1.9', 'patch'), '0.1.10');
});

test('bump refuses E plugins in a derived repo, allows them in the base', async () => {
  const root = baseRepo();
  examplePlugin(root, 'commit-message');
  assert.equal((await mb(root, ['bump', 'commit-message'])).code, 0, 'base owns its examples (SPEC 4.3)');
  write(root, '.mb-lock.json', canonicalPretty({ adopted: [], base: { url: 'x', tag: 'v1.0.0', commit: null }, files: {}, lockVersion: 1 }));
  const r = await mb(root, ['bump', 'commit-message']);
  assert.equal(r.code, 1);
  assert.match(r.err, /adopt commit-message/);
  assert.match(read(root, 'examples/plugins/commit-message/plugin.src.json'), /"0\.1\.1"/, 'unchanged by the refused bump');
});

test('bump --changed reads CHK-15 errors from check --json', async () => {
  const ctx = {
    listCommands: async () => [{ name: 'check' }],
    fail: (c, m) => Object.assign(new Error(m), { exitCode: c }),
  };
  const out = JSON.stringify({ ok: false, results: [
    { id: 'CHK-15', severity: 'error', path: 'plugins/b/plugin.src.json', message: '', fix: '' },
    { id: 'CHK-15', severity: 'error', path: 'examples/plugins/a/skills/a/SKILL.md', message: '', fix: '' },
    { id: 'CHK-15', severity: 'info', path: 'plugins/c', message: '', fix: '' },
    { id: 'CHK-04', severity: 'error', path: 'plugins/d/skills/d/SKILL.md', message: '', fix: '' },
  ] });
  assert.deepEqual(await changedPlugins(ctx, async () => ({ code: 1, out })), ['a', 'b']);
  await assert.rejects(changedPlugins(ctx, async () => ({ code: 1, out: 'boom' })), /no JSON/);
  await assert.rejects(changedPlugins({ ...ctx, listCommands: async () => [] }), /needs \.\/mb check/);
});

// ------------------------------------------------------------------ adopt

function derivedRepo() {
  const root = baseRepo();
  examplePlugin(root, 'meeting-notes', { configurable: true });
  examplePlugin(root, 'commit-message');
  write(root, '.mb-lock.json', canonicalPretty({
    adopted: [], base: { url: 'https://example.com/base.git', tag: 'v1.0.0', commit: null },
    files: {
      'examples/plugins/commit-message/plugin.src.json': 'a'.repeat(64),
      'examples/plugins/meeting-notes/plugin.src.json': 'b'.repeat(64),
      'examples/plugins/meeting-notes/skills/meeting-notes/SKILL.md': 'c'.repeat(64),
      'tools/mb.mjs': 'd'.repeat(64),
    },
    lockVersion: 1,
  }));
  return root;
}

test('adopt moves the example, updates the lock, keeps includeExamples, runs gen', async () => {
  const root = derivedRepo();
  const cfgBefore = read(root, 'marketplace.config.json');
  const cmdDir = makeCmdDir({ gen: stubCmd('gen') });
  const r = await mb(root, ['adopt', 'meeting-notes'], { cmdDir });
  assert.equal(r.code, 0, r.err);
  assert.ok(!has(root, 'examples/plugins/meeting-notes'));
  assert.ok(has(root, 'plugins/meeting-notes/skills/meeting-notes/SKILL.md'));
  assert.ok(has(root, 'plugins/meeting-notes/config.defaults.json'));
  assert.match(read(root, 'plugins/meeting-notes/plugin.src.json'), /"\$schema": "\.\.\/\.\.\/tools\/schemas\/plugin-src\.schema\.json"/);
  const lock = parse(fs.readFileSync(path.join(root, '.mb-lock.json')));
  assert.deepEqual(validate(loadSchema(REPO, 'lock'), lock), []);
  assert.deepEqual(lock.adopted, ['meeting-notes']);
  assert.deepEqual(Object.keys(lock.files).sort(), ['examples/plugins/commit-message/plugin.src.json', 'tools/mb.mjs']);
  assert.equal(read(root, 'marketplace.config.json'), cfgBefore, 'includeExamples unchanged');
  assert.equal(read(root, 'calls.log'), 'gen \n');
  // The adopted plugin is D now: bump works.
  assert.equal((await mb(root, ['bump', 'meeting-notes'])).code, 0);
});

test('adopt refusals: base repo, missing example, existing plugins/<p>', async () => {
  const base = baseRepo();
  examplePlugin(base, 'commit-message');
  assert.equal((await mb(base, ['adopt', 'commit-message'])).code, 2);
  const root = derivedRepo();
  assert.equal((await mb(root, ['adopt', 'nope'])).code, 1);
  write(root, 'plugins/commit-message/plugin.src.json', '{}\n');
  assert.equal((await mb(root, ['adopt', 'commit-message'])).code, 1);
  assert.ok(has(root, 'examples/plugins/commit-message'));
});

// ------------------------------------------------------------------ export

function exportRepo() {
  const root = baseRepo();
  examplePlugin(root, 'meeting-notes', { configurable: true });
  write(root, 'examples/plugins/meeting-notes/skills/meeting-notes/_mb/resolve.mjs', '// vendored\n');
  write(root, 'examples/plugins/meeting-notes/skills/meeting-notes/_mb/kit.json', '{}\n');
  examplePlugin(root, 'commit-message');
  write(root, 'plugins/demo/plugin.src.json', '{"name":"demo","version":"0.1.0","description":"D."}\n');
  write(root, 'plugins/demo/skills/hello/SKILL.md', '---\nname: hello\ndescription: Hi.\n---\n');
  write(root, 'plugins/demo/skills/hello/references/a.md', 'ref\n');
  write(root, 'plugins/demo/evals/hello-trigger/prompt.md', 'x\n');
  return root;
}

test('export skills creates a flat dir with _mb/', async () => {
  const root = exportRepo();
  const out = tmp('export');
  const r = await mb(root, ['export', 'skills', out]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readdirSync(out).sort(), ['commit-message', 'hello', 'meeting-notes']);
  assert.ok(fs.existsSync(path.join(out, 'meeting-notes/_mb/resolve.mjs')));
  assert.ok(fs.existsSync(path.join(out, 'hello/references/a.md')));
  assert.ok(!fs.existsSync(path.join(out, 'hello/evals')));
  // Re-export is a no-op; a different dir is refused unless --force.
  assert.match((await mb(root, ['export', 'skills', out])).out, /unchanged hello/);
  fs.writeFileSync(path.join(out, 'hello/SKILL.md'), 'edited\n');
  const refused = await mb(root, ['export', 'skills', out]);
  assert.equal(refused.code, 1);
  assert.equal(fs.readFileSync(path.join(out, 'hello/SKILL.md'), 'utf8'), 'edited\n');
  assert.equal((await mb(root, ['export', 'skills', out, '--force'])).code, 0);
  assert.match(fs.readFileSync(path.join(out, 'hello/SKILL.md'), 'utf8'), /name: hello/);
});

test('an exported configurable skill runs its resolver from the skill dir (MB-RUN-002)', async (t) => {
  const mbDir = path.join(REPO, 'examples/plugins/meeting-notes/skills/meeting-notes-template/_mb');
  if (!fs.existsSync(mbDir)) return t.skip('meeting-notes example not present (derived repo)');
  const out = tmp('export');
  assert.equal((await mb(REPO, ['export', 'skills', out, '--plugin', 'meeting-notes'])).code, 0);
  const home = tmp('home');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(out, 'meeting-notes-template/_mb/resolve.mjs'), '--plugin', 'meeting-notes'],
    { cwd: home, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, APPDATA: home } });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true);
  assert.equal(res.provenance['/language'], 'skill-defaults');
});

test('export honours --plugin, includeExamples, and needs _mb for configurable skills', async () => {
  const root = exportRepo();
  const one = tmp('export');
  assert.equal((await mb(root, ['export', 'skills', one, '--plugin', 'demo'])).code, 0);
  assert.deepEqual(fs.readdirSync(one), ['hello']);
  write(root, 'marketplace.config.json', canonicalPretty({ name: 'acme-skills', displayName: 'A', description: 'A.', owner: { name: 'A' }, includeExamples: ['commit-message'] }));
  const two = tmp('export');
  assert.equal((await mb(root, ['export', 'skills', two])).code, 0);
  assert.deepEqual(fs.readdirSync(two).sort(), ['commit-message', 'hello']);
  fs.rmSync(path.join(root, 'plugins/demo'), { recursive: true });
  write(root, 'plugins/demo/plugin.src.json', '{"name":"demo","version":"0.1.0","description":"D."}\n');
  write(root, 'plugins/demo/config.defaults.json', '{}\n');
  write(root, 'plugins/demo/skills/hello/SKILL.md', '---\nname: hello\ndescription: Hi.\n---\n');
  const r = await mb(root, ['export', 'skills', tmp('export')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /\.\/mb gen/);
  assert.equal((await mb(root, ['export', 'plugins', 'x'])).code, 2);
});

// ------------------------------------------------------------------ config resolve

function resolverRepo(json, exit) {
  const root = baseRepo();
  write(root, 'plugins/demo/plugin.src.json', '{"name":"demo","version":"0.1.0","description":"D."}\n');
  write(root, 'plugins/demo/config.defaults.json', '{}\n');
  write(root, 'plugins/demo/skills/hello/SKILL.md', '---\nname: hello\ndescription: Hi.\n---\n');
  // A stand-in resolver: prints a fixed result plus its argv/cwd for the assertions.
  write(root, 'plugins/demo/skills/hello/_mb/resolve.mjs',
    `process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n` +
    `process.stdout.write(${JSON.stringify(json)} + '\\n'); process.exitCode = ${exit};\n`);
  return root;
}

const RESOLVED = '{"blocked":false,"errors":[],"locked":["/checks/security"],"ok":true,"plugin":"demo","provenance":{"/checks/security":"org","/maxItems":"user"},"settings":{"checks":{"security":true},"maxItems":5},"tier":"a","warnings":[{"code":"LOCKED_OVERRIDE","layer":"user","path":"/checks/security"}]}';

test('config resolve prints the table (pointer, value, layer, locked) and exits like the resolver', async () => {
  const root = resolverRepo(RESOLVED, 0);
  const work = tmp('cwd');
  const r = await mb(root, ['config', 'resolve', 'demo', '--cwd', work]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pointer\s+value\s+layer\s+locked$/m);
  assert.match(r.out, /^\/checks\/security\s+true\s+org\s+yes$/m);
  assert.match(r.out, /^\/maxItems\s+5\s+user$/m);
  assert.match(r.out, /^warning: LOCKED_OVERRIDE layer=user path=\/checks\/security$/m);
  const seen = JSON.parse(r.err.trim());
  assert.deepEqual(seen.argv, ['--plugin', 'demo']);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(work));
  const j = await mb(root, ['config', 'resolve', 'demo', '--json', '--skill', 'hello']);
  assert.equal(j.out, RESOLVED + '\n');
});

test('config resolve passes through blocked (4) and error exits', async () => {
  const blocked = '{"blocked":true,"errors":[],"locked":[],"ok":true,"plugin":"demo","provenance":{},"settings":{},"tier":"a","warnings":[{"code":"BLOCKED_DENY","layer":"project"}]}';
  const r = await mb(resolverRepo(blocked, 4), ['config', 'resolve', 'demo']);
  assert.equal(r.code, 4);
  assert.match(r.out, /blocked: true/);
  assert.match(r.out, /warning: BLOCKED_DENY layer=project/);
  assert.equal((await mb(resolverRepo('not json', 0), ['config', 'resolve', 'demo'])).code, 1);
  const root = resolverRepo(RESOLVED, 0);
  assert.equal((await mb(root, ['config', 'resolve', 'demo', '--skill', 'nope'])).code, 1);
  assert.equal((await mb(root, ['config', 'show', 'demo'])).code, 2);
  assert.match(formatTable({ plugin: 'p', tier: 'a', ok: true, blocked: false, provenance: {}, settings: {} }), /\(no settings\)/);
});

// ------------------------------------------------------------------ try (fake host CLIs)

if (POSIX) {
  function fakeBin(log) {
    const bin = tmp('bin');
    const script = `#!/bin/sh\nprintf '%s|CODEX_HOME=%s|PWD=%s' "$(basename "$0")" "\${CODEX_HOME:-}" "$PWD" >> ${JSON.stringify(log)}\n` +
      `for a in "$@"; do printf '|%s' "$a" >> ${JSON.stringify(log)}; done\nprintf '\\n' >> ${JSON.stringify(log)}\n` +
      `if [ -n "\${CODEX_HOME:-}" ]; then ls "$CODEX_HOME" >> ${JSON.stringify(log)}; fi\necho "fake output"\n`;
    for (const n of ['claude', 'codex']) {
      fs.writeFileSync(path.join(bin, n), script);
      fs.chmodSync(path.join(bin, n), 0o755);
    }
    return bin;
  }
  async function withPath(bin, extraEnv, fn) {
    const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    Object.assign(process.env, extraEnv);
    try {
      return await fn();
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.CODEX_HOME;
    }
  }
  function tryRepo() {
    const root = baseRepo();
    examplePlugin(root, 'meeting-notes', { configurable: true });
    write(root, 'examples/plugins/meeting-notes/.claude-plugin/plugin.json', '{}\n');
    write(root, 'examples/plugins/meeting-notes/.codex-plugin/plugin.json', '{}\n');
    write(root, 'examples/plugins/meeting-notes/evals/raw-trigger/prompt.md', '---\nmax_turns: 5\n---\n\nTidy these notes: a, b.\n');
    write(root, '.agents/plugins/marketplace.json', '{}\n');
    return root;
  }

  test('try --host claude runs claude -p with --plugin-dir (and the resolver allow rule)', async () => {
    const root = tryRepo();
    const log = path.join(tmp('log'), 'calls.log');
    const r = await withPath(fakeBin(log), {}, () => mb(root, ['try', 'meeting-notes', '--host', 'claude']));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /fake output/);
    const line = fs.readFileSync(log, 'utf8').split('\n')[0].split('|');
    assert.equal(line[0], 'claude');
    assert.deepEqual(line.slice(3), ['-p', 'Tidy these notes: a, b.', '--plugin-dir',
      path.join(root, 'examples/plugins/meeting-notes'), '--allowedTools', 'Bash(node:*)']);
  });

  test('try --host codex installs into a temp CODEX_HOME (auth.json copied) and removes it', async () => {
    const root = tryRepo();
    const log = path.join(tmp('log'), 'calls.log');
    const realHome = tmp('codexhome');
    fs.writeFileSync(path.join(realHome, 'auth.json'), '{"fake":true}\n');
    const r = await withPath(fakeBin(log), { CODEX_HOME: realHome }, () => mb(root, ['try', 'meeting-notes', '--host', 'codex', 'Hello there']));
    assert.equal(r.code, 0, r.err);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    const calls = lines.filter((l) => l.startsWith('codex|')).map((l) => l.split('|'));
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].slice(3), ['plugin', 'marketplace', 'add', root]);
    assert.deepEqual(calls[1].slice(3), ['plugin', 'add', 'meeting-notes@acme-skills']);
    assert.deepEqual(calls[2].slice(3, 8), ['exec', '-s', 'workspace-write', '--ephemeral', '-C']);
    assert.equal(calls[2].at(-1), 'Hello there');
    const tempHome = calls[0][1].slice('CODEX_HOME='.length);
    assert.notEqual(tempHome, realHome);
    assert.ok(lines.includes('auth.json'), 'auth.json copied into the temp CODEX_HOME');
    assert.ok(!fs.existsSync(tempHome), 'temp CODEX_HOME removed');
    assert.equal(fs.readFileSync(path.join(realHome, 'auth.json'), 'utf8'), '{"fake":true}\n');
  });

  test('try: missing CLI is exit 7; bad host is exit 2; missing manifest asks for gen', async () => {
    const root = tryRepo();
    const empty = tmp('nobin');
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      assert.equal((await mb(root, ['try', 'meeting-notes', '--host', 'claude'])).code, 7);
    } finally {
      process.env.PATH = saved;
    }
    assert.equal((await mb(root, ['try', 'meeting-notes', '--host', 'gpt'])).code, 2);
    assert.equal((await mb(root, ['try', 'meeting-notes'])).code, 2);
    fs.rmSync(path.join(root, 'examples/plugins/meeting-notes/.claude-plugin'), { recursive: true });
    const r = await mb(root, ['try', 'meeting-notes', '--host', 'claude']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\.\/mb gen/);
  });
}
