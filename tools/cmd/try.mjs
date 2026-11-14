// tools/cmd/try.mjs: `mb try <p> --host claude|codex [prompt]` (SPEC §11, §15.3): a live smoke run.
// Claude: claude -p "<prompt>" --plugin-dir <pdir>.
// Codex: an isolated install (temp CODEX_HOME with a copied auth.json, marketplace add + plugin add)
// and `codex exec` in a temp git workdir. Never touches the real ~/.claude or ~/.codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isFile, readText, copyFile, removePath } from '../lib/fsx.mjs';
import { findPlugin, isConfigurable, isKebab, readMarketplaceConfig } from './new.mjs';

export const name = 'try';
export const summary = 'Live smoke run of one plugin on Claude Code or Codex.';
export const usage = 'mb try <p> --host claude|codex [prompt]';
export const options = { host: { type: 'string' } };

const DEFAULT_PROMPT = 'What can you help me with?';

/** The body of the plugin's first *-trigger eval case prompt (frontmatter stripped), or null. */
export function defaultPrompt(pluginDir) {
  const evals = path.join(pluginDir, 'evals');
  let cases = [];
  try {
    cases = fs.readdirSync(evals).filter((c) => /(^|-)trigger(-|$)/.test(c) && !/no-trigger/.test(c)).sort();
  } catch { /* no evals dir */ }
  for (const c of cases) {
    const f = path.join(evals, c, 'prompt.md');
    if (!isFile(f)) continue;
    const body = readText(f).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    if (body && !/^Replace this text/.test(body)) return body;
  }
  return null;
}

/** Spawn a CLI, stream its output through ctx, resolve to its exit code. ENOENT -> exit 7. */
function exec(ctx, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    child.stdout.on('data', (d) => (opts.quiet ? null : ctx.stdout(d.toString())));
    child.stderr.on('data', (d) => ctx.stderr(d.toString()));
    child.on('error', (e) => reject(e.code === 'ENOENT' ? ctx.fail(7, `"${cmd}" is not installed or not on PATH`) : e));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function tryClaude(ctx, pl, prompt) {
  const args = ['-p', prompt, '--plugin-dir', pl.dir];
  // Headless -p cannot answer a permission prompt; configurable skills must run their resolver.
  if (isConfigurable(pl.dir)) args.push('--allowedTools', 'Bash(node:*)');
  ctx.stderr(`$ claude ${args.map((a) => JSON.stringify(a)).join(' ')}\n`);
  return exec(ctx, 'claude', args);
}

async function tryCodex(ctx, pl, prompt) {
  const mkt = readMarketplaceConfig(ctx.root)?.name;
  if (!mkt) throw ctx.fail(3, 'marketplace.config.json#name is needed for the Codex install');
  if (!isFile(path.join(ctx.root, '.agents', 'plugins', 'marketplace.json'))) {
    throw ctx.fail(1, '.agents/plugins/marketplace.json is missing: run ./mb gen');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-try-'));
  try {
    const home = path.join(tmp, 'codex-home');
    const work = path.join(tmp, 'work');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const realHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const auth = path.join(realHome, 'auth.json');
    if (isFile(auth)) copyFile(auth, path.join(home, 'auth.json')); // read only; the copy is deleted below
    else ctx.stderr(`note: no ${auth}; Codex needs a login (or OPENAI_API_KEY)\n`);
    const env = { ...process.env, CODEX_HOME: home };
    for (const args of [['plugin', 'marketplace', 'add', ctx.root], ['plugin', 'add', `${pl.name}@${mkt}`]]) {
      ctx.stderr(`$ codex ${args.join(' ')}\n`);
      const code = await exec(ctx, 'codex', args, { env, quiet: true });
      if (code) return code;
    }
    const g = await exec(ctx, 'git', ['init', '-q'], { cwd: work, quiet: true });
    if (g) return g;
    const args = ['exec', '-s', 'workspace-write', '--ephemeral', '-C', work, prompt];
    ctx.stderr(`$ codex ${args.map((a) => JSON.stringify(a)).join(' ')}\n`);
    return await exec(ctx, 'codex', args, { env });
  } finally {
    removePath(tmp);
  }
}

export async function run(argv, ctx) {
  const [p, prompt, ...extra] = ctx.args.positionals;
  const host = ctx.args.values.host;
  if (p === undefined) throw ctx.usageError('missing plugin name');
  if (extra.length) throw ctx.usageError(`unexpected argument "${extra[0]}" (quote the prompt)`);
  if (host !== 'claude' && host !== 'codex') throw ctx.usageError('--host must be claude or codex');
  if (!isKebab(p)) throw ctx.usageError(`bad plugin name "${p}"`);
  const pl = findPlugin(ctx.root, p);
  if (!pl) throw ctx.fail(1, `no plugin "${p}"`);
  const manifest = host === 'claude' ? '.claude-plugin' : '.codex-plugin';
  if (!isFile(path.join(pl.dir, manifest, 'plugin.json'))) throw ctx.fail(1, `${pl.rel}/${manifest}/plugin.json is missing: run ./mb gen`);
  const text = prompt ?? defaultPrompt(pl.dir) ?? DEFAULT_PROMPT;
  return host === 'claude' ? tryClaude(ctx, pl, text) : tryCodex(ctx, pl, text);
}
