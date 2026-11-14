// Tests for the dispatcher tools/mb.mjs and the ./mb, mb.cmd launchers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, discoverCommands, EXIT } from '../../mb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const HELLO = `
export const name = 'hello';
export const summary = 'Say hello.';
export const usage = 'mb hello [--json] [--name <n>] [<words>...]';
export const options = { json: { type: 'boolean' }, name: { type: 'string' } };
export async function run(argv, ctx) {
  if (ctx.args.positionals.includes('bad')) throw ctx.usageError('bad positional');
  if (ctx.args.positionals.includes('fail3')) throw ctx.fail(3, 'invalid policy');
  if (ctx.args.positionals.includes('json')) { const { parse } = await import(${JSON.stringify(new URL('../../kit/json.mjs', import.meta.url).href)}); parse('{"a":1.5}', { mode: 'config' }); }
  if (ctx.args.positionals.includes('crash')) throw new Error('boom');
  if (ctx.args.positionals.includes('nested')) return ctx.runCommand('base-x', ['7']);
  ctx.stdout(ctx.args.values.json ? JSON.stringify({ name: ctx.args.values.name ?? 'world', base: ctx.isBase() }) + '\\n' : 'hello\\n');
  return 0;
}
`;
const BASEX = `
export const name = 'base-x';
export const summary = 'Return the exit code given.';
export const usage = 'mb base-x <code>';
export function run(argv, ctx) { return Number(ctx.args.positionals[0]); }
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cli-'));
  const cmd = path.join(dir, 'tools', 'cmd');
  fs.mkdirSync(cmd, { recursive: true });
  fs.writeFileSync(path.join(cmd, 'hello.mjs'), HELLO);
  fs.writeFileSync(path.join(cmd, 'base-x.mjs'), BASEX);
  fs.writeFileSync(path.join(cmd, '_helper.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(cmd, 'hello.test.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(cmd, 'Bad_Name.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(cmd, 'notes.md'), 'x\n');
  return dir;
}

async function runMb(dir, argv) {
  let out = '', err = '';
  const code = await main(argv, { root: dir, stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  return { code, out, err };
}

test('discovery: only tools/cmd/<verb>.mjs files, sorted; missing dir is empty', () => {
  const dir = fixture();
  try {
    assert.deepEqual(discoverCommands(path.join(dir, 'tools', 'cmd')), ['base-x', 'hello']);
    assert.deepEqual(discoverCommands(path.join(dir, 'nope')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--help lists the discovered commands with summaries', async () => {
  const dir = fixture();
  try {
    const r = await runMb(dir, ['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^ {2}base-x +Return the exit code given\.$/m);
    assert.match(r.out, /^ {2}hello +Say hello\.$/m);
    assert.doesNotMatch(r.out, /_helper|Bad_Name|notes/);
    assert.equal((await runMb(dir, ['-h'])).code, 0);
    const h = await runMb(dir, ['help', 'hello']);
    assert.equal(h.code, 0);
    assert.equal(h.out, 'mb hello [--json] [--name <n>] [<words>...]\n');
    const none = await runMb(dir, []);
    assert.equal(none.code, EXIT.USAGE);
    assert.match(none.err, /Commands:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict argv: unknown flags exit 2, globally and per command', async () => {
  const dir = fixture();
  try {
    assert.equal((await runMb(dir, ['--bogus'])).code, 2);
    const r = await runMb(dir, ['hello', '--bogus']);
    assert.equal(r.code, 2);
    assert.match(r.err, /bogus/);
    assert.match(r.err, /usage: mb hello/);
    assert.equal((await runMb(dir, ['hello', '--json=yes'])).code, 2); // value for a boolean
    assert.equal((await runMb(dir, ['hello', '--name'])).code, 2); // missing value
    assert.equal((await runMb(dir, ['hello', 'bad'])).code, 2); // command-level usage error
    assert.equal((await runMb(dir, ['nope'])).code, 2);
    assert.equal((await runMb(dir, ['../hello'])).code, 2);
    assert.equal((await runMb(dir, ['_helper'])).code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run, ctx and exit-code mapping', async () => {
  const dir = fixture();
  try {
    assert.deepEqual(await runMb(dir, ['hello']), { code: 0, out: 'hello\n', err: '' });
    const j = await runMb(dir, ['hello', '--json', '--name', 'Bob']);
    assert.deepEqual(JSON.parse(j.out), { name: 'Bob', base: true });
    fs.writeFileSync(path.join(dir, '.mb-lock.json'), '{}');
    assert.equal(JSON.parse((await runMb(dir, ['hello', '--json'])).out).base, false);
    assert.equal((await runMb(dir, ['hello', '--help'])).out, 'mb hello [--json] [--name <n>] [<words>...]\n');
    const f3 = await runMb(dir, ['hello', 'fail3']);
    assert.equal(f3.code, 3);
    assert.equal(f3.err, 'mb hello: invalid policy\n');
    const js = await runMb(dir, ['hello', 'json']);
    assert.equal(js.code, 3);
    assert.match(js.err, /BAD_NUMBER/);
    const crash = await runMb(dir, ['hello', 'crash']);
    assert.equal(crash.code, 1);
    assert.match(crash.err, /boom/);
    assert.equal((await runMb(dir, ['hello', 'nested'])).code, 7);
    assert.equal((await runMb(dir, ['base-x', '6'])).code, 6);
    assert.equal((await runMb(dir, ['base-x', '999'])).code, 1); // out-of-range -> failure
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid command module is reported (exit 1)', async () => {
  const dir = fixture();
  try {
    fs.writeFileSync(path.join(dir, 'tools', 'cmd', 'broken.mjs'), "export const name = 'other';\n");
    const r = await runMb(dir, ['broken']);
    assert.equal(r.code, 1);
    assert.match(r.err, /invalid command module tools\/cmd\/broken\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real CLI: node tools/mb.mjs --help, unknown flag, --version', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mb.mjs'), ...args], { encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Commands:/);
  for (const n of discoverCommands(path.join(ROOT, 'tools', 'cmd'))) assert.match(help.stdout, new RegExp(`^  ${n} `, 'm'));
  assert.equal(run('--definitely-unknown').status, 2);
  assert.equal(run('--version').status, 0);
});

test('launchers: ./mb (POSIX) and mb.cmd literals', { skip: process.platform === 'win32' && 'POSIX launcher' }, () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'mb'), 'utf8'), '#!/bin/sh\nexec node "$(dirname "$0")/tools/mb.mjs" "$@"\n');
  assert.equal(fs.readFileSync(path.join(ROOT, 'mb.cmd'), 'utf8'), '@node "%~dp0tools\\mb.mjs" %*\n');
  assert.ok(fs.statSync(path.join(ROOT, 'mb')).mode & 0o111, './mb is executable');
  const r = spawnSync(path.join(ROOT, 'mb'), ['--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Commands:/);
  assert.equal(spawnSync(path.join(ROOT, 'mb'), ['--nope']).status, 2);
});
