// CHK-03: plugin.src.json matches its schema; name == dir; names unique across plugins/ and the
// included examples (SPEC sections 3, 4, 12). Also warns on a codex authentication other than
// ON_INSTALL (section 3: the only verified value).
import { parse } from '../../kit/json.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';

export const id = 'CHK-03';
export const severity = 'error';
export const title = '`plugin.src.json` matches schema; `name` == dir; unique across `plugins/` + included examples';
export const fix = 'rename dir or name';

export function run(rctx) {
  const out = [];
  const schema = loadSchema(rctx.toolRoot, 'plugin-src');
  for (const p of rctx.plugins) {
    const rel = `${p.dir}/plugin.src.json`;
    if (!rctx.exists(rel)) {
      out.push({ path: rel, message: 'missing plugin.src.json', fix: `./mb new plugin ${p.name}` });
      continue;
    }
    let src;
    try {
      src = parse(rctx.readBytes(rel));
    } catch (e) {
      if (e.name !== 'JsonError') throw e;
      out.push({ path: rel, message: `cannot parse: ${e.message}` });
      continue;
    }
    for (const e of validate(schema, src)) out.push({ path: rel, message: `${e.path || '/'}: ${e.message}` });
    if (src && src.name !== p.name) out.push({ path: rel, message: `name "${src && src.name}" differs from its directory "${p.name}"` });
    const auth = src?.codex?.policy?.authentication;
    if (typeof auth === 'string' && auth !== 'ON_INSTALL') {
      out.push({ path: rel, severity: 'warning', message: `codex.policy.authentication "${auth}" is unverified; only ON_INSTALL is verified`, fix: 'use ON_INSTALL unless the host documents the value' });
    }
    const clash = rctx.allPlugins.filter((q) => q.name === p.name && q.dir !== p.dir);
    for (const q of clash) out.push({ path: rel, message: `plugin name "${p.name}" is also used by ${q.dir}` });
  }
  return out;
}
