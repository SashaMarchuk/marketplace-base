// tools/cmd/config.mjs: `mb config resolve <p> [--skill s] [--cwd d] [--json]` (SPEC §11, §7.5).
// Runs the vendored tier-a resolver of one skill (<pdir>/skills/<s>/_mb/resolve.mjs) exactly as a
// skill would, and prints its result as a table (or raw with --json). Exits like the resolver.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, canonical } from '../kit/json.mjs';
import { isDir, isFile } from '../lib/fsx.mjs';
import { findPlugin, listSkills, isKebab } from './new.mjs';

export const name = 'config';
export const summary = 'Show the resolved configuration of a plugin (tier-a resolver).';
export const usage = 'mb config resolve <p> [--skill s] [--cwd d] [--json]';
export const options = { skill: { type: 'string' }, cwd: { type: 'string' }, json: { type: 'boolean' } };

/** Value at a JSON Pointer ("" = whole doc); undefined if absent. */
function getPointer(doc, ptr) {
  if (ptr === '') return doc;
  let cur = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function fmtCode(c) {
  return [c.code, c.layer && `layer=${c.layer}`, c.path && `path=${c.path}`].filter(Boolean).join(' ');
}

/** Human table: pointer, value, layer, locked; then blocked/warnings/errors lines. */
export function formatTable(out) {
  const locked = new Set(out.locked ?? []);
  const rows = Object.keys(out.provenance ?? {}).sort().map((ptr) => {
    const v = getPointer(out.settings ?? {}, ptr);
    return [ptr, v === undefined ? '(unset)' : canonical(v), out.provenance[ptr], locked.has(ptr) ? 'yes' : ''];
  });
  const head = ['pointer', 'value', 'layer', 'locked'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd() + '\n';
  let s = `plugin: ${out.plugin}  tier: ${out.tier}  ok: ${out.ok}  blocked: ${out.blocked}\n\n`;
  s += rows.length ? line(head) + line(w.map((n) => '-'.repeat(n))) + rows.map(line).join('') : '(no settings)\n';
  for (const wr of out.warnings ?? []) s += `warning: ${fmtCode(wr)}\n`;
  for (const er of out.errors ?? []) s += `error: ${fmtCode(er)}\n`;
  return s;
}

export async function run(argv, ctx) {
  const [sub, p, ...extra] = ctx.args.positionals;
  if (sub !== 'resolve') throw ctx.usageError(sub === undefined ? 'missing "resolve"' : `unknown subcommand "${sub}"`);
  if (p === undefined) throw ctx.usageError('missing plugin name');
  if (extra.length) throw ctx.usageError(`unexpected argument "${extra[0]}"`);
  if (!isKebab(p)) throw ctx.usageError(`bad plugin name "${p}"`);
  const v = ctx.args.values;

  const pl = findPlugin(ctx.root, p);
  if (!pl) throw ctx.fail(1, `no plugin "${p}"`);
  const resolverOf = (s) => path.join(pl.dir, 'skills', s, '_mb', 'resolve.mjs');
  let skill = v.skill;
  if (skill === undefined) {
    skill = listSkills(pl.dir).find((s) => isFile(resolverOf(s)));
    if (!skill) throw ctx.fail(1, `${pl.rel} has no configurable skill with _mb/ (no config.defaults.json, or run ./mb gen)`);
  } else if (!isFile(resolverOf(skill))) {
    throw ctx.fail(1, `${pl.rel}/skills/${skill}/_mb/resolve.mjs not found (run ./mb gen)`);
  }
  const cwd = v.cwd === undefined ? ctx.cwd : path.resolve(ctx.cwd, v.cwd);
  if (!isDir(cwd)) throw ctx.usageError(`--cwd ${v.cwd}: not a directory`);

  const r = spawnSync(process.execPath, [resolverOf(skill), '--plugin', p], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.stderr) ctx.stderr(r.stderr);
  const code = r.status ?? 1;
  if (v.json) {
    ctx.stdout(r.stdout);
    return code;
  }
  let out;
  try {
    out = parse(r.stdout.trim());
  } catch {
    ctx.stderr(`mb config: the resolver printed no JSON (exit ${code})\n${r.stdout}`);
    return code === 0 ? 1 : code;
  }
  ctx.stdout(`skill: ${skill}  cwd: ${cwd}\n` + formatTable(out));
  return code;
}
