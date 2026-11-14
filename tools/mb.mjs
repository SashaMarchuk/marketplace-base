#!/usr/bin/env node
// tools/mb.mjs: the `mb` dispatcher. Launched by ./mb (POSIX) and mb.cmd (Windows).
//
// ===================== COMMAND MODULE CONTRACT (read before adding a command) =====================
// A command is ONE file `tools/cmd/<verb>.mjs`. Dropping the file in is all it takes: the dispatcher
// discovers it (no registry, nobody edits this file). <verb> matches ^[a-z][a-z0-9-]*$; files
// starting with "_" and files ending in ".test.mjs" are not commands. `./mb <verb> ...` loads only
// that module; `./mb --help` loads all of them to list name + summary.
//
// The module exports:
//   export const name = 'gen';                 // REQUIRED, must equal the file name without .mjs
//   export const summary = 'Write every generated artifact.';   // REQUIRED, one line for --help
//   export const usage = 'mb gen [--check]';   // REQUIRED, shown by `mb gen --help` and on exit 2
//   export const options = {                   // OPTIONAL: node:util parseArgs option map
//     check: { type: 'boolean' },              //   (type 'boolean' | 'string', optional short,
//     json:  { type: 'boolean' },              //    multiple). Default {}.
//   };
//   export async function run(argv, ctx) {     // REQUIRED; may be sync or async
//     return 0;                                // exit code; undefined means 0
//   }
//
// Argument parsing is done by the dispatcher BEFORE run(): strict (an unknown flag, or a value
// given to a boolean flag, is exit 2), positionals allowed. `--help`/`-h` is added to every command
// and prints `usage` (exit 0). A command with sub-verbs (`mb new plugin|skill`, `mb config resolve`)
// declares the union of its flags and checks positionals/flag combinations itself, throwing
// ctx.usageError(msg) for a bad combination.
//
// ctx (the second argument of run):
//   ctx.root             absolute native path of the repo that owns this tools/ dir (NOT the cwd)
//   ctx.cwd              process working directory
//   ctx.verb             the verb being run
//   ctx.argv             raw args after the verb (string[])
//   ctx.args             { values, positionals } from the strict parse
//   ctx.stdout(text)     write to stdout (no newline added); ctx.stderr(text) likewise
//   ctx.isBase()         true when <root>/.mb-lock.json does not exist
//   ctx.usageError(msg)  returns an Error with exitCode 2; `throw ctx.usageError('...')`
//   ctx.fail(code, msg)  returns an Error with that exitCode; `throw ctx.fail(3, 'bad policy')`
//   ctx.runCommand(verb, argv) -> Promise<exit code>   run another command in-process (init -> gen)
//   ctx.listCommands() -> Promise<[{ name, summary, usage }]>
//   ctx.EXIT             { OK:0, FAIL:1, USAGE:2, INVALID:3, BLOCKED:4, CONFLICT:6, MISSING_TOOL:7 }
//
// Errors: anything thrown with a numeric `exitCode` (ctx.usageError, ctx.fail, tools/lib/git.mjs
// MissingToolError = 7) prints "mb <verb>: <message>" to stderr and exits with that code; a usage
// error also prints the usage. A JsonError from tools/kit/json.mjs exits 3 with file:line:column.
// Anything else is a crash: stack on stderr, exit 1.
// Output: commands write through ctx.stdout/ctx.stderr and RETURN the exit code; never call
// process.exit() (it can truncate piped output).
// Paths: keep repo-relative paths POSIX and convert with tools/lib/fsx.mjs (Windows-safe).
// ==================================================================================================

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from './kit/json.mjs';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, INVALID: 3, BLOCKED: 4, CONFLICT: 6, MISSING_TOOL: 7 });

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');
const VERB_RE = /^[a-z][a-z0-9-]*$/;

function exitError(exitCode, message) {
  const e = new Error(message);
  e.exitCode = exitCode;
  return e;
}

