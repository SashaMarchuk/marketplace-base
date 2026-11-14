// Tests for U12: `mb github setup` (mocked gh responses), the pre-push hook, and the mb-*.yml
// workflows (static checks + the embedded scripts run locally). No network, no real GitHub calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../mb.mjs';
import { setup, parseGhOutput, loadRulesets, classicBody, fillCodeowners, NOTICE, HOOKS_PATH } from '../cmd/github.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(ROOT, '.github', 'workflows');
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX shell test' : false };
// Built at runtime so this file never contains a literal token (CHK-20 / gitleaks stay clean).
const FAKE_TOKEN = 'gh' + 'p_' + 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A root with the ruleset template and the CODEOWNERS seed. */
function setupRoot() {
  const root = tmp('mb-gh-');
  fs.mkdirSync(path.join(root, 'tools', 'templates', 'github'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'templates', 'github', 'ruleset.json'), path.join(root, 'tools', 'templates', 'github', 'ruleset.json'));
  fs.mkdirSync(path.join(root, '.github'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'templates', 'seeds', '.github', 'CODEOWNERS'), path.join(root, '.github', 'CODEOWNERS'));
  return root;
}

const REPO = (ownerType = 'User') => ({
  status: 200,
  data: { full_name: 'alice/skills', private: true, default_branch: 'main', owner: { login: 'alice', type: ownerType } },
});

/**
 * Mock gh: `routes` maps "METHOD path-prefix" -> response; unmatched calls fail the test.
 * Every call is recorded in `calls`.
 */
