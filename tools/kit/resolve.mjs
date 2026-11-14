#!/usr/bin/env node
// tools/kit/resolve.mjs: tier-a config resolver and writer. Vendored byte-for-byte
// into every configurable skill as skills/<s>/_mb/resolve.mjs, next to json.mjs.
//
//   resolve.mjs [--plugin <p>]          real mode: build INPUT from disk, print OUTPUT
//   resolve.mjs merge                   vector mode: INPUT JSON on stdin
//   resolve.mjs set   [--plugin <p>] --layer user|project|project-local [--shared] <ptr> <json>
//   resolve.mjs unset [--plugin <p>] --layer user|project|project-local [--shared] <ptr>
//
// Security: imports only ./json.mjs and node: built-ins; the only child process is
// `git rev-parse --show-toplevel` (argument array, no shell). Only the documented candidate paths are
// read; nothing walks up from cwd. All objects built here are null-prototype. One extra path, never part of
// resolution: a project-local write reads/appends <root>/.<mkt>/.gitignore so config.local.json is ignored.
// Output: exactly one compact canonical JSON object + "\n" on stdout, for every exit in {0,2,3,4,5,9}.
// Exit 9 = RUNTIME_UNSUPPORTED (node < 20, checked before any work): the skill goes to FALLBACK.md.
// KIT = $MB_KIT if set, else the directory of this file (MERGE-SPEC "Real mode").

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, canonical, canonicalPretty, same, compareCodePoints, FORBIDDEN_KEYS } from './json.mjs';

