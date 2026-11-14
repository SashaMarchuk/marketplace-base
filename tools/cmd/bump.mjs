// tools/cmd/bump.mjs: `mb bump <p>|--changed [patch|minor|major]`.
// Edits only the "version" string of plugin.src.json in place, so the hand-edited formatting stays.
// Then runs `./mb gen` (the version is stamped into generated manifests), or says to.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../kit/json.mjs';
import { readBytes, readText, writeFileAtomic } from '../lib/fsx.mjs';
import { main } from '../mb.mjs';
import { findPlugin, isKebab } from './new.mjs';

export const name = 'bump';
export const summary = 'Increase a plugin version in plugin.src.json (--changed: every plugin failing CHK-15).';
export const usage = 'mb bump <p>|--changed [patch|minor|major]';
export const options = { changed: { type: 'boolean' } };

const LEVELS = ['patch', 'minor', 'major'];
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function nextVersion(version, level) {
  const m = SEMVER.exec(version);
  if (!m) return null;
  let [maj, min, pat] = m.slice(1).map(Number);
  if (level === 'major') [maj, min, pat] = [maj + 1, 0, 0];
  else if (level === 'minor') [min, pat] = [min + 1, 0];
  else pat += 1;
  return `${maj}.${min}.${pat}`;
}

/**
 * Plugins with a CHK-15 error, from `check --json` run in-process with captured output.
 * CHK-15 result paths start with plugins/<p> or examples/plugins/<p>.
 */
export async function changedPlugins(ctx, runCheck = defaultRunCheck) {
  const cmds = await ctx.listCommands();
  if (!cmds.some((c) => c.name === 'check')) throw ctx.fail(1, '--changed needs ./mb check (tools/cmd/check.mjs)');
  const { code, out } = await runCheck(ctx);
  let res;
  try {
    res = parse(out);
  } catch {
    throw ctx.fail(1, `./mb check --json printed no JSON (exit ${code})`);
  }
  const names = new Set();
  for (const r of res.results ?? []) {
    if (r.id !== 'CHK-15' || r.severity !== 'error') continue;
    const m = /^(?:examples\/)?plugins\/([^/]+)/.exec(r.path ?? '');
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

/** Run `check --json --fast` in-process with stdout captured (ctx.runCommand shares our stdout). */
async function defaultRunCheck(ctx) {
  let out = '';
  const code = await main(['check', '--json', '--fast'], {
    root: ctx.root, cwd: ctx.cwd, cmdDir: path.dirname(fileURLToPath(import.meta.url)),
    stdout: (t) => { out += t; }, stderr: ctx.stderr,
  });
  return { code, out };
}

export async function run(argv, ctx) {
  const pos = ctx.args.positionals;
  const changed = Boolean(ctx.args.values.changed);
  const target = changed ? null : pos[0];
  const levelArg = changed ? pos[0] : pos[1];
  const maxArgs = changed ? 1 : 2;
  if (!changed && target === undefined) throw ctx.usageError('name a plugin or pass --changed');
  if (pos.length > maxArgs) throw ctx.usageError(`unexpected argument "${pos[maxArgs]}"`);
  const level = levelArg ?? 'patch';
  if (!LEVELS.includes(level)) throw ctx.usageError(`level must be patch, minor or major, got "${level}"`);
  if (!changed && !isKebab(target)) throw ctx.usageError(`bad plugin name "${target}"`);

  const names = changed ? await changedPlugins(ctx) : [target];
  if (changed && names.length === 0) {
    ctx.stdout('no plugin needs a version bump\n');
    return 0;
  }
  // Validate every target before editing any of them.
  const jobs = names.map((p) => {
    const pl = findPlugin(ctx.root, p);
    if (!pl) throw ctx.fail(1, `no plugin "${p}" (plugins/${p}/plugin.src.json)`);
    if (pl.example && !ctx.isBase()) {
      throw ctx.fail(1, `${pl.rel} is an example plugin owned by the base: run "./mb adopt ${p}" first`);
    }
    const file = path.join(pl.dir, 'plugin.src.json');
    const src = parse(readBytes(file));
    const next = nextVersion(src.version, level);
    if (!next) throw ctx.fail(3, `${pl.rel}/plugin.src.json: "version" must be MAJOR.MINOR.PATCH`);
    return { pl, file, from: src.version, to: next };
  });
  for (const j of jobs) {
    const text = readText(j.file);
    const re = new RegExp(`("version"\\s*:\\s*)"${j.from.replace(/\./g, '\\.')}"`);
    if (!re.test(text)) throw ctx.fail(1, `${j.pl.rel}/plugin.src.json: could not find the version string to edit`);
    const next = text.replace(re, `$1"${j.to}"`);
    parse(next); // sanity: still one valid document
    writeFileAtomic(j.file, next);
    ctx.stdout(`${j.pl.name}: ${j.from} -> ${j.to}\n`);
  }
  if (!(await ctx.listCommands()).some((c) => c.name === 'gen')) {
    ctx.stdout('next: ./mb gen\n');
    return 0;
  }
  return ctx.runCommand('gen', []);
}
