// tools/cmd/github.mjs: `mb github setup [--dry-run] [--require-codeowners]`.
//
// No plan detection: the plan field of the API is null for normal tokens. Every step is
// TRIED and degrades on HTTP 403/404/422:
//   1. GET repos/{owner}/{repo}            -> full name, private, owner type/login, default branch
//   2. rulesets from tools/templates/github/ruleset.json (branch ruleset + `v*` tag ruleset);
//      an existing ruleset with the same name is updated (PUT), so a re-run never duplicates it
//   3. refused -> classic PUT branches/<b>/protection with the same branch rules
//   4. refused -> print the "checks will report but not block" notice and
//      `git config core.hooksPath tools/hooks` (pre-push runs ./mb check --fast + ./mb gen --check)
//   5. .github/CODEOWNERS: a user owner gets the "@OWNER" placeholder lines uncommented with the
//      owner's login; an organization owner keeps them commented and gets a hint.
// Any other HTTP status (401, 5xx, ...) is a failure (exit 1) and installs nothing.
// --dry-run makes only the read-only repository GET and prints every call it would make.
//
// The GitHub CLI runner and the git runner are injectable (setup({ gh, git })) so tests can mock
// every response without network access or a fake `gh` binary.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '../kit/json.mjs';
import { runGit, MissingToolError } from '../lib/git.mjs';
import { writeFileAtomic } from '../lib/fsx.mjs';

export const name = 'github';
export const summary = 'Set up GitHub branch rules, tag rules, hooks and CODEOWNERS (no plan detection).';
export const usage = 'mb github setup [--dry-run] [--require-codeowners]';
export const options = {
  'dry-run': { type: 'boolean' },
  'require-codeowners': { type: 'boolean' },
};

export const TEMPLATE = 'tools/templates/github/ruleset.json';
export const HOOKS_PATH = 'tools/hooks';
export const DEGRADE = new Set([403, 404, 422]);
export const NOTICE = 'branch rules are not available for this repo (for example GitHub Free private repos): checks will report but not block';
const PLACEHOLDER_LINES = [
  ['# * @OWNER', (login) => `* @${login}`],
  ['# /policy/org.json @OWNER', (login) => `/policy/org.json @${login}`],
];

/**
 * Real `gh api` runner: gh(method, apiPath, body?) -> { status, data, message }.
 * status 0 means no HTTP response (not logged in, no remote, ...). Missing gh -> exit 7.
 */
