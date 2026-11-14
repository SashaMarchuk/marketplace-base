// CHK-14: eval coverage (SPEC sections 15.1, 12). Each skill has >= 1 trigger case (a grader with
// type tool_used, tool Skill, an input_match naming the skill, min absent or >= 1) and >= 1
// no-trigger case (same grader with min 0, max 0, arm both). Every prompt.md frontmatter key is in
// the native `claude plugin eval` set (an unknown key fails the native runner).
import { walk } from '../fsx.mjs';

export const id = 'CHK-14';
export const severity = 'error';
export const title = 'Each skill has >= 1 trigger case (`tool_used`, `tool: Skill`, `input_match` naming it, `min` >= 1) and >= 1 no-trigger case (`min: 0`, `max: 0`, `arm: both`); `prompt.md` frontmatter keys within the native set';
export const fix = './mb new skill scaffolds both';

const PROMPT_KEYS = new Set(['name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function names(grader, skill) {
  return typeof grader.input_match === 'string'
    && new RegExp(`(^|[^a-z0-9-])${esc(skill)}($|[^a-z0-9-])`).test(grader.input_match);
}

export function run(rctx) {
  const out = [];
  for (const p of rctx.plugins) {
    const graders = []; // { caseName, data }
    const evalsDir = `${p.dir}/evals`;
    const files = walk(rctx.abs(evalsDir));
    const cases = [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))];
    for (const c of cases) {
      const prompt = `${evalsDir}/${c}/prompt.md`;
      if (!rctx.exists(prompt)) {
        out.push({ path: `${evalsDir}/${c}`, message: 'eval case has no prompt.md' });
        continue;
      }
      const fm = rctx.frontmatter(rctx.readText(prompt));
      if (fm.error && fm.data === null) {
        // Frontmatter is optional for prompt.md; only a broken block is an error.
        if (/^---/.test(rctx.readText(prompt))) out.push({ path: prompt, message: fm.error });
      } else {
        if (fm.error) out.push({ path: prompt, message: fm.error });
        for (const k of Object.keys(fm.data)) {
          if (!PROMPT_KEYS.has(k)) out.push({ path: prompt, message: `prompt.md frontmatter key "${k}" is not in the native set (${[...PROMPT_KEYS].join(', ')})`, fix: 'remove the key; the native runner rejects unknown keys' });
        }
      }
      for (const f of files.filter((x) => x.startsWith(`${c}/graders/`) && x.endsWith('.md'))) {
        const g = rctx.frontmatter(rctx.readText(`${evalsDir}/${f}`));
        if (g.data) graders.push({ caseName: c, data: g.data });
      }
    }
    for (const s of rctx.skills(p)) {
      const skillGraders = graders.filter((g) => g.data.type === 'tool_used' && g.data.tool === 'Skill' && names(g.data, s));
      const trigger = skillGraders.some((g) => g.data.min === undefined || Number(g.data.min) >= 1);
      const noTrigger = skillGraders.some((g) => Number(g.data.min) === 0 && Number(g.data.max) === 0 && g.data.arm === 'both');
      const where = `${p.dir}/skills/${s}`;
      if (!trigger) out.push({ path: where, message: `skill "${s}" has no trigger eval case (tool_used Skill grader naming it, min >= 1)` });
      if (!noTrigger) out.push({ path: where, message: `skill "${s}" has no no-trigger eval case (tool_used Skill grader naming it, min 0, max 0, arm both)` });
    }
  }
  return out;
}
