// CHK-19: generated Codex files match tools/schemas/codex-{plugin,marketplace}.schema.json
// (SPEC section 12; schemas pinned to the verified host versions, owned by the generator unit).
// A missing schema is reported as info (not yet pinned); a missing generated file as an error.
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
  for (const p of rctx.plugins) check(pluginSchema, 'codex-plugin', `${p.dir}/.codex-plugin/plugin.json`);
  return out;
}
