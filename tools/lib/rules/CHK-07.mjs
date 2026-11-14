// CHK-07: no host variables or absolute home paths under a plugin's skills/.
// Whole-line comments in script files (SCRIPT_EXT; `//`, `#` but not `#!`, `/*`, `*`)
// are skipped: a comment describing a path form is not a path the code uses. Code lines and every
// line of any other file (markdown prose, spans, fences; .txt) are still checked, because an agent follows them.
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

const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|sh|bash|py|rb|ps1)$/i;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!!))/;

export function run(rctx) {
  const out = [];
  for (const p of rctx.plugins) {
    const skillsDir = `${p.dir}/skills`;
    for (const f of walk(rctx.abs(skillsDir))) {
      const rel = `${skillsDir}/${f}`;
      let buf;
      try { buf = rctx.readBytes(rel); } catch { continue; } // dangling symlink: CHK-08
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      const script = SCRIPT_EXT.test(f);
      buf.toString('utf8').split('\n').forEach((line, i) => {
        if (script && COMMENT_LINE.test(line)) return;
        for (const [label, re] of PATTERNS) if (re.test(line)) out.push({ path: rel, message: `${rel}:${i + 1}: ${label}` });
      });
    }
  }
  return out;
}
