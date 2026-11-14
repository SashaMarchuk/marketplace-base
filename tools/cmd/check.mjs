// tools/cmd/check.mjs: `mb check` (SPEC section 12). Runs every rule module tools/lib/rules/CHK-NN.mjs.
//
// Rule module contract (also used by the docs/base/rules.md generator):
//   export const id = 'CHK-01'; severity = 'error'|'warning'|'info'; title = '<rule text>';
//   export const fix = '<fix hint>'; export const slow = true;   // optional: skipped by --fast
//   export function run(rctx) -> [{ path, message, severity?, fix? }]   (sync or async; [] = clean)
// Importing a rule has no side effects. A rule that throws becomes one error result.
// rctx is built by buildRuleContext() below; see its comment for the fields.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '../kit/json.mjs';
import * as fsx from '../lib/fsx.mjs';
import { runGit } from '../lib/git.mjs';
import { compileOwnership, parseOwnership, OWNERSHIP_FILE, LOCK_FILE } from '../lib/ownership.mjs';

export const name = 'check';
export const summary = 'Run the repository rules (CHK-01..CHK-24).';
export const usage = 'mb check [<p>...] [--json] [--fast] [--offline] [--base <ref>]';
export const options = {
  json: { type: 'boolean' },
  fast: { type: 'boolean' },
  offline: { type: 'boolean' },
  base: { type: 'string' },
};

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RULES_DIR = path.join(TOOL_ROOT, 'tools', 'lib', 'rules');
const RULE_FILE_RE = /^CHK-\d\d\.mjs$/;
const SEVERITIES = ['error', 'warning', 'info'];

/** Load every rule module from rulesDir, sorted by file name. */
export async function loadRules(rulesDir = DEFAULT_RULES_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(rulesDir).filter((f) => RULE_FILE_RE.test(f)).sort();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const rules = [];
  for (const f of names) rules.push(await import(pathToFileURL(path.join(rulesDir, f)).href));
  return rules;
}

/** Minimal YAML-subset frontmatter parser for SKILL.md / eval files. Returns { data, body, error }. */
export function parseFrontmatter(text) {
  const t = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return { data: null, body: t, error: 'missing frontmatter (--- ... ---)' };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!kv) {
      if (/^\s/.test(line)) continue; // continuation of a nested block (e.g. metadata:)
      return { data, body: t.slice(m[0].length), error: `cannot parse frontmatter line: ${line}` };
    }
    const key = kv[1];
    let raw = kv[2] ?? '';
    const block = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^- /.test(lines[i + 1]) || lines[i + 1] === '')) {
      if (lines[i + 1] === '' && !(raw === '>' || raw === '|' || raw === '>-' || raw === '|-')) break;
      block.push(lines[++i]);
    }
    if (raw === '' && block.length && block.every((b) => /^\s*- /.test(b) || b === '')) {
      data[key] = block.filter((b) => b !== '').map((b) => scalar(b.replace(/^\s*- /, '')));
    } else if (raw === '' && block.length) {
      data[key] = {}; // nested mapping (metadata): keys are not interpreted
    } else if (/^[>|]-?$/.test(raw)) {
      const parts = block.map((b) => b.trim());
      data[key] = raw.startsWith('>') ? parts.filter(Boolean).join(' ') : parts.join('\n').trim();
    } else {
      if (block.length) raw += ' ' + block.map((b) => b.trim()).join(' '); // folded plain scalar
      data[key] = scalar(raw);
    }
  }
  return { data, body: t.slice(m[0].length), error: null };
}

function scalar(raw) {
  const s = raw.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x));
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  return s;
}

function gitFileList(root) {
  try {
    const top = runGit(['rev-parse', '--show-toplevel'], { cwd: root });
    if (top.code !== 0) return null;
    // Only use git when root IS the top level (a fixture inside another repo is not that repo).
    if (fs.realpathSync.native(path.resolve(top.stdout.trim())) !== fs.realpathSync.native(root)) return null;
    const list = (args) => {
      const r = runGit(['ls-files', '-z', ...args], { cwd: root });
      return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [];
    };
    return { all: list(['--cached', '--others', '--exclude-standard']), tracked: new Set(list(['--cached'])) };
  } catch {
    return null; // git missing: fall back to walking the tree
  }
}

/**
 * Build the rule context.
 *   root, toolRoot, isBase, files, tracked(rel), git (bool), classify(rel), config, mkt,
 *   plugins (selected), allPlugins, skills(plugin), configurable(plugin), opts, env,
 *   abs(rel), exists(rel), readText(rel), readBytes(rel), frontmatter(text)
 * opts: { plugins: [], fast, offline, base, env, toolRoot }
 */
