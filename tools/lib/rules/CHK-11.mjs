// CHK-11: plugin config files (SPEC sections 3, 6.2, 9, 12). config.defaults.json is an object under
// the config-text rules; config.schema.json uses only the schema subset; the defaults validate.
import { parse } from '../../kit/json.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';

export const id = 'CHK-11';
export const severity = 'error';
export const title = 'A plugin\'s `config.defaults.json` is an object under the 6.2 config-text rules; its `config.schema.json` uses only the subset; defaults validate';
export const fix = 'see docs/base/config.md#schema';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function run(rctx) {
  const out = [];
  const subset = loadSchema(rctx.toolRoot, 'config-schema-subset');
  for (const p of rctx.plugins) {
    const dRel = `${p.dir}/config.defaults.json`;
    const sRel = `${p.dir}/config.schema.json`;
    let defaults;
    if (rctx.exists(dRel)) {
      try {
        defaults = parse(rctx.readBytes(dRel), { mode: 'config' });
        if (!isObj(defaults)) out.push({ path: dRel, message: 'config.defaults.json must be a JSON object' });
      } catch (e) {
        if (e.name !== 'JsonError') throw e;
        out.push({ path: dRel, message: `config-text rules: ${e.message}` });
      }
    } else if (rctx.exists(sRel)) {
      out.push({ path: sRel, message: 'config.schema.json without config.defaults.json (the plugin is not configurable)', fix: 'add config.defaults.json ({} is fine) or remove the schema' });
    }
    if (!rctx.exists(sRel)) continue;
    let schema;
    try {
      schema = parse(rctx.readBytes(sRel), { mode: 'config' });
    } catch (e) {
      if (e.name !== 'JsonError') throw e;
      out.push({ path: sRel, message: `config-text rules: ${e.message}` });
      continue;
    }
    const bad = validate(subset, schema);
    for (const e of bad) out.push({ path: sRel, message: `outside the schema subset at ${e.path || '/'}: ${e.message}` });
    if (bad.length || !isObj(defaults)) continue;
    for (const e of validate(schema, defaults)) out.push({ path: dRel, message: `does not match config.schema.json at ${e.path || '/'}: ${e.message}` });
  }
  return out;
}
