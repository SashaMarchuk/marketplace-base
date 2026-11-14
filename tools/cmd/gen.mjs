// tools/cmd/gen.mjs: `mb gen [--check] [--verbose]`. The engine is tools/lib/gen/build.mjs.
// By default gen prints counts only; --verbose also lists every written and removed file.
import { build, diff, apply } from '../lib/gen/build.mjs';

export const name = 'gen';
export const summary = 'Write every generated artifact (manifests, marketplaces, _mb/, catalog, markers).';
export const usage = 'mb gen [--check] [--verbose]';
export const options = { check: { type: 'boolean' }, verbose: { type: 'boolean' } };

export async function run(argv, ctx) {
  if (ctx.args.positionals.length) throw ctx.usageError('gen takes no arguments');
  const result = await build(ctx.root);
  for (const p of result.problems) ctx.stderr(`mb gen: ${p.path}: ${p.message} (restore markers from tools/templates)\n`);
  // A plugin dir without plugin.src.json gets nothing generated; say so instead of skipping silently.
  for (const dir of result.skipped ?? []) {
    ctx.stderr(`mb gen: skipped ${dir}: no plugin.src.json (write it: "name", "version", "description"; see tools/schemas/plugin-src.schema.json)\n`);
  }

  if (ctx.args.values.check) {
    const d = diff(ctx.root, result);
    for (const x of d) ctx.stderr(`${x.kind.padEnd(7)} ${x.path}\n`);
    if (d.length) ctx.stderr(`mb gen --check: ${d.length} generated file(s) out of date; run ./mb gen\n`);
    if (d.length || result.problems.length) return 1;
    ctx.stdout('gen: up to date\n');
    return 0;
  }

  const { written, removed } = apply(ctx.root, result);
  if (ctx.args.values.verbose) {
    for (const p of written) ctx.stdout(`wrote   ${p}\n`);
    for (const p of removed) ctx.stdout(`removed ${p}\n`);
  }
  ctx.stdout(`gen: ${written.length} written, ${removed.length} removed${written.length + removed.length && !ctx.args.values.verbose ? ' (--verbose lists them)' : ''}\n`);
  return result.problems.length ? 1 : 0;
}
