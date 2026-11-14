// tools/cmd/init.mjs: `mb init`. Turns a fresh template copy or clone of the
// base into a derived marketplace: renders the S seeds, deletes the examples not selected, writes
// `.mb-lock.json` (B and E paths only), then runs `gen` and `check`.
//
// Safety: every input is validated and every seed is rendered in memory BEFORE the first write.
// Refuses when a lock exists (unless --force), when the name is `marketplace-base`, when the repo
// is no longer a pristine base copy (marketplace.config.json#name != marketplace-base, unless
// --force), and when the marketplace sits in a subdirectory of an enclosing git repo.
//
// `--examples` is recorded in `includeExamples` (all -> true, none -> false, a list ->
// that sorted list), so a later base-update knows which examples are "not included" (decision table row 1)
// and never brings deleted examples back, while an `all` repo still receives new examples.
// Re-init (`--force` with an existing lock) never overwrites an S file: it writes only
// the seeds that are missing, patches only `includeExamples` in marketplace.config.json (and only
// when --examples is given), and deletes the examples no longer selected.
// The lock's base commit comes from `git ls-remote <base.url>` (peeled), else from a
// local tag of the same name (a clone); when neither works the message names the failed lookup.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../kit/json.mjs';
import { fromPosix, walk, writeFileAtomic, writeJson, removePath, isDir } from '../lib/fsx.mjs';
import { gitRoot, lsRemoteTag, runGit } from '../lib/git.mjs';
import { compileOwnership, loadOwnership, LOCK_FILE } from '../lib/ownership.mjs';
import { hashFile } from '../lib/hash.mjs';
import { validate, loadSchema } from '../lib/schema-lite.mjs';
import { exampleOf, parseTag, readLock, repoFiles, sameDir, writeLock } from '../lib/lock.mjs';

export const name = 'init';
export const summary = 'Turn a fresh copy of the base into your marketplace (seeds, lock, gen, check).';
export const usage = 'mb init --name <mkt> --display <s> --owner <name> [--email e] [--repo owner/repo] [--examples all|none|<p,...>] [--force]';
export const options = {
  name: { type: 'string' },
  display: { type: 'string' },
  owner: { type: 'string' },
  email: { type: 'string' },
  repo: { type: 'string' },
  examples: { type: 'string' },
  force: { type: 'boolean' },
};

const SEEDS_DIR = ['tools', 'templates', 'seeds'];
const CONFIG = 'marketplace.config.json';
// Seed file name -> target path (a real `.gitignore` inside seeds/ would act as an ignore file).
const SEED_RENAMES = { gitignore: '.gitignore' };

/** Plain {{token}} substitution; `escape` maps each value (JSON-escaping for JSON seeds). */
function renderTokens(text, tokens, escape, rel) {
  const out = text.replace(/\{\{([A-Za-z]+)\}\}/g, (m, k) => (Object.hasOwn(tokens, k) ? escape(tokens[k]) : m));
  const left = /\{\{[^}]*\}\}/.exec(out);
  if (left) {
    const e = new Error(`seed ${rel} has an unknown token ${left[0]}`);
    e.exitCode = 1;
    throw e;
  }
  return out;
}

/** { commit, why }: the tag's commit from the base URL, else from a local tag; `why` explains a null. */
function baseCommit(root, url, tag) {
  const remote = lsRemoteTag(root, url, tag);
  if (remote) return { commit: remote, why: null };
  const local = runGit(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { cwd: root });
  if (local.code === 0 && local.stdout.trim()) return { commit: local.stdout.trim(), why: null };
  const reachable = runGit(['ls-remote', '--heads', url], { cwd: root }).code === 0;
  return {
    commit: null,
    why: reachable ? `tag ${tag} not found at ${url} or locally` : `could not reach ${url}; no local tag ${tag}`,
  };
}

/** "host/path" of a git URL (https, ssh://, scp-style), lowercased and without `.git`, for comparison. */
function urlKey(u) {
  const s = String(u).trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/i.exec(s);
  return (m ? `${m[1]}/${m[2]}` : s).toLowerCase();
}

