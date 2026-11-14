// CHK-04: SKILL.md frontmatter: name == dir, kebab <= 64; description 1-1024;
// only the Agent Skills keys. Known host-only keys (HOST_ONLY, Claude Code) are a warning, not an
// error: a skill may use them, Codex ignores them. Also one warning per SKILL.md that still contains
// "TODO" (the `mb new skill` scaffold body), so an unfinished skill is visible but not blocking.
// [integrator] An unquoted top-level value containing ": " is an error (strict YAML rejects it).

export const id = 'CHK-04';
export const severity = 'error';
export const title = 'SKILL.md frontmatter: `name` == dir, kebab <= 64; `description` 1-1024; only allowed keys (`name, description, license, compatibility, metadata`); host-only keys (`user-invocable`, `disable-model-invocation`, `allowed-tools`, `argument-hint`, `model`) are a warning; no `: ` in an unquoted value. A SKILL.md that still contains `TODO` gets one warning';
export const fix = 'move host-specific keys out of frontmatter';

const ALLOWED = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
// Claude Code reads these; Codex ignores them. Allowed with a warning so the portability cost is visible.
const HOST_ONLY = new Set(['user-invocable', 'disable-model-invocation', 'allowed-tools', 'argument-hint', 'model']);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function frontmatterLines(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1].split(/\r?\n/) : [];
}

export function run(rctx) {
  const out = [];
  for (const p of rctx.plugins) {
    for (const s of rctx.skills(p)) {
      const rel = `${p.dir}/skills/${s}/SKILL.md`;
      if (!rctx.exists(rel)) {
        out.push({ path: rel, message: 'missing SKILL.md', fix: `./mb new skill ${p.name}/${s} "<description>"` });
        continue;
      }
      const text = rctx.readText(rel);
      const { data, error } = rctx.frontmatter(text);
      if (error) {
        out.push({ path: rel, message: error });
        if (!data) continue;
      }
      // Strict YAML parsers reject `: ` inside an unquoted scalar; quote such values.
      for (const line of frontmatterLines(text)) {
        const m = /^([A-Za-z0-9_-]+):[ \t]+([^'"[{>|].*)$/.exec(line);
        if (m && /:\s/.test(m[2])) out.push({ path: rel, message: `frontmatter "${m[1]}" has ": " in an unquoted value (invalid YAML)`, fix: 'wrap the value in double quotes' });
      }
      for (const k of Object.keys(data)) {
        if (HOST_ONLY.has(k)) out.push({ path: rel, severity: 'warning', message: `frontmatter key "${k}" is host-specific (ignored by Codex)`, fix: 'keep it only if the Claude-only behaviour is intended' });
        else if (!ALLOWED.has(k)) out.push({ path: rel, message: `frontmatter key "${k}" is not an Agent Skills key` });
      }
      if (data.name !== s) out.push({ path: rel, message: `name "${data.name ?? ''}" differs from its directory "${s}"`, fix: 'rename the skill dir or the name' });
      if (!KEBAB.test(s) || s.length > 64) out.push({ path: rel, message: `skill name "${s}" must be kebab-case, at most 64 chars`, fix: 'rename the skill dir' });
      const d = data.description;
      if (typeof d !== 'string' || d.length < 1 || d.length > 1024) {
        out.push({ path: rel, message: 'description must be a string of 1-1024 characters', fix: 'write a one-paragraph description with "Use when ..."' });
      }
      if (/\bTODO\b/.test(text)) out.push({ path: rel, severity: 'warning', message: 'SKILL.md still contains TODO', fix: 'finish the skill body' });
    }
  }
  return out;
}
