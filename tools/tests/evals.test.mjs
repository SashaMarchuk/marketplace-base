// Tests for `mb eval`: tools/cmd/eval.mjs and tools/lib/evals/*.mjs.
// No live host calls: the Codex streams are recorded `codex exec --json` output (Codex CLI 0.164.0,
// scrubbed at capture: temp paths -> /tmp/mb-eval, thread ids zeroed) under
// tools/tests/fixtures/evals/codex/, and every process call goes through an injected fake exec.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter, parseYaml } from '../lib/evals/frontmatter.mjs';
import { listCases, loadCase, parseJsonl, traceSignals, gradeOne, gradeRun, scoreRun, scoreCase } from '../lib/evals/graders.mjs';
import { buildClaudeArgs, makeJudge, summarizeNative, nativeRuns, lastResultFromTrace } from '../lib/evals/claude.mjs';
import { buildExecArgs, runCodexPlugin, realCodexHome } from '../lib/evals/codex.mjs';
import { runEval, failureDetails } from '../cmd/eval.mjs';
import { main } from '../mb.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.dirname(TOOLS);
const FIX = path.join(TOOLS, 'tests', 'fixtures', 'evals', 'codex');
const EXAMPLES = path.join(ROOT, 'examples', 'plugins');
// A frozen copy of the commit-message example's cases: tools/ ships to derived repos, where
// examples may be deleted (init --examples none) or moved (adopt).
const CM = path.join(TOOLS, 'tests', 'fixtures', 'evals', 'plugins', 'commit-message');

const TEMP = [];
after(() => { for (const d of TEMP) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TEMP.push(d); return d; };

const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const TRIGGER = { trace: fixture('commit-message-trigger.jsonl'), last: fixture('commit-message-trigger.last.txt') };
const NO_TRIGGER = { trace: fixture('commit-message-no-trigger.jsonl'), last: fixture('commit-message-no-trigger.last.txt') };
const runOf = (f, extra = {}) => ({ events: parseJsonl(f.trace), trace: f.trace, lastMessage: f.last, filesBefore: [], filesAfter: [], ...extra });
const g = (data) => ({ name: data.name ?? data.type, ...data });

// ---------------------------------------------------------------- frontmatter

test('frontmatter: every example eval file parses', { skip: !fs.existsSync(EXAMPLES) && 'no examples/plugins in this repo' }, () => {
  let n = 0;
  for (const p of fs.readdirSync(EXAMPLES)) {
    for (const c of listCases(path.join(EXAMPLES, p))) {
      const loaded = loadCase(c);
      assert.ok(loaded.prompt.length > 0, `${c}: empty prompt`);
      assert.ok(loaded.graders.length > 0, `${c}: no graders`);
      for (const gr of loaded.graders) assert.ok(gr.type, `${c}/${gr.name}: no type`);
      n++;
    }
  }
  assert.ok(n >= 1);
});

test('frontmatter: quoting, lists, nesting, block scalars', () => {
  const { data, body } = splitFrontmatter("---\ninput_match: '\"skill\"\\s*:\\s*\"x''y\"'\ntags: [a, 'b c', \"d\"]\nmin: 0\nweight: 0.5\narm: both # trailing comment\nenv:\n  A: \"1\"\n  B: two\nlist:\n- x\n- y\nsp: |\n  line1\n  line2\n---\nbody\n");
  assert.equal(data.input_match, '"skill"\\s*:\\s*"x\'y"'); // backslashes stay literal in single quotes
  assert.deepEqual(data.tags, ['a', 'b c', 'd']);
  assert.equal(data.min, 0);
  assert.equal(data.weight, 0.5);
  assert.equal(data.arm, 'both');
  assert.deepEqual(data.env, { A: '1', B: 'two' });
  assert.deepEqual(data.list, ['x', 'y']);
  assert.equal(data.sp, 'line1\nline2\n');
  assert.equal(body, 'body\n');
  assert.deepEqual(parseYaml('# c\nschema_version: "1.0"\nname: x\ncontext:\n  scaffold_script: scaffold.sh\n'),
    { schema_version: '1.0', name: 'x', context: { scaffold_script: 'scaffold.sh' } });
  assert.deepEqual(splitFrontmatter('no frontmatter').data, {});
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parseYaml('__proto__: 1\n'), /forbidden key/);
  assert.throws(() => parseYaml('a: {b: 1}\n'), /unsupported/);
});

// ---------------------------------------------------------------- stream parsing

test('parseJsonl keeps only lines starting with "{" (the stdin notice is dropped)', () => {
  const ev = parseJsonl(`Reading additional input from stdin...\n${TRIGGER.trace}{"truncated`);
  assert.equal(ev[0].type, 'thread.started');
  assert.ok(ev.every((e) => typeof e.type === 'string'));
});