function mockGh(routes) {
  const calls = [];
  const gh = (method, p, body) => {
    calls.push({ method, path: p, body });
    const key = Object.keys(routes).filter((k) => `${method} ${p}`.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected gh call: ${method} ${p}`);
    return routes[key];
  };
  return { gh, calls };
}

function mockGit() {
  const calls = [];
  return { git: (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; }, calls };
}

async function runSetup(routes, opts = {}) {
  const root = opts.root ?? setupRoot();
  const { gh, calls } = mockGh(routes);
  const g = mockGit();
  let out = '';
  const result = await setup({ root, gh, git: g.git, out: (s) => { out += s; }, dryRun: opts.dryRun, requireCodeowners: opts.requireCodeowners });
  return { result, out, calls, gitCalls: g.calls, root };
}

const R = 'repos/alice/skills';
const noPlanCall = (calls) => calls.every((c) => !/^(user|orgs\/|users\/)|plan/.test(c.path));

test('ruleset 200: rulesets applied, no classic protection call, no hooks (MB-GH-003)', async () => {
  const { result, calls, gitCalls, out } = await runSetup({
    'GET repos/{owner}/{repo}': REPO(),
    [`GET ${R}/rulesets`]: { status: 200, data: [] },
    [`POST ${R}/rulesets`]: { status: 201, data: { id: 1 } },
  });
  assert.equal(result.protection, 'ruleset');
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => c.body.target), ['branch', 'tag']);
  assert.ok(!calls.some((c) => c.path.includes('/protection')));
  assert.deepEqual(gitCalls, []);
  assert.ok(noPlanCall(calls));
  // The branch ruleset requires a PR (0 approvals: a solo owner can merge) and the mb-check status.
  const rules = Object.fromEntries(posts[0].body.rules.map((r) => [r.type, r.parameters ?? true]));
  assert.equal(rules.pull_request.required_approving_review_count, 0);
  assert.deepEqual(rules.required_status_checks.required_status_checks, [{ context: 'mb-check' }]);
  assert.ok(rules.deletion && rules.non_fast_forward);
  assert.deepEqual(posts[1].body.conditions.ref_name.include, ['refs/tags/v*']);
  assert.match(out, /ruleset mb-default-branch applied/);
});

test('re-run: an existing ruleset of the same name is updated with PUT, not duplicated', async () => {
  const { result, calls } = await runSetup({
    'GET repos/{owner}/{repo}': REPO(),
    [`GET ${R}/rulesets`]: { status: 200, data: [{ id: 7, name: 'mb-default-branch' }, { id: 9, name: 'mb-release-tags' }] },
    [`PUT ${R}/rulesets/`]: { status: 200, data: {} },
  });
  assert.equal(result.protection, 'ruleset');
  assert.deepEqual(calls.filter((c) => c.method === 'PUT').map((c) => c.path), [`${R}/rulesets/7`, `${R}/rulesets/9`]);
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('ruleset 403 then classic protection 200: reports classic protection (MB-GH-002)', async () => {
  const { result, calls, gitCalls, out } = await runSetup({
    'GET repos/{owner}/{repo}': REPO(),
    [`GET ${R}/rulesets`]: { status: 200, data: [] },
    [`POST ${R}/rulesets`]: { status: 403, message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' },
    [`PUT ${R}/branches/main/protection`]: { status: 200, data: {} },
  });
  assert.equal(result.protection, 'classic');
  assert.match(out, /classic protection applied/);
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body.required_status_checks.contexts, ['mb-check']);
  assert.equal(put.body.allow_force_pushes, false);
  assert.equal(put.body.allow_deletions, false);
  assert.deepEqual(gitCalls, []);
  assert.ok(noPlanCall(calls));
});

test('rulesets list refused (404) also falls through to classic protection', async () => {
  const { result } = await runSetup({
    'GET repos/{owner}/{repo}': REPO(),
    [`GET ${R}/rulesets`]: { status: 404, message: 'Not Found' },
    [`PUT ${R}/branches/main/protection`]: { status: 200, data: {} },
  });
  assert.equal(result.protection, 'classic');
});

test('both refused (403): prints the notice and installs the hooks (MB-GH-004)', async () => {
  const { result, out, gitCalls, calls } = await runSetup({
    'GET repos/{owner}/{repo}': REPO(),
    [`GET ${R}/rulesets`]: { status: 200, data: [] },
    [`POST ${R}/rulesets`]: { status: 403, message: 'Upgrade to GitHub Pro' },
    [`PUT ${R}/branches/main/protection`]: { status: 403, message: 'Upgrade to GitHub Pro' },
  });
  assert.equal(result.protection, 'hooks');
  assert.ok(out.includes(NOTICE));
  assert.deepEqual(gitCalls, [['config', 'core.hooksPath', HOOKS_PATH]]);
  assert.ok(noPlanCall(calls));
});

test('422 degrades like 403', async () => {
  const { result } = await runSetup({
    'GET repos/{owner}/{repo}': REPO(),
    [`GET ${R}/rulesets`]: { status: 200, data: [] },
    [`POST ${R}/rulesets`]: { status: 422, message: 'Validation Failed' },
    [`PUT ${R}/branches/main/protection`]: { status: 422, message: 'Validation Failed' },
  });
  assert.equal(result.protection, 'hooks');
});

test('other statuses (500, 401) fail with exit 1 and install nothing', async () => {
  for (const status of [500, 401]) {
    const g = mockGit();
    const { gh } = mockGh({
      'GET repos/{owner}/{repo}': REPO(),
      [`GET ${R}/rulesets`]: { status: 200, data: [] },
      [`POST ${R}/rulesets`]: { status, message: 'boom' },
    });
    await assert.rejects(setup({ root: setupRoot(), gh, git: g.git, out: () => {} }), (e) => e.exitCode === 1 && e.message.includes(String(status)));
    assert.deepEqual(g.calls, []);
  }
  const g = mockGit();
  const { gh } = mockGh({
    'GET repos/{owner}/{repo}': REPO(),
    [`GET ${R}/rulesets`]: { status: 403 },
    [`PUT ${R}/branches/main/protection`]: { status: 503, message: 'unavailable' },
  });
  await assert.rejects(setup({ root: setupRoot(), gh, git: g.git, out: () => {} }), (e) => e.exitCode === 1);
  assert.deepEqual(g.calls, []);
});

test('repository GET failure (no remote / not logged in) is exit 1', async () => {
  const { gh } = mockGh({ 'GET repos/{owner}/{repo}': { status: 0, message: 'gh auth login' } });
  await assert.rejects(setup({ root: setupRoot(), gh, git: mockGit().git, out: () => {} }), (e) => e.exitCode === 1);
});

test('--dry-run: only the repository GET, no write, no git config, no file change, no plan call', async () => {
  const root = setupRoot();
  const before = fs.readFileSync(path.join(root, '.github', 'CODEOWNERS'), 'utf8');
  const { result, calls, gitCalls, out } = await runSetup({ 'GET repos/{owner}/{repo}': REPO() }, { root, dryRun: true });
  assert.equal(result.protection, 'dry-run');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET repos/{owner}/{repo}']);
  assert.deepEqual(gitCalls, []);
  assert.equal(fs.readFileSync(path.join(root, '.github', 'CODEOWNERS'), 'utf8'), before);
  for (const s of [`${R}/rulesets`, `${R}/branches/main/protection`, 'core.hooksPath tools/hooks', 'would uncomment']) assert.ok(out.includes(s), s);
});

test('CODEOWNERS: a user owner gets the placeholder lines uncommented', async () => {
  const { result, root } = await runSetup({
    'GET repos/{owner}/{repo}': REPO('User'),
    [`GET ${R}/rulesets`]: { status: 200, data: [] },
    [`POST ${R}/rulesets`]: { status: 201, data: {} },
  });
  assert.equal(result.codeowners, 'filled');
  const lines = fs.readFileSync(path.join(root, '.github', 'CODEOWNERS'), 'utf8').split('\n');
  assert.ok(lines.includes('* @alice'));
  assert.ok(lines.includes('/policy/org.json @alice'));
  assert.ok(!lines.some((l) => l.includes('@OWNER') && !l.startsWith('# "') && /^# [*/]/.test(l)));
  // A second run leaves it unchanged.
  const again = await runSetup({
    'GET repos/{owner}/{repo}': REPO('User'),
    [`GET ${R}/rulesets`]: { status: 200, data: [] },
    [`POST ${R}/rulesets`]: { status: 201, data: {} },
  }, { root });
  assert.equal(again.result.codeowners, 'unchanged');
});

test('CODEOWNERS: an organization owner keeps the lines commented and gets the team hint', async () => {
  const { result, root, out } = await runSetup({
    'GET repos/{owner}/{repo}': { status: 200, data: { ...REPO().data, full_name: 'acme/skills', owner: { login: 'acme', type: 'Organization' } } },
    'GET repos/acme/skills/rulesets': { status: 200, data: [] },
    'POST repos/acme/skills/rulesets': { status: 201, data: {} },
  });
  assert.equal(result.codeowners, 'org-hint');
  assert.match(out, /add `@acme\/<team>` lines to \.github\/CODEOWNERS/);
  const text = fs.readFileSync(path.join(root, '.github', 'CODEOWNERS'), 'utf8');
  assert.ok(text.split('\n').includes('# * @OWNER'));
});

test('--require-codeowners requires code-owner review with one approval (ruleset and classic)', () => {
  const sets = loadRulesets(ROOT, true);
  const pr = sets.branch.rules.find((r) => r.type === 'pull_request').parameters;
  assert.equal(pr.require_code_owner_review, true);
  assert.equal(pr.required_approving_review_count, 1);
  const c = classicBody(sets.branch);
  assert.equal(c.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(loadRulesets(ROOT, false).branch.rules.find((r) => r.type === 'pull_request').parameters.required_approving_review_count, 0);
});

test('fillCodeowners keeps CRLF and returns null when nothing matches', () => {
  assert.equal(fillCodeowners('# * @OWNER\r\nx\r\n', 'bob'), '* @bob\r\nx\r\n');
  assert.equal(fillCodeowners('* @bob\n', 'bob'), null);
});

test('parseGhOutput reads the status line, headers and JSON body of `gh api -i`', () => {
  const r = parseGhOutput('HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"message":"Upgrade to GitHub Pro"}');
  assert.equal(r.status, 403);
  assert.equal(r.message, 'Upgrade to GitHub Pro');
  const v = parseGhOutput('HTTP/2.0 422 Unprocessable\n\n{"message":"Validation Failed","errors":["Invalid rule \'x\'"]}');
  assert.equal(v.message, "Validation Failed (Invalid rule 'x')");
  const ok = parseGhOutput('HTTP/2.0 200 OK\nX: y\n\n[{"id":1}]');
  assert.deepEqual(ok.data, [{ id: 1 }]);
  assert.equal(parseGhOutput('', 'To get started with GitHub CLI, please run:  gh auth login').status, 0);
});

test('mb github: usage errors, and a missing gh is exit 7', async () => {
  let err = '';
  const io = { root: ROOT, stdout: () => {}, stderr: (s) => { err += s; } };
  assert.equal(await main(['github'], io), 2);
  assert.equal(await main(['github', 'protect'], io), 2);
  assert.equal(await main(['github', 'setup', '--plan'], io), 2);
  const saved = process.env.PATH;
  process.env.PATH = tmp('mb-empty-path-');
  try {
    assert.equal(await main(['github', 'setup', '--dry-run'], io), 7);
  } finally {
    process.env.PATH = saved;
  }
  assert.match(err, /gh/);
});

// ---------------------------------------------------------------- pre-push hook

function hookRepo() {
  const dir = tmp('mb-hook-');
  fs.cpSync(path.join(ROOT, 'tools'), path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.mb'));
  fs.copyFileSync(path.join(ROOT, '.mb', 'ownership.json'), path.join(dir, '.mb', 'ownership.json'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'alice@example.com');
  git('config', 'user.name', 'Alice');
  return { dir, git };
}

function runHook(dir) {
  const r = spawnSync('sh', [path.join(dir, 'tools', 'hooks', 'pre-push'), 'origin', 'https://example.com/acme/skills.git'], {
    cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, MB_LEAK_DENYLIST: '' },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('pre-push hook blocks a commit containing a fake ghp_ token (CHK-20)', POSIX_ONLY, () => {
  const { dir, git } = hookRepo();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'nothing secret here\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'clean');
  const clean = runHook(dir);
  assert.doesNotMatch(clean.out, /GitHub token/);

  fs.writeFileSync(path.join(dir, 'notes.txt'), `token = ${FAKE_TOKEN}\n`);
  git('commit', '-q', '-am', 'oops');
  const dirty = runHook(dir);
  assert.notEqual(dirty.code, 0);
  assert.match(dirty.out, /CHK-20/);
  assert.match(dirty.out, /notes\.txt:1: GitHub token/);
  assert.match(dirty.out, /pre-push: blocked/);
});

test('pre-push hook is executable and runs check --fast and gen --check', () => {
  const p = path.join(ROOT, 'tools', 'hooks', 'pre-push');
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(text, /tools\/mb\.mjs check --fast/);
  assert.match(text, /tools\/mb\.mjs gen --check/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(p).mode & 0o111);
});

// ---------------------------------------------------------------- workflows

const read = (f) => fs.readFileSync(path.join(WF, f), 'utf8');
const WORKFLOWS = ['mb-check.yml', 'mb-evals.yml', 'mb-release.yml', 'mb-base-update.yml'];

/** Text of the top-level job `id` (from "  id:" to the next top-level job). */
function job(text, id) {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${id}:`);
  assert.ok(start >= 0, `job ${id} exists`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end]) && !/^\S/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

/** The dedented `run: |` script of the step whose `name:` is `stepName`. */
function stepRun(text, stepName) {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.trim() === `- name: ${stepName}` || l.trim() === `name: ${stepName}`);
  assert.ok(i >= 0, `step ${stepName}`);
  while (!/^\s*run: \|\s*$/.test(lines[i])) i++;
  const indent = lines[i].search(/\S/);
  const body = [];
  for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > indent); i++) body.push(lines[i]);
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(pad)).join('\n') + '\n';
}

