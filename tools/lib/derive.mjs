// tools/lib/derive.mjs: the derive/update proof (`mb test --derive`) and the helpers
// that tools/tests/derive.test.mjs shares with it.
//
// API:
//   hermeticEnv(tmp) -> env           child env: PATH = node + git only (no claude/codex/gitleaks),
//                                     no CI vars, empty global git config, fixed author identity
//   run(cmd, args, { cwd, env, input }) -> { code, stdout, stderr }
//   gitIn(dir, args, env) -> stdout   throws on a non-zero exit
//   mbIn(dir, args, env) -> { code, stdout, stderr }   runs <dir>/tools/mb.mjs in a child process
//   copyTree(src, dst, skip)          recursive copy, skipping top-level-or-nested names in `skip`
//   commitAll(dir, env, msg)
//   deriveTemplateCopy(bareUrl, tag, dir, env)   "Use this template": the tag's files, fresh history
//   scriptedEdits(dir, env)           derive-proof D/S edits (plugin, README text, policy, workflow, adopt)
//   snapshotDS(dir) -> Map rel -> hash   D and S files (hash rule) of a derived repo
//   deriveProof({ root, stdout, stderr }) -> exit code   the derive proof against the base repo at `root`
//
// The proof only READS the base repo at `root` (git clone --bare of its HEAD and tags); every write
// happens in a temp dir, which is removed afterwards (set MB_KEEP_TMP=1 to keep it).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse, canonicalPretty } from '../kit/json.mjs';
import { hashFile } from './hash.mjs';
import { compileOwnership, loadOwnership, LOCK_FILE } from './ownership.mjs';
import { compareTags, highestStableTag, isStableTag, parseTag, repoFiles } from './lock.mjs';

function findOnPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(dir, bin + ext);
      try { if (fs.statSync(f).isFile()) return dir; } catch { /* next */ }
    }
  }
  return null;
}

