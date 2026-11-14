// tools/cmd/test.mjs: `mb test [--vectors-only] [--runtime node|bun] [--derive]`.
//
// 1. Unit tests: `node --test <files>`, with every tools/tests/**/*.test.mjs listed explicitly
//    (Node 22 rejects a directory argument). tools/tests/fixtures/** is never scanned, and
//    derive.test.mjs runs only with --derive. Plugin-own tests are added too:
//    {plugins,examples/plugins}/<p>/tests/**/*.test.mjs (node --test only; any other harness, such as
//    a shell run.sh or pytest, is the plugin's own CI step and is not run by mb).
// 2. Conformance vectors: every tools/kit/vectors/<v>/ through `<runtime> <copy> merge`, comparing
//    stdout bytes with expected.json and the exit code with expected.exit. Copies = the source
//    tools/kit/resolve.mjs plus each vendored {plugins,examples/plugins}/<p>/skills/<s>/_mb/resolve.mjs
//    (never a tree walk; tools/tests/fixtures holds stub copies).
// --derive runs only the derive/update proof: tools/tests/derive.test.mjs, then
// `deriveProof(ctx)` from tools/lib/derive.mjs when that module exports it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { walk, isFile, isDir } from '../lib/fsx.mjs';

export const name = 'test';
export const summary = 'Run the unit tests and the conformance vectors against every resolver copy.';
export const usage = 'mb test [--vectors-only] [--runtime node|bun] [--derive]';
export const options = { 'vectors-only': { type: 'boolean' }, runtime: { type: 'string' }, derive: { type: 'boolean' } };

const DERIVE_TEST = 'tools/tests/derive.test.mjs';
// Under bun, process.execPath is bun, which has no `--test`; unit tests always run on node.
const NODE = process.versions.bun ? 'node' : process.execPath;

/** Run a process; resolves {code, stdout: Buffer, error}. Streams output when `forward` is given. */
function exec(cmd, args, { cwd, input, forward } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) { resolve({ code: null, stdout: Buffer.alloc(0), error }); return; }
    const out = [];
    child.stdout.on('data', (b) => (forward ? forward.stdout(b.toString()) : out.push(b)));
    child.stderr.on('data', (b) => forward && forward.stderr(b.toString()));
    child.on('error', (error) => resolve({ code: null, stdout: Buffer.concat(out), error }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out) }));
    child.stdin.on('error', () => {}); // the child may exit before reading stdin
    child.stdin.end(input ?? '');
  });
}

/** Sorted POSIX rel paths of the unit test files: tools/tests first, then each plugin's tests/. */
export function testFiles(root) {
  const files = walk(path.join(root, 'tools', 'tests'), { ignore: (rel) => rel === 'fixtures' || rel.startsWith('fixtures/') })
    .filter((rel) => rel.endsWith('.test.mjs'))
    .map((rel) => `tools/tests/${rel}`);
  for (const base of ['plugins', 'examples/plugins']) {
    const absBase = path.join(root, ...base.split('/'));
    if (!isDir(absBase)) continue;
    for (const p of fs.readdirSync(absBase).sort()) {
      const tests = path.join(absBase, p, 'tests');
      if (!isDir(tests)) continue;
      for (const rel of walk(tests)) if (rel.endsWith('.test.mjs')) files.push(`${base}/${p}/tests/${rel}`);
    }
  }
  return files;
}

/** Resolver copies: the source first, then vendored copies under the known roots only. */
export function resolverCopies(root) {
  const copies = ['tools/kit/resolve.mjs'];
  for (const base of ['plugins', 'examples/plugins']) {
    const absBase = path.join(root, ...base.split('/'));
    if (!isDir(absBase)) continue;
    for (const p of fs.readdirSync(absBase).sort()) {
      const skills = path.join(absBase, p, 'skills');
      if (!isDir(skills)) continue;
      for (const s of fs.readdirSync(skills).sort()) {
        if (isFile(path.join(skills, s, '_mb', 'resolve.mjs'))) copies.push(`${base}/${p}/skills/${s}/_mb/resolve.mjs`);
      }
    }
  }
  return copies;
}

