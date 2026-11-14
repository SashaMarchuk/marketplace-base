// CHK-15: version bump required. Non-G files of a plugin (excluding evals/**
// and README.md) changed since the comparison commit while src.version did not increase.
// Comparison commit = merge-base(<ref>, HEAD), ref = --base or origin/<default-branch>. With
// `--base HEAD^1` (push to the default branch) that is the first parent. Skipped (info) only when the
// commit cannot be computed. Changes = `git diff <commit>` against the worktree, plus untracked files.
// Changes under `_mb/` alone never require a bump (it is generated).
import { parse } from '../../kit/json.mjs';
import { runGit, showFile } from '../git.mjs';

export const id = 'CHK-15';
export const severity = 'error';
export const title = 'Non-G files of a plugin (excluding `evals/**` and `README.md`) changed while `src.version` did not increase. Compared against merge-base(`--base`, default `origin/<default-branch>`); with `--base HEAD^1` (push to the default branch) the first parent. Skipped (I) only when that commit cannot be computed';
export const fix = './mb bump <p>';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function cmpVersion(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  return 0;
}

function defaultRef(root) {
  const head = runGit(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const r of ['origin/main', 'origin/master']) {
    if (runGit(['rev-parse', '--verify', '-q', `${r}^{commit}`], { cwd: root }).code === 0) return r;
  }
  return null;
}

export function run(rctx) {
  if (!rctx.git) return [{ path: '.', severity: 'info', message: 'skipped: not a git work tree' }];
  const ref = rctx.opts.base ?? defaultRef(rctx.root);
  const mb = ref && runGit(['merge-base', ref, 'HEAD'], { cwd: rctx.root });
  if (!mb || mb.code !== 0) {
    return [{ path: '.', severity: 'info', message: `skipped: no comparison commit (${ref ? `merge-base ${ref} HEAD failed` : 'no --base and no origin default branch'})`, fix: 'pass --base <ref>' }];
  }
  const commit = mb.stdout.trim();
  const out = [];
  for (const p of rctx.plugins) {
    const d = runGit(['diff', '--name-only', '-z', commit, '--', p.dir], { cwd: rctx.root });
    if (d.code !== 0) throw new Error(`git diff failed: ${d.stderr.trim()}`);
    const changed = new Set(d.stdout.split('\0').filter(Boolean));
    for (const f of rctx.files) if (f.startsWith(p.dir + '/') && !rctx.tracked(f)) changed.add(f);
    const relevant = [...changed].filter((f) =>
      rctx.classify(f) !== 'G' && !f.startsWith(`${p.dir}/evals/`) && f !== `${p.dir}/README.md`).sort();
    if (!relevant.length) continue;
    const oldBytes = showFile(rctx.root, commit, `${p.dir}/plugin.src.json`);
    if (!oldBytes) continue; // a new plugin (or a newly adopted one): nothing to compare
    let oldVersion;
    try { oldVersion = parse(oldBytes).version; } catch { continue; }
    const newVersion = p.src?.version;
    const c = cmpVersion(String(newVersion), String(oldVersion));
    if (c === null) continue; // CHK-03 reports a bad version
    if (c <= 0) {
      out.push({
        path: `${p.dir}/plugin.src.json`,
        message: `${relevant.length} file(s) changed since ${commit.slice(0, 12)} (e.g. ${relevant[0]}) but version ${newVersion} did not increase from ${oldVersion}`,
        fix: `./mb bump ${p.name}`,
      });
    }
  }
  return out;
}
