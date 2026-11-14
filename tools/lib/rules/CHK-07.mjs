// CHK-07: no host variables or absolute home paths under a plugin's skills/ (SPEC sections 10, 12).
import { walk } from '../fsx.mjs';

export const id = 'CHK-07';
export const severity = 'error';
export const title = 'No host variables or absolute home paths under `skills/`: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${PLUGIN_ROOT}`, `$CODEX_HOME`, `/Users/`, `/home/<x>/`, `C:\\Users\\`';
export const fix = 'use `<skill-dir>/…`';

const PATTERNS = [
  ['host variable ${CLAUDE_PLUGIN_ROOT}', /\$\{CLAUDE_PLUGIN_ROOT\}/],
  ['host variable ${CLAUDE_PLUGIN_DATA}', /\$\{CLAUDE_PLUGIN_DATA\}/],
  ['host variable ${PLUGIN_ROOT}', /\$\{PLUGIN_ROOT\}/],
  ['host variable $CODEX_HOME', /\$\{?CODEX_HOME\b/],
  ['absolute home path /Users/', /\/Users\//],
  ['absolute home path /home/<x>/', /\/home\/[^/\s]+\//],
  ['absolute home path C:\\Users\\', /[A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\)/i],
];

export function run(rctx) {
  const out = [];
  for (const p of rctx.plugins) {
    const skillsDir = `${p.dir}/skills`;
    for (const f of walk(rctx.abs(skillsDir))) {
      const rel = `${skillsDir}/${f}`;
      let buf;
      try { buf = rctx.readBytes(rel); } catch { continue; } // dangling symlink: CHK-08
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      buf.toString('utf8').split('\n').forEach((line, i) => {
        for (const [label, re] of PATTERNS) if (re.test(line)) out.push({ path: rel, message: `${rel}:${i + 1}: ${label}` });
      });
    }
  }
  return out;
}
