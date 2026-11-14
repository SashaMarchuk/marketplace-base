// tools/cmd/base-update.mjs: `mb base-update` (SPEC §14.3). Pulls a newer base tag into a derived
// repo by copying files, never by a 3-way merge.
//
// Two phases (the state file is the contract between them, keep it stable across base versions):
//   1. (old tooling) pick the tag, require a clean tree, snapshot `pre` (hash of every locked file),
//      refuse edited/local files under the permanent B paths (SELF), fetch the tag, store
//      {tag, commit, pre} in `git rev-parse --git-path mb-update.json`, check out SELF from the
//      commit, then re-run `node tools/mb.mjs base-update --to <tag> --continue [flags]` so the
//      NEW tooling does the rest.
//   2. (--continue, new tooling) read the state file (never FETCH_HEAD), apply the decision table
//      (tools/lib/lock.mjs decide) to every locked path and every B/E path of the commit, run the
//      migrations for the versions crossed, write the lock, delete the state file, run gen and
//      `check --fast`, print the report.
// --dry-run stops after the fetch: it prints the plan and writes nothing in the worktree.
//
// [spec-decided] The fetch uses `--depth 1` only when the tag's commit is not already in the local
// object store: a depth-1 fetch of a commit that is already an ancestor of HEAD (clone-derived
// repos) marks it shallow and truncates the visible history.
// [spec-decided] A downgrade (target older than the locked tag) is refused; the same tag is allowed
// (re-applies and re-reports kept conflicts).
// [spec-decided] Exit: 6 on conflicts without --force/--keep; else gen's exit if non-zero; else 1 if
// `check --fast` fails (with --keep, CHK-16 is red on purpose for the kept conflicts); else 0.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from '../kit/json.mjs';
import { fromPosix, writeFileAtomic, exists } from '../lib/fsx.mjs';
import { git, runGit, gitPath, lsRemoteTag } from '../lib/git.mjs';
import { compileOwnership, parseOwnership } from '../lib/ownership.mjs';
import { hashFile, lockHash } from '../lib/hash.mjs';
import {
  ROWS, SELF_PATHS, compareTags, decide, exampleIncluded, exampleOf, highestStableTag, isSelfPath,
  parseTag, readLock, repoFiles, requireGitRoot, tagsFromLsRemote, writeLock,
} from '../lib/lock.mjs';

export const name = 'base-update';
export const summary = 'Pull a newer base tag into this derived repo (file copy, conflict-safe).';
export const usage = 'mb base-update [--to vX.Y.Z] [--force|--keep] [--no-workflows] [--continue] [--dry-run]';
export const options = {
  to: { type: 'string' },
  force: { type: 'boolean' },
  keep: { type: 'boolean' },
  'no-workflows': { type: 'boolean' },
  continue: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
};

export const REPORT_TITLE = 'base-update report';
const STATE_NAME = 'mb-update.json';
const WORKFLOW_RE = /^\.github\/workflows\/mb-[^/]*\.yml$/;
const MIGRATION_RE = /^(\d+\.\d+\.\d+)\.mjs$/;

// ---------- git helpers ----------

/** Map path -> { mode, type, sha } of every entry of <commit> (recursive). */
function lsTree(root, commit) {
  const out = git(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: root });
  const map = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    map.set(rec.slice(tab + 1), { mode, type, sha });
  }
  return map;
}

/** Read many blobs with one `git cat-file --batch`. Returns Map sha -> Buffer. */
function readBlobs(root, shas) {
  const uniq = [...new Set(shas)];
  const map = new Map();
  if (!uniq.length) return map;
  const r = runGit(['cat-file', '--batch'], { cwd: root, input: Buffer.from(uniq.join('\n') + '\n'), encoding: 'buffer' });
  if (r.code !== 0) throw Object.assign(new Error(`git cat-file failed: ${r.stderr}`), { exitCode: 1 });
  const buf = r.stdout;
  let pos = 0;
  for (const sha of uniq) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    if (header[1] === 'missing') throw Object.assign(new Error(`object ${sha} is missing`), { exitCode: 1 });
    const size = Number(header[2]);
    map.set(sha, buf.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1; // content is followed by "\n"
  }
  return map;
}

