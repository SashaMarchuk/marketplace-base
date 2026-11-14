// tools/lib/hash.mjs: hashing helpers.
//
// sha256(data)        hex sha256 of a string (UTF-8) or bytes.
// sha8(data)          first 8 hex chars of sha256(data).
// lockHash(bytes)     the SPEC §2 hash rule for .mb-lock.json and drift checks: sha256 of the file
//                     bytes after every G-marker body has been emptied (see markers.mjs). Applied to
//                     every file, whatever its name; works on raw bytes (latin1 round-trip), so
//                     binary and non-UTF-8 files hash losslessly.
// hashFile(absPath)   lockHash of a file on disk.
// sha256Concat(list)  sha256 over the plain concatenation of byte chunks, in the given order
//                     (callers sort; e.g. FALLBACK step 2 key = sorted vector files + MERGE-SPEC.md).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { emptyMarkers } from './markers.mjs';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha8(data) {
  return sha256(data).slice(0, 8);
}

export function lockHash(bytes) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  const emptied = emptyMarkers(buf.toString('latin1'));
  return sha256(Buffer.from(emptied, 'latin1'));
}

export function hashFile(absPath) {
  return lockHash(readFileSync(absPath));
}

export function sha256Concat(chunks) {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return h.digest('hex');
}
