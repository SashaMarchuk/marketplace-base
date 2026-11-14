// tools/cmd/new.mjs: `mb new plugin <p>` and `mb new skill <p>/<s> "<description>"` (SPEC §11, §15).
// Also exports the small repo helpers the other contributor commands share (bump, adopt, export,
// try, config): plugin listing, marketplace config, templates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, canonicalPretty } from '../kit/json.mjs';
import { exists, isDir, isFile, readBytes, readText, writeFileAtomic, mkdirp, walk } from '../lib/fsx.mjs';
import { markerLines, findMarkers } from '../lib/markers.mjs';
import { exampleIncluded } from '../lib/lock.mjs';

export const name = 'new';
export const summary = 'Scaffold a plugin or a skill (with its trigger and no-trigger eval cases).';
export const usage = 'mb new plugin <p> [--category c] [--author n]\n' +
  '       mb new skill <p>/<s> "<description>" [--config]';
export const options = {
  category: { type: 'string' },
  author: { type: 'string' },
  config: { type: 'boolean' },
};

// ---------------------------------------------------------------- shared helpers (exported)

export const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const RESERVED_PLUGIN_NAMES = Object.freeze(['constructor', 'prototype']); // also in plugin-src.schema.json
// Templates are located from this file, never from ctx.root (tests run against temp repos).
export const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export function isKebab(s) {
  return typeof s === 'string' && s.length <= 64 && KEBAB.test(s);
}

/** marketplace.config.json as an object, or null when absent. Parse errors propagate (exit 3). */
export function readMarketplaceConfig(root) {
  const p = path.join(root, 'marketplace.config.json');
  if (!isFile(p)) return null;
  return parse(readBytes(p));
}

/**
 * Plugins of the marketplace, sorted by name: every dir under plugins/ and examples/plugins/ that has
 * plugin.src.json. Each: { name, rel (POSIX), dir (abs), example, included }.
 */
export function listPlugins(root) {
  const cfg = readMarketplaceConfig(root);
  const out = [];
  for (const [rel, example] of [['plugins', false], ['examples/plugins', true]]) {
    const base = path.join(root, ...rel.split('/'));
    if (!isDir(base)) continue;
    for (const p of fs.readdirSync(base).sort()) {
      const dir = path.join(base, p);
      if (!isFile(path.join(dir, 'plugin.src.json'))) continue;
      out.push({ name: p, rel: `${rel}/${p}`, dir, example, included: example ? exampleIncluded(cfg?.includeExamples, p) : true });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.example - b.example));
}

/** Find plugin <p>: plugins/<p> first, then examples/plugins/<p>. null if neither exists. */
export function findPlugin(root, p) {
  return listPlugins(root).find((x) => x.name === p) ?? null;
}

/** Sorted skill names of a plugin dir (dirs under skills/ that contain SKILL.md). */
export function listSkills(pluginDir) {
  const s = path.join(pluginDir, 'skills');
  if (!isDir(s)) return [];
  return fs.readdirSync(s).filter((n) => isFile(path.join(s, n, 'SKILL.md'))).sort();
}

export function isConfigurable(pluginDir) {
  return isFile(path.join(pluginDir, 'config.defaults.json'));
}

