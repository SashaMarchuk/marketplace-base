// tools/lib/git.mjs: thin wrapper around the git CLI. No shell is ever used (argument arrays only).
//
// API:
//   runGit(args, { cwd, input, encoding }) -> { code, stdout, stderr }
//        never throws for a non-zero exit; stdout is a string (encoding 'utf8', default) or a
//        Buffer (encoding 'buffer'). Throws MissingToolError (exitCode 7) when git is not installed.
//   git(args, opts) -> stdout (trailing newline trimmed for strings)
//        throws GitError { exitCode: 1, code, stderr, args } on a non-zero exit.
//   hasGit() -> bool
//   gitRoot(cwd) -> absolute native path | null   (`git rev-parse --show-toplevel`)
//   gitPath(cwd, name) -> absolute path           (`git rev-parse --git-path <name>`, made absolute)
//   isIgnored(cwd, relPath) -> bool               (`git check-ignore -q`)
//   lsFiles(cwd, args?) -> [POSIX rel paths]      (`git ls-files -z`)
//   showFile(cwd, rev, relPath) -> Buffer | null  (`git show <rev>:<path>`; null if absent)
//   lsRemoteTag(cwd, url, tag) -> commit | null   (prefers the peeled `^{}` line)
//
// Errors carry a numeric `exitCode`, which tools/mb.mjs maps to the process exit code.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export class MissingToolError extends Error {
  constructor(tool) {
    super(`required external tool missing: ${tool}`);
    this.name = 'MissingToolError';
    this.exitCode = 7;
    this.tool = tool;
  }
}

export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args.join(' ')} failed (exit ${code}): ${String(stderr).trim()}`);
    this.name = 'GitError';
    this.exitCode = 1;
    this.code = code;
    this.stderr = stderr;
    this.args = args;
  }
}

export function runGit(args, opts = {}) {
  const encoding = opts.encoding ?? 'utf8';
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: encoding === 'buffer' ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    env: opts.env ?? process.env,
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new MissingToolError('git');
    throw r.error;
  }
  return { code: r.status ?? 1, stdout: r.stdout, stderr: String(r.stderr ?? '') };
}

export function git(args, opts = {}) {
  const r = runGit(args, opts);
  if (r.code !== 0) throw new GitError(args, r.code, r.stderr);
  return typeof r.stdout === 'string' ? r.stdout.replace(/\r?\n$/, '') : r.stdout;
}

export function hasGit() {
  try {
    return runGit(['--version']).code === 0;
  } catch {
    return false;
  }
}

export function gitRoot(cwd) {
  try {
    const r = runGit(['rev-parse', '--show-toplevel'], { cwd });
    if (r.code !== 0) return null;
    const out = r.stdout.replace(/\r?\n$/, '');
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

export function gitPath(cwd, name) {
  const p = git(['rev-parse', '--git-path', name], { cwd });
  return path.resolve(cwd, p);
}

export function isIgnored(cwd, relPath) {
  return runGit(['check-ignore', '-q', '--', relPath], { cwd }).code === 0;
}

export function lsFiles(cwd, args = []) {
  const out = git(['ls-files', '-z', ...args], { cwd });
  return out.split('\0').filter(Boolean);
}

export function showFile(cwd, rev, relPath) {
  const r = runGit(['show', `${rev}:${relPath}`], { cwd, encoding: 'buffer' });
  return r.code === 0 ? r.stdout : null;
}

export function lsRemoteTag(cwd, url, tag) {
  const r = runGit(['ls-remote', url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd });
  if (r.code !== 0) return null;
  let plain = null, peeled = null;
  for (const line of r.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref === `refs/tags/${tag}^{}`) peeled = sha;
    else if (ref === `refs/tags/${tag}`) plain = sha;
  }
  return peeled ?? plain;
}
