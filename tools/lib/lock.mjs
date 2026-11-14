// tools/lib/lock.mjs: `.mb-lock.json` and the pure parts of `mb init` / `mb base-update` (SPEC §14).
//
// API:
//   readLock(root) -> lock             strict parse + lock.schema.json; throws exitCode 3 when invalid
//   writeLock(root, { base, files, adopted }) writes canonical pretty JSON (sorted keys, lockVersion 1)
//   SELF_PATHS, isSelfPath(rel)        the permanent B paths checked out first by base-update (§14.3)
//   parseTag(tag) / compareTags(a, b) / isStableTag(tag) / highestStableTag(tags)   semver helpers
//   tagsFromLsRemote(stdout) -> [tag]  names of refs/tags/v* in `git ls-remote --tags` output
//   exampleOf(rel) -> <p> | null       plugin name of an `examples/plugins/<p>/...` path
//   exampleIncluded(includeExamples, p)  true | false | [names]; missing means true
//   repoFiles(root) -> [rel]           tracked + untracked-not-ignored files (git), else a plain walk
//   requireGitRoot(root, fail)         refuses a root that is not the top level of its own git repo
//   decide(input) -> { row, action, lockHash }   the §14.3 decision table, one path at a time
//   ROWS                               human text of each table row (used by the --dry-run plan)

import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../kit/json.mjs';
import { writeJson, walk } from './fsx.mjs';
import { runGit, gitRoot } from './git.mjs';
import { LOCK_FILE } from './ownership.mjs';
import { validate, loadSchema } from './schema-lite.mjs';

function exitError(code, msg) {
  const e = new Error(msg);
  e.exitCode = code;
  return e;
}

export function readLock(root) {
  const abs = path.join(root, LOCK_FILE);
  let lock;
  try {
    lock = parse(fs.readFileSync(abs));
  } catch (e) {
    if (e.code === 'ENOENT') throw exitError(2, `${LOCK_FILE} not found: this is not a derived repo (run ./mb init first)`);
    if (e.name === 'JsonError') throw exitError(3, `${LOCK_FILE}:${e.line}:${e.column}: ${e.detail ?? e.message}`);
    throw e;
  }
  const bad = validate(loadSchema(root, 'lock'), lock);
  if (bad.length) throw exitError(3, `${LOCK_FILE} is invalid: ${bad.map((b) => `${b.path || '/'} ${b.message}`).join('; ')}`);
  return lock;
}

export function writeLock(root, { base, files, adopted }) {
  const sortedFiles = {};
  for (const k of Object.keys(files).sort()) sortedFiles[k] = files[k];
  writeJson(path.join(root, LOCK_FILE), {
    adopted: [...new Set(adopted ?? [])].sort(),
    base: { url: base.url, tag: base.tag, commit: base.commit ?? null },
    files: sortedFiles,
    lockVersion: 1,
  });
}

// Permanent B paths (SPEC §14.3 SELF). base-update checks them out BEFORE the decision table so
// that the rest of the update runs with the new tooling; they therefore get the strict guard.
export const SELF_PATHS = Object.freeze(['tools', '.mb/ownership.json', '.mb/base-version.json', '.mb/migrations', 'mb', 'mb.cmd']);

export function isSelfPath(rel) {
  return SELF_PATHS.some((p) => rel === p || rel.startsWith(p + '/'));
}

const TAG_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/;

