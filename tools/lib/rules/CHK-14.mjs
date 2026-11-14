// CHK-14: eval coverage. Each skill has >= 1 trigger case (a grader with
// type tool_used, tool Skill, an input_match naming the skill, min absent or >= 1) and >= 1
// no-trigger case (same grader with min 0, max 0, arm both). Every prompt.md frontmatter key is in
// the native `claude plugin eval` set (an unknown key fails the native runner). Every grader has a
// native `type` and that type's key option (an unknown type would be SKIPPED, a regex without a
// pattern would match anything).
// A `---` inside a prompt.md or grader frontmatter is an error: the native loader ends the
// frontmatter at the first `---`, even mid-line (`# a |---| b`), while our parser does not.
// Warnings for documented eval rules: a prompt.md still holding the scaffold placeholder text, and
// more than one grader in a `config-respected` case (docs/base/evals.md: a config case has ONE grader).
import { walk } from '../fsx.mjs';

export const id = 'CHK-14';
export const severity = 'error';
export const title = 'Each skill has >= 1 trigger case (`tool_used`, `tool: Skill`, `input_match` naming it, `min` >= 1) and >= 1 no-trigger case (`min: 0`, `max: 0`, `arm: both`); `prompt.md` frontmatter keys within the native set; no `---` inside a frontmatter block; warns on a scaffold placeholder prompt and on more than one grader in `config-respected`';
export const fix = './mb new skill scaffolds both';

const PROMPT_KEYS = new Set(['name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']);
// Native grader types and the option each one cannot do without (docs/base/evals.md#graders).
const GRADER_TYPES = { regex: 'pattern', tool_used: 'tool', tool_order: null, file_exists: 'path', llm: null, baseline: null };
const GRADER_FIX = 'see docs/base/evals.md#graders';
const PLACEHOLDER = /^Replace this text/; // first words of the scaffold prompts (tools/templates/evals)

/** The first frontmatter line containing `---`, or null. */
function dashLine(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? (m[1].split(/\r?\n/).find((l) => l.includes('---')) ?? null) : null;
}
const DASH_FIX = 'remove "---" from the frontmatter (the native loader ends the frontmatter there)';

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
      const ptext = rctx.readText(prompt);
      const pdash = dashLine(ptext);
      if (pdash !== null) out.push({ path: prompt, message: `frontmatter line "${pdash}" contains "---"`, fix: DASH_FIX });
      const body = ptext.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
      if (PLACEHOLDER.test(body)) out.push({ path: prompt, severity: 'warning', message: 'prompt.md still holds the scaffold placeholder text', fix: 'replace it with a realistic user request' });
      const fm = rctx.frontmatter(ptext);
      if (fm.error && fm.data === null) {
        // Frontmatter is optional for prompt.md; only a broken block is an error.
        if (/^---/.test(rctx.readText(prompt))) out.push({ path: prompt, message: fm.error });
      } else {
        if (fm.error) out.push({ path: prompt, message: fm.error });
        for (const k of Object.keys(fm.data)) {
          if (!PROMPT_KEYS.has(k)) out.push({ path: prompt, message: `prompt.md frontmatter key "${k}" is not in the native set (${[...PROMPT_KEYS].join(', ')})`, fix: 'remove the key; the native runner rejects unknown keys' });
        }
      }
      const graderFiles = files.filter((x) => x.startsWith(`${c}/graders/`) && x.endsWith('.md'));
      if (c === 'config-respected' && graderFiles.length > 1) {
        out.push({ path: `${evalsDir}/${c}/graders`, severity: 'warning', message: `config case has ${graderFiles.length} graders; it should have ONE (the visible effect of the setting)`, fix: 'keep only the grader that checks the setting (docs/base/evals.md#config-cases)' });
      }
      for (const f of graderFiles) {
        const gpath = `${evalsDir}/${f}`;
        const gtext = rctx.readText(gpath);
        const gdash = dashLine(gtext);
        if (gdash !== null) out.push({ path: gpath, message: `frontmatter line "${gdash}" contains "---"`, fix: DASH_FIX });
        const g = rctx.frontmatter(gtext);
        if (!g.data) {
          out.push({ path: gpath, message: `grader has no valid frontmatter${g.error ? ` (${g.error})` : ''}`, fix: GRADER_FIX });
          continue;
        }
        graders.push({ caseName: c, data: g.data });
        const type = g.data.type;
        if (typeof type !== 'string' || !Object.hasOwn(GRADER_TYPES, type)) {
          out.push({ path: gpath, message: `grader type ${type === undefined ? 'is missing' : `"${type}" is not a native type`} (${Object.keys(GRADER_TYPES).join(', ')})`, fix: GRADER_FIX });
          continue;
        }
        const need = GRADER_TYPES[type];
        if (need && (g.data[need] === undefined || g.data[need] === '')) {
          out.push({ path: gpath, message: `${type} grader has no "${need}"`, fix: GRADER_FIX });
        }
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