test('no workflow uses pull_request_target; every action is pinned by commit SHA', () => {
  for (const f of WORKFLOWS) {
    const t = read(f);
    assert.doesNotMatch(t, /^\s*pull_request_target\s*:/m, f);
    assert.doesNotMatch(t, /on:[^\n]*pull_request_target/, f);
    for (const m of t.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${f}: ${m[1]}`);
  }
});

test('no workflow triggered by pull_request references a secret; only mb-check runs on pull_request', () => {
  for (const f of WORKFLOWS) {
    const t = read(f);
    const onBlock = t.slice(t.indexOf('\non:'), t.indexOf('\njobs:'));
    const prTriggered = /^\s+pull_request\s*:/m.test(onBlock);
    assert.equal(prTriggered, f === 'mb-check.yml', f);
    if (prTriggered) assert.ok(!t.includes('secrets.'), f);
  }
});

test('mb-check aggregate step fails unless every check leg succeeded (MB-GH-001)', POSIX_ONLY, () => {
  const script = stepRun(read('mb-check.yml'), 'Every check leg succeeded');
  const res = (r) => spawnSync('bash', ['-eo', 'pipefail', '-c', script], { encoding: 'utf8', env: { ...process.env, RESULT: r } }).status;
  assert.equal(res('success'), 0);
  for (const r of ['failure', 'skipped', 'cancelled']) assert.notEqual(res(r), 0, r);
});

test('mb-check: setup + matrix check (bash, CLI before check, base-only gated) + aggregate mb-check job (MB-GH-001)', () => {
  const t = read('mb-check.yml');
  assert.match(t, /^permissions:\n {2}contents: read$/m);
  const check = job(t, 'check');
  assert.match(check, /defaults:\n\s+run:\n\s+shell: bash/);
  assert.match(check, /fail-fast: false/);
  assert.match(check, /fromJSON\(needs\.setup\.outputs\.matrix\)/);
  assert.match(check, /fetch-depth: 0/);
  const install = check.indexOf('npm i -g "@anthropic-ai/claude-code@');
  assert.ok(install > 0 && install < check.indexOf('./mb check --json'));
  assert.match(check, /--base HEAD\^1/);
  for (const cmd of ['./mb test --derive', './mb test --vectors-only --runtime bun']) {
    const at = check.indexOf(cmd);
    assert.ok(at > 0, cmd);
    assert.match(check.slice(check.lastIndexOf('- ', at), at), /if: needs\.setup\.outputs\.is-base == 'true'/, cmd);
  }
  assert.match(check, /@fission-ai\/openspec@\$\{OPENSPEC_VERSION\}/);
  assert.match(t, /OPENSPEC_VERSION: 2\.0\.0/);
  const agg = job(t, 'mb-check');
  assert.match(agg, /name: mb-check\n/);
  assert.match(agg, /needs: \[check\]/);
  assert.match(agg, /if: always\(\)/);
  assert.match(agg, /\[ "\$RESULT" = "success" \]/);
});

test('mb-check setup script reads ci.osMatrix and isBase', POSIX_ONLY, () => {
  const script = stepRun(read('mb-check.yml'), 'Read ci.osMatrix and isBase');
  const dir = tmp('mb-wf-');
  fs.writeFileSync(path.join(dir, 'marketplace.config.json'), JSON.stringify({ ci: { osMatrix: ['ubuntu-latest', 'windows-latest'] } }));
  const outFile = path.join(dir, 'out.txt');
  const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'matrix={"os":["ubuntu-latest","windows-latest"]}\nis-base=true\n');
});

test('mb-release fails in the base when .mb/base-version.json differs from the tag, skips in derived repos (MB-GH-005)', POSIX_ONLY, () => {
  const t = read('mb-release.yml');
  const script = stepRun(t, 'Base only - .mb/base-version.json must equal the tag');
  const dir = tmp('mb-rel-');
  fs.mkdirSync(path.join(dir, '.mb'));
  fs.writeFileSync(path.join(dir, '.mb', 'base-version.json'), '{"version":"v1.2.0"}\n');
  const runIt = (tag) => spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, TAG: tag } });
  assert.equal(runIt('v1.2.0').status, 0);
  const bad = runIt('v1.3.0');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /::error::/);
  fs.writeFileSync(path.join(dir, '.mb-lock.json'), '{}\n'); // derived repo
  const derived = runIt('v9.9.9');
  assert.equal(derived.status, 0);
  assert.match(derived.stdout, /skipped/);
  // The assertion runs in build, before anything is published.
  const build = job(t, 'build');
  assert.ok(build.indexOf('base-version.json must equal the tag') < build.indexOf('./mb check'));
  assert.match(build, /policy emit --host claude/);
  assert.match(build, /policy emit --host codex/);
  assert.match(build, /SHA256SUMS/);
  assert.match(job(t, 'publish'), /needs: \[build\]/);
  assert.match(t, /tags: \['v\*'\]/);
});

test('mb-base-update: read-only update job with no secrets; publish runs no fetched code and never opens a PR without the token', () => {
  const t = read('mb-base-update.yml');
  assert.match(t, /vars\.MB_BASE_UPDATE == 'true'/);
  const update = job(t, 'update');
  assert.match(update, /permissions:\n\s+contents: read/);
  assert.ok(!update.includes('secrets.'));
  assert.match(update, /--no-workflows/);
  const publish = job(t, 'publish');
  assert.ok(!/^\s*(\.\/mb|node|npm|npx|sh|bash)\b/m.test(publish), 'publish runs no repository code');
  assert.match(publish, /git apply --index/);
  assert.match(publish, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/); // the tag is validated
  // gh pr create only inside the HAS_TOKEN branch; otherwise compare link + checklist in the summary.
  const script = stepRun(t, 'Apply, push, and open the PR or print the compare link');
  const prAt = script.indexOf('gh pr create');
  assert.ok(prAt > script.indexOf('if [ "$HAS_TOKEN" = "true" ]; then'));
  assert.ok(prAt < script.indexOf('else'));
  assert.match(script, /compare\/\$DEFAULT_BRANCH\.\.\.\$branch/);
  assert.match(script, /GITHUB_STEP_SUMMARY/);
});

test('mb-base-update: exit 1 after the report (kept conflicts, red check) still publishes; other failures stop', POSIX_ONLY, () => {
  const script = stepRun(read('mb-base-update.yml'), './mb base-update');
  const run = (code, report) => {
    const dir = tmp('mb-bu-');
    fs.writeFileSync(path.join(dir, 'mb'), `#!/bin/sh\nprintf '%s\\n' '${report}'\nexit ${code}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'rt'));
    spawnSync('git', ['init', '-q', dir]); // the step runs `git config` in the checkout
    const env = { ...process.env, RUNNER_TEMP: path.join(dir, 'rt'), HAS_TOKEN: 'false' };
    return spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd: dir, encoding: 'utf8', env });
  };
  assert.equal(run(1, 'base-update report: v0.1.0 -> v0.2.0 (abc)').status, 0);
  assert.equal(run(1, 'mb base-update: something failed').status, 1);
  assert.equal(run(6, 'base-update report: v0.1.0 -> v0.2.0 (abc)').status, 6);
  assert.equal(run(0, 'base-update report: v0.1.0 -> v0.2.0 (abc)').status, 0);
});

