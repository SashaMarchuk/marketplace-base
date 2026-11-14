// CHK-21: OpenSpec shape (SPEC sections 12, 19). Each openspec/specs/*/spec.md has >= 1
// "### Requirement:" and each requirement >= 1 "#### Scenario:". Requirements in the base's mb-*
// specs carry an ID `MB-<CAP>-NNN`; IDs are unique across all specs. Cited runners exist:
// "(vector <NNN-slug>)" -> tools/kit/vectors/<NNN-slug>/, "(test <path>)" -> that file; base (mb-*)
// specs never cite examples/ files (ORCH O18).

export const id = 'CHK-21';
export const severity = 'error';
export const title = 'OpenSpec shape: each `openspec/specs/*/spec.md` has >= 1 `### Requirement:` and each requirement >= 1 `#### Scenario:`; base IDs `MB-<CAP>-NNN` unique; cited vector and test files exist';
export const fix = 'see openspec/config.yaml';

const SPEC_RE = /^openspec\/specs\/([^/]+)\/spec\.md$/;
const ID_RE = /\bMB-[A-Z]+-\d{3}\b/;
const CITE_RE = /\((vector|test)\s+`?([^)`\s]+)`?\)/g;

export function run(rctx) {
  const out = [];
  const ids = new Map(); // id -> first location
  let inFence = false;
  for (const rel of rctx.files.filter((f) => SPEC_RE.test(f))) {
    const cap = SPEC_RE.exec(rel)[1];
    const lines = rctx.readText(rel).split('\n');
    const reqs = []; // { title, line, scenarios }
    let cur = null;
    inFence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      if (inFence) return;
      const req = /^### Requirement:\s*(.*)$/.exec(l);
      if (req) {
        cur = { title: req[1].trim(), line: i + 1, scenarios: 0 };
        reqs.push(cur);
      } else if (/^#### Scenario:/.test(l)) {
        if (cur) cur.scenarios++;
      } else if (/^#{1,3} /.test(l)) {
        cur = null;
      }
      for (const m of l.matchAll(CITE_RE)) {
        const target = m[1] === 'vector' ? `tools/kit/vectors/${m[2]}` : m[2];
        if (!rctx.exists(target)) out.push({ path: rel, message: `${rel}:${i + 1}: cited ${m[1]} "${m[2]}" does not exist` });
        // Examples can be deleted or adopted in a derived repo, so base specs cite base files only.
        else if (cap.startsWith('mb-') && target.startsWith('examples/')) {
          out.push({ path: rel, message: `${rel}:${i + 1}: base spec cites example file "${m[2]}"; cite a tools/ test instead` });
        }
      }
    });
    if (!reqs.length) out.push({ path: rel, message: 'no "### Requirement:" heading' });
    for (const r of reqs) {
      const where = `${rel}:${r.line}`;
      if (!r.scenarios) out.push({ path: rel, message: `${where}: requirement "${r.title}" has no "#### Scenario:"` });
      const idm = ID_RE.exec(r.title);
      if (cap.startsWith('mb-') && !(idm && r.title.startsWith(idm[0]))) {
        out.push({ path: rel, message: `${where}: base requirement title must start with its ID MB-<CAP>-NNN` });
      }
      if (idm) {
        if (ids.has(idm[0])) out.push({ path: rel, message: `${where}: duplicate requirement ID ${idm[0]} (first at ${ids.get(idm[0])})` });
        else ids.set(idm[0], where);
      }
    }
  }
  return out;
}