function hasCommit(root, sha) {
  return Boolean(sha) && runGit(['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).code === 0;
}

/** Hash of the worktree file, or null when absent. A directory at the path is 'DIR' (never equal). */
function currentHash(root, rel) {
  const abs = fromPosix(root, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isDirectory()) return 'DIR';
  return hashFile(abs);
}

// ---------- the plan (shared by --dry-run and --continue) ----------

/**
 * Apply the §14.3 table to lock.files ∪ {B/E paths of <commit>}.
 * Returns [{ path, row, action, conflict, lockHash, entry }] sorted by path.
 */
function computePlan({ root, lock, commit, tree, pre, flags }) {
  const ownBytes = tree.has('.mb/ownership.json') ? readBlobs(root, [tree.get('.mb/ownership.json').sha]).get(tree.get('.mb/ownership.json').sha) : null;
  if (!ownBytes) throw Object.assign(new Error(`${commit} has no .mb/ownership.json; not a marketplace-base commit`), { exitCode: 1 });
  const classify = compileOwnership(parseOwnership(ownBytes));
  let includeExamples = true;
  try {
    includeExamples = parse(fs.readFileSync(path.join(root, 'marketplace.config.json'))).includeExamples ?? true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const adopted = new Set(lock.adopted ?? []);

  const universe = new Set(Object.keys(lock.files));
  for (const [p, ent] of tree) {
    const cls = classify(p);
    if ((cls === 'B' || cls === 'E') && ent.type !== 'tree') universe.add(p);
  }
  const blobsWanted = [];
  for (const p of universe) {
    const ent = tree.get(p);
    const cls = classify(p);
    if (ent && ent.type === 'blob' && (cls === 'B' || cls === 'E')) blobsWanted.push(ent.sha);
  }
  const blobs = readBlobs(root, blobsWanted);

  const plan = [];
  for (const p of [...universe].sort()) {
    const ent = tree.get(p);
    const cls = classify(p);
    const newBE = ent && (cls === 'B' || cls === 'E');
    if (newBE && ent.type !== 'blob') {
      throw Object.assign(new Error(`${p} in ${commit} is a ${ent.type}; base-update copies regular files only`), { exitCode: 1 });
    }
    if (newBE && ent.mode === '120000') {
      throw Object.assign(new Error(`${p} in ${commit} is a symlink; base-update refuses symlinks`), { exitCode: 1 });
    }
    const ex = exampleOf(p);
    const skipExample = ex !== null && (adopted.has(ex) || !exampleIncluded(includeExamples, ex));
    const N = newBE ? lockHash(blobs.get(ent.sha)) : null;
    const L = Object.hasOwn(lock.files, p) ? lock.files[p] : null;
    const C = Object.hasOwn(pre, p) ? pre[p] : currentHash(root, p);
    const d = decide({
      skipExample,
      workflowHeld: Boolean(flags.noWorkflows) && WORKFLOW_RE.test(p),
      N, T: Boolean(ent), L, C, force: Boolean(flags.force),
    });
    plan.push({ path: p, ...d, entry: ent });
  }
  return plan;
}

function printPlan(ctx, plan) {
  ctx.stdout('plan (row, action, path):\n');
  for (const it of plan) ctx.stdout(`  row ${it.row}  ${it.action.padEnd(7)}  ${it.path}  # ${ROWS[it.row]}\n`);
}

// ---------- phase 1 ----------

async function phaseOne(ctx, root, lock, flags, statePath) {
  if (exists(statePath)) {
    throw ctx.fail(2, `an update is in progress (state file ${statePath}). Run "./mb base-update --continue" to finish it, or discard it: git reset --hard && git clean -fd, then delete that file`);
  }
  const url = lock.base.url;
  let tag = flags.to;
  if (tag === undefined) {
    const r = runGit(['ls-remote', '--tags', url], { cwd: root });
    if (r.code !== 0) throw ctx.fail(1, `cannot list the tags of ${url}: ${r.stderr.trim()}`);
    tag = highestStableTag(tagsFromLsRemote(r.stdout));
    if (!tag) throw ctx.fail(1, `${url} has no stable vX.Y.Z tag`);
  } else if (!parseTag(tag)) {
    throw ctx.usageError(`--to ${tag}: expected a vX.Y.Z tag`);
  }
  if (compareTags(tag, lock.base.tag) < 0) {
    throw ctx.fail(2, `${tag} is older than the locked base ${lock.base.tag}; downgrades are not supported`);
  }

  if (!flags.dryRun) {
    const st = git(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root });
    const dirty = st.split('\0').filter(Boolean);
    if (dirty.length) {
      throw ctx.fail(2, `the working tree is not clean; commit or stash first:\n  ${dirty.slice(0, 20).join('\n  ')}${dirty.length > 20 ? `\n  ... ${dirty.length - 20} more` : ''}`);
    }
  }

  // Snapshot BEFORE any checkout.
  const pre = {};
  for (const f of Object.keys(lock.files)) pre[f] = currentHash(root, f);

  const selfProblems = [];
  if (!flags.force) {
    for (const f of Object.keys(lock.files)) {
      if (isSelfPath(f) && pre[f] !== lock.files[f]) selfProblems.push(`${f} (${pre[f] === null ? 'deleted' : 'edited'})`);
    }
    for (const f of repoFiles(root)) {
      if (isSelfPath(f) && !Object.hasOwn(lock.files, f)) selfProblems.push(`${f} (local file, no lock entry)`);
    }
    if (selfProblems.length) {
      throw ctx.fail(6, `edited or local files in the base tooling (${SELF_PATHS.join(', ')}); nothing was changed. Revert them or upstream them to the base, or use --force to overwrite:\n  ${selfProblems.join('\n  ')}`);
    }
  }

  const peeled = lsRemoteTag(root, url, tag);
  if (!peeled) throw ctx.fail(1, `tag ${tag} not found at ${url}`);
  const fetchArgs = ['fetch', '--no-tags', ...(hasCommit(root, peeled) ? [] : ['--depth', '1']), url, `refs/tags/${tag}`];
  const fr = runGit(fetchArgs, { cwd: root });
  if (fr.code !== 0) throw ctx.fail(1, `git ${fetchArgs.join(' ')} failed: ${fr.stderr.trim()}`);
  const commit = git(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: root });
  ctx.stdout(`base ${tag} -> ${commit}\n`);
  const tree = lsTree(root, commit);

  // An ignored local file at a SELF path the commit brings would be overwritten silently by checkout.
  if (!flags.force) {
    for (const p of tree.keys()) {
      if (isSelfPath(p) && !Object.hasOwn(lock.files, p) && currentHash(root, p) !== null) selfProblems.push(`${p} (local file, no lock entry)`);
    }
    if (selfProblems.length) {
      throw ctx.fail(6, `local files at base tooling paths; nothing was changed. Move them away, or use --force:\n  ${selfProblems.join('\n  ')}`);
    }
  }

  if (flags.dryRun) {
    const plan = computePlan({ root, lock, commit, tree, pre, flags });
    printPlan(ctx, plan);
    const conflicts = plan.filter((p) => p.conflict).length;
    ctx.stdout(`dry run: ${lock.base.tag} -> ${tag}; ${plan.filter((p) => ['write', 'delete'].includes(p.action)).length} file(s) would change, ${conflicts} conflict(s); nothing was written\n`);
    return 0;
  }

  fs.writeFileSync(statePath, JSON.stringify({ tag, commit, pre }) + '\n');
  const pathspecs = SELF_PATHS.filter((s) => [...tree.keys()].some((p) => p === s || p.startsWith(s + '/')));
  git(['checkout', commit, '--', ...pathspecs], { cwd: root });
  ctx.stdout(`checked out the base tooling (${pathspecs.join(' ')}); continuing with it\n`);

  // Re-run with the NEW tooling in a fresh process (an in-process import would reuse cached modules).
  const childArgs = [path.join(root, 'tools', 'mb.mjs'), 'base-update', '--to', tag, '--continue'];
  if (flags.force) childArgs.push('--force');
  if (flags.keep) childArgs.push('--keep');
  if (flags.noWorkflows) childArgs.push('--no-workflows');
  const r = spawnSync(process.execPath, childArgs, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw r.error;
  if (r.stdout) ctx.stdout(r.stdout);
  if (r.stderr) ctx.stderr(r.stderr);
  return r.status ?? 1;
}

// ---------- phase 2 ----------

function removeEmptyParents(root, rel) {
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const dir = fromPosix(root, parts.slice(0, i).join('/'));
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
  }
}

async function runMigrations(ctx, root, fromTag, toTag) {
  const dir = path.join(root, '.mb', 'migrations');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no migrations */ }
  const versions = names
    .map((n) => MIGRATION_RE.exec(n))
    .filter(Boolean)
    .map((m) => ({ file: m[0], tag: `v${m[1]}` }))
    .filter((m) => compareTags(m.tag, fromTag) > 0 && compareTags(m.tag, toTag) <= 0)
    .sort((a, b) => compareTags(a.tag, b.tag));
  const out = [];
  for (const m of versions) {
    const mod = await import(pathToFileURL(path.join(dir, m.file)).href);
    const fn = typeof mod.default === 'function' ? mod.default : mod.migrate;
    if (typeof fn !== 'function') throw ctx.fail(1, `.mb/migrations/${m.file} exports no default function`);
    let edited;
    try {
      edited = await fn({ root, fromTag, toTag, version: m.tag });
    } catch (e) {
      throw ctx.fail(1, `migration ${m.file} failed: ${e && e.message}. Fix it, then run ./mb base-update --continue`);
    }
    out.push({ version: m.tag, edited: Array.isArray(edited) ? edited.map(String).sort() : [] });
  }
  return out;
}

