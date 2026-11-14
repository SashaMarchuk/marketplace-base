// tools/lib/fsx.mjs: small filesystem helpers. Repo-relative paths are always POSIX ("a/b");
// absolute paths are native. Convert with toPosix()/fromPosix(); never build native paths by
// string concatenation with "/".
//
// API:
//   toPosix(p)                        native relative path -> POSIX (backslashes -> "/" on win32 only)
//   fromPosix(root, rel)              <root> + POSIX rel -> native absolute path
//   relPosix(root, abs)               native absolute path -> POSIX path relative to root
//   exists(abs) -> bool               (lstat-based: a dangling symlink exists)
//   isFile(abs), isDir(abs) -> bool   (follows symlinks)
//   readBytes(abs) -> Buffer
//   readText(abs) -> string           (UTF-8; use readBytes for strict JSON parsing)
//   readJson(abs, { mode }) -> value  strict parse via tools/kit/json.mjs (bytes in, so BOM and
//                                     invalid UTF-8 are caught); a JsonError gets .file = abs
//   writeFileAtomic(abs, data, { mode }) write temp file in the same dir, then rename; creates dirs
//   writeJson(abs, value)             pretty canonical JSON (trailing "\n"), atomic
//   mkdirp(abs, mode?)
//   walk(root, { ignore }) -> [rel]   sorted POSIX paths of FILES (and symlinks, not followed)
//                                     under root; skips ".git" and "node_modules" dirs by default;
//                                     ignore: (rel, dirent) => bool to skip a file or a whole dir
//   copyFile(src, dst)                creates parent dirs, preserves bytes
//   removePath(abs)                   rm -rf of ONE explicit path (refuses a filesystem root)

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse, canonicalPretty } from '../kit/json.mjs';

export function toPosix(p) {
  return path.sep === '\\' ? String(p).replace(/\\/g, '/') : String(p);
}

export function fromPosix(root, rel) {
  return path.join(root, ...String(rel).split('/'));
}

export function relPosix(root, abs) {
  return toPosix(path.relative(root, abs));
}

export function exists(abs) {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

export function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

export function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

export function readBytes(abs) {
  return fs.readFileSync(abs);
}

export function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

export function readJson(abs, opts = {}) {
  try {
    return parse(fs.readFileSync(abs), opts);
  } catch (e) {
    if (e && e.name === 'JsonError') e.file = abs;
    throw e;
  }
}

export function mkdirp(abs, mode) {
  fs.mkdirSync(abs, { recursive: true, ...(mode === undefined ? {} : { mode }) });
}

export function writeFileAtomic(abs, data, opts = {}) {
  const dir = path.dirname(abs);
  mkdirp(dir, opts.dirMode);
  const tmp = path.join(dir, `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* temp file may not exist */ }
    throw e;
  }
}

export function writeJson(abs, value) {
  writeFileAtomic(abs, canonicalPretty(value));
}

const DEFAULT_SKIP_DIRS = new Set(['.git', 'node_modules']);

export function walk(root, opts = {}) {
  const out = [];
  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' && relDir === '') return;
      throw e;
    }
    for (const d of entries) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isDirectory() && DEFAULT_SKIP_DIRS.has(d.name)) continue;
      if (opts.ignore && opts.ignore(rel, d)) continue;
      if (d.isDirectory()) visit(path.join(absDir, d.name), rel);
      else out.push(rel);
    }
  };
  visit(root, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function copyFile(src, dst) {
  mkdirp(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

export function removePath(abs) {
  const resolved = path.resolve(abs);
  if (resolved === path.parse(resolved).root) throw new Error(`removePath: refusing to remove ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}
