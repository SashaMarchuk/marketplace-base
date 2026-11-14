// mb check command: --json shape, fix hints, --fast, plugin filter, crash handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../mb.mjs';
import { buildRuleContext, runRules, loadRules, parseFrontmatter } from '../../cmd/check.mjs';
import { makeRepo, tmpDir, write, TOOL_ROOT } from './_fixture.mjs';

async function mb(root, argv) {
  let out = '', err = '';
  const code = await main(argv, { root, cmdDir: path.join(TOOL_ROOT, 'tools', 'cmd'), stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  return { code, out, err };
}

// A rule dir with three fake rules, to test the runner alone.
function fakeRules() {
  const dir = tmpDir('mb-fake-rules-');
  write(dir, 'CHK-90.mjs', "export const id='CHK-90', severity='warning', title='t', fix='do x';\nexport function run(){ return [{ path: 'a', message: 'warn' }]; }\n");
  write(dir, 'CHK-91.mjs', "export const id='CHK-91', severity='error', title='t', fix='f', slow=true;\nexport async function run(){ return [{ path: 'b', message: 'slow error', fix: 'specific' }]; }\n");
  write(dir, 'CHK-92.mjs', "export const id='CHK-92', severity='error', title='t', fix='f';\nexport function run(){ throw new Error('boom'); }\n");
  write(dir, 'helper.mjs', 'throw new Error("not a rule");\n');
  return dir;
}

test('runner: results get id/severity/fix, --fast skips slow rules, a crash becomes an error', async () => {
  const rules = await loadRules(fakeRules());
  assert.deepEqual(rules.map((r) => r.id), ['CHK-90', 'CHK-91', 'CHK-92']);
  const root = makeRepo();
  const all = await runRules(rules, buildRuleContext(root, { toolRoot: TOOL_ROOT }));
  assert.deepEqual(all, [
    { id: 'CHK-90', severity: 'warning', path: 'a', message: 'warn', fix: 'do x' },
    { id: 'CHK-91', severity: 'error', path: 'b', message: 'slow error', fix: 'specific' },
    { id: 'CHK-92', severity: 'error', path: '.', message: 'rule crashed: boom', fix: 'f' },
  ]);
  const fast = await runRules(rules, buildRuleContext(root, { toolRoot: TOOL_ROOT, fast: true }));
  assert.deepEqual(fast.map((r) => r.id), ['CHK-90', 'CHK-92']);
});

test('only CHK-18/19/24 are slow (skipped by --fast)', async () => {
  const slow = (await loadRules()).filter((r) => r.slow === true).map((r) => r.id);
  assert.deepEqual(slow, ['CHK-18', 'CHK-19', 'CHK-24']);
});

test('mb check --json matches the documented JSON shape and exits 1 on errors', async () => {
  const root = makeRepo({ 'plugins/demo/plugin.src.json': '{"name":"demo","name":"demo"}' });
  const { code, out } = await mb(root, ['check', '--json', '--fast', '--offline']);
  assert.equal(code, 1);
  const doc = JSON.parse(out);
  assert.deepEqual(Object.keys(doc), ['ok', 'results']);
  assert.equal(doc.ok, false);
  for (const r of doc.results) {
    assert.deepEqual(Object.keys(r), ['id', 'severity', 'path', 'message', 'fix']);
    assert.ok(['error', 'warning', 'info'].includes(r.severity));
  }
  assert.ok(doc.results.some((r) => r.id === 'CHK-01' && r.fix === 'fix JSON at plugins/demo/plugin.src.json:1'));
});

test('mb check human output prints fix hints; a plugin filter limits plugin rules; unknown plugin is exit 2', async () => {
  const root = makeRepo({ 'plugins/other/plugin.src.json': '{"name":"wrong","version":"0.1.0","description":"X."}' });
  let res = await mb(root, ['check', '--fast', 'other']);
  assert.match(res.out, /ERROR\s+CHK-03 plugins\/other\/plugin.src.json: name "wrong" differs/);
  assert.match(res.out, /fix: rename dir or name/);
  res = await mb(root, ['check', '--fast', '--json', 'demo']);
  assert.ok(!JSON.parse(res.out).results.some((r) => r.id === 'CHK-03'));
  res = await mb(root, ['check', 'nope']);
  assert.equal(res.code, 2);
});

test('frontmatter parser: scalars, quotes, lists, folded blocks', () => {
  const { data, error } = parseFrontmatter("---\na: 'it''s'\nb: \"x\\ty\"\nc: [Read, Grep]\nd:\n  - one\n  - two\ne: >\n  long\n  text\nf: 0\ng: true\n---\nbody\n");
  assert.equal(error, null);
  assert.deepEqual(data, { a: "it's", b: 'x\ty', c: ['Read', 'Grep'], d: ['one', 'two'], e: 'long text', f: 0, g: true });
  assert.ok(fs.existsSync(TOOL_ROOT));
});

test('mb check human output collapses stale generated files into one CHK-10 line, printed first', async () => {
  const root = makeRepo();
  assert.equal((await mb(root, ['gen'])).code, 0);
  for (const rel of ['plugins/demo/.claude-plugin/plugin.json', 'plugins/demo/.codex-plugin/plugin.json']) write(root, rel, '{}\n');
  const human = await mb(root, ['check', '--fast', '--offline']);
  assert.equal(human.code, 1);
  const lines = human.out.split('\n').filter((l) => /^(ERROR|WARNING|INFO)/.test(l));
  assert.equal(lines.filter((l) => l.includes('CHK-10')).length, 1);
  assert.match(lines[0], /^ERROR {3}CHK-10 \.: 2 generated file\(s\) out of date \(plugins\/demo\/\.claude-plugin\/plugin\.json, /);
  const json = JSON.parse((await mb(root, ['check', '--json', '--fast', '--offline'])).out);
  assert.equal(json.results.filter((r) => r.id === 'CHK-10').length, 2, '--json keeps one result per file');
});