async function phaseTwo(ctx, root, lock, flags, statePath) {
  if (!exists(statePath)) throw ctx.fail(2, `no update in progress (no ${statePath}); run ./mb base-update without --continue`);
  const state = parse(fs.readFileSync(statePath));
  const { tag, commit, pre } = state;
  if (!parseTag(tag) || !/^[0-9a-f]{40}$/.test(String(commit)) || !pre || typeof pre !== 'object') {
    throw ctx.fail(3, `${statePath} is malformed; discard the update (git reset --hard && git clean -fd) and delete it`);
  }
  if (flags.to !== undefined && flags.to !== tag) throw ctx.usageError(`--to ${flags.to} does not match the update in progress (${tag})`);
  if (!hasCommit(root, commit)) throw ctx.fail(1, `commit ${commit} of ${tag} is not in the object store; discard the update and start again`);

  let version = 'unknown';
  try { version = parse(fs.readFileSync(path.join(root, '.mb', 'base-version.json'))).version; } catch { /* reported as unknown */ }
  ctx.stdout(`continuing base-update with tooling ${version} (${tag} ${commit})\n`);

  const tree = lsTree(root, commit);
  const plan = computePlan({ root, lock, commit, tree, pre, flags });

  // Validate every write target before the first write.
  const blocked = [];
  for (const it of plan) {
    if (it.action !== 'write') continue;
    const parts = it.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const anc = fromPosix(root, parts.slice(0, i).join('/'));
      try {
        if (!fs.lstatSync(anc).isDirectory()) blocked.push(`${it.path} (${parts.slice(0, i).join('/')} is a file)`);
      } catch { /* absent: will be created */ }
    }
    try {
      if (fs.lstatSync(fromPosix(root, it.path)).isDirectory()) blocked.push(`${it.path} (is a directory)`);
    } catch { /* absent */ }
  }
  if (blocked.length) throw ctx.fail(1, `cannot write base files over local paths; nothing was written. Move these away, then run ./mb base-update --continue:\n  ${blocked.join('\n  ')}`);

  const writes = plan.filter((p) => p.action === 'write');
  const blobs = readBlobs(root, writes.map((w) => w.entry.sha));
  for (const w of writes) {
    const abs = fromPosix(root, w.path);
    writeFileAtomic(abs, blobs.get(w.entry.sha));
    if (process.platform !== 'win32') fs.chmodSync(abs, w.entry.mode === '100755' ? 0o755 : 0o644);
  }
  for (const d of plan.filter((p) => p.action === 'delete')) {
    try { fs.unlinkSync(fromPosix(root, d.path)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    removeEmptyParents(root, d.path);
  }

  const migrations = await runMigrations(ctx, root, lock.base.tag, tag);

  const files = {};
  for (const it of plan) if (it.lockHash !== null) files[it.path] = it.lockHash;
  writeLock(root, { base: { url: lock.base.url, tag, commit }, files, adopted: lock.adopted });
  fs.unlinkSync(statePath);

  const by = (pred) => plan.filter(pred).map((p) => p.path);
  const changed = by((p) => p.action === 'write');
  const deleted = by((p) => p.action === 'delete');
  const released = by((p) => p.row === 6);
  const conflicts = plan.filter((p) => p.conflict);
  const held = by((p) => p.row === 2);

  ctx.stdout('\n$ ./mb gen\n');
  const genCode = await ctx.runCommand('gen', []);
  ctx.stdout('\n$ ./mb check --fast\n');
  const checkCode = genCode ? null : await ctx.runCommand('check', ['--fast']);

  const list = (title, arr) => ctx.stdout(`${title} (${arr.length})${arr.length ? ':\n  ' + arr.join('\n  ') : ''}\n`);
  ctx.stdout(`\n${REPORT_TITLE}: ${lock.base.tag} -> ${tag} (${commit})\n`);
  list('changed', changed);
  list('deleted', deleted);
  list('released (no longer base-owned; now yours)', released);
  if (flags.noWorkflows) list('workflows left untouched (--no-workflows)', held);
  list(`conflicts${flags.force ? ' (overwritten by --force)' : flags.keep ? ' (kept by --keep)' : ' (left untouched)'}`,
    conflicts.map((c) => `${c.path}  # row ${c.row}: ${ROWS[c.row]}`));
  ctx.stdout(`migrations run (${migrations.length})${migrations.map((m) => `\n  ${m.version}: edited ${m.edited.join(', ') || '(no files)'}`).join('')}\n`);

  if (conflicts.length && !flags.force && !flags.keep) {
    ctx.stderr(`mb base-update: ${conflicts.length} conflict(s) left untouched. Resolve each one (revert your change, upstream it to the base, or re-run with --force to take the base version, or --keep to keep yours), then commit\n`);
    return 6;
  }
  if (genCode) return genCode;
  if (checkCode) {
    if (flags.keep && conflicts.length) ctx.stderr('mb base-update: ./mb check is red: CHK-16 stays red on purpose for the kept conflicts until they are resolved\n');
    return checkCode;
  }
  return 0;
}

export async function run(argv, ctx) {
  const v = ctx.args.values;
  if (ctx.args.positionals.length) throw ctx.usageError(`unexpected argument "${ctx.args.positionals[0]}"`);
  if (v.force && v.keep) throw ctx.usageError('--force and --keep are mutually exclusive');
  if (v.continue && v['dry-run']) throw ctx.usageError('--dry-run cannot be combined with --continue');
  const flags = { to: v.to, force: v.force, keep: v.keep, noWorkflows: v['no-workflows'], dryRun: v['dry-run'] };
  const root = ctx.root;
  if (ctx.isBase()) throw ctx.usageError('base-update runs in a derived repo (this repo has no .mb-lock.json; run ./mb init first)');
  requireGitRoot(root, 'base-update');
  const lock = readLock(root);
  const statePath = gitPath(root, STATE_NAME);
  return v.continue ? phaseTwo(ctx, root, lock, flags, statePath) : phaseOne(ctx, root, lock, flags, statePath);
}
