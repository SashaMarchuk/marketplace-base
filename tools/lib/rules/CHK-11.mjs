// CHK-11: plugin config files. config.defaults.json is an object under the config-text rules;
// config.schema.json uses only the schema subset; the defaults validate. A top-level `merge` key
// warns: it is reserved for the merge opt-out (`/merge/allowGenerated`).
import { parse } from '../../kit/json.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';

export const id = 'CHK-11';
export const severity = 'error';
export const title = 'A plugin\'s `config.defaults.json` is an object under the config-text rules; its `config.schema.json` uses only the subset; defaults validate';
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
        else if (Object.hasOwn(defaults, 'merge')) out.push({ path: dRel, severity: 'warning', message: 'top-level setting "merge" is reserved (the merge opt-out appears there as /merge/allowGenerated)', fix: 'rename the setting; see docs/base/config.md#file-shape' });
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
    if (isObj(schema) && isObj(schema.properties) && Object.hasOwn(schema.properties, 'merge')) out.push({ path: sRel, severity: 'warning', message: 'top-level property "merge" is reserved (the merge opt-out appears there as /merge/allowGenerated)', fix: 'rename the setting; see docs/base/config.md#file-shape' });
    if (bad.length || !isObj(defaults)) continue;
    for (const e of validate(schema, defaults)) out.push({ path: dRel, message: `does not match config.schema.json at ${e.path || '/'}: ${e.message}` });
  }
  return out;
}