test('traceSignals: started + completed of one item count once; the SKILL.md read names plugin and skill', () => {
  const t = traceSignals(parseJsonl(TRIGGER.trace));
  assert.equal(t.commands.length, 1);
  assert.deepEqual(t.skills, [{ plugin: 'commit-message', skill: 'commit-message' }]);
  const n = traceSignals(parseJsonl(NO_TRIGGER.trace));
  assert.deepEqual(n, { commands: [], skills: [] });
});

// ---------------------------------------------------------------- grader mapping

test('MB-EVL-005: the real commit-message graders pass on the recorded trigger stream', async () => {
  const c = loadCase(path.join(CM, 'evals', 'trigger-staged-change'));
  const res = await gradeRun(c.graders, runOf(TRIGGER));
  assert.deepEqual(res.map((r) => [r.name, r.passed, r.skipped]), [['conventional-header', true, false], ['skill-fired', true, false]]);
  assert.equal(scoreRun(res, c.graders), 1);
  // The same graders fail on a stream where the skill never fired.
  const neg = await gradeRun(c.graders, runOf(NO_TRIGGER));
  assert.equal(neg.find((r) => r.name === 'skill-fired').passed, false);
});

test('MB-EVL-005: the no-trigger grader passes without a SKILL.md read and fails with one', async () => {
  const c = loadCase(path.join(CM, 'evals', 'no-trigger-general-git'));
  assert.equal((await gradeRun(c.graders, runOf(NO_TRIGGER)))[0].passed, true);
  assert.equal((await gradeRun(c.graders, runOf(TRIGGER)))[0].passed, false);
  // An agent_message that only NAMES the skill is not a skill read (the trigger stream has one).
  const prose = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will use skills/commit-message/SKILL.md"}}\n';
  assert.equal((await gradeRun(c.graders, runOf({ trace: prose, last: '' })))[0].passed, true);
});

