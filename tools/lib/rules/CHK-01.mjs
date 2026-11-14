// CHK-01: mb-owned JSON parses with the strict parser's default mode.
import { parse } from '../../kit/json.mjs';

export const id = 'CHK-01';
export const severity = 'error';
export const title = 'Every mb-owned `*.json` (classes B, S, G, M, E, plus `policy/**` and the plugin source files `plugins/*/plugin.src.json`, `plugins/*/config.defaults.json`, `plugins/*/config.schema.json`) parses with the parser\'s default mode: no duplicate keys, no forbidden keys; floats allowed. Other D JSON (`.vscode/**`, `tsconfig.json`, ...) is not scanned';
export const fix = 'fix JSON at <path>:<line>';

const PLUGIN_SRC = /^plugins\/[^/]+\/(plugin\.src|config\.defaults|config\.schema)\.json$/;

export function run(rctx) {
  const out = [];
  for (const rel of rctx.files) {
    if (!rel.endsWith('.json')) continue;
    const owned = rctx.classify(rel) !== 'D' || rel.startsWith('policy/') || PLUGIN_SRC.test(rel);
    if (!owned) continue;
    try {
      parse(rctx.readBytes(rel));
    } catch (e) {
      if (e.name !== 'JsonError') throw e;
      out.push({ path: rel, message: `${rel}:${e.line}:${e.column}: ${e.detail}`, fix: `fix JSON at ${rel}:${e.line}` });
    }
  }
  return out;
}
