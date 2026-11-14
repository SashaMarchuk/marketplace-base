// tools/lib/ownership.mjs: ownership classes.
//
// Glob dialect (implemented here, zero deps): a glob matches when it matches the WHOLE path;
// `*` matches any run of characters except `/` (including the empty run); `**` as a whole segment
// matches zero or more whole segments; every other character is literal (no braces, no classes).
// Paths are repo-relative POSIX ("a/b/c"). Backslashes are converted to "/" and a leading "./"
// is dropped, so callers on Windows may pass native relative paths.
//
// Resolution: first matching glob in class order G, M, E, B, S; unmatched paths are D.
//
// API:
//   CLASS_ORDER                       ['G','M','E','B','S']
//   OWNERSHIP_FILE                    '.mb/ownership.json'
//   globToRegExp(glob) -> RegExp
//   matchGlob(glob, relPath) -> bool
//   normalizeRel(relPath) -> string
//   parseOwnership(textOrBytes) -> { G:[...], M:[...], E:[...], B:[...], S:[...] } (validated)
//   loadOwnership(root) -> same, read from <root>/.mb/ownership.json
//   compileOwnership(ownership) -> classify function (relPath) -> 'G'|'M'|'E'|'B'|'S'|'D'
//   classify(relPath, ownership) -> class letter
//   isBase(root) -> bool                (!exists(<root>/.mb-lock.json))

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../kit/json.mjs';

export const CLASS_ORDER = Object.freeze(['G', 'M', 'E', 'B', 'S']);
export const OWNERSHIP_FILE = '.mb/ownership.json';
export const LOCK_FILE = '.mb-lock.json';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function normalizeRel(relPath) {
  let p = String(relPath).replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

export function globToRegExp(glob) {
  const segs = glob.split('/');
  let re = '';
  segs.forEach((seg, k) => {
    const last = k === segs.length - 1;
    if (seg === '**') {
      // zero or more whole segments, including their separators
      if (segs.length === 1) re += '(?:[^/]+(?:/[^/]+)*)?';
      else if (last) re += '(?:/[^/]+)*'; // "a/**": the "/" before ** is emitted here
      else re += '(?:[^/]+/)*';
      return;
    }
    re += seg.split('*').map(escapeRe).join('[^/]*');
    const nextIsTrailingGlobstar = k === segs.length - 2 && segs[k + 1] === '**';
    if (!last && !nextIsTrailingGlobstar) re += '/';
  });
  return new RegExp('^' + re + '$');
}

export function matchGlob(glob, relPath) {
  return globToRegExp(glob).test(normalizeRel(relPath));
}

export function parseOwnership(textOrBytes) {
  const o = parse(textOrBytes);
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${OWNERSHIP_FILE}: expected an object`);
  for (const k of Object.keys(o)) {
    if (!CLASS_ORDER.includes(k)) throw new Error(`${OWNERSHIP_FILE}: unknown class ${k}`);
    if (!Array.isArray(o[k]) || o[k].some((g) => typeof g !== 'string' || g === '')) {
      throw new Error(`${OWNERSHIP_FILE}: class ${k} must be an array of non-empty strings`);
    }
  }
  for (const k of CLASS_ORDER) o[k] ??= [];
  return o;
}

export function loadOwnership(root) {
  return parseOwnership(readFileSync(join(root, OWNERSHIP_FILE)));
}

export function compileOwnership(ownership) {
  const table = CLASS_ORDER.map((cls) => [cls, (ownership[cls] ?? []).map(globToRegExp)]);
  return (relPath) => {
    const p = normalizeRel(relPath);
    for (const [cls, res] of table) if (res.some((re) => re.test(p))) return cls;
    return 'D';
  };
}

export function classify(relPath, ownership) {
  return compileOwnership(ownership)(relPath);
}

export function isBase(root) {
  return !existsSync(join(root, LOCK_FILE));
}