function listExamples(root) {
  const dir = path.join(root, 'examples', 'plugins');
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export async function run(argv, ctx) {
  const v = ctx.args.values;
  const root = ctx.root;
  if (ctx.args.positionals.length) throw ctx.usageError(`unexpected argument "${ctx.args.positionals[0]}"`);
  for (const k of ['name', 'display', 'owner']) {
    if (!v[k] || !v[k].trim()) throw ctx.usageError(`--${k} is required`);
  }
  for (const k of ['name', 'display', 'owner', 'email', 'repo', 'examples']) {
    // eslint-disable-next-line no-control-regex
    if (v[k] !== undefined && /[\u0000-\u001f\u007f]/.test(v[k])) throw ctx.usageError(`--${k} must not contain control characters or newlines`);
  }
  if (v.name === 'marketplace-base') throw ctx.usageError('--name marketplace-base is the base itself; choose your own marketplace name');

  // Never act on an enclosing repo (a marketplace in a subdirectory of another checkout).
  const top = gitRoot(root);
  if (top && !sameDir(top, root)) throw ctx.fail(2, `the marketplace must be the top level of its git repository (found ${top})`);

  const lockExists = fs.existsSync(path.join(root, LOCK_FILE));
  if (lockExists && !v.force) throw ctx.fail(1, `${LOCK_FILE} exists: this repo is already initialised (use --force to re-run init; it writes only missing seed files and applies --examples, never overwriting yours)`);

  const baseConfig = parse(fs.readFileSync(path.join(root, CONFIG)));
  if (!lockExists && baseConfig.name !== 'marketplace-base' && !v.force) {
    throw ctx.fail(1, `${CONFIG} names "${baseConfig.name}", not marketplace-base: this is not a fresh copy of the base (use --force to init anyway)`);
  }
  const baseUrl = baseConfig?.base?.url;
  if (typeof baseUrl !== 'string' || !baseUrl) throw ctx.fail(3, `${CONFIG}: base.url is missing`);
  const tag = parse(fs.readFileSync(path.join(root, '.mb', 'base-version.json'))).version;
  if (!parseTag(tag)) throw ctx.fail(3, `.mb/base-version.json: "${tag}" is not a vX.Y.Z tag`);

  // Examples selection. A re-init without --examples keeps the recorded selection.
  const examples = listExamples(root);
  const recorded = lockExists ? baseConfig.includeExamples ?? true : true;
  let sel = v.examples ?? 'all';
  if (v.examples === undefined && recorded === false) sel = 'none';
  if (v.examples === undefined && Array.isArray(recorded)) sel = recorded.filter((p) => examples.includes(p)).join(',') || 'none';
  let keep, includeExamples;
  if (sel === 'all') {
    keep = examples;
    includeExamples = true;
  } else if (sel === 'none') {
    keep = [];
    includeExamples = false;
  } else {
    keep = [...new Set(sel.split(',').map((s) => s.trim()).filter(Boolean))].sort();
    const unknown = keep.filter((p) => !examples.includes(p));
    if (!keep.length || unknown.length) throw ctx.usageError(`--examples: unknown example(s) ${unknown.join(', ') || '(empty list)'}; available: ${examples.join(', ') || '(none)'}`);
    includeExamples = keep;
  }
  const drop = examples.filter((p) => !keep.includes(p));

  // Render every seed in memory first.
  const tokens = {
    mkt: v.name,
    displayName: v.display,
    owner: v.owner,
    email: v.email ?? '',
    repo: v.repo ?? '<owner>/<repo>',
    year: String(new Date().getUTCFullYear()),
    baseUrl,
  };
  const ownership = loadOwnership(root);
  const classify = compileOwnership(ownership);
  const seedRoot = path.join(root, ...SEEDS_DIR);
  const rendered = new Map();
  for (const rel of walk(seedRoot)) {
    const target = SEED_RENAMES[rel] ?? rel;
    if (classify(target) !== 'S') throw ctx.fail(1, `seed ${rel} would write ${target}, which is not an S path in .mb/ownership.json`);
    if (lockExists && target === CONFIG) {
      // Re-init: the existing config is the user's; only includeExamples may change.
      const json = { ...baseConfig, includeExamples };
      const bad = validate(loadSchema(root, 'marketplace-config'), json);
      if (bad.length) throw ctx.fail(1, `${CONFIG} is invalid: ${bad.map((b) => `${b.path} ${b.message}`).join('; ')}`);
      if (JSON.stringify(recorded) !== JSON.stringify(includeExamples)) rendered.set(target, json);
      continue;
    }
    if (lockExists && fs.existsSync(fromPosix(root, target))) continue; // never overwrite an S file
    const text = fs.readFileSync(path.join(seedRoot, ...rel.split('/')), 'utf8');
    if (target === CONFIG) {
      const json = parse(renderTokens(text, { ...tokens, repo: v.repo ?? 'x/y' }, (s) => JSON.stringify(s).slice(1, -1), rel));
      if (v.email === undefined && json.owner) delete json.owner.email;
      if (v.repo === undefined) delete json.distribution;
      json.includeExamples = includeExamples;
      const bad = validate(loadSchema(root, 'marketplace-config'), json);
      if (bad.length) throw ctx.usageError(`invalid arguments for ${CONFIG}: ${bad.map((b) => `${b.path} ${b.message}`).join('; ')}`);
      rendered.set(target, json);
    } else {
      rendered.set(target, renderTokens(text, tokens, (s) => s, rel));
    }
  }
  if (!lockExists && !rendered.has(CONFIG)) throw ctx.fail(1, `tools/templates/seeds/${CONFIG} is missing`);

  // A forced re-init keeps the recorded hash of every path already locked, so a local edit of a
  // B/E file is not "laundered" into the lock (it must stay a conflict for base-update and CHK-16).
  const oldLock = lockExists ? readLock(root) : null;
  const adopted = oldLock ? oldLock.adopted : [];

  // Base commit of the tag: peeled ^{} line preferred (annotated), else the plain line (lightweight).
  const { commit, why } = baseCommit(root, baseUrl, tag);
  const origin = runGit(['remote', 'get-url', 'origin'], { cwd: root });
  const originIsBase = origin.code === 0 && urlKey(origin.stdout) === urlKey(baseUrl);

  // ---- writes start here ----
  for (const [target, content] of rendered) {
    const abs = fromPosix(root, target);
    if (target === CONFIG) writeJson(abs, content);
    else writeFileAtomic(abs, content);
  }
  for (const p of drop) removePath(path.join(root, 'examples', 'plugins', p));
  if (!keep.length) {
    for (const d of [path.join(root, 'examples', 'plugins'), path.join(root, 'examples')]) {
      if (isDir(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    }
  }

  const files = {};
  const lockable = (rel) => {
    const cls = classify(rel);
    return cls === 'B' || (cls === 'E' && keep.includes(exampleOf(rel)));
  };
  for (const [rel, h] of Object.entries(oldLock?.files ?? {})) if (lockable(rel)) files[rel] = h;
  for (const rel of repoFiles(root)) if (lockable(rel) && !Object.hasOwn(files, rel)) files[rel] = hashFile(fromPosix(root, rel));
  writeLock(root, { base: { url: baseUrl, tag, commit }, files, adopted });

  ctx.stdout(`initialised ${v.name} from base ${tag} (${commit ?? `commit unknown: ${why}; the next base-update fills it`})\n`);
  ctx.stdout(`seeds ${lockExists ? 'written (missing or includeExamples changed)' : 'rendered'}: ${[...rendered.keys()].sort().join(', ') || '(none)'}\n`);
  ctx.stdout(`examples kept: ${keep.join(', ') || '(none)'}${drop.length ? `; deleted: ${drop.join(', ')}` : ''}\n`);
  ctx.stdout(`${LOCK_FILE}: ${Object.keys(files).length} base files locked\n`);

  ctx.stdout('\n$ ./mb gen\n');
  const genCode = await ctx.runCommand('gen', []);
  if (genCode) {
    ctx.stderr(`mb init: gen failed (exit ${genCode}); fix the error and run ./mb gen, then ./mb check\n`);
    return genCode;
  }
  ctx.stdout('\n$ ./mb check\n');
  const checkCode = await ctx.runCommand('check', []);

  ctx.stdout(`
Next steps:
  1. Review the changes, then commit:  git add -A && git commit -m "Initialise ${v.name} from marketplace-base ${tag}"
  2. Add a skill:                      ./mb new skill <plugin>/<skill> "<what it does>. Use when <trigger>."
  3. Check before every push:          ./mb gen && ./mb check
  4. Set up GitHub (optional):         ./mb github setup --dry-run
  5. Pull base updates later:          ./mb base-update
`);
  if (originIsBase) {
    ctx.stderr(`mb init: WARNING: git remote "origin" still points at the base (${baseUrl}); a push to origin would publish your marketplace there.\n` +
      'Fix: git remote rename origin base && git remote add origin <your repo URL>\n');
  }
  if (checkCode) ctx.stderr(`mb init: init is done, but ./mb check reported problems (exit ${checkCode}); see above\n`);
  return checkCode;
}
