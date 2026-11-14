// tools/cmd/policy.mjs: `mb policy emit --host claude|codex [--team t] [--out dir]` (SPEC §13).
//
// Inputs: policy/org.json (+ policy/teams/<t>.json with --team), the catalog (plugins that reach the
// marketplaces) and marketplace.config.json `distribution` + `policyEmit`. Tier a only.
// Output: dist/policy/<host>/<org|team-t>/ (or --out <dir>, taken as the final directory) with SHA256SUMS.
// Exit 3: invalid policy, unknown team file, missing or invalid marketplace.config.json / distribution.
// stdout: the written files, then the guarantee table, ending with the honesty sentence.

import path from 'node:path';
import { fromPosix, writeFileAtomic, removePath, isDir } from '../lib/fsx.mjs';
import { loadRepo } from '../lib/gen/repo.mjs';
import { loadPolicy, TEAM_NAME } from '../lib/policy/load.mjs';
import { decide } from '../lib/policy/decide.mjs';
import { renderHost, guaranteeReport } from '../lib/policy/render.mjs';

export const name = 'policy';
export const summary = 'Emit host-native policy files (Claude managed settings, Codex requirements).';
export const usage = 'mb policy emit --host claude|codex [--team t] [--out dir]';
export const options = { host: { type: 'string' }, team: { type: 'string' }, out: { type: 'string' } };

const HOSTS = ['claude', 'codex'];
// Files an emit may write; removed from an --out dir first so a stale file never survives a re-run.
const knownFiles = (mkt) => [`managed-settings.d/50-${mkt}.json`, 'requirements.toml', 'README.txt', 'SHA256SUMS'];

export async function run(argv, ctx) {
  const [sub, ...extra] = ctx.args.positionals;
  if (sub !== 'emit') throw ctx.usageError(sub === undefined ? 'missing "emit"' : `unknown sub-command "${sub}" (expected emit)`);
  if (extra.length) throw ctx.usageError(`unexpected argument "${extra[0]}"`);
  const { host, team = null, out } = ctx.args.values;
  if (!HOSTS.includes(host)) throw ctx.usageError(host === undefined ? 'missing --host' : `unknown host "${host}" (expected claude or codex)`);
  if (team !== null && !TEAM_NAME.test(team)) throw ctx.usageError(`--team "${team}" must match ${TEAM_NAME.source}`);

  const repo = loadRepo(ctx.root); // throws GenError (exit 3) on an invalid config or plugin source
  const dist = repo.config.distribution;
  if (!dist) throw ctx.fail(3, 'marketplace.config.json has no "distribution" ({"source":"github","repo":"<owner>/<repo>"}); policy emit needs it');
  const marketplaceOnly = repo.config.policyEmit?.marketplaceOnly ?? false;

  const policy = loadPolicy(ctx.root, team); // throws PolicyError (exit 3)
  for (const w of policy.warnings) ctx.stderr(`warning: ${w.code}: ${w.file}: "${w.key}" is honoured only in personal layers; ignored\n`);
  const decision = decide(repo.included.map((p) => p.name), policy.layers);
  for (const p of decision.unknownPlugins) ctx.stderr(`warning: enforced.plugins.${p} names no plugin in the catalog; nothing emitted for it\n`);

  const scope = team === null ? 'org' : `team-${team}`;
  const files = renderHost({ host, scope, mkt: repo.mkt, repo: dist.repo, marketplaceOnly, decision });

  const outDir = out !== undefined ? path.resolve(ctx.cwd, out) : fromPosix(ctx.root, `dist/policy/${host}/${scope}`);
  if (out === undefined) {
    if (isDir(outDir)) removePath(outDir); // our own dir under dist/: start clean
  } else {
    for (const rel of knownFiles(repo.mkt)) removePath(path.join(outDir, ...rel.split('/')));
  }
  for (const rel of Object.keys(files).sort()) writeFileAtomic(path.join(outDir, ...rel.split('/')), files[rel]);

  ctx.stdout(`policy emit: ${host} ${scope} -> ${out !== undefined ? outDir : `dist/policy/${host}/${scope}`}\n`);
  for (const rel of Object.keys(files).sort()) ctx.stdout(`  wrote ${rel}\n`);
  ctx.stdout(guaranteeReport());
  return 0;
}
