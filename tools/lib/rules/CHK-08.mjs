// CHK-08: no symlinks inside a plugin dir, and no `../` path that escapes the plugin dir
// (SPEC section 12). Escapes are found as `../` path tokens in text files, resolved against the
// directory of the file that contains them. A JSON "$schema" line is exempt (editor hint only).
import fs from 'node:fs';
import path from 'node:path';
import { walk } from '../fsx.mjs';

export const id = 'CHK-08';
export const severity = 'error';
export const title = 'No symlinks; no `../` escapes from a plugin dir';
export const fix = 'copy the file into the plugin';

const ESCAPE_RE = /(?:^|[^\w./-])((?:\.\.\/)+[^\s)"'`<>\]]*)/g;

export function run(rctx) {
  const out = [];
  for (const p of rctx.plugins) {
    for (const f of walk(rctx.abs(p.dir))) {
      const rel = `${p.dir}/${f}`;
      if (fs.lstatSync(rctx.abs(rel)).isSymbolicLink()) {
        out.push({ path: rel, message: 'symlink inside a plugin (hosts copy plugins; links break)' });
        continue;
      }
      const buf = rctx.readBytes(rel);
      if (buf.subarray(0, 8000).includes(0)) continue;
      const fileDir = path.posix.dirname(f); // relative to the plugin dir
      buf.toString('utf8').split('\n').forEach((line, i) => {
        if (/"\$schema"\s*:/.test(line)) return; // an editor hint to the repo's schemas, not loaded by hosts
        for (const m of line.matchAll(ESCAPE_RE)) {
          const target = path.posix.normalize(path.posix.join(fileDir, m[1]));
          if (target === '..' || target.startsWith('../')) {
            out.push({ path: rel, message: `${rel}:${i + 1}: "${m[1]}" escapes the plugin dir` });
          }
        }
      });
    }
  }
  return out;
}
