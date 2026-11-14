// CHK-10: `gen --check` is clean: every generated file, vendored `_mb/` byte equality and the G
// marker bodies match what `./mb gen` would write (SPEC §12). Uses the generator API directly.
import { build, diff } from '../gen/build.mjs';

export const id = 'CHK-10';
export const severity = 'error';
export const title = '`gen --check` clean, including vendored `_mb/` byte equality and markers';
export const fix = './mb gen';

const MESSAGE = {
  changed: 'differs from the generated output',
  missing: 'generated file is missing',
  stale: 'stale generated file (gen would delete it)',
};

export async function run(rctx) {
  let result;
  try {
    result = await build(rctx.root);
  } catch (e) {
    if (typeof e.exitCode !== 'number') throw e;
    return [{ path: '.', message: `cannot generate: ${e.message}`, fix: 'fix the input named above, then ./mb gen' }];
  }
  return [
    ...diff(rctx.root, result).map((d) => ({ path: d.path, message: MESSAGE[d.kind] })),
    ...result.problems.map((p) => ({ path: p.path, message: p.message, fix: 'restore markers from tools/templates' })),
  ];
}
