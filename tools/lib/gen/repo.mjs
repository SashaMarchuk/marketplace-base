// tools/lib/gen/repo.mjs: load the generator's inputs (SPEC §3, §5) into one plain model.
//
// loadRepo(root) -> {
//   root, config, mkt, layers, owner,
//   plugins: [{ name, dir, example, included, src, configurable, defaults, schemaBytes,
//               skills: [{ name, dir, skillMd, frontmatter }], hostSpecific: [component] }],
//   included: plugins that go into the marketplaces and catalog, sorted by name,
//   orgBytes, teamFiles: [{ name, bytes }], kitDir
// }
// Every plugin dir that has a plugin.src.json is loaded (so a not-included example still gets its own
// manifests and _mb, keeping its dir self-consistent); only `included` reaches the marketplaces.
// Invalid inputs throw GenError (exit 3) naming the file.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, compareCodePoints } from '../../kit/json.mjs';
import { fromPosix, isDir, isFile, exists, readBytes } from '../fsx.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';
import { exampleIncluded } from '../lock.mjs';

export const DEFAULT_LAYERS = Object.freeze(['skill-defaults', 'org', 'team', 'project', 'user', 'project-local']);
export const PLUGIN_ROOTS = Object.freeze([
  { dir: 'plugins', example: false },
  { dir: 'examples/plugins', example: true },
]);
// CHK-09 host-specific components; shown as a badge in the catalog.
export const HOST_SPECIFIC = Object.freeze(['commands', 'agents', 'hooks', '.mcp.json', 'mcp.json', 'bin']);

// Schemas are tooling, read from the repo that owns this code (not from the repo being generated).
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export class GenError extends Error {
  constructor(message, exitCode = 3) {
    super(message);
    this.name = 'GenError';
    this.exitCode = exitCode;
  }
}

const byName = (a, b) => compareCodePoints(a.name, b.name);

function readJsonFile(root, rel, mode) {
  try {
    return parse(readBytes(fromPosix(root, rel)), { mode });
  } catch (e) {
    if (e && e.name === 'JsonError') throw new GenError(`${rel}:${e.line}:${e.column}: ${e.message}`);
    throw e;
  }
}

function schemaErrors(name, value, rel) {
  const errs = validate(loadSchema(TOOL_ROOT, name), value);
  if (errs.length) {
    throw new GenError(`${rel} is invalid:\n` + errs.map((e) => `  ${e.path || '/'}: ${e.message}`).join('\n'));
  }
}

function listDirs(abs) {
  if (!isDir(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort(compareCodePoints);
}

/**
 * Minimal YAML-frontmatter reader for SKILL.md: top-level `key: value` scalars (plain, 'single',
 * "double") and `>`/`|` block scalars. Nested maps and lists are skipped. Returns {} without
 * frontmatter. Only `name` and `description` are used by the generator.
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end === -1) return {};
  const out = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rawValue] = m;
    let v = rawValue.trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      v = v[0] === '>' ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1).replace(/''/g, "'");
    } else if (v === '') {
      continue; // a nested map or list follows: not a scalar
    }
    out[key] = v;
  }
  return out;
}

function loadPlugin(root, rel, example) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const src = readJsonFile(root, `${rel}/plugin.src.json`, 'default');
  schemaErrors('plugin-src', src, `${rel}/plugin.src.json`);
  if (src.name !== name) throw new GenError(`${rel}/plugin.src.json: name "${src.name}" must equal the directory name "${name}"`);

  const configurable = isFile(fromPosix(root, `${rel}/config.defaults.json`));
  let defaults = null, schemaBytes = null;
  if (configurable) {
    defaults = readJsonFile(root, `${rel}/config.defaults.json`, 'config');
    if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
      throw new GenError(`${rel}/config.defaults.json must hold a JSON object`);
    }
    // A top-level `$schema` is an editor hint (SPEC 6.2), not a setting: never vendor it (O13).
    delete defaults.$schema;
    const schemaRel = `${rel}/config.schema.json`;
    if (isFile(fromPosix(root, schemaRel))) {
      readJsonFile(root, schemaRel, 'default'); // must at least parse; CHK-11 checks the subset
      schemaBytes = readBytes(fromPosix(root, schemaRel));
    }
  }

  const skills = [];
  for (const s of listDirs(fromPosix(root, `${rel}/skills`))) {
    const skillMd = `${rel}/skills/${s}/SKILL.md`;
    if (!isFile(fromPosix(root, skillMd))) continue; // not a skill dir
    const text = readBytes(fromPosix(root, skillMd)).toString('utf8');
    skills.push({ name: s, dir: `${rel}/skills/${s}`, skillMd, frontmatter: parseFrontmatter(text) });
  }
  const hostSpecific = HOST_SPECIFIC.filter((c) => exists(fromPosix(root, `${rel}/${c}`)));
  return { name, dir: rel, example, src, configurable, defaults, schemaBytes, skills, hostSpecific };
}

export function loadRepo(root) {
  const cfgRel = 'marketplace.config.json';
  if (!isFile(fromPosix(root, cfgRel))) throw new GenError(`${cfgRel} not found in ${root}`);
  const config = readJsonFile(root, cfgRel, 'default');
  schemaErrors('marketplace-config', config, cfgRel);

  const plugins = [];
  for (const { dir, example } of PLUGIN_ROOTS) {
    for (const p of listDirs(fromPosix(root, dir))) {
      const rel = `${dir}/${p}`;
      if (!isFile(fromPosix(root, `${rel}/plugin.src.json`))) continue;
      const plugin = loadPlugin(root, rel, example);
      plugin.included = !example || exampleIncluded(config.includeExamples, p);
      plugins.push(plugin);
    }
  }

  const included = plugins.filter((p) => p.included).sort(byName);
  for (let i = 1; i < included.length; i++) {
    if (included[i].name === included[i - 1].name) {
      throw new GenError(`plugin name clash: ${included[i - 1].dir} and ${included[i].dir} (CHK-03)`);
    }
  }

  const orgRel = 'policy/org.json';
  const orgBytes = isFile(fromPosix(root, orgRel)) ? readBytes(fromPosix(root, orgRel)) : null;
  const teamsAbs = fromPosix(root, 'policy/teams');
  const teamFiles = isDir(teamsAbs)
    ? fs.readdirSync(teamsAbs, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name)
      .sort(compareCodePoints)
      .map((n) => ({ name: n, bytes: readBytes(path.join(teamsAbs, n)) }))
    : [];

  return {
    root,
    config,
    mkt: config.name,
    layers: config.config?.layers ?? [...DEFAULT_LAYERS],
    owner: config.owner,
    plugins,
    included,
    orgBytes,
    teamFiles,
    kitDir: fromPosix(root, 'tools/kit'),
  };
}