/** Sorted command names found in cmdDir (missing dir -> []). */
export function discoverCommands(cmdDir) {
  let files;
  try {
    files = fs.readdirSync(cmdDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return files
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !f.startsWith('_'))
    .map((f) => f.slice(0, -4))
    .filter((n) => VERB_RE.test(n))
    .sort();
}

async function loadCommand(cmdDir, verb) {
  const mod = await import(pathToFileURL(path.join(cmdDir, `${verb}.mjs`)).href);
  const problems = [];
  if (mod.name !== verb) problems.push(`export "name" must be "${verb}"`);
  if (typeof mod.summary !== 'string') problems.push('missing string export "summary"');
  if (typeof mod.usage !== 'string') problems.push('missing string export "usage"');
  if (typeof mod.run !== 'function') problems.push('missing function export "run"');
  if (mod.options !== undefined && (mod.options === null || typeof mod.options !== 'object')) {
    problems.push('export "options" must be an object');
  }
  if (problems.length) throw exitError(EXIT.FAIL, `invalid command module tools/cmd/${verb}.mjs: ${problems.join('; ')}`);
  return mod;
}

function readBaseVersion(root) {
  try {
    return parse(fs.readFileSync(path.join(root, '.mb', 'base-version.json'))).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function helpText(cmds) {
  const width = Math.max(8, ...cmds.map((c) => c.name.length)) + 2;
  const lines = [
    'mb: marketplace-base CLI',
    '',
    'Usage: ./mb <command> [args]      (Windows: mb.cmd <command> [args])',
    '',
    'Commands:',
    ...(cmds.length ? cmds.map((c) => `  ${c.name.padEnd(width)}${c.summary}`) : ['  (no commands installed)']),
    '',
    'Run "./mb <command> --help" for the usage of one command.',
    'Exit codes: 0 ok, 1 failure, 2 usage, 3 invalid config/policy, 4 blocked, 6 base-update conflicts, 7 missing tool.',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Run the CLI. argv = args after "mb". Returns the exit code (never calls process.exit).
 * opts: { root, cmdDir, cwd, stdout, stderr } (all optional; tests point cmdDir at a temp dir).
 */
export async function main(argv, opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const cmdDir = opts.cmdDir ?? path.join(root, 'tools', 'cmd');
  const stdout = opts.stdout ?? ((t) => process.stdout.write(t));
  const stderr = opts.stderr ?? ((t) => process.stderr.write(t));
  const cwd = opts.cwd ?? process.cwd();

  const listCommands = async () => {
    const out = [];
    for (const n of discoverCommands(cmdDir)) {
      const m = await loadCommand(cmdDir, n);
      out.push({ name: m.name, summary: m.summary, usage: m.usage });
    }
    return out;
  };

  const runCommand = async (verb, args) => {
    let mod;
    try {
      if (!VERB_RE.test(verb) || !discoverCommands(cmdDir).includes(verb)) {
        throw exitError(EXIT.USAGE, `unknown command "${verb}". Run "./mb --help" for the list.`);
      }
      mod = await loadCommand(cmdDir, verb);
      let parsed;
      try {
        parsed = parseArgs({
          args,
          options: { help: { type: 'boolean', short: 'h' }, ...(mod.options ?? {}) },
          strict: true,
          allowPositionals: true,
        });
      } catch (e) {
        throw exitError(EXIT.USAGE, e.message);
      }
      if (parsed.values.help) {
        stdout(mod.usage.endsWith('\n') ? mod.usage : mod.usage + '\n');
        return EXIT.OK;
      }
      const ctx = {
        root, cwd, verb, argv: args, args: parsed, EXIT,
        stdout, stderr,
        isBase: () => !fs.existsSync(path.join(root, '.mb-lock.json')),
        usageError: (msg) => exitError(EXIT.USAGE, msg),
        fail: (code, msg) => exitError(code, msg),
        runCommand, listCommands,
      };
      const code = await mod.run(args, ctx);
      if (code === undefined) return EXIT.OK;
      return Number.isInteger(code) && code >= 0 && code <= 255 ? code : EXIT.FAIL;
    } catch (e) {
      if (e && Number.isInteger(e.exitCode)) {
        stderr(`mb ${verb}: ${e.message}\n`);
        if (e.exitCode === EXIT.USAGE && mod) stderr(`usage: ${mod.usage.trimEnd()}\n`);
        return e.exitCode;
      }
      if (e && e.name === 'JsonError') {
        const where = e.file ? `${e.file}:${e.line}:${e.column}` : `line ${e.line}, column ${e.column}`;
        stderr(`mb ${verb}: invalid JSON (${e.code}) at ${where}: ${e.detail}\n`);
        return EXIT.INVALID;
      }
      stderr(`mb ${verb}: internal error\n${e && e.stack ? e.stack : e}\n`);
      return EXIT.FAIL;
    }
  };

  const [first, ...rest] = argv;
  try {
    if (first === undefined) {
      stderr(helpText(await listCommands()));
      return EXIT.USAGE;
    }
    if (first === '--help' || first === '-h' || first === 'help') {
      if (first === 'help' && rest.length) return runCommand(rest[0], ['--help']);
      if (first !== 'help' && rest.length) throw exitError(EXIT.USAGE, `unexpected argument "${rest[0]}" after ${first}`);
      stdout(helpText(await listCommands()));
      return EXIT.OK;
    }
    if (first === '--version') {
      stdout(`${readBaseVersion(root)}\n`);
      return EXIT.OK;
    }
    if (first.startsWith('-')) throw exitError(EXIT.USAGE, `unknown option "${first}". Run "./mb --help".`);
  } catch (e) {
    if (e && Number.isInteger(e.exitCode)) {
      stderr(`mb: ${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
  return runCommand(first, rest);
}

// Run only when executed directly (not when imported by tests or other commands).
function isMain() {
  if (!process.argv[1]) return false;
  try {
    const norm = (p) => (process.platform === 'win32' ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync(p));
    return norm(process.argv[1]) === norm(SELF);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`mb: internal error\n${e && e.stack ? e.stack : e}\n`); process.exitCode = 1; },
  );
}