test('skill input_match is the Claude-shaped regex: another skill does not count', async () => {
  const other = g({ type: 'tool_used', tool: 'Skill', input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?changelog-entry"' });
  assert.equal((await gradeOne(other, runOf(TRIGGER))).passed, false);
});

test('tool_used Bash: input_match on the command text, min/max', async () => {
  const run = runOf(TRIGGER);
  assert.equal((await gradeOne(g({ type: 'tool_used', tool: 'Bash', input_match: 'SKILL\\.md' }), run)).passed, true);
  assert.equal((await gradeOne(g({ type: 'tool_used', tool: 'Bash', input_match: 'resolve\\.mjs', min: 1 }), run)).passed, false);
  assert.equal((await gradeOne(g({ type: 'tool_used', tool: 'Bash', max: 0 }), run)).passed, false);
  assert.equal((await gradeOne(g({ type: 'tool_used', tool: 'Bash', max: 0, min: 0 }), runOf(NO_TRIGGER))).passed, true);
});

test('regex: last_message vs trace, flags, not_contains, count:N', async () => {
  const run = runOf(TRIGGER);
  assert.equal((await gradeOne(g({ type: 'regex', pattern: 'thread\\.started' }), run)).passed, false); // default target = last_message
  assert.equal((await gradeOne(g({ type: 'regex', target: 'trace', pattern: 'thread\\.started' }), run)).passed, true);
  assert.equal((await gradeOne(g({ type: 'regex', pattern: 'FIX\\(DATE\\)', flags: 'i' }), run)).passed, true);
  assert.equal((await gradeOne(g({ type: 'regex', pattern: 'Action items', match: 'not_contains' }), run)).passed, true);
  assert.equal((await gradeOne(g({ type: 'regex', target: 'trace', pattern: '"type":"turn\\.', match: 'count:2' }), run)).passed, true);
  assert.equal((await gradeOne(g({ type: 'regex', target: 'trace', pattern: '"type":"turn\\.', match: 'count:3' }), run)).passed, false);
  const bad = await gradeOne(g({ type: 'regex', pattern: '(' }), run);
  assert.deepEqual([bad.passed, bad.skipped], [false, false]); // a broken pattern fails, never skips
});

test('file_exists: the workdir file list after the run', async () => {
  const run = runOf(TRIGGER, { filesBefore: ['.acme/config.json'], filesAfter: ['.acme/config.json', 'out/notes.md'] });
  assert.equal((await gradeOne(g({ type: 'file_exists', path: 'out/notes.md' }), run)).passed, true);
  assert.equal((await gradeOne(g({ type: 'file_exists', path: 'out/*.md' }), run)).passed, true);
  assert.equal((await gradeOne(g({ type: 'file_exists', path: 'missing.txt' }), run)).passed, false);
  assert.equal((await gradeOne(g({ type: 'file_exists', path: 'missing.txt', exists: false }), run)).passed, true);
});

test('unmapped graders are SKIPPED; llm uses the judge when there is one', async () => {
  const run = runOf(TRIGGER);
  for (const d of [{ type: 'tool_order', before: 'Read', after: 'Skill' }, { type: 'baseline' }, { type: 'tool_used', tool: 'Read' },
    { type: 'llm', criteria: 'x' }, { type: 'regex', target: 'files', pattern: 'x' }, { type: 'mystery' }]) {
    const r = await gradeOne(g(d), run);
    assert.deepEqual([r.passed, r.skipped], [false, true], JSON.stringify(d));
  }
  const judge = async (criteria, last) => ({ passed: /fix\(date\)/.test(last) && criteria === 'C', reason: 'ok' });
  assert.equal((await gradeOne(g({ type: 'llm', criteria: 'C' }), run, { judge })).passed, true);
  assert.equal((await gradeOne(g({ type: 'llm', criteria: 'C' }), run, { judge: async () => null })).skipped, true);
});

test('MB-EVL-006: SKIPPED never counts as a pass; an all-skipped case FAILS', async () => {
  const graders = [g({ type: 'tool_order', before: 'A', after: 'B' }), g({ type: 'regex', pattern: 'nope', weight: 2 }), g({ type: 'regex', pattern: 'fix', weight: 1 })];
  const res = await gradeRun(graders, runOf(TRIGGER));
  assert.equal(scoreRun(res, graders), 1 / 3); // skipped grader is out of the denominator, not a pass
  const skippedOnly = [g({ type: 'baseline' }), g({ type: 'llm', criteria: 'x' })];
  const s = scoreRun(await gradeRun(skippedOnly, runOf(TRIGGER)), skippedOnly);
  assert.equal(s, null);
  assert.deepEqual(scoreCase([s, s, s], 0), { score: 0, passed: false, allSkipped: true }); // fails even at threshold 0
  assert.deepEqual(scoreCase([], 0.6).passed, false);
  assert.deepEqual(scoreCase([1, 1, 0], 0.6), { score: 2 / 3, passed: true, allSkipped: false });
  assert.equal(scoreCase([1, 0, 0], 0.6).passed, false);
});

// ---------------------------------------------------------------- Claude runner

test('MB-EVL-003: Claude command line snapshot (configurable plugin)', () => {
  const args = buildClaudeArgs({
    pluginPath: '/r/examples/plugins/code-review', jsonOut: '/r/dist/evals/claude-code-review.json', outputDir: '/r/dist/evals/claude-code-review',
    threshold: 0.6, runs: 3, model: 'claude-model', judgeModel: 'judge-model', maxCostUsd: 5, configurable: true,
  });
  assert.deepEqual(['claude', ...args], [
    'claude', 'plugin', 'eval', '/r/examples/plugins/code-review', '--trust-plugin', '--ablation', 'none', '--no-publish',
    '--json', '/r/dist/evals/claude-code-review.json', '--output-dir', '/r/dist/evals/claude-code-review',
    '--threshold', '0.6', '--runs', '3', '--model', 'claude-model', '--judge-model', 'judge-model', '--max-cost-usd', '5',
    '--scaffold', '--allow-tools', 'Bash(node:*)', 'Bash(sh:*)',
  ]);
  // Not configurable, no models configured: no scaffold, no allow rules, no model flags.
  const plain = buildClaudeArgs({ pluginPath: 'p', jsonOut: 'j', threshold: 0.6, runs: 1, maxCostUsd: 5, caseGlob: 'trigger-*' });
  assert.deepEqual(plain, ['plugin', 'eval', 'p', '--trust-plugin', '--ablation', 'none', '--no-publish', '--json', 'j',
    '--threshold', '0.6', '--runs', '1', '--max-cost-usd', '5', '--case', 'trigger-*']);
});

test('native result summary (shape observed on Claude Code 2.1.325)', () => {
  const native = { suite: { threshold: 0.6 }, cases: [{ name: 'a', aggregates: { score: 1, passRate: 1 } }, { name: 'b', aggregates: { score: 0.5 } }, { name: 'c' }] };
  assert.deepEqual(summarizeNative(native), [{ name: 'a', score: 1, passed: true }, { name: 'b', score: 0.5, passed: false }, { name: 'c', score: null, passed: null }]);
  assert.deepEqual(summarizeNative({}), []);
});

test('judge: claude -p via stdin, no tools, verdict line parsed', async () => {
  const calls = [];
  const judge = makeJudge({ model: 'j', exec: async (cmd, args, opts) => { calls.push({ cmd, args, input: opts.input }); return { code: 0, stdout: 'VERDICT: FAIL\nlists 3 findings' }; } });
  assert.deepEqual(await judge('at most 2 findings', 'answer'), { passed: false, reason: 'lists 3 findings' });
  assert.deepEqual(calls[0].args, ['-p', '--no-session-persistence', '--tools', '', '--model', 'j']);
  assert.match(calls[0].input, /at most 2 findings[\s\S]*answer/);
  const none = makeJudge({ exec: async () => ({ code: 0, stdout: 'no idea' }) });
  assert.equal(await none('c', 'a'), null);
});

// ---------------------------------------------------------------- Codex runner

test('Codex exec argv', () => {
  assert.deepEqual(buildExecArgs({ workdir: '/w', lastFile: '/l.txt', model: 'm', prompt: 'P' }),
    ['exec', '--json', '-s', 'workspace-write', '--ephemeral', '-C', '/w', '-o', '/l.txt', '-m', 'm', 'P']);
  assert.deepEqual(buildExecArgs({ workdir: '/w', lastFile: '/l.txt', prompt: 'P' }).includes('-m'), false);
});

/**
 * A fake process layer. `codex exec` answers with a recorded stream (trigger stream when the prompt
 * asks for a commit message) and writes -o last.txt; `sh <scaffold>` writes a file into its cwd.
 * Every call is recorded with the CODEX_HOME it saw and whether auth.json existed in it at that time.
 */
function fakeExec({ streamFor } = {}) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    const home = opts.env?.CODEX_HOME;
    calls.push({ cmd, args, cwd: opts.cwd, input: opts.input, home, env: opts.env, authInHome: home ? fs.existsSync(path.join(home, 'auth.json')) : null });
    if (args[0] === '--version') return { code: 0, stdout: `${cmd} 1.0\n`, stderr: '' };
    if (cmd === 'claude' && args[0] === 'auth') return { code: 0, stdout: '{"loggedIn": false}', stderr: '' };
    if (cmd === 'git') { fs.mkdirSync(path.join(opts.cwd, '.git'), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; }
    if (cmd === 'sh') { fs.writeFileSync(path.join(opts.cwd, 'scaffolded.txt'), opts.env.EVAL_MB_MARKETPLACE); return { code: 0, stdout: '', stderr: '' }; }
    if (cmd === 'codex' && args[0] === 'exec') {
      const prompt = args[args.length - 1];
      const f = streamFor ? streamFor(prompt) : (/rebase/.test(prompt) ? NO_TRIGGER : TRIGGER);
      fs.writeFileSync(args[args.indexOf('-o') + 1], f.last);
      return { code: 0, stdout: `Reading additional input from stdin...\n${f.trace}`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' }; // codex login / plugin marketplace add / plugin add
  };
  return { exec, calls };
}

/** A fake "real" CODEX_HOME with an auth.json, and its fingerprint (bytes + mtimes). */
function fakeRealHome() {
  const dir = tmpDir('mb-eval-realhome-');
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"placeholder":"not-a-real-session"}');
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(dir, 'auth.json'), old, old);
  fs.utimesSync(dir, old, old);
  return dir;
}
const fingerprint = (dir) => JSON.stringify(fs.readdirSync(dir).sort().map((f) => {
  const st = fs.statSync(path.join(dir, f));
  return [f, st.mtimeMs, fs.readFileSync(path.join(dir, f), 'utf8')];
}).concat([[dir, fs.statSync(dir).mtimeMs]]));

const cmCases = () => listCases(CM).map(loadCase);

test('MB-EVL-004: temp CODEX_HOME per case; the real CODEX_HOME is untouched (mtime + bytes)', async () => {
  const real = fakeRealHome();
  const before = fingerprint(real);
  const userCodex = path.join(os.homedir(), '.codex');
  const userBefore = fs.existsSync(userCodex) ? fs.statSync(userCodex).mtimeMs : null;
  const { exec, calls } = fakeExec();
  const tmpRoot = tmpDir('mb-eval-tmp-');
  const res = await runCodexPlugin({ root: '/repo', mkt: 'acme', plugin: 'commit-message', cases: cmCases(), runs: 1, threshold: 0.6,
    auth: 'copy', env: { ...process.env, CODEX_HOME: real, CI: '' }, exec, tmpRoot });

  const codexCalls = calls.filter((c) => c.cmd === 'codex');
  assert.ok(codexCalls.length >= 6);
  const homes = new Set(codexCalls.map((c) => c.home));
  assert.equal(homes.size, 2, 'one temp CODEX_HOME per case');
  for (const h of homes) {
    assert.notEqual(path.resolve(h), path.resolve(real));
    assert.ok(path.resolve(h).startsWith(fs.realpathSync(tmpRoot)) || path.resolve(h).startsWith(tmpRoot));
  }
  assert.ok(codexCalls.every((c) => c.authInHome), 'auth.json was copied into the temp home');
  assert.deepEqual(codexCalls.filter((c) => c.args[0] === 'plugin').map((c) => c.args.join(' ')).slice(0, 2),
    ['plugin marketplace add /repo', 'plugin add commit-message@acme']);
  assert.ok(!calls.some((c) => c.args[0] === 'login'), 'no login when a session is copied');
  assert.equal(fingerprint(real), before, 'real CODEX_HOME unchanged');
  if (userBefore !== null) assert.equal(fs.statSync(userCodex).mtimeMs, userBefore, 'the user ~/.codex unchanged');
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'temp dirs removed');
  assert.deepEqual(res.cases.map((c) => [c.name, c.passed, c.score]), [['no-trigger-general-git', true, 1], ['trigger-staged-change', true, 1]]);
  assert.equal(realCodexHome({ CODEX_HOME: real }), real);
});

