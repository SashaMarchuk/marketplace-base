// CHK-22: portability of plugin text files (SPEC sections 12, 18). Text files under plugins/ and
// examples/ use LF line endings, and skill scripts are invoked through an interpreter
// (`sh <skill-dir>/scripts/x`), never directly (no reliance on the exec bit, which Windows and some
// installs drop). A direct invocation = an inline code span or a fenced code line that STARTS with
// `./scripts/` or `<skill-dir>/scripts/` (optionally quoted).

export const id = 'CHK-22';
export const severity = 'error';
export const title = 'Text files under `plugins/` and `examples/` are LF; scripts invoked as `sh <skill-dir>/scripts/x` (no exec-bit reliance)';
export const fix = 'git add --renormalize';

const SCOPE = /^(plugins|examples)\//;
const DIRECT = /^["']?(?:\.\/|<skill-dir>\/)scripts\//;

export function run(rctx) {
  const out = [];
  for (const rel of rctx.files) {
    if (!SCOPE.test(rel)) continue;
    let buf;
    try { buf = rctx.readBytes(rel); } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString('utf8');
    if (text.includes('\r')) out.push({ path: rel, message: 'CRLF or CR line endings (must be LF)' });
    if (!rel.endsWith('.md')) continue;
    let inFence = false;
    text.split('\n').forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
      const snippets = inFence ? [line.trim()] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
      for (const s of snippets) {
        if (DIRECT.test(s)) out.push({ path: rel, message: `${rel}:${i + 1}: script run directly ("${s}")`, fix: 'run it as `sh <skill-dir>/scripts/x` (or node/python3 ...)' });
      }
    });
  }
  return out;
}