export function parseTag(tag) {
  const m = TAG_RE.exec(String(tag));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

export function isStableTag(tag) {
  const t = parseTag(tag);
  return Boolean(t) && t.pre === null;
}

/** Semver order: numeric parts, then a release sorts above its pre-releases, then pre-release ids. */
export function compareTags(a, b) {
  const x = parseTag(a), y = parseTag(b);
  if (!x || !y) throw new Error(`not a version tag: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xs = x.pre.split('.'), ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const xn = /^\d+$/.test(xs[i]), yn = /^\d+$/.test(ys[i]);
    if (xn && yn && Number(xs[i]) !== Number(ys[i])) return Number(xs[i]) < Number(ys[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

/** Highest stable tag; pre-release tags (v1.3.0-rc.1) are never "latest" (SPEC §14.3). */
export function highestStableTag(tags) {
  let best = null;
  for (const t of tags) if (isStableTag(t) && (best === null || compareTags(t, best) > 0)) best = t;
  return best;
}

export function tagsFromLsRemote(stdout) {
  const out = new Set();
  for (const line of String(stdout).split('\n')) {
    const m = /\trefs\/tags\/(v[^\s^]+)(?:\^\{\})?$/.exec(line.trim());
    if (m && parseTag(m[1])) out.add(m[1]);
  }
  return [...out];
}

export function exampleOf(rel) {
  const m = /^examples\/plugins\/([^/]+)\//.exec(rel);
  return m ? m[1] : null;
}

export function exampleIncluded(includeExamples, p) {
  if (includeExamples === undefined || includeExamples === true) return true;
  if (includeExamples === false) return false;
  return Array.isArray(includeExamples) && includeExamples.includes(p);
}

/**
 * Files of the worktree as POSIX rel paths: tracked plus untracked-not-ignored (so a stray ignored
 * `.DS_Store` never counts). Outside a git repo: every file (walk).
 */
export function repoFiles(root) {
  if (gitRoot(root) && sameDir(gitRoot(root), root)) {
    const r = runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
    if (r.code === 0) {
      const files = [...new Set(r.stdout.split('\0').filter(Boolean))];
      // A tracked file deleted from the worktree is not a worktree file.
      return files.filter((f) => fs.existsSync(path.join(root, ...f.split('/')))).sort();
    }
  }
  return walk(root);
}

export function sameDir(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/** base-update works on the top level of a git repo only (never on an enclosing repo). */
export function requireGitRoot(root, what) {
  const top = gitRoot(root);
  if (!top) throw exitError(2, `${what} needs a git repository at ${root} (git init; git add -A; git commit first)`);
  if (!sameDir(top, root)) {
    throw exitError(2, `${what}: the marketplace must be the top level of its git repository (found ${top}); refusing to act on an enclosing repo`);
  }
}

export const ROWS = Object.freeze({
  1: 'skip: adopted or not-included example',
  2: 'leave untouched (--no-workflows)',
  3: 'up to date',
  4: 'write base version',
  5: 'CONFLICT: local change at a base path',
  6: 'released: no longer base-owned, left in place',
  7: 'delete: removed upstream',
  8: 'CONFLICT: edited locally, removed upstream',
});

/**
 * SPEC §14.3 decision table for ONE path (first matching row wins).
 * input: { skipExample, workflowHeld, N, T, L, C, force }
 *   N: hash of <commit>:f when f is B/E under the new ownership, else null
 *   T: f exists in the <commit> tree (any class)
 *   L: lock hash or null;  C: current hash, or null when ABSENT
 * returns { row, action: 'skip'|'hold'|'none'|'write'|'delete'|'release', conflict, lockHash }
 *   lockHash null means "no entry afterwards".
 */
export function decide({ skipExample, workflowHeld, N, T, L, C, force }) {
  if (skipExample) return { row: 1, action: 'skip', conflict: false, lockHash: null };
  if (workflowHeld) return { row: 2, action: 'hold', conflict: false, lockHash: L };
  if (N !== null) {
    if (C === N) return { row: 3, action: 'none', conflict: false, lockHash: N };
    if ((L !== null && C === L) || (L === null && C === null)) return { row: 4, action: 'write', conflict: false, lockHash: N };
    return force
      ? { row: 5, action: 'write', conflict: true, lockHash: N }
      : { row: 5, action: 'hold', conflict: true, lockHash: L };
  }
  if (T) return { row: 6, action: 'release', conflict: false, lockHash: null };
  if (C === L || C === null) return { row: 7, action: C === null ? 'none' : 'delete', conflict: false, lockHash: null };
  return force
    ? { row: 8, action: 'delete', conflict: true, lockHash: null }
    : { row: 8, action: 'hold', conflict: true, lockHash: L };
}