export function makeGh(cwd) {
  return (method, apiPath, body) => {
    const args = ['api', '-i', '--method', method, '-H', 'Accept: application/vnd.github+json', apiPath];
    if (body !== undefined) args.push('--input', '-');
    const r = spawnSync('gh', args, {
      cwd, encoding: 'utf8', windowsHide: true,
      input: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.error) {
      if (r.error.code === 'ENOENT') throw new MissingToolError('gh');
      throw r.error;
    }
    return parseGhOutput(r.stdout, r.stderr);
  };
}

/** Parse `gh api -i` output: a status line, headers, a blank line, then the body. */
export function parseGhOutput(stdout, stderr = '') {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(stdout ?? '');
  if (!m) return { status: 0, data: null, message: String(stderr).trim() || 'no HTTP response from gh' };
  const sep = /\r?\n\r?\n/.exec(stdout);
  const raw = sep ? stdout.slice(sep.index + sep[0].length).trim() : '';
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  let message = (data && typeof data === 'object' && data.message) || String(stderr).trim();
  // A 422 also means "malformed body": show the details so a template bug is not mistaken for a plan limit.
  if (data && Array.isArray(data.errors) && data.errors.length) {
    message += ` (${data.errors.map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e))).join('; ')})`;
  }
  return { status: Number(m[1]), data, message };
}

const ok = (s) => s >= 200 && s < 300;

/** Branch + tag ruleset bodies from the template, adjusted for --require-codeowners. */
export function loadRulesets(root, requireCodeowners) {
  const tpl = parse(fs.readFileSync(path.join(root, ...TEMPLATE.split('/'))));
  if (requireCodeowners) {
    const pr = tpl.branch.rules.find((r) => r.type === 'pull_request');
    pr.parameters.require_code_owner_review = true;
    pr.parameters.required_approving_review_count = 1;
  }
  return tpl;
}

/** The classic branch-protection body equivalent to the branch ruleset. */
export function classicBody(branchRuleset) {
  const pr = branchRuleset.rules.find((r) => r.type === 'pull_request').parameters;
  const sc = branchRuleset.rules.find((r) => r.type === 'required_status_checks').parameters;
  return {
    required_status_checks: { strict: sc.strict_required_status_checks_policy, contexts: sc.required_status_checks.map((c) => c.context) },
    enforce_admins: false,
    required_pull_request_reviews: {
      dismiss_stale_reviews: pr.dismiss_stale_reviews_on_push,
      require_code_owner_reviews: pr.require_code_owner_review,
      required_approving_review_count: pr.required_approving_review_count,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

/** CODEOWNERS text with the placeholder lines filled for `login`, or null when nothing changes. */
export function fillCodeowners(text, login) {
  let changed = false;
  const out = text.split('\n').map((line) => {
    const hit = PLACEHOLDER_LINES.find(([p]) => line.replace(/\r$/, '') === p);
    if (!hit) return line;
    changed = true;
    return hit[1](login) + (line.endsWith('\r') ? '\r' : '');
  });
  return changed ? out.join('\n') : null;
}

function httpError(what, r) {
  const e = new Error(`${what} failed (${r.status ? `HTTP ${r.status}` : 'no response'}): ${r.message || 'unknown error'}`);
  e.exitCode = 1;
  return e;
}

/**
 * Run the setup. opts: { root, dryRun, requireCodeowners, gh, git, out }.
 * gh(method, path, body?) -> { status, data, message }; git(args) -> { code, stdout, stderr }.
 * Returns { protection: 'ruleset'|'classic'|'hooks'|'dry-run', codeowners: string }.
 */
export async function setup({ root, dryRun = false, requireCodeowners = false, gh, git, out }) {
  const say = (s) => out(s + '\n');
  const plan = (method, p) => say(`  would call: gh api --method ${method} ${p}`);

  // 1. Repository facts (read-only; also done in dry-run).
  const repo = await gh('GET', 'repos/{owner}/{repo}');
  if (repo.status !== 200 || !repo.data?.full_name) {
    throw httpError('reading the repository (run inside a clone with a GitHub remote, after `gh auth login`)', repo);
  }
  const full = repo.data.full_name;
  const branch = repo.data.default_branch;
  const ownerType = repo.data.owner?.type;
  const login = repo.data.owner?.login;
  say(`Repository ${full} (${repo.data.private ? 'private' : 'public'}, owner ${login}: ${ownerType}), default branch ${branch}`);
  const sets = loadRulesets(root, requireCodeowners);
  const protPath = `repos/${full}/branches/${encodeURIComponent(branch)}/protection`;
  const result = { protection: null, codeowners: null };

  if (dryRun) {
    say('Dry run: no change is made. Each step is tried in order; HTTP 403/404/422 falls through to the next.');
    say('Step 2: rulesets');
    plan('GET', `repos/${full}/rulesets?includes_parents=false`);
    for (const s of [sets.branch, sets.tag]) plan('POST', `repos/${full}/rulesets   # ${s.name} (PUT rulesets/<id> if it already exists)`);
    say('Step 3: if refused, classic branch protection');
    plan('PUT', protPath);
    say('Step 4: if refused again');
    say(`  would print: ${NOTICE}`);
    say(`  would run: git config core.hooksPath ${HOOKS_PATH}`);
    result.protection = 'dry-run';
  } else {
    result.protection = await applyProtection({ gh, git, root, full, sets, protPath, say });
  }

  // 5. CODEOWNERS.
  say('Step 5: .github/CODEOWNERS');
  result.codeowners = codeowners({ root, ownerType, login, dryRun, say });
  if (requireCodeowners && result.codeowners !== 'filled' && result.codeowners !== 'would-fill') {
    say('  note: --require-codeowners needs at least one owner line in .github/CODEOWNERS');
  }
  return result;
}

async function applyProtection({ gh, git, root, full, sets, protPath, say }) {
  // 2. Rulesets. List first so a re-run updates instead of failing with a duplicate-name 422.
  say('Step 2: rulesets');
  const list = await gh('GET', `repos/${full}/rulesets?includes_parents=false`);
  let refused = DEGRADE.has(list.status) ? list : null;
  if (!refused && !ok(list.status)) throw httpError('listing rulesets', list);
  if (!refused) {
    const existing = Array.isArray(list.data) ? list.data : [];
    const branchRes = await putRuleset(gh, full, sets.branch, existing);
    if (DEGRADE.has(branchRes.status)) refused = branchRes;
    else if (!ok(branchRes.status)) throw httpError(`ruleset ${sets.branch.name}`, branchRes);
    else {
      say(`  ruleset ${sets.branch.name} applied: pull request + required check mb-check, no force-push, no deletion`);
      const tagRes = await putRuleset(gh, full, sets.tag, existing);
      if (ok(tagRes.status)) say(`  ruleset ${sets.tag.name} applied: v* tags cannot be moved or deleted`);
      else if (DEGRADE.has(tagRes.status)) say(`  warning: tag ruleset refused (HTTP ${tagRes.status}): v* tags are not protected`);
      else throw httpError(`ruleset ${sets.tag.name}`, tagRes);
      return 'ruleset';
    }
  }
  say(`  rulesets refused (HTTP ${refused.status}${refused.message ? `: ${refused.message}` : ''})`);

  // 3. Classic branch protection.
  say('Step 3: classic branch protection');
  const prot = await gh('PUT', protPath, classicBody(sets.branch));
  if (ok(prot.status)) {
    say('  classic protection applied: pull request + required check mb-check, no force-push, no deletion');
    say('  note: classic protection cannot protect tags; v* tags are not protected');
    return 'classic';
  }
  if (!DEGRADE.has(prot.status)) throw httpError('classic branch protection', prot);
  say(`  classic protection refused (HTTP ${prot.status}${prot.message ? `: ${prot.message}` : ''})`);

  // 4. Degrade: local hooks.
  say('Step 4: local hooks');
  say(`  ${NOTICE}`);
  const g = git(['config', 'core.hooksPath', HOOKS_PATH]);
  if (g.code !== 0) throw Object.assign(new Error(`git config core.hooksPath failed: ${String(g.stderr).trim()}`), { exitCode: 1 });
  say(`  installed: git config core.hooksPath ${HOOKS_PATH} (pre-push runs ./mb check --fast and ./mb gen --check)`);
  return 'hooks';
}

async function putRuleset(gh, full, body, existing) {
  const found = existing.find((r) => r && r.name === body.name);
  return found
    ? gh('PUT', `repos/${full}/rulesets/${found.id}`, body)
    : gh('POST', `repos/${full}/rulesets`, body);
}

function codeowners({ root, ownerType, login, dryRun, say }) {
  const file = path.join(root, '.github', 'CODEOWNERS');
  if (!fs.existsSync(file)) {
    say('  .github/CODEOWNERS is missing: skipped');
    return 'missing';
  }
  if (ownerType !== 'User') {
    say(`  owner ${login} is an organization: lines left commented; add \`@${login}/<team>\` lines to .github/CODEOWNERS`);
    return 'org-hint';
  }
  const next = fillCodeowners(fs.readFileSync(file, 'utf8'), login);
  if (next === null) {
    say('  no "@OWNER" placeholder lines: unchanged');
    return 'unchanged';
  }
  if (dryRun) {
    say(`  would uncomment "* @${login}" and "/policy/org.json @${login}"`);
    return 'would-fill';
  }
  writeFileAtomic(file, next);
  say(`  uncommented "* @${login}" and "/policy/org.json @${login}" (commit this change)`);
  return 'filled';
}

export async function run(argv, ctx) {
  const pos = ctx.args.positionals;
  if (pos[0] !== 'setup' || pos.length !== 1) throw ctx.usageError('expected: github setup');
  const r = await setup({
    root: ctx.root,
    dryRun: Boolean(ctx.args.values['dry-run']),
    requireCodeowners: Boolean(ctx.args.values['require-codeowners']),
    gh: makeGh(ctx.root),
    git: (args) => runGit(args, { cwd: ctx.root }),
    out: ctx.stdout,
  });
  ctx.stdout(`Done: branch rules = ${r.protection}; CODEOWNERS = ${r.codeowners}\n`);
  return 0;
}
