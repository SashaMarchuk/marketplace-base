// tools/cmd/gen.mjs: `mb gen [--check]` (SPEC §4, §11). The engine is tools/lib/gen/build.mjs.
import { build, diff, apply } from '../lib/gen/build.mjs';

export const name = 'gen';
export const summary = 'Write every generated artifact (manifests, marketplaces, _mb/, catalog, markers).';
export const usage = 'mb gen [--check]';
export const options = { check: { type: 'boolean' } };

export async function run(argv, ctx) {
  if (ctx.args.positionals.length) throw ctx.usageError('gen takes no arguments');
  const result = await build(ctx.root);
  for (const p of result.problems) ctx.stderr(`mb gen: ${p.path}: ${p.message} (restore markers from tools/templates)\n`);

  if (ctx.args.values.check) {
    const d = diff(ctx.root, result);
    for (const x of d) ctx.stderr(`${x.kind.padEnd(7)} ${x.path}\n`);
    if (d.length) ctx.stderr(`mb gen --check: ${d.length} generated file(s) out of date; run ./mb gen\n`);
    if (d.length || result.problems.length) return 1;
    ctx.stdout('gen: up to date\n');
    return 0;
  }

  const { written, removed } = apply(ctx.root, result);
  for (const p of written) ctx.stdout(`wrote   ${p}\n`);
  for (const p of removed) ctx.stdout(`removed ${p}\n`);
  ctx.stdout(`gen: ${written.length} written, ${removed.length} removed\n`);
  return result.problems.length ? 1 : 0;
}
