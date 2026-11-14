// CHK-13: secret-named keys hold ${env:NAME} references, never literals (SPEC sections 6.2, 12).
// Scanned: every plugin's config.defaults.json, policy/**/*.json, and a committed .<mkt>/config.json.
// Matches whole key names only (so `maxTokens` passes). Objects/arrays under such a key are
// searched recursively; non-empty strings and numbers must be a ${env:NAME} reference.
import { parse } from '../../kit/json.mjs';

export const id = 'CHK-13';
export const severity = 'error';
export const title = 'Keys whose whole name matches `/^(api_?key|secret|password|token|credential)s?$/i` (so `maxTokens` does not match) in defaults, policy or committed `.<mkt>/config.json` must hold `${env:NAME}`';
export const fix = 'use ${env:NAME}';

const SECRET_KEY = /^(api_?key|secret|password|token|credential)s?$/i;
const ENV_REF = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

function scan(v, ptr, hits, underSecret = false) {
  if (Array.isArray(v)) return v.forEach((x, i) => scan(x, `${ptr}/${i}`, hits, underSecret));
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) scan(x, `${ptr}/${k}`, hits, underSecret || SECRET_KEY.test(k));
    return;
  }
  if (underSecret && (typeof v === 'number' || (typeof v === 'string' && v !== '' && !ENV_REF.test(v)))) hits.push(ptr);
}

export function run(rctx) {
  const targets = new Set(rctx.plugins.map((p) => `${p.dir}/config.defaults.json`));
  for (const f of rctx.files) if (/^policy\/.+\.json$/.test(f)) targets.add(f);
  if (rctx.mkt) {
    const project = `.${rctx.mkt}/config.json`;
    if (rctx.git ? rctx.tracked(project) : true) targets.add(project);
  }
  const out = [];
  for (const rel of [...targets].sort()) {
    if (!rctx.exists(rel)) continue;
    let doc;
    try { doc = parse(rctx.readBytes(rel)); } catch { continue; } // CHK-01/11/12 report parse errors
    const hits = [];
    scan(doc, '', hits);
    for (const ptr of hits) out.push({ path: rel, message: `${ptr} holds a literal value; secrets must be \${env:NAME} references` });
  }
  return out;
}
