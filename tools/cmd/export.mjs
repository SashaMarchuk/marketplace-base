// tools/cmd/export.mjs: `mb export skills <dir> [--plugin p] [--force]` (SPEC §11, §4.7).
// Copies each skills/<s> dir (with its generated _mb/) flat into <dir>, for a plain skills-folder
// install (~/.agents/skills for Codex, ~/.claude/skills for Claude).
import path from 'node:path';
import { isDir, isFile, readBytes, walk, copyFile, removePath, mkdirp } from '../lib/fsx.mjs';
import { listPlugins, listSkills, isConfigurable } from './new.mjs';

export const name = 'export';
export const summary = 'Copy every skill (with _mb/) flat into a skills folder.';
export const usage = 'mb export skills <dir> [--plugin p] [--force]';
export const options = { plugin: { type: 'string' }, force: { type: 'boolean' } };

/** true when two dirs hold the same file paths with the same bytes. */
function sameTree(a, b) {
  const fa = walk(a);
  const fb = walk(b);
  if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
  return fa.every((f) => readBytes(path.join(a, ...f.split('/'))).equals(readBytes(path.join(b, ...f.split('/')))));
}

export async function run(argv, ctx) {
  const [kind, dir, ...extra] = ctx.args.positionals;
  if (kind !== 'skills') throw ctx.usageError(kind === undefined ? 'missing "skills"' : `unknown kind "${kind}" (expected skills)`);
  if (dir === undefined) throw ctx.usageError('missing target <dir>');
  if (extra.length) throw ctx.usageError(`unexpected argument "${extra[0]}"`);
  const { plugin, force } = ctx.args.values;

  let plugins = listPlugins(ctx.root).filter((p) => p.included);
  if (plugin !== undefined) {
    plugins = plugins.filter((p) => p.name === plugin);
    if (!plugins.length) throw ctx.fail(1, `no plugin "${plugin}" in this marketplace`);
  }

  // Collect and validate everything before writing.
  const target = path.resolve(ctx.cwd, dir);
  const items = [];
  const seen = new Map();
  for (const p of plugins) {
    for (const s of listSkills(p.dir)) {
      const src = path.join(p.dir, 'skills', s);
      if (seen.has(s)) throw ctx.fail(1, `skill "${s}" exists in ${seen.get(s)} and ${p.rel}: a flat export needs unique names`);
      seen.set(s, p.rel);
      if (isConfigurable(p.dir) && !isFile(path.join(src, '_mb', 'resolve.mjs'))) {
        throw ctx.fail(1, `${p.rel}/skills/${s} is configurable but has no _mb/ yet: run ./mb gen`);
      }
      const dst = path.join(target, s);
      const state = !isDir(dst) && !isFile(dst) ? 'new' : isDir(dst) && sameTree(src, dst) ? 'same' : 'different';
      items.push({ s, src, dst, state });
    }
  }
  const clashes = items.filter((i) => i.state === 'different');
  if (clashes.length && !force) {
    throw ctx.fail(1, `refusing to overwrite (pass --force): ${clashes.map((i) => i.dst).join(', ')}`);
  }

  mkdirp(target);
  for (const it of items) {
    if (it.state === 'same') {
      ctx.stdout(`  unchanged ${it.s}\n`);
      continue;
    }
    if (it.state === 'different') removePath(it.dst);
    for (const f of walk(it.src)) copyFile(path.join(it.src, ...f.split('/')), path.join(it.dst, ...f.split('/')));
    ctx.stdout(`  ${it.state === 'new' ? 'exported' : 'replaced'} ${it.s}\n`);
  }
  ctx.stdout(`${items.length} skill(s) in ${target}\n`);
  return 0;
}
