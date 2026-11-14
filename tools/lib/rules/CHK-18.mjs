// CHK-18: `claude plugin validate --strict` on the generated marketplace root and on each plugin,
// with a throwaway CLAUDE_CONFIG_DIR. Skipped (info) when `claude` is not on PATH
// locally; an error in CI (env CI set), where the host CLI is installed first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const id = 'CHK-18';
export const severity = 'error';
export const title = '`claude plugin validate --strict` on the root and on each plugin, with `CLAUDE_CONFIG_DIR=<tmp>`; skipped (I) if `claude` is absent locally, required in CI';
export const fix = 'see the validator message';
export const slow = true;

/** Absolute path of `claude` on rctx.env.PATH (PATHEXT on Windows), or null. */
function findClaude(env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(dir, `claude${ext}`);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch { /* not here */ }
    }
  }
  return null;
}

function validateDir(rctx, bin, dir, configDir) {
  return spawnSync(bin, ['plugin', 'validate', '--strict', dir], {
    env: { ...rctx.env, CLAUDE_CONFIG_DIR: configDir },
    encoding: 'utf8',
    windowsHide: true,
    shell: /\.(cmd|bat)$/i.test(bin), // npm installs a .cmd shim on Windows
    timeout: 120000,
  });
}

export function run(rctx) {
  const targets = [];
  // An empty marketplace (e.g. `init --examples none` before the first plugin) is valid for us,
  // but the host validator warns "no plugins defined" and --strict turns that into an error: skip it.
  if (rctx.exists('.claude-plugin/marketplace.json') && rctx.plugins.length) targets.push('.');
  for (const p of rctx.plugins) if (rctx.exists(`${p.dir}/.claude-plugin/plugin.json`)) targets.push(p.dir);
  if (!targets.length) return []; // nothing generated yet: CHK-10 reports it

  const bin = findClaude(rctx.env);
  if (!bin) {
    return rctx.env.CI
      ? [{ path: '.', message: '`claude` is not installed; CI must install the pinned host CLI before mb check', fix: 'npm i -g @anthropic-ai/claude-code@<pinned>' }]
      : [{ path: '.', severity: 'info', message: 'skipped: `claude` is not on PATH', fix: 'install Claude Code to run the validator locally' }];
  }
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-claude-config-'));
  const out = [];
  try {
    for (const t of targets) {
      const r = validateDir(rctx, bin, rctx.abs(t), configDir);
      if (r.error) throw r.error;
      if (r.status !== 0) {
        const msg = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').filter(Boolean).slice(0, 8).join(' | ');
        out.push({ path: t === '.' ? '.claude-plugin/marketplace.json' : `${t}/.claude-plugin/plugin.json`, message: `claude plugin validate --strict failed (exit ${r.status}): ${msg}` });
      }
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
  return out;
}
