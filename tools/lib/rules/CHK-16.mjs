// CHK-16: derived repos only. Every .mb-lock.json entry hashes (hash rule)
// to its recorded value, and every B/E path in the tree has a lock entry. Stays red after
// `base-update --keep` on purpose. A B/E path without a lock entry inside the reserved
// areas (tools/, .mb/, docs/base/, .github/workflows/mb-*.yml) is reported by CHK-17 (warning) instead.
// Paths of an adopted example, or of one that marketplace.config.json#includeExamples
// leaves out, are skipped in both directions (same predicate as base-update row 1): dropping an
// example after init is "remove it from includeExamples, then delete examples/plugins/<p>".
import { parse } from '../../kit/json.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';
import { hashFile } from '../hash.mjs';
import { LOCK_FILE } from '../ownership.mjs';
import { exampleIncluded, exampleOf } from '../lock.mjs';

export const id = 'CHK-16';
export const severity = 'error';
export const title = 'Derived repos: every B/E path and every lock entry hashes to its `.mb-lock.json` value. Stays red after `base-update --keep` on purpose until the kept conflict is resolved';
export const fix = 'revert, or upstream a PR; `base-update --force` to reset';

const RESERVED = (rel) => /^(tools|\.mb|docs\/base)\//.test(rel) || /^\.github\/workflows\/mb-[^/]*\.yml$/.test(rel);

export function run(rctx) {
  if (rctx.isBase) return [];
  let lock;
  try {
    lock = parse(rctx.readBytes(LOCK_FILE));
  } catch (e) {
    if (e.name !== 'JsonError') throw e;
    return [{ path: LOCK_FILE, message: `cannot parse: ${e.message}` }];
  }
  const bad = validate(loadSchema(rctx.toolRoot, 'lock'), lock);
  if (bad.length) return bad.map((e) => ({ path: LOCK_FILE, message: `${e.path || '/'}: ${e.message}` }));
  const adopted = new Set(lock.adopted ?? []);
  const managed = (rel) => {
    const ex = exampleOf(rel);
    return ex === null || (!adopted.has(ex) && exampleIncluded(rctx.config?.includeExamples, ex));
  };
  const out = [];
  for (const [rel, want] of Object.entries(lock.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!managed(rel)) continue;
    if (!rctx.exists(rel)) {
      out.push({ path: rel, message: 'base file is missing (deleted locally)' });
    } else if (hashFile(rctx.abs(rel)) !== want) {
      out.push({ path: rel, message: 'base file differs from the locked base version' });
    }
  }
  for (const rel of rctx.files) {
    const cls = rctx.classify(rel);
    if ((cls === 'B' || cls === 'E') && !Object.hasOwn(lock.files, rel) && !RESERVED(rel) && managed(rel)) {
      out.push({ path: rel, message: `${cls === 'B' ? 'base-owned' : 'example'} path has no lock entry (a local file in a base-owned place)`, fix: cls === 'E' ? './mb adopt <p> before editing examples (or drop <p> from includeExamples)' : 'move the file to a derived-owned path' });
    }
  }
  return out;
}
