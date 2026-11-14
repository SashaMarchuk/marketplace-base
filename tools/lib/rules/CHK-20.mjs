// CHK-20: leak scan (SPEC section 12).
// 1. Built-in secret patterns over every repo file (tracked + untracked, not ignored).
// 2. Home-path patterns over spikes/**, tools/tests/fixtures/** and dist/evals/** (captured host output;
//    dist/ is gitignored, so dist/evals is only seen when mb-evals.yml runs this rule over it).
// 3. A PRIVATE denylist (one regex per line, case-insensitive; blank and "#" lines skipped), read from
//    $MB_LEAK_DENYLIST (a path outside the repo) or else the gitignored local .mb/leak-denylist.txt.
//    It is never read from a committed file: a tracked .mb/leak-denylist.txt is itself an error.
//    Denylist hits never print the pattern or the matched text (CI logs are public).
//    A line starting with "!" is an ALLOW pattern: its matches are removed from a line before the
//    deny patterns run (the line itself is still scanned), e.g. the public repo URL or owner handle.
// 4. `gitleaks dir` when gitleaks is on PATH.
// Fail closed: an unreadable denylist or an invalid pattern is an error, never "clean".
// A line with `mb-allow-leak: <reason>` is exempt from the built-in and home-path patterns only.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isIgnored } from '../git.mjs';

export const id = 'CHK-20';
export const severity = 'error';
export const title = 'Leak scan: built-in secret regexes (private keys, `ghp_`, `sk-`, `xox[bp]-`, AWS keys, JWT-shaped tokens); home-path regexes (`/Users/<x>/`, `/home/<x>/`, `C:\\Users\\<x>\\`) over `spikes/**`, `tools/tests/fixtures/**` and (in `mb-evals.yml`) `dist/evals/**`; a private denylist (one regex per line; `!<regex>` lines are allow-substrings removed before matching) from `$MB_LEAK_DENYLIST` (outside the repo) or the gitignored local `.mb/leak-denylist.txt`, never from a committed file (a tracked `.mb/leak-denylist.txt` is itself an error); `gitleaks dir` if installed. A bad pattern is a failure, never "clean". A line containing `mb-allow-leak: <reason>` is exempt from the built-in patterns';
export const fix = 'remove, or add an allowlist with reason';

const LOCAL_DENYLIST = '.mb/leak-denylist.txt';

// [label, regex]. Written so that no pattern source matches itself.
export const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['sk- API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[bpoas]-[A-Za-z0-9-]{10,}/],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['AWS secret key', /aws_?secret_?access_?key["'\s:=]+[A-Za-z0-9/+]{40}\b/i],
  ['JWT-shaped token', /eyJ[\w-]{10,}\.[\w-]{10,}/],
];

export const HOME_PATTERNS = [
  ['macOS home path', /\/Users\/[^/\s"'`]+\//],
  ['Linux home path', /\/home\/[^/\s"'`]+\//],
  ['Windows home path', /[A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\)[^\\\s"'`]+(?:\\\\|\\)/],
];

const ALLOW_RE = /mb-allow-leak:\s*\S/;
const HOME_SCOPE = /^(spikes|tools\/tests\/fixtures|dist\/evals)\//;

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** Load the private denylist. Returns { patterns, source } or throws a result-shaped error. */
function loadDenylist(rctx, out) {
  const envPath = rctx.env.MB_LEAK_DENYLIST;
  let file = null, label = null;
  if (envPath) {
    file = path.resolve(envPath);
    label = '$MB_LEAK_DENYLIST';
    const rootReal = fs.realpathSync.native(rctx.root);
    let real = file;
    try { real = fs.realpathSync.native(file); } catch { /* reported below */ }
    const rel = path.relative(rootReal, real);
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (inside && rctx.git && !isIgnored(rctx.root, rel.split(path.sep).join('/'))) {
      out.push({ path: '.', message: '$MB_LEAK_DENYLIST points to a file inside the repo that is not gitignored; keep the denylist outside the repo' });
      return [];
    }
  } else if (rctx.exists(LOCAL_DENYLIST)) {
    file = rctx.abs(LOCAL_DENYLIST);
    label = LOCAL_DENYLIST;
  } else {
    return [];
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    out.push({ path: '.', message: `cannot read the private denylist (${label}): ${e.code ?? e.message}` });
    return null;
  }
  const patterns = [];
  patterns.allow = [];
  text.split(/\r?\n/).forEach((line, n) => {
    if (/^\s*(#.*)?$/.test(line)) return;
    try {
      if (line.startsWith('!')) patterns.allow.push(new RegExp(line.slice(1), 'gi'));
      else patterns.push({ n: n + 1, re: new RegExp(line, 'i') });
    } catch {
      out.push({ path: '.', message: `invalid pattern on line ${n + 1} of the private denylist (${label})` });
      patterns.bad = true;
    }
  });
  return patterns.bad ? null : patterns;
}

function runGitleaks(rctx, out) {
  const r = spawnSync('gitleaks', ['dir', rctx.root, '--no-banner', '--redact', '--log-level', 'error', '--exit-code', '1'], {
    env: rctx.env, encoding: 'utf8', windowsHide: true,
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') return; // not installed: optional
    out.push({ path: '.', message: `gitleaks failed to run: ${r.error.message}` });
  } else if (r.status === 1) {
    out.push({ path: '.', message: 'gitleaks reported findings (run: gitleaks dir . -v)' });
  } else if (r.status !== 0) {
    out.push({ path: '.', message: `gitleaks exited ${r.status}: ${String(r.stderr).trim().split('\n')[0]}` });
  }
}

export function run(rctx) {
  const out = [];
  if (rctx.tracked(LOCAL_DENYLIST)) {
    out.push({ path: LOCAL_DENYLIST, message: 'the private denylist is committed; remove it from git (git rm --cached) and keep it gitignored' });
  }
  const deny = loadDenylist(rctx, out);
  if (deny === null) return out; // fail closed: no scan result can be trusted

  for (const rel of rctx.files) {
    if (rel === LOCAL_DENYLIST) continue;
    let buf;
    try { buf = rctx.readBytes(rel); } catch { continue; } // e.g. a dangling symlink (CHK-08)
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    const homeScope = HOME_SCOPE.test(rel);
    lines.forEach((line, i) => {
      const where = `${rel}:${i + 1}`;
      if (!ALLOW_RE.test(line)) {
        for (const [label, re] of SECRET_PATTERNS) if (re.test(line)) out.push({ path: rel, message: `${where}: ${label}` });
        if (homeScope) for (const [label, re] of HOME_PATTERNS) if (re.test(line)) out.push({ path: rel, message: `${where}: ${label}` });
      }
      const stripped = (deny.allow ?? []).reduce((l, a) => l.replace(a, ''), line);
      for (const p of deny) {
        if (p.re.test(stripped)) out.push({ path: rel, message: `${where}: matches private denylist pattern #${p.n}` });
      }
    });
  }
  // File names are content too.
  for (const rel of rctx.files) {
    const stripped = (deny.allow ?? []).reduce((l, a) => l.replace(a, ''), rel);
    for (const p of deny) if (p.re.test(stripped)) out.push({ path: rel, message: `file name matches private denylist pattern #${p.n}` });
  }
  runGitleaks(rctx, out);
  return out;
}

