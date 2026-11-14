// tools/lib/gen/version-stamp.mjs: generated plugin version.
//
// version = src.version, plus "+mb.<sha8>" for configurable plugins. sha8 = the first 8 hex chars of
// sha256 over the plugin's vendored _mb trees (every configurable skill), computed from the IN-MEMORY
// trees (never from disk, so gen is idempotent). Encoding : files sorted by their
// POSIX path relative to the plugin dir ("skills/<s>/_mb/<rel>", code-point order); each file
// contributes  utf8(path) 0x00 utf8(decimal byte length) 0x00 bytes  so no two trees collide.

import { compareCodePoints } from '../../kit/json.mjs';
import { sha256Concat } from '../hash.mjs';

/** trees: [{ skill, files: Map<relInMb, Buffer> }] -> 8 hex chars. */
export function mbTreeHash(trees) {
  const entries = [];
  for (const t of trees) for (const [rel, bytes] of t.files) entries.push([`skills/${t.skill}/_mb/${rel}`, bytes]);
  entries.sort((a, b) => compareCodePoints(a[0], b[0]));
  const chunks = [];
  for (const [p, bytes] of entries) {
    chunks.push(Buffer.from(p, 'utf8'), Buffer.from([0]), Buffer.from(String(bytes.length), 'utf8'), Buffer.from([0]), bytes);
  }
  return sha256Concat(chunks).slice(0, 8);
}

export function stampVersion(plugin, trees) {
  return plugin.configurable ? `${plugin.src.version}+mb.${mbTreeHash(trees)}` : plugin.src.version;
}