export function hermeticEnv(tmp) {
  const gitconfig = path.join(tmp, 'empty.gitconfig');
  if (!fs.existsSync(gitconfig)) fs.writeFileSync(gitconfig, '');
  const dirs = [path.dirname(process.execPath), findOnPath('git')].filter(Boolean);
  const env = {
    PATH: [...new Set(dirs)].join(path.delimiter),
    HOME: tmp,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'alice@example.com',
    GIT_COMMITTER_NAME: 'Alice', GIT_COMMITTER_EMAIL: 'alice@example.com',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const k of ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'PATHEXT', 'ComSpec']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export function run(cmd, args, { cwd, env, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function gitIn(dir, args, env) {
  const r = run('git', args, { cwd: dir, env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} (in ${dir}) failed: ${r.stderr}`);
  return r.stdout.replace(/\r?\n$/, '');
}

export function mbIn(dir, args, env) {
  return run(process.execPath, [path.join(dir, 'tools', 'mb.mjs'), ...args], { cwd: dir, env });
}

export function copyTree(src, dst, skip = new Set(['.git', 'node_modules', 'dist', '.DS_Store'])) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(d.name)) continue;
    const s = path.join(src, d.name), t = path.join(dst, d.name);
    if (d.isDirectory()) copyTree(s, t, skip);
    else if (d.isFile()) {
      fs.copyFileSync(s, t);
      fs.chmodSync(t, fs.statSync(s).mode & 0o777);
    }
  }
}

export function commitAll(dir, env, msg) {
  gitIn(dir, ['add', '-A'], env);
  const r = run('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: dir, env });
  if (r.code !== 0) throw new Error(`git commit failed in ${dir}: ${r.stderr}`);
}

export function deriveTemplateCopy(bareUrl, tag, dir, env) {
  gitIn(path.dirname(dir), ['clone', '-q', '--branch', tag, bareUrl, dir], env);
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  gitIn(dir, ['init', '-q', '-b', 'main'], env);
  commitAll(dir, env, `Create from template (${tag})`);
}

export function scriptedEdits(dir, env) {
  const steps = [];
  const must = (r, what) => {
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}):\n${r.stdout}\n${r.stderr}`);
    steps.push(what);
  };
  must(mbIn(dir, ['new', 'skill', 'proof-tools/say-hello', 'Say hello. Use when greeted.'], env), 'new plugin proof-tools');
  const readme = path.join(dir, 'README.md');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace(/\n/, '\n\nOur own intro text, written by the derived repo.\n'));
  steps.push('README intro text');
  fs.mkdirSync(path.join(dir, 'policy', 'teams'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy', 'teams', 'proof.json'), '{\n  "$schema": "../../tools/schemas/layer-file.schema.json"\n}\n');
  steps.push('policy file');
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'local-proof.yml'), 'name: local-proof\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n');
  steps.push('local workflow');
  const exDir = path.join(dir, 'examples', 'plugins');
  const examples = fs.existsSync(exDir) ? fs.readdirSync(exDir).sort() : [];
  if (examples.length) must(mbIn(dir, ['adopt', examples[0]], env), `adopt ${examples[0]}`);
  return steps;
}

export function snapshotDS(dir) {
  const classify = compileOwnership(loadOwnership(dir));
  const out = new Map();
  for (const rel of repoFiles(dir)) {
    const c = classify(rel);
    if (c === 'D' || c === 'S') out.set(rel, hashFile(path.join(dir, ...rel.split('/'))));
  }
  return out;
}

/** Paths of the S files the report says migrations edited. */
export function migrationEdits(report) {
  const out = new Set();
  for (const m of report.matchAll(/^ {2}v\S+: edited (.+)$/gm)) for (const f of m[1].split(', ')) if (f !== '(no files)') out.add(f);
  return out;
}

function nextPatch(tag) {
  const t = parseTag(tag);
  return `v${t.major}.${t.minor}.${t.patch + 1}`;
}

/** The derive proof against the base repo at `root`. Returns 0 when every step passes. */
export async function deriveProof({ root, stdout = (t) => process.stdout.write(t), stderr = (t) => process.stderr.write(t) } = {}) {
  const env0 = process.env;
  if (run('git', ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: root, env: env0 }).code !== 0) {
    stderr('derive proof: the base repo has no commit yet; commit first (the proof uses committed HEAD and tags)\n');
    return 1;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-derive-'));
  const env = hermeticEnv(tmp);
  let failed = 0;
  const step = (ok, msg) => {
    (ok ? stdout : stderr)(`${ok ? 'PASS' : 'FAIL'}  ${msg}\n`);
    if (!ok) failed++;
  };
  try {
    const bare = path.join(tmp, 'base.git');
    gitIn(tmp, ['clone', '-q', '--bare', root, bare], env);
    const bareUrl = pathToFileURL(bare).href;
    const head = gitIn(bare, ['rev-parse', 'HEAD^{commit}'], env);
    const tags = gitIn(bare, ['tag', '--list', 'v*'], env).split('\n').filter((t) => t && parseTag(t));
    const atHead = tags.filter((t) => isStableTag(t) && gitIn(bare, ['rev-parse', `${t}^{commit}`], env) === head);
    let target = highestStableTag(atHead);
    if (!target) {
      target = nextPatch(highestStableTag(tags) ?? 'v0.0.0');
      gitIn(bare, ['tag', target, head], env);
      stdout(`derive proof: HEAD is untagged; using synthetic tag ${target} for HEAD\n`);
    }
    const froms = tags.filter((t) => isStableTag(t) && compareTags(t, target) < 0).sort(compareTags).reverse().slice(0, 2);
    if (!froms.length) {
      // Legitimate only before the first release (no N-1 yet); never silent in CI.
      stdout('derive proof: SKIPPED: there is no earlier stable tag to derive from (needs at least one released tag)\n');
      if (env0.GITHUB_ACTIONS === 'true') stdout('::warning title=derive proof skipped::no earlier stable tag (vX.Y.Z) to derive from; push the release tag so the next run proves N-1/N-2 derivation\n');
      return 0;
    }

    // A tag with one extra B file, for step 7 (a D file at a path the next tag adds).
    const probeTag = nextPatch(target);
    const probeRel = 'docs/base/derive-proof-probe.md';
    {
      const w = path.join(tmp, 'probe-work');
      gitIn(tmp, ['clone', '-q', bare, w], env);
      gitIn(w, ['checkout', '-q', target], env);
      fs.mkdirSync(path.join(w, 'docs', 'base'), { recursive: true });
      fs.writeFileSync(path.join(w, ...probeRel.split('/')), 'Probe file added by the base.\n');
      commitAll(w, env, 'probe');
      gitIn(w, ['tag', probeTag], env);
      gitIn(w, ['push', '-q', bare, `refs/tags/${probeTag}`], env);
    }
    const targetTree = new Set(gitIn(bare, ['ls-tree', '-r', '--name-only', target], env).split('\n'));

    for (const from of froms) {
      stdout(`\nderive proof: ${from} -> ${target}\n`);
      const dir = path.join(tmp, `derived-${from}`);
      deriveTemplateCopy(bareUrl, from, dir, env);
      const cfgPath = path.join(dir, 'marketplace.config.json');
      const cfg = parse(fs.readFileSync(cfgPath));
      cfg.base = { ...(cfg.base ?? {}), url: bareUrl };
      fs.writeFileSync(cfgPath, canonicalPretty(cfg));
      const init = mbIn(dir, ['init', '--name', 'proof-skills', '--display', 'Proof Skills', '--owner', 'Alice'], env);
      step(init.code === 0, `${from}: init (exit ${init.code})${init.code ? '\n' + init.stdout.slice(-3000) + init.stderr : ''}`);
      if (init.code) continue;
      commitAll(dir, env, 'init');
      scriptedEdits(dir, env);
      commitAll(dir, env, 'derived edits');
      const oldLock = parse(fs.readFileSync(path.join(dir, LOCK_FILE)));

      // Copies for steps 6 and 7, taken before the update.
      const dir6 = path.join(tmp, `step6-${from}`), dir7 = path.join(tmp, `step7-${from}`);
      fs.cpSync(dir, dir6, { recursive: true });
      fs.cpSync(dir, dir7, { recursive: true });

      const before = snapshotDS(dir);
      const up = mbIn(dir, ['base-update', '--to', target], env);
      const report = up.stdout;
      step(up.code === 0 && /^conflicts[^\n]*\(0\)/m.test(report), `${from}: base-update to ${target}: exit ${up.code}, 0 conflicts${up.code ? '\n' + report.slice(-4000) + up.stderr : ''}`);
      const edited = migrationEdits(report);
      const after = new Map();
      for (const rel of before.keys()) {
        const abs = path.join(dir, ...rel.split('/'));
        after.set(rel, fs.existsSync(abs) ? hashFile(abs) : null);
      }
      const changedDS = [...before.keys()].filter((f) => before.get(f) !== after.get(f) && !edited.has(f));
      step(changedDS.length === 0, `${from}: D and S bytes unchanged${changedDS.length ? ': ' + changedDS.join(', ') : ''}`);
      const removed = Object.keys(oldLock.files).filter((f) => !targetTree.has(f));
      const lingering = removed.filter((f) => fs.existsSync(path.join(dir, ...f.split('/'))));
      step(lingering.length === 0, `${from}: ${removed.length} base file(s) removed upstream are gone${lingering.length ? '; still present: ' + lingering.join(', ') : ''}`);

      // Step 6: an edited B file is a conflict (exit 6).
      const targetOwn = compileOwnership(JSON.parse(gitIn(bare, ['show', `${target}:.mb/ownership.json`], env)));
      const victims = Object.keys(oldLock.files).filter((f) => !/^(tools|\.mb)\//.test(f) && !['mb', 'mb.cmd'].includes(f) && targetTree.has(f) && targetOwn(f) === 'B');
      const victim = victims.find((f) => f.endsWith('.md')) ?? victims[0];
      if (victim) {
        const abs = path.join(dir6, ...victim.split('/'));
        fs.appendFileSync(abs, '\nA local edit of a base-owned file.\n');
        const bytes = fs.readFileSync(abs);
        commitAll(dir6, env, 'edit a B file');
        const r6 = mbIn(dir6, ['base-update', '--to', target], env);
        step(r6.code === 6 && fs.readFileSync(abs).equals(bytes), `${from}: edited B file ${victim} gives exit 6 and stays untouched (exit ${r6.code})`);
      } else {
        step(false, `${from}: no B file outside the tooling to edit for step 6`);
      }

      // Step 7: a D file at a path the next tag adds as B is a conflict (exit 6), bytes intact.
      const abs7 = path.join(dir7, ...probeRel.split('/'));
      fs.mkdirSync(path.dirname(abs7), { recursive: true });
      fs.writeFileSync(abs7, 'Our own file, created before the base added this path.\n');
      commitAll(dir7, env, 'own file at a future base path');
      const r7 = mbIn(dir7, ['base-update', '--to', probeTag], env);
      step(r7.code === 6 && fs.readFileSync(abs7, 'utf8') === 'Our own file, created before the base added this path.\n',
        `${from}: D file at a path ${probeTag} adds gives exit 6 with the D bytes intact (exit ${r7.code})`);
    }
  } catch (e) {
    step(false, `derive proof crashed: ${e && e.stack ? e.stack : e}`);
  } finally {
    if (process.env.MB_KEEP_TMP === '1') stdout(`derive proof: temp dir kept at ${tmp}\n`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  stdout(failed ? `derive proof: ${failed} step(s) failed\n` : 'derive proof: all steps passed\n');
  return failed ? 1 : 0;
}