export function buildRuleContext(root, opts = {}) {
  const toolRoot = opts.toolRoot ?? TOOL_ROOT;
  const abs = (rel) => fsx.fromPosix(root, rel);
  const exists = (rel) => fsx.exists(abs(rel));
  const g = gitFileList(root);
  const files = [...new Set(g ? g.all : fsx.walk(root))]
    .filter((rel) => fsx.exists(abs(rel))) // a tracked file deleted in the worktree is not scanned
    .sort();

  let ownership;
  try {
    ownership = parseOwnership(fs.readFileSync(abs(OWNERSHIP_FILE)));
  } catch {
    ownership = parseOwnership(fs.readFileSync(fsx.fromPosix(toolRoot, OWNERSHIP_FILE)));
  }
  const classify = compileOwnership(ownership);

  let config = null;
  try {
    config = parse(fs.readFileSync(abs('marketplace.config.json')));
  } catch { /* reported by CHK-01/CHK-02 */ }
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(config)) config = null;

  const inc = config ? config.includeExamples ?? true : true;
  const included = (n) => inc === true || (Array.isArray(inc) && inc.includes(n));
  const listDirs = (rel) => {
    try {
      return fs.readdirSync(abs(rel), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return [];
    }
  };
  const mkPlugin = (dir, name, example) => {
    let src = null;
    try {
      src = parse(fs.readFileSync(abs(`${dir}/plugin.src.json`)));
    } catch { /* CHK-01/CHK-03 */ }
    return { name, dir, example, src: isObj(src) ? src : null };
  };
  const allPlugins = [
    ...listDirs('plugins').map((n) => mkPlugin(`plugins/${n}`, n, false)),
    ...listDirs('examples/plugins').filter(included).map((n) => mkPlugin(`examples/plugins/${n}`, n, true)),
  ];
  const wanted = opts.plugins ?? [];
  const plugins = wanted.length ? allPlugins.filter((p) => wanted.includes(p.name)) : allPlugins;

  return {
    root,
    toolRoot,
    isBase: !exists(LOCK_FILE),
    files,
    git: Boolean(g),
    tracked: (rel) => Boolean(g && g.tracked.has(rel)),
    classify,
    config,
    mkt: config && typeof config.name === 'string' ? config.name : null,
    plugins,
    allPlugins,
    skills: (p) => listDirs(`${p.dir}/skills`),
    configurable: (p) => fsx.isFile(abs(`${p.dir}/config.defaults.json`)),
    opts: { fast: !!opts.fast, offline: !!opts.offline, base: opts.base ?? null, plugins: wanted },
    env: opts.env ?? process.env,
    abs,
    exists,
    readText: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    readBytes: (rel) => fs.readFileSync(abs(rel)),
    frontmatter: parseFrontmatter,
  };
}

/** Run rules against a context. Returns sorted results [{ id, severity, path, message, fix }]. */
export async function runRules(rules, rctx) {
  const results = [];
  for (const rule of rules) {
    if (rctx.opts.fast && rule.slow) continue;
    let out;
    try {
      out = (await rule.run(rctx)) ?? [];
    } catch (e) {
      out = [{ path: '.', severity: 'error', message: `rule crashed: ${e && e.message ? e.message : e}` }];
    }
    for (const r of out) {
      const severity = SEVERITIES.includes(r.severity) ? r.severity : rule.severity;
      results.push({ id: rule.id, severity, path: r.path || '.', message: String(r.message), fix: r.fix ?? rule.fix });
    }
  }
  const key = (r) => `${r.id}\0${r.path}\0${r.message}`;
  results.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return results;
}

export async function run(argv, ctx) {
  const { values, positionals } = ctx.args;
  const rctx = buildRuleContext(ctx.root, {
    plugins: positionals,
    fast: values.fast,
    offline: values.offline,
    base: values.base,
  });
  const unknown = positionals.filter((p) => !rctx.allPlugins.some((x) => x.name === p));
  if (unknown.length) throw ctx.usageError(`unknown plugin: ${unknown.join(', ')}`);

  const results = await runRules(await loadRules(), rctx);
  const ok = !results.some((r) => r.severity === 'error');

  if (values.json) {
    ctx.stdout(JSON.stringify({ ok, results }) + '\n');
  } else {
    for (const r of results) {
      ctx.stdout(`${r.severity.toUpperCase().padEnd(7)} ${r.id} ${r.path}: ${r.message}\n        fix: ${r.fix}\n`);
    }
    const n = (s) => results.filter((r) => r.severity === s).length;
    ctx.stdout(`mb check: ${n('error')} error(s), ${n('warning')} warning(s), ${n('info')} info${values.fast ? ' (--fast)' : ''}\n`);
  }
  return ok ? 0 : 1;
}