/** Replace every {{key}} in text; an unknown key is a bug in the template, so it throws. */
export function render(text, vars) {
  return text.replace(/\{\{([a-z]+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`template placeholder ${m} has no value`);
    return vars[k];
  });
}

// ---------------------------------------------------------------- scaffolding pieces

/** A YAML scalar for one line of text: plain when unambiguous, else JSON-style double quotes. */
export function yamlScalar(s) {
  // Starts with a letter/digit, no ": ", no " #", no trailing ":" or space, not a YAML keyword/number.
  const plain = /^[A-Za-z0-9][^\n]*[^\s:]$|^[A-Za-z0-9]$/.test(s) && !/: |\s#/.test(s)
    && !/^(true|false|null|yes|no|on|off|[-+.0-9eE]+)$/i.test(s);
  return plain ? s : JSON.stringify(s);
}

function titleOf(kebab) {
  return kebab.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** The empty config marker pair (whole lines), generated so no template holds a literal pair (O1). */
function configPair() {
  const { begin, end } = markerLines('config');
  return `${begin}\n${end}\n`;
}

/** Insert an empty config pair after the first heading (or the frontmatter). Returns null if present. */
export function insertConfigPair(text) {
  if (findMarkers(text).pairs.some((p) => p.id === 'config')) return null;
  const lines = text.split('\n');
  let i = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    i = close === -1 ? 0 : close + 1;
  }
  let j = i;
  while (j < lines.length && lines[j].trim() === '') j++;
  if (j < lines.length && /^# /.test(lines[j])) i = j + 1;
  const pair = configPair().trimEnd().split('\n');
  lines.splice(i, 0, '', ...pair, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function pluginSrc(vars, extra) {
  const tpl = parse(readBytes(path.join(TEMPLATES, 'plugin', 'plugin.src.json')));
  const obj = {};
  for (const [k, v] of Object.entries(tpl)) obj[k] = typeof v === 'string' ? render(v, vars) : v;
  return { ...obj, ...extra };
}

/** Files of an eval case template: [{ rel, text }] with rel relative to the case dir. */
function caseFiles(kind, vars) {
  const dir = path.join(TEMPLATES, 'evals', kind);
  return walk(dir).map((rel) => ({ rel, text: render(readText(path.join(dir, ...rel.split('/'))), vars) }));
}

function writePlan(root, plan, ctx) {
  for (const f of plan) {
    const abs = path.join(root, ...f.rel.split('/'));
    if (f.dir) mkdirp(abs);
    else writeFileAtomic(abs, f.text);
    ctx.stdout(`  ${f.verb ?? 'created'} ${f.rel}${f.dir ? '/' : ''}\n`);
  }
}

/** Run another mb command if it is installed; returns its exit code, or null if missing. */
async function runIfPresent(ctx, verb, argv) {
  const cmds = await ctx.listCommands();
  if (!cmds.some((c) => c.name === verb)) {
    ctx.stdout(`note: ./mb ${verb} is not installed; skipped\n`);
    return null;
  }
  ctx.stdout(`\n$ ./mb ${[verb, ...argv].join(' ')}\n`);
  return ctx.runCommand(verb, argv);
}

function checkNewPluginName(ctx, root, p) {
  if (!isKebab(p)) throw ctx.usageError(`plugin name "${p}" must be kebab-case (a-z, 0-9, -), at most 64 chars`);
  // These are forbidden JSON keys (resolver: plugins.<p> could never be written).
  if (RESERVED_PLUGIN_NAMES.includes(p)) throw ctx.usageError(`plugin name "${p}" is reserved`);
  if (exists(path.join(root, 'examples', 'plugins', p))) {
    throw ctx.fail(1, `examples/plugins/${p} exists: a plugin name must be unique (run "./mb adopt ${p}" to take over the example)`);
  }
}

function newPluginPlan(root, p, description, values) {
  const extra = {};
  if (values.category !== undefined) extra.category = values.category;
  if (values.author !== undefined) extra.author = { name: values.author };
  const src = pluginSrc({ plugin: p, description }, extra);
  return [
    { rel: `plugins/${p}/plugin.src.json`, text: canonicalPretty(src) },
    { rel: `plugins/${p}/skills`, dir: true },
  ];
}

// ---------------------------------------------------------------- run

export async function run(argv, ctx) {
  const [sub, ...rest] = ctx.args.positionals;
  const v = ctx.args.values;
  if (sub === 'plugin') return newPlugin(ctx, rest, v);
  if (sub === 'skill') return newSkill(ctx, rest, v);
  throw ctx.usageError(sub === undefined ? 'missing "plugin" or "skill"' : `unknown kind "${sub}" (expected plugin or skill)`);
}

function newPlugin(ctx, rest, v) {
  if (rest.length !== 1) throw ctx.usageError('new plugin takes exactly one name');
  if (v.config) throw ctx.usageError('--config belongs to "new skill"');
  const p = rest[0];
  checkNewPluginName(ctx, ctx.root, p);
  if (exists(path.join(ctx.root, 'plugins', p))) throw ctx.fail(1, `plugins/${p} already exists`);
  ctx.stdout(`new plugin ${p}\n`);
  writePlan(ctx.root, newPluginPlan(ctx.root, p, `The ${p} plugin.`, v), ctx);
  ctx.stdout(`next: ./mb new skill ${p}/<skill> "<what it does. Use when ...>"\n`);
  return 0;
}

async function newSkill(ctx, rest, v) {
  if (rest.length !== 2) throw ctx.usageError('new skill takes <plugin>/<skill> and a quoted description');
  if (v.category !== undefined || v.author !== undefined) throw ctx.usageError('--category/--author belong to "new plugin"');
  const [ps, rawDesc] = rest;
  const m = /^([^/]+)\/([^/]+)$/.exec(ps);
  if (!m) throw ctx.usageError(`expected <plugin>/<skill>, got "${ps}"`);
  const [, p, s] = m;
  if (!isKebab(s)) throw ctx.usageError(`skill name "${s}" must be kebab-case (a-z, 0-9, -), at most 64 chars`);
  const description = rawDesc.trim();
  if (description.length < 1 || description.length > 1024 || /[\r\n]/.test(description)) {
    throw ctx.usageError('the description must be one line of 1 to 1024 characters');
  }

  const root = ctx.root;
  const pdirRel = `plugins/${p}`;
  const pdir = path.join(root, 'plugins', p);
  const plan = [];
  const pluginExists = isFile(path.join(pdir, 'plugin.src.json'));
  if (!pluginExists) {
    checkNewPluginName(ctx, root, p);
    if (exists(pdir)) throw ctx.fail(1, `${pdirRel} exists but has no plugin.src.json`);
    const pdesc = /\.$/.test(description) ? description : `${description}.`;
    plan.push(...newPluginPlan(root, p, pdesc, {}));
  }

  // Refuse before writing anything: skill name clashes (CHK-05 is marketplace-wide) and case dirs.
  for (const other of listPlugins(root)) {
    if (listSkills(other.dir).includes(s) || exists(path.join(other.dir, 'skills', s))) {
      throw ctx.fail(1, `a skill named "${s}" already exists in ${other.rel}: skill names are unique across the marketplace`);
    }
  }
  const configurable = Boolean(v.config) || isConfigurable(pdir);
  const cfg = readMarketplaceConfig(root);
  const vars = {
    plugin: p, skill: s, title: titleOf(s), description: yamlScalar(description),
    marketplace: cfg?.name ?? 'marketplace-base',
    config: configurable ? configPair() + '\n' : '',
  };
  const cases = [['trigger', `${s}-trigger`], ['no-trigger', `${s}-no-trigger`]];
  if (v.config && !exists(path.join(pdir, 'evals', 'config-respected'))) cases.push(['config-respected', 'config-respected']);
  for (const [, dirName] of cases) {
    if (exists(path.join(pdir, 'evals', dirName))) throw ctx.fail(1, `${pdirRel}/evals/${dirName} already exists`);
  }

  plan.push({ rel: `${pdirRel}/skills/${s}/SKILL.md`, text: render(readText(path.join(TEMPLATES, 'skill', 'SKILL.md')), vars) });
  for (const [kind, dirName] of cases) {
    for (const f of caseFiles(kind, vars)) plan.push({ rel: `${pdirRel}/evals/${dirName}/${f.rel}`, text: f.text });
  }
  if (v.config) {
    if (!isFile(path.join(pdir, 'config.defaults.json'))) plan.push({ rel: `${pdirRel}/config.defaults.json`, text: canonicalPretty({}) });
    // Every skill of a configurable plugin carries the config block (SPEC §3), so existing siblings get the pair.
    for (const sib of listSkills(pdir)) {
      const rel = `${pdirRel}/skills/${sib}/SKILL.md`;
      const next = insertConfigPair(readText(path.join(root, ...rel.split('/'))));
      if (next !== null) plan.push({ rel, text: next, verb: 'added config block to' });
    }
  }

  ctx.stdout(`new skill ${p}/${s}${configurable ? ' (configurable)' : ''}\n`);
  writePlan(root, plan, ctx);

  const genCode = await runIfPresent(ctx, 'gen', []);
  if (genCode) return genCode;
  const checkCode = await runIfPresent(ctx, 'check', [p]);
  if (checkCode) return checkCode;
  ctx.stdout(`\nnext: write ${pdirRel}/skills/${s}/SKILL.md and the prompt in ${pdirRel}/evals/${s}-trigger/prompt.md\n`);
  return 0;
}