test('mb-evals: leak-scans dist/evals before upload (CHK-20)', POSIX_ONLY, () => {
  const t = read('mb-evals.yml');
  assert.ok(t.indexOf('id: scan') < t.indexOf('actions/upload-artifact'));
  assert.match(t, /steps\.scan\.outcome == 'success'/);
  const script = stepRun(t, 'Leak scan of the eval results (CHK-20)');
  const dir = tmp('mb-evscan-');
  fs.symlinkSync(path.join(ROOT, 'tools'), path.join(dir, 'tools'));
  fs.mkdirSync(path.join(dir, 'dist', 'evals'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'evals', 'claude-demo.json'), '{"cases":[]}\n');
  const env = { ...process.env, MB_LEAK_DENYLIST: '', PATH: process.env.PATH };
  const clean = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  fs.writeFileSync(path.join(dir, 'dist', 'evals', 'codex-demo.json'), `{"last":"${FAKE_TOKEN}"}\n`);
  const dirty = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stdout, /codex-demo\.json:1: GitHub token/);
  fs.writeFileSync(path.join(dir, 'dist', 'evals', 'codex-demo.json'), '{"cwd":"/Users/alice/work"}\n');
  const home = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env });
  assert.notEqual(home.status, 0, 'home paths in eval results are leaks too');
});