const ALL_LAYERS = ['skill-defaults', 'org', 'team', 'project', 'user', 'project-local'];
const PERSONAL = new Set(['project', 'user', 'project-local']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PATTERN_RE = /^[a-z0-9*][a-z0-9*-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9_:-]{1,64}$/; // `:` allows tool-identity keys such as mcp:server
const TOP_KEYS = ['$schema', 'settings', 'plugins', 'enforced', 'access', 'team', 'merge'];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = () => Object.create(null);
const clone = (v) => (Array.isArray(v) ? v.map(clone) : !isObj(v) ? v
  : Object.keys(v).reduce((o, k) => { o[k] = clone(v[k]); return o; }, obj()));
const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const overlap = (a, b) => a === b || b.startsWith(a + '/') || a.startsWith(b + '/');

class Fail { constructor(code, err) { this.code = code; this.err = err; } }
const fail = (code, err) => { throw new Fail(code, err); };

// ---------- output ----------
function output(plugin, tier, r) {
  const sortDedupe = (list) => [...new Map(list.map((x) => [canonical(x), x])).entries()]
    .sort((a, b) => compareCodePoints(a[0], b[0])).map((e) => e[1]);
  return canonical({
    blocked: r.blocked ?? false, errors: sortDedupe(r.errors ?? []), locked: [...new Set(r.locked ?? [])].sort(compareCodePoints),
    ok: r.ok, plugin, provenance: r.provenance ?? obj(), settings: r.settings ?? obj(), tier,
    warnings: sortDedupe(r.warnings ?? []),
  }) + '\n';
}
const failResult = (code, errors, warnings) => ({ exit: code, ok: false, errors, warnings });

// ---------- layer file parsing ----------
function checkAccess(a) {
  if (!isObj(a)) return false;
  for (const k of Object.keys(a)) {
    if (k !== 'allow' && k !== 'deny') return false;
    if (!Array.isArray(a[k]) || !a[k].every((p) => typeof p === 'string' && PATTERN_RE.test(p))) return false;
  }
  return true;
}
function hasNull(v) {
  if (v === null) return true;
  if (Array.isArray(v)) return v.some(hasNull);
  return isObj(v) && Object.values(v).some(hasNull);
}
// plugins map (layer `plugins` or `enforced.plugins`): {<p>: {enabled?: bool, settings?: {}}}.
function checkPlugins(pl, unknown) {
  if (!isObj(pl)) return false;
  for (const p of Object.keys(pl)) {
    const e = pl[p];
    if (!isObj(e)) return false;
    for (const k of Object.keys(e)) {
      if (k === 'enabled') { if (typeof e[k] !== 'boolean') return false; }
      else if (k === 'settings') { if (!isObj(e[k])) return false; }
      else unknown.push(k);
    }
  }
  return true;
}
// Parse one layer file. Policy (org/team): any problem -> Fail(3). Personal: problems outside
// `access` -> null (+FILE_SKIPPED). Returns the doc (unknown keys and ignored keys removed).
function parseLayer(layer, raw, W) {
  const policy = !PERSONAL.has(layer);
  const bad = (code) => { if (policy) fail(3, { code, layer }); W.push({ code: 'FILE_SKIPPED', layer }); return null; };
  let d;
  try { d = parse(raw, { mode: 'config' }); } catch (e) { if (e && e.name === 'JsonError') return bad('POLICY_INVALID'); throw e; }
  if (!isObj(d)) return bad('POLICY_INVALID');
  if (hasOwn(d, 'access') && !checkAccess(d.access)) fail(3, { code: 'ACCESS_INVALID', layer });
  if (policy && hasOwn(d, 'enforced') && hasNull(d.enforced)) fail(3, { code: 'ENFORCED_INVALID', layer });
  const unknown = [];
  for (const k of Object.keys(d)) if (!TOP_KEYS.includes(k)) unknown.push(k);
  if (hasOwn(d, '$schema') && typeof d.$schema !== 'string') return bad('POLICY_INVALID');
  if (hasOwn(d, 'settings') && !isObj(d.settings)) return bad('POLICY_INVALID');
  if (hasOwn(d, 'plugins') && !checkPlugins(d.plugins, unknown)) return bad('POLICY_INVALID');
  if (hasOwn(d, 'enforced')) {
    if (!policy) { W.push({ code: 'ENFORCED_IGNORED', layer }); delete d.enforced; }
    else {
      const en = d.enforced;
      if (!isObj(en)) return bad('POLICY_INVALID');
      for (const k of Object.keys(en)) if (k !== 'settings' && k !== 'plugins') unknown.push(k);
      if (hasOwn(en, 'settings') && !isObj(en.settings)) return bad('POLICY_INVALID');
      if (hasOwn(en, 'plugins') && !checkPlugins(en.plugins, unknown)) return bad('POLICY_INVALID');
    }
  }
  if (hasOwn(d, 'merge')) {
    if (layer !== 'user') { W.push({ code: 'KEY_IGNORED', layer }); delete d.merge; }
    else if (!isObj(d.merge) || Object.keys(d.merge).some((k) => k !== 'allowGenerated' || typeof d.merge[k] !== 'boolean')) return bad('POLICY_INVALID');
  }
  if (hasOwn(d, 'team')) {
    // Honoured only in project/user, and only with a valid name (it becomes a file name).
    if ((layer !== 'project' && layer !== 'user') || typeof d.team !== 'string' || !NAME_RE.test(d.team)) {
      W.push({ code: 'KEY_IGNORED', layer }); delete d.team;
    }
  }
  if (unknown.length) {
    if (policy) fail(3, { code: 'POLICY_INVALID', layer });
    W.push({ code: 'UNKNOWN_KEY', layer });
    for (const k of unknown) if (!TOP_KEYS.includes(k)) delete d[k];
    if (isObj(d.plugins)) for (const p of Object.keys(d.plugins)) {
      for (const k of Object.keys(d.plugins[p])) if (k !== 'enabled' && k !== 'settings') delete d.plugins[p][k];
    }
  }
  return d;
}

// ---------- merge primitives ----------
// RFC 7386 merge-patch of `patch` into `target` (mutated) at pointer `base`; records provenance.
function patchInto(target, patch, layer, prov, base) {
  for (const k of Object.keys(patch)) {
    const v = patch[k], ptr = base + '/' + esc(k);
    if (v === null) { delete target[k]; dropProv(prov, ptr); }
    else if (isObj(v)) {
      if (!isObj(target[k])) { target[k] = obj(); dropProv(prov, ptr); }
      patchInto(target[k], v, layer, prov, ptr);
    } else { target[k] = clone(v); dropProv(prov, ptr); if (prov) prov[ptr] = layer; }
  }
  return target;
}
// Remove provenance at or below ptr, and an ancestor leaf entry that a write at ptr replaces.
function dropProv(prov, ptr) {
  if (prov) for (const q of Object.keys(prov)) if (overlap(q, ptr)) delete prov[q];
}
function leaves(v, base, out) {
  for (const k of Object.keys(v)) {
    const x = v[k], ptr = base + '/' + esc(k);
    if (isObj(x) && Object.keys(x).length) leaves(x, ptr, out); else out.push([ptr, x]);
  }
  return out;
}
const segs = (ptr) => ptr.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
function getPtr(o, ptr) {
  let cur = o;
  for (const s of segs(ptr)) { if (!isObj(cur) || !hasOwn(cur, s)) return undefined; cur = cur[s]; }
  return cur;
}
function setPtr(o, ptr, v) {
  const ss = segs(ptr);
  let cur = o;
  for (const s of ss.slice(0, -1)) { if (!isObj(cur[s])) cur[s] = obj(); cur = cur[s]; }
  cur[ss[ss.length - 1]] = clone(v);
}
// Whole-name glob: `*` matches any run. Linear-time (no regex backtracking on hostile patterns).
function glob(pat, name) {
  let p = 0, n = 0, star = -1, mark = 0;
  while (n < name.length) {
    if (p < pat.length && pat[p] !== '*' && pat[p] === name[n]) { p++; n++; }
    else if (p < pat.length && pat[p] === '*') { star = p++; mark = n; }
    else if (star >= 0) { p = star + 1; n = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

// ---------- core ----------
// Personal layer paths. No walk-up: root = gitRoot ?? cwd. user is undefined when unknown.
export function layerPaths(env, mkt, W) {
  const root = env.gitRoot ?? env.cwd, win = env.platform === 'win32', sep = win ? '\\' : '/', x = env.XDG_CONFIG_HOME;
  const paths = { project: root + sep + '.' + mkt + sep + 'config.json', 'project-local': root + sep + '.' + mkt + sep + 'config.local.json' };
  if (win) { if (env.APPDATA) paths.user = env.APPDATA + '\\' + mkt + '\\config.json'; else W.push({ code: 'USER_DIR_UNKNOWN' }); }
  else paths.user = (typeof x === 'string' && x.startsWith('/') ? x : env.home + '/.config') + '/' + mkt + '/config.json';
  return paths;
}
// read(path) -> string|Uint8Array|undefined (absent). May throw Fail. Only candidate paths are asked.
export function core(I, read) {
  const W = [];
  try {
    if (!(I.specVersion <= 1)) fail(5, { code: 'SPEC_UNSUPPORTED' });
    const kit = I.kit, env = I.env, L = kit.layers, P = kit.plugin, mkt = kit.marketplace;
    if (!Array.isArray(L) || L[0] !== 'skill-defaults' || new Set(L).size !== L.length || !L.every((l) => ALL_LAYERS.includes(l))) {
      fail(3, { code: 'LAYERS_INVALID' });
    }
    const paths = layerPaths(env, mkt, W);
    const doc = obj();
    doc['skill-defaults'] = { settings: kit.defaults ?? obj() };
    const load = (layer, p) => {
      if (p === undefined) return;
      const raw = read(p, layer, W);
      if (raw !== undefined) { const d = parseLayer(layer, raw, W); if (d) doc[layer] = d; }
    };
    if (L.includes('org')) load('org', '$KIT/policy/org.json');
    for (const l of ['project', 'user', 'project-local']) if (L.includes(l)) load(l, paths[l]);
    const team = doc.project?.team ?? doc.user?.team ?? null;
    if (team !== null && L.includes('team')) {
      const p = '$KIT/policy/teams/' + team + '.json';
      if (read(p, 'team', W) === undefined) fail(3, { code: 'TEAM_UNKNOWN', layer: team });
      load('team', p);
    }

    // 1 cascade
    let acc = obj(), enabled = true, enabledFrom = null;
    const prov = obj();
    for (const l of L) {
      const d = doc[l];
      if (!d) continue;
      if (isObj(d.settings)) patchInto(acc, d.settings, l, prov, '');
      const pe = isObj(d.plugins) && hasOwn(d.plugins, P) ? d.plugins[P] : null;
      if (pe && isObj(pe.settings)) patchInto(acc, pe.settings, l, prov, '');
      if (pe && typeof pe.enabled === 'boolean') { enabled = pe.enabled; enabledFrom = l; }
    }

    // 2 enforced: team, then org (org applied last wins)
    const lockedBy = obj();
    for (const l of ['team', 'org']) {
      const en = doc[l]?.enforced;
      if (!isObj(en)) continue;
      const pe = isObj(en.plugins) && hasOwn(en.plugins, P) ? en.plugins[P] : null;
      const E = obj();
      if (isObj(en.settings)) patchInto(E, en.settings, l, null, '');
      if (pe && isObj(pe.settings)) patchInto(E, pe.settings, l, null, '');
      for (const [ptr, v] of leaves(E, '', [])) {
        const differs = !same(getPtr(acc, ptr), v);
        if (l === 'org' && differs && Object.keys(lockedBy).some((q) => lockedBy[q] === 'team' && overlap(q, ptr))) {
          W.push({ code: 'ENFORCED_CONFLICT', path: ptr });
        }
        for (const q of Object.keys(prov)) {
          if (overlap(q, ptr) && PERSONAL.has(prov[q]) && differs) W.push({ code: 'LOCKED_OVERRIDE', layer: prov[q], path: ptr });
        }
        setPtr(acc, ptr, v);
        for (const q of Object.keys(prov)) if (overlap(q, ptr)) delete prov[q];
        for (const q of Object.keys(lockedBy)) if (overlap(q, ptr)) delete lockedBy[q];
        prov[ptr] = l; lockedBy[ptr] = l;
      }
      if (pe && typeof pe.enabled === 'boolean') { enabled = pe.enabled; enabledFrom = l; }
    }

    // 3 access (every present layer may declare; order of L irrelevant)
    let blocked = false;
    for (const l of ALL_LAYERS) {
      const a = doc[l]?.access;
      if (!a) continue;
      if (a.deny && a.deny.some((pat) => glob(pat, P))) { W.push({ code: 'BLOCKED_DENY', layer: l }); blocked = true; }
      if (a.allow && !a.allow.some((pat) => glob(pat, P))) { W.push({ code: 'BLOCKED_NOT_ALLOWED', layer: l }); blocked = true; }
    }
    if (enabled === false) { W.push({ code: 'DISABLED', layer: enabledFrom }); blocked = true; }
    return { exit: blocked ? 4 : 0, ok: true, blocked, settings: acc, locked: Object.keys(lockedBy), provenance: prov, warnings: W };
  } catch (e) {
    if (e instanceof Fail) return failResult(e.code, [e.err], W);
    throw e;
  }
}

// ---------- real mode ----------
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function gitRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    return out ? path.resolve(out) : null;
  } catch { return null; }
}

function loadKit(kitDir) {
  let kit;
  try { kit = parse(fs.readFileSync(path.join(kitDir, 'kit.json'))); } // default mode, like the merge-mode envelope
  catch (e) { if (e.code === 'ENOENT' || e.name === 'JsonError' || e.code === 'EACCES') throw new Fail(3, { code: 'KIT_INVALID' }); throw e; }
  const str = (v) => typeof v === 'string' && v.length > 0;
  // plugin must not be a forbidden key: `set` writes it as a key (plugins.<p>) into the layer file.
  if (!isObj(kit) || !str(kit.plugin) || FORBIDDEN_KEYS.includes(kit.plugin) || !str(kit.marketplace) || !NAME_RE.test(kit.marketplace) || !Number.isInteger(kit.specVersion) ||
      (kit.defaults !== undefined && !isObj(kit.defaults))) throw new Fail(3, { code: 'KIT_INVALID' });
  return kit;
}

// Build the INPUT and a reader restricted to the computed candidate paths (MERGE-SPEC "Real mode").
export function realInput(kitDir, kit) {
  const win = process.platform === 'win32', cwd = process.cwd();
  const I = {
    specVersion: kit.specVersion, request: { plugin: kit.plugin, tier: 'a' },
    kit: { marketplace: kit.marketplace, plugin: kit.plugin, skill: kit.skill, layers: kit.layers, defaults: kit.defaults ?? obj() },
    env: { platform: win ? 'win32' : 'posix', cwd, gitRoot: gitRoot(cwd), home: os.homedir(),
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null, APPDATA: process.env.APPDATA ?? null },
  };
  const read = (p, layer, W) => {
    const abs = p.startsWith('$KIT/') ? path.join(kitDir, ...p.slice(5).split('/')) : p;
    try { return fs.readFileSync(abs); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return undefined;
      W.push({ code: 'FILE_UNREADABLE', layer });
      // Fail closed: an org/team file that exists but cannot be read must not silently drop policy.
      if (!PERSONAL.has(layer)) fail(3, { code: 'POLICY_INVALID', layer });
      return undefined;
    }
  };
  return { I, read };
}

// ---------- set / unset ----------
// Minimal checker for the config schema subset: type, enum, properties, items, minimum, maximum, maxLength.
function schemaOk(s, v) {
  if (!isObj(s)) return true;
  if (s.type !== undefined) {
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
    if (!(t === s.type || (s.type === 'number' && t === 'integer'))) return false;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) return false;
  if (typeof v === 'number' && ((typeof s.minimum === 'number' && v < s.minimum) || (typeof s.maximum === 'number' && v > s.maximum))) return false;
  if (typeof v === 'string' && typeof s.maxLength === 'number' && [...v].length > s.maxLength) return false;
  if (isObj(v) && isObj(s.properties)) for (const k of Object.keys(v)) if (hasOwn(s.properties, k) && !schemaOk(s.properties[k], v[k])) return false;
  if (Array.isArray(v) && isObj(s.items) && !v.every((x) => schemaOk(s.items, x))) return false;
  return true;
}
// Subschema at ptr; undefined = path outside the schema (unchecked); null = path under a typed non-object.
function subSchema(s, ptr) {
  for (const seg of segs(ptr)) {
    if (!isObj(s)) return undefined;
    if (isObj(s.properties) && hasOwn(s.properties, seg)) s = s.properties[seg];
    else if (s.type === 'array' && /^(0|[1-9][0-9]*)$/.test(seg)) s = s.items;
    else return s.type !== undefined && s.type !== 'object' ? null : undefined;
  }
  return s;
}

// Keep project-local private: make sure <dir>/.gitignore has the line <name> (create or append; never
// rewrite existing lines; no git call, so it also works outside a repo or before `git init`).
function ignoreLocal(dir, name) {
  const gi = path.join(dir, '.gitignore');
  let txt = '';
  try { txt = fs.readFileSync(gi, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (txt.split(/\r?\n/).some((l) => l.trim() === name)) return;
  fs.appendFileSync(gi, (txt && !txt.endsWith('\n') ? '\n' : '') + name + '\n');
}

function writeOp(op, args, kitDir, kit) {
  const { layer, shared } = args, [ptr, rawValue] = args.positionals;
  const usage = (m) => { throw Object.assign(new Fail(2, { code: 'USAGE' }), { msg: m }); };
  if (!PERSONAL.has(layer)) usage('--layer must be user, project or project-local');
  if (args.positionals.length !== (op === 'set' ? 2 : 1)) usage(`${op}: wrong number of arguments`);
  if (typeof ptr !== 'string' || !ptr.startsWith('/') || !segs(ptr).every((s) => KEY_RE.test(s) && !FORBIDDEN_KEYS.includes(s))) {
    usage('pointer segments must match ^[A-Za-z0-9_:-]{1,64}$');
  }
  let value;
  if (op === 'set') {
    try { value = parse(rawValue, { mode: 'config' }); } catch (e) {
      if (e.name !== 'JsonError') throw e;
      usage(`bad value: ${e.message} (the value is JSON: quote strings, e.g. '"table"')`);
    }
    let schema;
    try { schema = parse(fs.readFileSync(path.join(kitDir, 'config.schema.json')), { mode: 'config' }); } catch (e) {
      if (e.name === 'JsonError') fail(3, { code: 'KIT_INVALID' }); else if (e.code !== 'ENOENT') throw e;
    }
    const sub = schema === undefined ? undefined : subSchema(schema, ptr);
    if (sub === null || (sub !== undefined && !schemaOk(sub, value))) fail(3, { code: 'SCHEMA_INVALID', path: ptr });
  }
  const { I, read } = realInput(kitDir, kit);
  const before = core(I, read);
  if (!before.ok) return before;
  if (before.locked.some((q) => overlap(q, ptr))) return failResult(3, [{ code: 'LOCKED', path: ptr }], before.warnings);
  const file = layerPaths(I.env, kit.marketplace, [])[layer];
  const invalid = (code, hint) => Object.assign(failResult(3, [{ code, layer }], before.warnings), hint ? { hint } : {});
  // Layer-correct hint: project-local is the fallback for user/project, never for itself.
  const denied = () => invalid('WRITE_DENIED', layer === 'project-local' ? 'rerun with approval, or fix the file permissions' : 'write project-local instead, or rerun with approval');
  if (file === undefined) return denied();
  // The project dir .<mkt> comes from the checkout: never write through a symlink there (the dir,
  // the config file or .gitignore). The user layer is not repo-controlled (dotfile links stay fine).
  if (layer !== 'user') {
    const dir = path.dirname(file), link = [dir, file, path.join(dir, '.gitignore')].find((p) => {
      try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; }
    });
    if (link) return invalid('WRITE_DENIED', `refusing to write through the symlink ${link}`);
  }
  let raw, d = obj();
  try { raw = fs.readFileSync(file); } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') return denied();
    if (e.code !== 'ENOENT') throw e;
  }
  if (raw !== undefined) {
    // Refuse to rewrite a file the resolver skips (bad JSON or shape): never "repair" it silently.
    if (parseLayer(layer, raw, []) === null) return invalid('FILE_INVALID');
    d = parse(raw, { mode: 'config' });
  }
  let host = d;
  for (const k of shared ? ['settings'] : ['plugins', kit.plugin, 'settings']) {
    if (!isObj(host[k])) { if (op === 'unset') return { ...before, exit: 0 }; host[k] = obj(); }
    host = host[k];
  }
  if (op === 'set') setPtr(host, ptr, value);
  else {
    const ss = segs(ptr), parent = ss.length > 1 ? getPtr(host, '/' + ss.slice(0, -1).map(esc).join('/')) : host;
    if (!isObj(parent) || !hasOwn(parent, ss[ss.length - 1])) return { ...before, exit: 0 };
    delete parent[ss[ss.length - 1]];
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (layer === 'project-local') ignoreLocal(path.dirname(file), path.basename(file));
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, canonicalPretty(d), { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') return denied();
    throw e;
  }
  const after = core(I, read);
  // The path goes to stderr only (the JSON keys are fixed by MERGE-SPEC); `mb config` shows it.
  return { ...after, exit: after.ok ? 0 : after.exit, msg: `wrote ${file}` };
}

// ---------- CLI ----------
function parseCli(argv) {
  const out = { mode: 'resolve', positionals: [], plugin: undefined, layer: undefined, shared: false };
  let i = 0;
  if (['merge', 'set', 'unset'].includes(argv[0])) out.mode = argv[i++];
  for (; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--plugin') out.plugin = val();
    else if (a === '--layer' && out.mode !== 'resolve' && out.mode !== 'merge') out.layer = val();
    else if (a === '--shared' && (out.mode === 'set' || out.mode === 'unset')) out.shared = true;
    else if (a === '--') { out.positionals.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && !/^-?[0-9]/.test(a))) throw new Error(`unknown option ${a}`);
    else out.positionals.push(a);
  }
  if ((out.mode === 'resolve' || out.mode === 'merge') && out.positionals.length) throw new Error(`unexpected argument ${out.positionals[0]}`);
  if (out.mode === 'merge' && out.plugin !== undefined) throw new Error('merge takes no --plugin');
  return out;
}

// node 20+ is required (bun reports its node-compatible version in process.versions.node).
export const MIN_NODE = 20;
export function runtimeSupported(versions) {
  return Number(String((versions && versions.node) || '0').split('.')[0]) >= MIN_NODE;
}

export function main(argv, versions = process.versions) {
  let plugin = null, tier = 'a', r;
  if (!runtimeSupported(versions)) {
    r = { ...failResult(9, [{ code: 'RUNTIME_UNSUPPORTED' }], []), msg: `node ${MIN_NODE} or later required (found ${versions.node}); follow FALLBACK.md` };
    process.stderr.write(`resolve.mjs: ${r.msg}\n`);
    return { text: output(plugin, tier, r), exit: 9 };
  }
  try {
    let args;
    try { args = parseCli(argv); } catch (e) { throw Object.assign(new Fail(2, { code: 'USAGE' }), { msg: e.message }); }
    if (args.mode === 'merge') {
      const I = parse(fs.readFileSync(0));
      if (!isObj(I) || !isObj(I.kit) || !isObj(I.env) || !isObj(I.request) || !isObj(I.files ?? {})) throw new Fail(2, { code: 'USAGE' });
      plugin = I.request.plugin ?? null; tier = I.request.tier ?? 'a';
      const files = I.files ?? {};
      r = core(I, (p) => (hasOwn(files, p) ? files[p] : undefined));
    } else {
      const kitDir = process.env.MB_KIT ? path.resolve(process.env.MB_KIT) : SELF_DIR;
      const kit = loadKit(kitDir);
      plugin = kit.plugin;
      if (args.plugin !== undefined && args.plugin !== kit.plugin) throw Object.assign(new Fail(2, { code: 'USAGE' }), { msg: `--plugin ${args.plugin} does not match ${kit.plugin}` });
      if (args.mode === 'resolve') { const { I, read } = realInput(kitDir, kit); r = core(I, read); }
      else r = writeOp(args.mode, args, kitDir, kit);
    }
  } catch (e) {
    if (e instanceof Fail) r = { ...failResult(e.code, [e.err], []), msg: e.msg };
    else if (e && e.name === 'JsonError') r = { ...failResult(2, [{ code: 'USAGE' }], []), msg: `stdin: ${e.message}` };
    else throw e; // a crash stays a crash (no JSON): the skill falls back per FALLBACK.md
  }
  if (r.msg || r.hint) process.stderr.write(`resolve.mjs: ${r.msg || r.hint}\n`);
  return { text: output(plugin, tier, r), exit: r.exit };
}

const isMain = (() => {
  try { return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const { text, exit } = main(process.argv.slice(2));
  fs.writeSync(1, Buffer.from(text, 'utf8'));
  process.exitCode = exit;
}