test('MB-EVL-004: CI logs in with --with-api-key and never copies auth.json', async () => {
  const real = fakeRealHome();
  const { exec, calls } = fakeExec();
  await runCodexPlugin({ root: '/repo', mkt: 'acme', plugin: 'commit-message', cases: cmCases().slice(0, 1), runs: 1, threshold: 0.6,
    auth: 'api-key', env: { ...process.env, CODEX_HOME: real, CI: 'true', OPENAI_API_KEY: 'test-key-placeholder' }, exec, tmpRoot: tmpDir('mb-eval-tmp-') });
  const login = calls.find((c) => c.args[0] === 'login');
  assert.deepEqual(login.args, ['login', '--with-api-key']);
  assert.equal(login.input, 'test-key-placeholder\n');
  assert.notEqual(login.home, real);
  assert.ok(calls.filter((c) => c.cmd === 'codex').every((c) => c.authInHome === false), 'no auth.json copied');
});

test('scaffold runs with sh in the workdir with EVAL_MB_MARKETPLACE; its files are in the before list', async () => {
  const caseDir = tmpDir('mb-eval-case-');
  fs.mkdirSync(path.join(caseDir, 'graders'));
  fs.writeFileSync(path.join(caseDir, 'case.yaml'), 'schema_version: "1.0"\nname: cfg\ncontext:\n  scaffold_script: scaffold.sh\n');
  fs.writeFileSync(path.join(caseDir, 'scaffold.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(caseDir, 'prompt.md'), '---\nruns: 2\n---\nWrite me a commit message.\n');
  fs.writeFileSync(path.join(caseDir, 'graders', 'f.md'), '---\ntype: file_exists\npath: scaffolded.txt\n---\n');
  const c = loadCase(caseDir);
  assert.equal(c.scaffold, path.join(caseDir, 'scaffold.sh'));
  const { exec, calls } = fakeExec();
  const real = fakeRealHome();
  const res = await runCodexPlugin({ root: '/repo', mkt: 'acme', plugin: 'p', cases: [c], threshold: 0.6, scaffold: true,
    auth: 'copy', env: { ...process.env, CODEX_HOME: real }, exec, tmpRoot: tmpDir('mb-eval-tmp-') });
  const sh = calls.filter((x) => x.cmd === 'sh');
  assert.equal(sh.length, 2, 'case runs: 2 from prompt.md');
  assert.deepEqual(sh[0].args, [c.scaffold]);
  assert.equal(sh[0].env.EVAL_MB_MARKETPLACE, 'acme');
  assert.match(path.basename(sh[0].cwd), /^work-0$/);
  assert.equal(res.cases[0].passed, true);
  // Without --scaffold the script is not run and the file grader fails.
  const off = fakeExec();
  const r2 = await runCodexPlugin({ root: '/repo', mkt: 'acme', plugin: 'p', cases: [c], runs: 1, threshold: 0.6, scaffold: false,
    auth: 'copy', env: { ...process.env, CODEX_HOME: real }, exec: off.exec, tmpRoot: tmpDir('mb-eval-tmp-') });
  assert.equal(off.calls.filter((x) => x.cmd === 'sh').length, 0);
  assert.equal(r2.cases[0].passed, false);
});

// ---------------------------------------------------------------- mb eval command

function fakeRepo() {
  const root = tmpDir('mb-eval-repo-');
  fs.writeFileSync(path.join(root, 'marketplace.config.json'), JSON.stringify({ name: 'acme', evals: { threshold: 0.6, runs: 1, maxCostUsd: 1 } }));
  fs.mkdirSync(path.join(root, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'), '{}');
  fs.cpSync(CM, path.join(root, 'plugins', 'commit-message'), { recursive: true });
  return root;
}

function ctxFor(root, values, positionals = []) {
  const out = { stdout: '', stderr: '' };
  const err = (code) => (msg) => Object.assign(new Error(msg), { exitCode: code });
  return {
    out,
    ctx: {
      root, cwd: root, args: { values, positionals },
      stdout: (t) => { out.stdout += t; }, stderr: (t) => { out.stderr += t; },
      usageError: err(2), fail: (code, msg) => err(code)(msg),
    },
  };
}

test('mb eval --host codex: writes dist/evals/codex-<p>.json, exit 0; a missed trigger is exit 1', async () => {
  const root = fakeRepo();
  const real = fakeRealHome();
  const { exec } = fakeExec();
  const { ctx, out } = ctxFor(root, { host: 'codex' });
  assert.equal(await runEval(ctx, { exec, env: { ...process.env, CODEX_HOME: real, CI: '' } }), 0, out.stdout + out.stderr);
  const j = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'evals', 'codex-commit-message.json'), 'utf8'));
  assert.deepEqual(j.cases.map((c) => c.name), ['no-trigger-general-git', 'trigger-staged-change']);
  assert.deepEqual(Object.keys(j.cases[0].runs[0].graders[0]).sort(), ['name', 'passed', 'reason', 'skipped', 'type']);
  assert.match(out.stdout, /PASS codex commit-message\/trigger-staged-change: 1\.00/);

  const miss = fakeExec({ streamFor: () => NO_TRIGGER });
  const c2 = ctxFor(root, { host: 'codex', case: 'trigger-*' });
  assert.equal(await runEval(c2.ctx, { exec: miss.exec, env: { ...process.env, CODEX_HOME: real, CI: '' } }), 1);
  assert.match(c2.out.stdout, /FAIL codex commit-message\/trigger-staged-change/);
});

test('an errored codex run (exit 1, empty stream) scores 0 ungraded: a no-trigger case FAILS', async () => {
  const root = fakeRepo();
  const real = fakeRealHome();
  const { exec: base } = fakeExec();
  const exec = async (cmd, args, opts) => (cmd === 'codex' && args[0] === 'exec'
    ? { code: 1, stdout: 'Reading additional input from stdin...\n', stderr: '401 Unauthorized' } : base(cmd, args, opts));
  const { ctx, out } = ctxFor(root, { host: 'codex', case: 'no-trigger-*' });
  assert.equal(await runEval(ctx, { exec, env: { ...process.env, CODEX_HOME: real, CI: '' } }), 1);
  assert.match(out.stdout, /FAIL codex commit-message\/no-trigger-general-git: 0\.00 \(1 run\(s\) errored: codex exec exit 1\)/);
  // Exit 0 but no turn.completed (a truncated stream) is an error too.
  const trunc = async (cmd, args, opts) => (cmd === 'codex' && args[0] === 'exec'
    ? { code: 0, stdout: '{"type":"thread.started"}\n', stderr: '' } : base(cmd, args, opts));
  const c2 = ctxFor(root, { host: 'codex', case: 'no-trigger-*' });
  assert.equal(await runEval(c2.ctx, { exec: trunc, env: { ...process.env, CODEX_HOME: real, CI: '' } }), 1);
  assert.match(c2.out.stdout, /no turn\.completed event/);
});

test('mb eval: a missing host is SKIPPED: exit 7 when requested locally, 0 in CI or with --host all', async () => {
  const root = fakeRepo();
  const missing = async (cmd) => ({ code: null, stdout: '', stderr: '', missing: true });
  for (const [values, env, code] of [
    [{ host: 'codex' }, { CI: '' }, 7],
    [{ host: 'codex' }, { CI: 'true' }, 0],
    [{ host: 'all' }, { CI: '' }, 0],
    [{ host: 'claude' }, { CI: '' }, 7],
  ]) {
    const { ctx, out } = ctxFor(root, values);
    assert.equal(await runEval(ctx, { exec: missing, env }), code, JSON.stringify(values) + JSON.stringify(env));
    assert.match(out.stdout, /SKIPPED/);
  }
});

test('mb eval --host claude: passes the plugin PATH and the runner flags; native exit 1 = FAIL', async () => {
  const root = fakeRepo();
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'auth') return { code: 0, stdout: '{"loggedIn": true}', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const { ctx } = ctxFor(root, { host: 'claude', runs: '2' });
  assert.equal(await runEval(ctx, { exec, env: { CI: '' } }), 1);
  const ev = calls.find((a) => a[0] === 'plugin');
  assert.equal(ev[2], path.join(root, 'plugins', 'commit-message'));
  assert.deepEqual(ev.slice(ev.indexOf('--runs'), ev.indexOf('--runs') + 2), ['--runs', '2']);
  assert.ok(!ev.includes('--scaffold') && !ev.includes('--allow-tools'), 'commit-message is not configurable');
  await assert.rejects(runEval(ctxFor(root, { host: 'x' }).ctx, { exec, env: {} }), (e) => e.exitCode === 2);
  await assert.rejects(runEval(ctxFor(root, { host: 'claude', runs: '0' }).ctx, { exec, env: {} }), (e) => e.exitCode === 2);
  await assert.rejects(runEval(ctxFor(root, { host: 'claude' }, ['nope']).ctx, { exec, env: {} }), (e) => e.exitCode === 2);
});

// ---------------------------------------------------------------- config cases, failure details, new evals

/** Every config case dir: the template and each example case with a scaffold script. */
function configCaseDirs() {
  const dirs = [path.join(TOOLS, 'templates', 'evals', 'config-respected')];
  if (fs.existsSync(EXAMPLES)) {
    for (const p of fs.readdirSync(EXAMPLES)) {
      for (const c of listCases(path.join(EXAMPLES, p))) if (fs.existsSync(path.join(c, 'scaffold.sh'))) dirs.push(c);
    }
  }
  return dirs;
}

test('a config case has exactly ONE grader, so its score is the share of runs that honour the config', () => {
  // config-* cases check a setting's effect; the access cases (blocked, malformed) fail at 0.5 or 0 anyway.
  for (const dir of configCaseDirs().filter((d) => path.basename(d).startsWith('config-'))) {
    const graders = fs.readdirSync(path.join(dir, 'graders')).filter((f) => f.endsWith('.md'));
    assert.equal(graders.length, 1, `${dir}: ${graders.join(', ')}`);
  }
  // The template's stub is a regex grader that cannot pass until it is edited.
  const stub = loadCase(path.join(TOOLS, 'templates', 'evals', 'config-respected')).graders;
  assert.deepEqual(stub.map((x) => [x.name, x.type, x.target]), [['config-effect', 'regex', 'last_message']]);
});

test('the meeting-notes config grader needs both project sections and no default "Action items"', { skip: !fs.existsSync(path.join(EXAMPLES, 'meeting-notes')) && 'no example' }, async () => {
  const [grader] = loadCase(path.join(EXAMPLES, 'meeting-notes', 'evals', 'config-sections')).graders;
  const score = async (last) => (await gradeOne(grader, { lastMessage: last })).passed;
  assert.equal(await score('## Context\n- a\n\n## Next steps\n- b'), true);
  assert.equal(await score('## Summary\n## Decisions\n## Action items\n- b'), false, 'defaults (config ignored)');
  assert.equal(await score('## Context\n## Next steps\n## Action items'), false);
});

test('each config scaffold makes the workspace its own git root before writing the project layer', { skip: process.platform === 'win32' && 'POSIX sh' }, () => {
  const git = spawnSync('git', ['--version']);
  for (const dir of configCaseDirs()) {
    const text = fs.readFileSync(path.join(dir, 'scaffold.sh'), 'utf8');
    assert.ok(text.indexOf('git init -q .') !== -1 && text.indexOf('git init -q .') < text.indexOf('mkdir -p ".$mkt"'), dir);
  }
  if (git.status !== 0) return; // no git: the static check above is all we can do
  // Like the Claude sandbox: the workspace sits inside another repo. The scaffold must win the walk-up.
  const outer = tmpDir('mb-eval-outer-');
  spawnSync('git', ['init', '-q'], { cwd: outer });
  const ws = path.join(outer, 'cwd');
  fs.mkdirSync(ws);
  const script = path.join(EXAMPLES, 'meeting-notes', 'evals', 'config-sections', 'scaffold.sh');
  if (!fs.existsSync(script)) return;
  const env = { PATH: process.env.PATH, HOME: outer, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(outer, 'none') };
  assert.equal(spawnSync('sh', [script], { cwd: ws, env }).status, 0);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ws, env, encoding: 'utf8' }).stdout.trim();
  assert.equal(fs.realpathSync(top), fs.realpathSync(ws));
  assert.ok(fs.readdirSync(ws).some((f) => f.startsWith('.') && fs.existsSync(path.join(ws, f, 'config.json'))));
});

