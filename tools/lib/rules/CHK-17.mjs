// CHK-17: reserved names hold no derived (D) files: .github/workflows/mb-*.yml,
// tools/, .mb/ (except leak-denylist.txt), docs/base/. A file there is "derived" when its class is D,
// or, in a derived repo, when it is B/E/S but has no .mb-lock.json entry (it did not come from the base).
import { parse } from '../../kit/json.mjs';
import { LOCK_FILE } from '../ownership.mjs';

export const id = 'CHK-17';
export const severity = 'warning';
export const title = 'Reserved names: workflows `mb-*.yml`, dirs `tools/`, `.mb/` (except `leak-denylist.txt`), `docs/base/` contain no D files';
export const fix = 'move it out of the reserved path';

// A path-specific hint per reserved name.
function fixFor(rel) {
  if (rel.startsWith('.github/')) return 'rename it: local CI goes in .github/workflows/<name>.yml (no mb- prefix)';
  if (rel.startsWith('docs/base/')) return 'move it to docs/<name> (docs/base/ belongs to the base)';
  if (rel.startsWith('tools/')) return 'move it to scripts/ or another non-reserved dir (tools/ belongs to the base)';
  return 'move it out of .mb/ (only .mb/leak-denylist.txt is yours there)';
}

const RESERVED = (rel) => /^(tools|\.mb|docs\/base)\//.test(rel) || /^\.github\/workflows\/mb-[^/]*\.yml$/.test(rel);

export function run(rctx) {
  let lockFiles = null;
  if (!rctx.isBase) {
    try { lockFiles = parse(rctx.readBytes(LOCK_FILE)).files ?? {}; } catch { lockFiles = null; } // CHK-16
  }
  const out = [];
  for (const rel of rctx.files) {
    if (!RESERVED(rel) || rel === '.mb/leak-denylist.txt') continue;
    const cls = rctx.classify(rel);
    if (cls === 'G' || cls === 'M') continue;
    const local = cls === 'D' || (lockFiles !== null && !Object.hasOwn(lockFiles, rel));
    if (local) out.push({ path: rel, message: 'local file in a name reserved for the base; base updates may overwrite or delete it', fix: fixFor(rel) });
  }
  return out;
}
