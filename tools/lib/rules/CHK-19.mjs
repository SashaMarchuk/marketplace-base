// CHK-19: generated Codex files match tools/schemas/codex-{plugin,marketplace}.schema.json
// (schemas pinned to the verified host versions, owned by the generator unit).
// A missing schema is reported as info (not yet pinned); a missing generated file as an error,
// except for a plugin with no readable plugin.src.json (CHK-03's error; `mb gen` would not help).
import { parse } from '../../kit/json.mjs';
import { validate } from '../schema-lite.mjs';
import { exists, fromPosix, readBytes } from '../fsx.mjs';

export const id = 'CHK-19';
export const severity = 'error';
export const title = 'Generated Codex files match `tools/schemas/codex-*.schema.json`, pinned to the verified host versions';
export const fix = './mb gen';
export const slow = true;

function loadOptional(rctx, name) {
  const abs = fromPosix(rctx.toolRoot, `tools/schemas/${name}.schema.json`);
  return exists(abs) ? parse(readBytes(abs)) : null;
}

export function run(rctx) {
  const out = [];
  const check = (schema, schemaName, rel) => {
    if (!schema) {
      out.push({ path: rel, severity: 'info', message: `skipped: tools/schemas/${schemaName}.schema.json not present` });
      return;
    }
    if (!rctx.exists(rel)) {
      out.push({ path: rel, message: 'generated Codex file is missing' });
      return;
    }
    let doc;
    try { doc = parse(rctx.readBytes(rel)); } catch (e) {
      if (e.name !== 'JsonError') throw e;
      out.push({ path: rel, message: `cannot parse: ${e.message}` });
      return;
    }
    for (const e of validate(schema, doc)) out.push({ path: rel, message: `${e.path || '/'}: ${e.message}` });
  };
  if (rctx.allPlugins.length === 0) return out; // nothing to generate
  check(loadOptional(rctx, 'codex-marketplace'), 'codex-marketplace', '.agents/plugins/marketplace.json');
  const pluginSchema = loadOptional(rctx, 'codex-plugin');
  // A plugin without a readable plugin.src.json is reported by CHK-03 (gen cannot fix it), so skip it here.
  for (const p of rctx.plugins) if (p.src) check(pluginSchema, 'codex-plugin', `${p.dir}/.codex-plugin/plugin.json`);
  return out;
}
