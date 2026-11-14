// tools/lib/policy/decide.mjs: turn loaded policy layers into per-plugin host decisions.
//
// For each plugin in the catalog (the plugins that reach the marketplaces):
//   false  when an `access.deny` pattern of any layer matches, when some layer declares `access.allow`
//          and none of its patterns match (allow is expanded against the current catalog), or when the
//          final enforced `enabled` is false;
//   true   when the final enforced `enabled` is true and the plugin is not blocked;
//   absent otherwise (the host default applies).
// Final enforced `enabled`: layers are applied team then org, so org wins a conflict (as in the resolver).
// A block always beats an enforced `true` (the resolver would exit 4 for that plugin).
// Enforced entries and patterns that name no catalog plugin produce nothing; they are reported back
// as `unknownPlugins` so the command can warn.

import { compareCodePoints } from '../../kit/json.mjs';

/** `*` is a glob over plugin names; every other character of a pattern is literal. */
export function globMatch(pattern, name) {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\-]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

/** Leaves of an enforced settings object as [pointer, value]; empty objects are leaves. */
function leaves(value, ptr = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    return [[ptr, value]];
  }
  const out = [];
  for (const k of Object.keys(value).sort(compareCodePoints)) out.push(...leaves(value[k], `${ptr}/${k}`));
  return out;
}

/**
 * @param {string[]} catalog  plugin names in the marketplace
 * @param {{name:string, doc:object}[]} layers  team first, org last (loadPolicy order)
 * @returns {{
 *   enabled: Record<string, boolean>,          // plugin -> host value (only decided plugins)
 *   reasons: Record<string, string[]>,         // plugin -> why (for README.txt)
 *   settings: {layer:string, plugin:string|null, pointer:string, value:any}[],  // advisory everywhere
 *   unknownPlugins: string[]                   // enforced plugin names not in the catalog
 * }}
 */
export function decide(catalog, layers) {
  const names = [...catalog].sort(compareCodePoints);
  const inCatalog = new Set(names);
  const enabled = {};
  const reasons = {};
  const unknown = new Set();
  const settings = [];

  for (const p of names) {
    const why = [];
    let forced = null;
    for (const { name: layer, doc } of layers) {
      const e = doc.enforced?.plugins?.[p]?.enabled;
      if (typeof e === 'boolean') forced = { value: e, layer };
    }
    let blocked = false;
    for (const { name: layer, doc } of layers) {
      const deny = doc.access?.deny ?? [];
      const hit = deny.find((pat) => globMatch(pat, p));
      if (hit !== undefined) { blocked = true; why.push(`${layer} access.deny "${hit}"`); }
      const allow = doc.access?.allow;
      if (Array.isArray(allow) && !allow.some((pat) => globMatch(pat, p))) {
        blocked = true;
        why.push(`${layer} access.allow does not include it`);
      }
    }
    if (forced && forced.value === false) { blocked = true; why.push(`${forced.layer} enforced enabled=false`); }
    if (blocked) {
      enabled[p] = false;
      reasons[p] = why;
    } else if (forced && forced.value === true) {
      enabled[p] = true;
      reasons[p] = [`${forced.layer} enforced enabled=true`];
    }
  }

  for (const { name: layer, doc } of layers) {
    const es = doc.enforced?.settings;
    if (es && Object.keys(es).length) {
      for (const [pointer, value] of leaves(es)) settings.push({ layer, plugin: null, pointer, value });
    }
    for (const p of Object.keys(doc.enforced?.plugins ?? {}).sort(compareCodePoints)) {
      if (!inCatalog.has(p)) unknown.add(p);
      const s = doc.enforced.plugins[p].settings;
      if (s && Object.keys(s).length) {
        for (const [pointer, value] of leaves(s)) settings.push({ layer, plugin: p, pointer, value });
      }
    }
  }

  return { enabled, reasons, settings, unknownPlugins: [...unknown].sort(compareCodePoints) };
}
