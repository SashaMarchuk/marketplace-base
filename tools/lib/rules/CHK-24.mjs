// CHK-24: derived repos: the base repo has a newer stable tag than the locked one. The base URL is
// read like base-update reads it (marketplace.config.json base.url, else the lock). Network; skipped
// with --offline (and by --fast). Info only. Pre-release tags (v1.3.0-rc.1) are never "newer".
import { parse } from '../../kit/json.mjs';
import { runGit } from '../git.mjs';
import { LOCK_FILE } from '../ownership.mjs';
import { baseUrlOf } from '../lock.mjs';

export const id = 'CHK-24';
export const severity = 'info';
export const title = 'The base repo has a newer tag than the lock (network; skipped with `--offline`)';
export const fix = './mb base-update';
export const slow = true;

const TAG = /^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** a > b for tags like v1.2.3 / v1.2.3-rc.1 (a release sorts above its pre-releases). */
export function newer(a, b) {
  const x = TAG.exec(a), y = TAG.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return !x[4] && Boolean(y[4]);
}

export function run(rctx) {
  if (rctx.isBase || rctx.opts.offline) return [];
  let lock;
  try { lock = parse(rctx.readBytes(LOCK_FILE)); } catch { return []; } // CHK-16
  const current = lock?.base?.tag;
  if (typeof current !== 'string') return [];
  const url = baseUrlOf(rctx.root, lock);
  if (typeof url !== 'string') return [];
  const r = runGit(['ls-remote', '--tags', url], { cwd: rctx.root });
  if (r.code !== 0) return [{ path: LOCK_FILE, message: `could not list tags of ${url}` }];
  let best = null;
  for (const line of r.stdout.split('\n')) {
    const m = /\trefs\/tags\/(v\d+\.\d+\.\d+)(?:\^\{\})?$/.exec(line.trim()); // stable tags only
    if (m && (!best || newer(m[1], best))) best = m[1];
  }
  return best && newer(best, current) ? [{ path: LOCK_FILE, message: `base ${best} is available (locked: ${current})` }] : [];
}
