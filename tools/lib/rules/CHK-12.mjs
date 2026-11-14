// CHK-12: policy files. policy/org.json and policy/teams/*.json must be
// valid POLICY layers: config-text parse, closed shape levels (layer-file schema), valid access, no
// null under `enforced`. Enforced values must validate against each target plugin's schema, and a
// team's enforced value must not conflict with the org's (ENFORCED_CONFLICT is an error in CI).
// an INFO when a plugin in this repo matches an org `access.deny` entry (often intended,
// so never a warning; it just makes the block visible before release).
import { parse, same } from '../../kit/json.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';
import { globMatch } from '../policy/decide.mjs';

export const id = 'CHK-12';
export const severity = 'error';
export const title = '`policy/*.json` valid as POLICY layers (tier-a parser, config-text rules, closed shape levels); enforced values validate against the target plugin schemas; team-vs-org enforced conflict';
export const fix = 'fix policy file';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** RFC 7386 merge patch (copying; never mutates its inputs). */
export function patch(target, p) {
  if (!isObj(p)) return p === undefined ? target : structuredClone(p);
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null) delete out[k];
    else out[k] = patch(out[k], v);
  }
  return out;
}

/** Leaves as [pointer, value]: scalars, arrays and EMPTY objects are leaves (7.3). */
export function leaves(v, ptr = '') {
  if (!isObj(v) || (Object.keys(v).length === 0 && ptr !== '')) return ptr === '' ? [] : [[ptr, v]];
  return Object.keys(v).flatMap((k) => leaves(v[k], `${ptr}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}

const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

function get(obj, ptr) {
  let cur = obj;
  for (const seg of ptr.split('/').slice(1)) {
    const k = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function set(obj, ptr, value) {
  const segs = ptr.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = obj;
  segs.slice(0, -1).forEach((k) => {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  });
  cur[segs[segs.length - 1]] = structuredClone(value);
}

function hasNull(v) {
  if (v === null) return true;
  if (Array.isArray(v)) return v.some(hasNull);
  return isObj(v) && Object.values(v).some(hasNull);
}

/** The enforced settings a POLICY doc applies to plugin p (shared, then plugin-specific). */
export function enforcedFor(doc, p) {
  const e = doc && doc.enforced;
  if (!isObj(e)) return {};
  return patch(patch({}, e.settings ?? {}), (p && e.plugins?.[p]?.settings) ?? {});
}

/** Problems of one policy file text: [message]. Returns { doc, problems }. */
export function policyProblems(bytes, layerSchema) {
  let doc;
  try {
    doc = parse(bytes, { mode: 'config' });
  } catch (e) {
    if (e.name !== 'JsonError') throw e;
    return { doc: null, problems: [`POLICY_INVALID: ${e.message}`] };
  }
  const problems = validate(layerSchema, doc).map((e) => {
    const code = e.path.startsWith('/access') ? 'ACCESS_INVALID' : 'POLICY_INVALID';
    return `${code}: ${e.path || '/'}: ${e.message}`;
  });
  if (isObj(doc) && hasNull(doc.enforced)) problems.push('ENFORCED_INVALID: null is not allowed under "enforced"');
  return { doc: problems.length ? null : doc, problems };
}

/** Pointers where org's enforced value conflicts with a team-locked value for plugin p (7.3 step 2). */
export function enforcedConflicts(teamDoc, orgDoc, p) {
  const acc = {};
  const teamLocked = leaves(enforcedFor(teamDoc, p)).map(([ptr, v]) => (set(acc, ptr, v), ptr));
  const out = [];
  for (const [ptr, v] of leaves(enforcedFor(orgDoc, p))) {
    const differs = !same(get(acc, ptr), v);
    if (differs && teamLocked.some((q) => overlap(q, ptr))) out.push(ptr);
  }
  return out;
}

export function run(rctx) {
  const out = [];
  const layerSchema = loadSchema(rctx.toolRoot, 'layer-file');
  const files = rctx.files.filter((f) => /^policy\/(teams\/)?[^/]+\.json$/.test(f));
  const docs = new Map();
  for (const rel of files) {
    const { doc, problems } = policyProblems(rctx.readBytes(rel), layerSchema);
    for (const m of problems) out.push({ path: rel, message: m });
    if (doc) docs.set(rel, doc);
  }

  // Enforced values against the target plugin schemas (all plugins, not just the selected ones).
  const schemas = new Map();
  for (const p of rctx.allPlugins) {
    const sRel = `${p.dir}/config.schema.json`;
    if (!rctx.exists(sRel)) continue;
    try {
      schemas.set(p.name, parse(rctx.readBytes(sRel), { mode: 'config' }));
    } catch { /* CHK-11 reports it */ }
  }
  const known = new Set(rctx.allPlugins.map((p) => p.name));
  for (const [rel, doc] of docs) {
    for (const name of Object.keys(doc.enforced?.plugins ?? {})) {
      if (!known.has(name)) out.push({ path: rel, severity: 'warning', message: `enforced.plugins.${name}: no such plugin in this marketplace` });
    }
    if (!doc.enforced) continue;
    for (const [name, schema] of schemas) {
      const e = enforcedFor(doc, name);
      if (Object.keys(e).length === 0) continue;
      let errs;
      try { errs = validate(schema, e); } catch { continue; } // a schema outside the subset: CHK-11
      for (const x of errs) out.push({ path: rel, message: `enforced value for ${name} does not match its config.schema.json at ${x.path || '/'}: ${x.message}` });
    }
  }

  // Plugins the org denies (info only).
  const org = docs.get('policy/org.json');
  const deny = Array.isArray(org?.access?.deny) ? org.access.deny.filter((d) => typeof d === 'string') : [];
  for (const p of rctx.plugins) {
    const hit = deny.find((d) => globMatch(d, p.name));
    if (hit !== undefined) {
      out.push({ path: 'policy/org.json', severity: 'info', message: `plugin ${p.name} matches org access.deny "${hit}" (blocked by org policy)`, fix: 'nothing to do if intended; otherwise edit access.deny in policy/org.json' });
    }
  }

  // Team-vs-org conflicts, per plugin (plus the shared settings alone).
  if (org) {
    for (const [rel, team] of docs) {
      if (!rel.startsWith('policy/teams/')) continue;
      const names = new Set([...known, ...Object.keys(team.enforced?.plugins ?? {}), ...Object.keys(org.enforced?.plugins ?? {})]);
      const seen = new Set();
      for (const name of [null, ...[...names].sort()]) {
        for (const ptr of enforcedConflicts(team, org, name)) {
          const where = name ? `plugin ${name}` : 'shared settings';
          const key = `${ptr}`;
          if (name && seen.has(key)) continue; // already reported for the shared settings
          if (!name) seen.add(key);
          out.push({ path: rel, message: `ENFORCED_CONFLICT at ${ptr} (${where}): the team locks a value the org enforces differently` });
        }
      }
    }
  }
  return out;
}
