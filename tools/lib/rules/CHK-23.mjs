// CHK-23: G markers. Each expected marker pair appears exactly once, well-formed and
// in the file's style: README (catalog, install), USAGE (config-locations), AGENTS (agents),
// .gitignore (gitignore, hash style), and the SKILL.md of every configurable skill (config).
// Any marker problem in another SKILL.md is reported too.
import { MARKER_FILES, findMarkers } from '../markers.mjs';

export const id = 'CHK-23';
export const severity = 'error';
export const title = 'Each G marker pair appears exactly once and is well-formed';
export const fix = 'restore markers from tools/templates';

function checkFile(rctx, rel, spec, out) {
  if (!rctx.exists(rel)) {
    out.push({ path: rel, message: `missing (must contain markers: ${spec.ids.join(', ')})` });
    return;
  }
  const { pairs, problems } = findMarkers(rctx.readText(rel));
  for (const p of problems) out.push({ path: rel, message: `${rel}:${p.line}: marker "${p.id}": ${p.problem}` });
  for (const id of spec.ids) {
    const n = pairs.filter((p) => p.id === id).length;
    const bad = pairs.filter((p) => p.id === id && p.style !== spec.style).length;
    if (n === 0 && !problems.some((p) => p.id === id)) out.push({ path: rel, message: `marker "${id}" is missing` });
    if (bad) out.push({ path: rel, message: `marker "${id}" must use the ${spec.style === 'hash' ? '# mb:<id>:begin' : '<!-- mb:<id>:begin -->'} form` });
  }
  for (const p of pairs) {
    if (!spec.ids.includes(p.id)) out.push({ path: rel, message: `${rel}:${p.line}: unexpected marker "${p.id}"` });
  }
}

export function run(rctx) {
  const out = [];
  const skillSpec = MARKER_FILES.find((s) => s.basename);
  for (const spec of MARKER_FILES.filter((s) => !s.basename)) checkFile(rctx, spec.file, spec, out);
  for (const p of rctx.plugins) {
    const configurable = rctx.configurable(p);
    for (const s of rctx.skills(p)) {
      const rel = `${p.dir}/skills/${s}/SKILL.md`;
      if (configurable) checkFile(rctx, rel, skillSpec, out);
      else if (rctx.exists(rel)) {
        const { pairs, problems } = findMarkers(rctx.readText(rel));
        for (const x of problems) out.push({ path: rel, message: `${rel}:${x.line}: marker "${x.id}": ${x.problem}` });
        if (pairs.some((x) => x.id === 'config')) out.push({ path: rel, message: 'config marker in a skill of a plugin without config.defaults.json', fix: './mb gen' });
      }
    }
  }
  return out;
}
