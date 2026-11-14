// CHK-02: marketplace.config.json matches its schema; config.layers valid (SPEC sections 5, 12).
import { parse } from '../../kit/json.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';

export const id = 'CHK-02';
export const severity = 'error';
export const title = '`marketplace.config.json` matches its schema; layers valid (section 5)';
export const fix = 'see docs/base/config.md#layers';

const FILE = 'marketplace.config.json';

export function run(rctx) {
  if (!rctx.exists(FILE)) return [{ path: FILE, message: 'missing marketplace.config.json' }];
  let cfg;
  try {
    cfg = parse(rctx.readBytes(FILE));
  } catch (e) {
    if (e.name !== 'JsonError') throw e;
    return [{ path: FILE, message: `cannot parse: ${e.message}` }];
  }
  // The schema encodes the layer rules: non-empty, unique, the six names only, skill-defaults first.
  return validate(loadSchema(rctx.toolRoot, 'marketplace-config'), cfg)
    .map((e) => ({ path: FILE, message: `${e.path || '/'}: ${e.message}` }));
}