test('--keep-temp reaches claude plugin eval (before the variadic --allow-tools)', () => {
  const a = buildClaudeArgs({ pluginPath: 'p', jsonOut: 'j', configurable: true, keepTemp: true });
  assert.ok(a.indexOf('--keep-temp') !== -1 && a.indexOf('--keep-temp') < a.indexOf('--allow-tools'));
  assert.ok(!buildClaudeArgs({ pluginPath: 'p', jsonOut: 'j' }).includes('--keep-temp'));
});

test('failure details from a native case: failed graders with reasons, the answer from a kept trace', () => {
  const dir = tmpDir('mb-eval-trace-');
  const trace = path.join(dir, 'trace.jsonl');
  const answer = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
  fs.writeFileSync(trace, ['{"type":"system"}', JSON.stringify({ type: 'result', result: answer }), ''].join('\n'));
  assert.equal(lastResultFromTrace(trace), answer);
  assert.equal(lastResultFromTrace(path.join(dir, 'gone.jsonl')), null);
  const native = { arms: { with: [
    { error: null, tracePath: trace, graders: [{ name: 'cfg', passed: false, explanation: 'pattern not found in last_message', scored: true }, { name: 'ok', passed: true, scored: true }] },
    { error: 'timeout', tracePath: path.join(dir, 'gone.jsonl'), graders: [] },
  ] } };
  const runs = nativeRuns(native);
  assert.deepEqual(runs[0].graders[0], { name: 'cfg', passed: false, skipped: false, reason: 'pattern not found in last_message' });
  const text = failureDetails(runs, { keep: true });
  assert.match(text, /run 1: failed cfg: pattern not found in last_message/);
  assert.match(text, /run 1: final answer \(first 20 of 25 line\(s\)\):\n {6}\| line 1\n/);
  assert.ok(text.includes('| line 20\n') && !text.includes('| line 21'));
  assert.match(text, /run 2: error: timeout/);
  assert.doesNotMatch(text, /re-run with --keep-temp/);
  assert.match(failureDetails(runs), /re-run with --keep-temp/);
});

