// tools/lib/gen/vendor-kit.mjs: the per-skill `_mb/` tree (SPEC §4.6).
//
// _mb/ = byte copies of EVERY file under tools/kit/ (resolve.mjs, json.mjs, MERGE-SPEC.md,
//        FALLBACK.md, vectors/**, realmode/**, whatever is there; dot-files are skipped)
//      + vectors.sha256     "<sha8>\n", the tier-b/c key (SPEC §8 step 2)
//      + kit.json           pretty canonical {defaults, layers, marketplace, plugin, skill, specVersion:1}
//      + policy/org.json    byte copy, if present
//      + policy/teams/*.json byte copies
//      + config.schema.json byte copy of the plugin's schema, if present
// Every configurable skill of a plugin gets the same tree; only kit.json#skill differs.

import { compareCodePoints, canonicalPretty } from '../../kit/json.mjs';
import { walk, fromPosix, readBytes } from '../fsx.mjs';
import { sha256Concat } from '../hash.mjs';
import { GenError } from './repo.mjs';

export const SPEC_VERSION = 1;
const GENERATED = new Set(['kit.json', 'vectors.sha256', 'config.schema.json']);
const KEY_FILE = /^(MERGE-SPEC\.md|vectors\/[^/]+\/(input\.json|expected\.json|expected\.exit))$/;

/** Kit files as [{ rel, bytes }], sorted. Throws if tools/kit is missing or shadows a generated name. */
export function readKit(kitDir) {
  const rels = walk(kitDir, { ignore: (rel) => rel.split('/').some((seg) => seg.startsWith('.')) });
  if (rels.length === 0) throw new GenError('tools/kit is missing or empty');
  for (const rel of rels) {
    if (GENERATED.has(rel) || rel.startsWith('policy/')) throw new GenError(`tools/kit/${rel} clashes with a generated _mb file`);
  }
  return rels.map((rel) => ({ rel, bytes: readBytes(fromPosix(kitDir, rel)) }));
}

/**
 * SPEC §8 step 2: sha256 over the concatenation, in sorted path order (paths relative to the kit dir,
 * code-point order, MERGE-SPEC.md sorted in with the rest), of every vectors/<v>/{input.json,
 * expected.json, expected.exit} and MERGE-SPEC.md. Returns the first 8 hex chars.
 */
export function vectorsKey(kitFiles) {
  const chosen = kitFiles.filter((f) => KEY_FILE.test(f.rel)).sort((a, b) => compareCodePoints(a.rel, b.rel));
  return sha256Concat(chosen.map((f) => f.bytes)).slice(0, 8);
}

/** Map<relInMb, Buffer> for one skill. */
export function mbTree(repo, plugin, skillName, kitFiles) {
  const files = new Map();
  for (const f of kitFiles) files.set(f.rel, f.bytes);
  files.set('vectors.sha256', Buffer.from(vectorsKey(kitFiles) + '\n'));
  const kit = {
    defaults: plugin.defaults,
    layers: repo.layers,
    marketplace: repo.mkt,
    plugin: plugin.name,
    skill: skillName,
    specVersion: SPEC_VERSION,
  };
  files.set('kit.json', Buffer.from(canonicalPretty(kit)));
  if (repo.orgBytes) files.set('policy/org.json', repo.orgBytes);
  for (const t of repo.teamFiles) files.set(`policy/teams/${t.name}`, t.bytes);
  if (plugin.schemaBytes) files.set('config.schema.json', plugin.schemaBytes);
  return files;
}