/** Vector dirs (subdirectories only; vectors/README.md is skipped). */
export function vectorDirs(kitDir) {
  const vdir = path.join(kitDir, 'vectors');
  return fs.readdirSync(vdir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

async function runVectors(ctx, runtime) {
  const root = ctx.root, kitDir = path.join(root, 'tools', 'kit');
  const vectors = vectorDirs(kitDir).map((v) => {
    const d = path.join(kitDir, 'vectors', v);
    return { v, input: fs.readFileSync(path.join(d, 'input.json')), expected: fs.readFileSync(path.join(d, 'expected.json')),
      exit: Number(fs.readFileSync(path.join(d, 'expected.exit'), 'utf8').trim()) };
  });
  const copies = resolverCopies(root);
  const jobs = copies.flatMap((c) => vectors.map((x) => ({ c, ...x })));
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const r = await exec(runtime, [path.join(root, ...j.c.split('/')), 'merge'], { cwd: root, input: j.input });
      if (r.error) { failures.push(`${j.c} ${j.v}: cannot run ${runtime}: ${r.error.message}`); continue; }
      if (r.code !== j.exit) failures.push(`${j.c} ${j.v}: exit ${r.code}, expected ${j.exit}`);
      else if (!r.stdout.equals(j.expected)) failures.push(`${j.c} ${j.v}: stdout differs\n  got:      ${r.stdout.toString().trimEnd()}\n  expected: ${j.expected.toString().trimEnd()}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  failures.sort();
  for (const f of failures) ctx.stderr(`FAIL ${f}\n`);
  ctx.stdout(`vectors (${path.basename(runtime)}): ${copies.length} resolver cop${copies.length === 1 ? 'y' : 'ies'} ` +
    `(${copies.length - 1} vendored) x ${vectors.length} vectors: ${jobs.length - failures.length} passed, ${failures.length} failed\n`);
  return failures.length ? 1 : 0;
}

async function runDerive(ctx) {
  let code = 0;
  if (isFile(path.join(ctx.root, ...DERIVE_TEST.split('/')))) {
    const r = await exec(NODE, ['--test', DERIVE_TEST], { cwd: ctx.root, forward: ctx });
    if (r.code !== 0) code = 1;
  }
  const lib = path.join(ctx.root, 'tools', 'lib', 'derive.mjs');
  if (!isFile(lib)) {
    ctx.stderr('mb test --derive: tools/lib/derive.mjs not found; derive proof not available\n');
    return 1;
  }
  const mod = await import(pathToFileURL(lib).href);
  if (typeof mod.deriveProof === 'function') {
    const rc = await mod.deriveProof(ctx);
    if (rc) code = 1;
  }
  return code;
}

export async function run(argv, ctx) {
  const v = ctx.args.values;
  if (ctx.args.positionals.length) throw ctx.usageError('test takes no arguments');
  const rt = v.runtime ?? 'node';
  if (rt !== 'node' && rt !== 'bun') throw ctx.usageError('--runtime must be node or bun');
  if (v.derive && (v['vectors-only'] || v.runtime)) throw ctx.usageError('--derive cannot be combined with other flags');
  if (v.derive) return runDerive(ctx);

  const runtime = rt === 'bun' ? 'bun' : NODE;
  if (rt === 'bun') {
    const probe = await exec('bun', ['--version']);
    if (probe.error || probe.code !== 0) throw ctx.fail(ctx.EXIT.MISSING_TOOL, 'required external tool missing: bun');
  }

  let code = 0;
  if (!v['vectors-only']) {
    const files = testFiles(ctx.root).filter((f) => f !== DERIVE_TEST);
    ctx.stdout(`unit tests: node --test (${files.length} files)\n`);
    const r = await exec(NODE, ['--test', ...files], { cwd: ctx.root, forward: ctx });
    if (r.error) throw ctx.fail(ctx.EXIT.MISSING_TOOL, `cannot run node: ${r.error.message}`);
    if (r.code !== 0) code = 1;
  }
  if ((await runVectors(ctx, runtime)) !== 0) code = 1;
  ctx.stdout(code ? 'mb test: FAILED\n' : 'mb test: ok\n');
  return code;
}