test('a failing codex case prints the failed graders and the answer; --keep-temp keeps the temp dir', async () => {
  const root = fakeRepo();
  const real = fakeRealHome();
  const miss = fakeExec({ streamFor: () => NO_TRIGGER });
  const { ctx, out } = ctxFor(root, { host: 'codex', case: 'trigger-*', 'keep-temp': true });
  assert.equal(await runEval(ctx, { exec: miss.exec, env: { ...process.env, CODEX_HOME: real, CI: '' } }), 1);
  assert.match(out.stdout, /FAIL codex commit-message\/trigger-staged-change[^\n]*\n {4}run 1: failed /);
  assert.match(out.stdout, /final answer \(first /);
  const kept = /kept codex commit-message: (\S+)/.exec(out.stdout);
  assert.ok(kept && fs.existsSync(path.join(kept[1], 'case-0', 'last-0.txt')), out.stdout);
  TEMP.push(kept[1]);
  const j = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'evals', 'codex-commit-message.json'), 'utf8'));
  assert.equal(typeof j.cases[0].runs[0].lastMessage, 'string');
});

test('mb new evals <p>/<s> adds the trigger and no-trigger cases to an existing skill only', async () => {
  const root = tmpDir('mb-eval-new-');
  fs.writeFileSync(path.join(root, 'marketplace.config.json'), JSON.stringify({ name: 'acme' }));
  const pdir = path.join(root, 'plugins', 'demo');
  fs.mkdirSync(path.join(pdir, 'skills', 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(pdir, 'plugin.src.json'), JSON.stringify({ name: 'demo', version: '0.1.0', description: 'Demo.' }));
  const skill = '---\nname: legacy\ndescription: Legacy. Use when testing.\n---\n\n# Legacy\n';
  fs.writeFileSync(path.join(pdir, 'skills', 'legacy', 'SKILL.md'), skill);
  const cmdDir = tmpDir('mb-eval-cmd-'); // only `new`: no gen/check run here
  fs.writeFileSync(path.join(cmdDir, 'new.mjs'), `export * from ${JSON.stringify(pathToFileURL(path.join(TOOLS, 'cmd', 'new.mjs')).href)};\n`);
  const mb = async (argv) => {
    let o = '';
    const code = await main(argv, { root, cmdDir, cwd: root, stdout: (x) => { o += x; }, stderr: (x) => { o += x; } });
    return { code, out: o };
  };
  const r = await mb(['new', 'evals', 'demo/legacy']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /created plugins\/demo\/evals\/legacy-trigger\/ \(eval case, 2 file\(s\)\)/);
  for (const f of ['legacy-trigger/prompt.md', 'legacy-trigger/graders/skill-fired.md', 'legacy-no-trigger/prompt.md', 'legacy-no-trigger/graders/skill-not-fired.md']) {
    assert.ok(fs.existsSync(path.join(pdir, 'evals', ...f.split('/'))), f);
  }
  assert.match(fs.readFileSync(path.join(pdir, 'evals', 'legacy-trigger', 'graders', 'skill-fired.md'), 'utf8'), /\?legacy"'/);
  assert.equal(fs.readFileSync(path.join(pdir, 'skills', 'legacy', 'SKILL.md'), 'utf8'), skill, 'the skill is untouched');
  assert.equal((await mb(['new', 'evals', 'demo/legacy'])).code, 1, 'cases exist');
  assert.equal((await mb(['new', 'evals', 'demo/nope'])).code, 1, 'no such skill');
  assert.equal((await mb(['new', 'evals', 'nope/legacy'])).code, 1, 'no such plugin');
  assert.equal((await mb(['new', 'evals', 'demo/legacy', '--config'])).code, 2);
  assert.equal((await mb(['new', 'evals'])).code, 2);
});

test('mb new evals runs gen before check, as mb new skill does', async () => {
  const root = tmpDir('mb-eval-new-gen-');
  fs.writeFileSync(path.join(root, 'marketplace.config.json'), JSON.stringify({ name: 'acme' }));
  const pdir = path.join(root, 'plugins', 'demo');
  fs.mkdirSync(path.join(pdir, 'skills', 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(pdir, 'plugin.src.json'), JSON.stringify({ name: 'demo', version: '0.1.0', description: 'Demo.' }));
  fs.writeFileSync(path.join(pdir, 'skills', 'legacy', 'SKILL.md'), '---\nname: legacy\ndescription: Legacy. Use when testing.\n---\n');
  const cmdDir = tmpDir('mb-eval-cmd-');
  fs.writeFileSync(path.join(cmdDir, 'new.mjs'), `export * from ${JSON.stringify(pathToFileURL(path.join(TOOLS, 'cmd', 'new.mjs')).href)};\n`);
  // Stub gen/check that only record the order they ran in.
  for (const c of ['gen', 'check']) {
    fs.writeFileSync(path.join(cmdDir, `${c}.mjs`), `export const name = '${c}'; export const summary = 'stub'; export const usage = 'stub';\nexport async function run(argv, ctx) { ctx.stdout('ran ${c}\\n'); return 0; }\n`);
  }
  let o = '';
  const code = await main(['new', 'evals', 'demo/legacy'], { root, cmdDir, cwd: root, stdout: (x) => { o += x; }, stderr: (x) => { o += x; } });
  assert.equal(code, 0, o);
  assert.deepEqual(o.match(/ran \w+/g), ['ran gen', 'ran check']);
});
