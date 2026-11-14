// tools/cmd/adopt.mjs: `mb adopt <p>`. Derived repos only.
// Moves examples/plugins/<p> (E) to plugins/<p> (D), drops its lock entries, records <p> in the
// lock's `adopted` list, and runs gen. marketplace.config.json#includeExamples is NOT changed.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../kit/json.mjs';
import { exists, isDir, isFile, readBytes, readText, writeFileAtomic, writeJson } from '../lib/fsx.mjs';
import { LOCK_FILE } from '../lib/ownership.mjs';
import { isKebab } from './new.mjs';

export const name = 'adopt';
export const summary = 'Take over an example plugin: move it to plugins/<p> as your own (derived repos).';
export const usage = 'mb adopt <p>';

const SCHEMA_REF = /("\$schema"\s*:\s*)"(?:\.\.\/)+tools\/schemas\/plugin-src\.schema\.json"/;

export async function run(argv, ctx) {
  const pos = ctx.args.positionals;
  if (pos.length !== 1) throw ctx.usageError('adopt takes exactly one plugin name');
  const p = pos[0];
  if (!isKebab(p)) throw ctx.usageError(`bad plugin name "${p}"`);
  if (ctx.isBase()) throw ctx.usageError('adopt runs in a derived repo (this repo has no .mb-lock.json)');

  const root = ctx.root;
  const from = path.join(root, 'examples', 'plugins', p);
  const to = path.join(root, 'plugins', p);
  if (!isDir(from)) throw ctx.fail(1, `examples/plugins/${p} does not exist (not included, or already adopted)`);
  if (exists(to)) throw ctx.fail(1, `plugins/${p} already exists`);

  const lockPath = path.join(root, LOCK_FILE);
  const lock = parse(readBytes(lockPath));
  const prefix = `examples/plugins/${p}/`;
  const files = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(lock.files ?? {})) {
    if (k.startsWith(prefix)) dropped++;
    else files[k] = v;
  }
  const adopted = [...new Set([...(lock.adopted ?? []), p])].sort();

  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.renameSync(from, to);
  writeJson(lockPath, { ...lock, adopted, files });

  // The file moved one level up: keep its editor $schema hint pointing at the schema.
  const src = path.join(to, 'plugin.src.json');
  if (isFile(src)) {
    const text = readText(src);
    const next = text.replace(SCHEMA_REF, '$1"../../tools/schemas/plugin-src.schema.json"');
    if (next !== text) writeFileAtomic(src, next);
  }

  ctx.stdout(`adopted ${p}: examples/plugins/${p} -> plugins/${p}; ${dropped} lock entr${dropped === 1 ? 'y' : 'ies'} dropped\n`);
  const cmds = await ctx.listCommands();
  if (cmds.some((c) => c.name === 'gen')) {
    ctx.stdout('\n$ ./mb gen\n');
    const code = await ctx.runCommand('gen', []);
    if (code) return code;
  } else {
    ctx.stdout('note: ./mb gen is not installed; run it before committing\n');
  }
  ctx.stdout(`next: ./mb check ${p} (the plugin is yours now; bump it when you change it)\n`);
  return 0;
}
