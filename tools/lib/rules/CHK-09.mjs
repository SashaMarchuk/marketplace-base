// CHK-09: host-specific components in a plugin. Warning; error in examples,
// which must stay skills-only.
import { exists, fromPosix } from '../fsx.mjs';

export const id = 'CHK-09';
export const severity = 'warning';
export const title = 'Host-specific components (`commands/`, `agents/`, `hooks/`, `.mcp.json`, `mcp.json`, `bin/`): W (E in examples)';
export const fix = 'skills are the portable unit';

const HOST_SPECIFIC = ['commands', 'agents', 'hooks', '.mcp.json', 'mcp.json', 'bin'];

export function run(rctx) {
  const out = [];
  for (const p of rctx.plugins) {
    for (const n of HOST_SPECIFIC) {
      if (!exists(fromPosix(rctx.root, `${p.dir}/${n}`))) continue;
      out.push({
        path: `${p.dir}/${n}`,
        severity: p.example ? 'error' : 'warning',
        message: `host-specific component "${n}" works on one host only${p.example ? ' (examples must be skills-only)' : ''}`,
      });
    }
  }
  return out;
}