test('mb-evals: a missing API key skips that host with a notice and exit 0 (MB-EVL-007)', POSIX_ONLY, () => {
  const script = stepRun(read('mb-evals.yml'), 'Check the API key');
  const out = tmp('mb-evkey-');
  const run = (env) => spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: path.join(out, 'o'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ...env } });
  const r = run({ HOST: 'codex' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::skipped: codex evals \(OPENAI_API_KEY is not set\)/);
  assert.match(fs.readFileSync(path.join(out, 'o'), 'utf8'), /run=false/);
});

test('mb-release: policy emit is skipped with a notice when marketplace.config.json has no distribution (O9)', POSIX_ONLY, () => {
  const script = stepRun(read('mb-release.yml'), './mb policy emit (both hosts)');
  const dir = tmp('mb-rel-');
  fs.writeFileSync(path.join(dir, 'marketplace.config.json'), '{"name":"acme"}\n');
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::policy emit skipped/);
  // No outputs: the release is created without assets (GitHub refuses empty asset files).
  const ghOut = path.join(dir, 'gh-output');
  const pkg = spawnSync('bash', ['-eo', 'pipefail', '-c', stepRun(read('mb-release.yml'), 'Package + SHA256SUMS')], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: ghOut } });
  assert.equal(pkg.status, 0, pkg.stderr);
  assert.match(fs.readFileSync(ghOut, 'utf8'), /^assets=false$/m);
  assert.equal(fs.existsSync(path.join(dir, 'dist', 'assets')), false);
});

test('CODEOWNERS seed and base copy: every owner line commented, placeholder lines present', () => {
  for (const f of [path.join(ROOT, 'tools', 'templates', 'seeds', '.github', 'CODEOWNERS'), path.join(ROOT, '.github', 'CODEOWNERS')]) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(lines.every((l) => l.startsWith('#')), f);
    assert.ok(lines.includes('# * @OWNER') && lines.includes('# /policy/org.json @OWNER'), f);
  }
});
