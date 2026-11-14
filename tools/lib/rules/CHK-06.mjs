// CHK-06: SKILL.md <= 500 lines; every relative markdown link target, and every backticked path
// starting with scripts/, references/ or assets/, exists inside the skill dir.
// Fenced code blocks are skipped (examples there are not references). Markdown links inside inline
// code spans are skipped too (`[t](u)` in backticks is literal text); backticked paths are still checked.
import path from 'node:path';

export const id = 'CHK-06';
export const severity = 'error';
export const title = 'SKILL.md <= 500 lines; every relative markdown link target, and every backticked path starting with `scripts/`, `references/` or `assets/`, exists inside the skill dir';
export const fix = 'move detail to references/';

const LINK_RE = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g;
const TICK_RE = /`((?:scripts|references|assets)\/[^`\s]*)`/g;

function stripFences(text) {
  let inFence = false;
  return text.split('\n').map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return ''; }
    return inFence ? '' : l;
  }).join('\n');
}

export function run(rctx) {
  const out = [];
  for (const p of rctx.plugins) {
    for (const s of rctx.skills(p)) {
      const dir = `${p.dir}/skills/${s}`;
      const rel = `${dir}/SKILL.md`;
      if (!rctx.exists(rel)) continue; // CHK-04
      const text = rctx.readText(rel);
      const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      if (lines > 500) out.push({ path: rel, message: `SKILL.md has ${lines} lines (max 500)` });
      const body = stripFences(text);
      const targets = [];
      for (const m of body.replace(/`[^`\n]*`/g, '').matchAll(LINK_RE)) {
        const t = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#') || t.startsWith('/')) continue;
        targets.push(t);
      }
      for (const m of body.matchAll(TICK_RE)) targets.push(m[1]);
      for (const t of targets) {
        let clean = t.replace(/[#?].*$/, '');
        try { clean = decodeURI(clean); } catch { /* keep raw */ }
        if (!clean) continue;
        const target = path.posix.normalize(path.posix.join(dir, clean));
        if (target !== dir && !target.startsWith(dir + '/')) {
          out.push({ path: rel, message: `link "${t}" points outside the skill dir`, fix: 'copy the file into the skill dir' });
        } else if (!rctx.exists(target)) {
          out.push({ path: rel, message: `link "${t}" does not exist in the skill dir` });
        }
      }
    }
  }
  return out;
}
