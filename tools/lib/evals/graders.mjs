// tools/lib/evals/graders.mjs: load native eval cases and grade Codex runs.
//
// The Codex runner reads the same files as `claude plugin eval`. This module is pure: it gets the
// parsed `codex exec --json` stream, last.txt and the workdir file lists, and returns grader results.
// Mapping:
//   regex (target last_message)  -> last.txt          regex (target trace) -> the JSONL stream
//   file_exists                  -> workdir file list after the run (the before list is kept for reports)
//   tool_used Skill              -> command_execution items that read .../skills/<s>/SKILL.md (recorded streams in tools/tests/fixtures/evals/codex)
//   tool_used Bash               -> command_execution items; input_match on the command text
//   llm                          -> the judge callback (null = SKIPPED)
//   other tool_used, tool_order, baseline, unknown types -> SKIPPED
// SKIPPED never counts as a pass. A run whose graders are all skipped has no score; such a case FAILS.
import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter, parseYaml } from './frontmatter.mjs';
import { matchGlob } from '../ownership.mjs';

/** All case dirs of a plugin (dirs under evals/ with a prompt.md), sorted; filtered by a name glob. */
export function listCases(pluginDir, caseGlob) {
  const evals = path.join(pluginDir, 'evals');
  let names = [];
  try {
    names = fs.readdirSync(evals, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  return names
    .filter((n) => fs.existsSync(path.join(evals, n, 'prompt.md')))
    .filter((n) => !caseGlob || matchGlob(caseGlob, n))
    .map((n) => path.join(evals, n));
}

/** Read one case dir: prompt.md (frontmatter + body), optional case.yaml, graders/*.md (sorted). */
export function loadCase(caseDir) {
  const prompt = splitFrontmatter(fs.readFileSync(path.join(caseDir, 'prompt.md'), 'utf8'));
  const caseFile = path.join(caseDir, 'case.yaml');
  const caseYaml = fs.existsSync(caseFile) ? parseYaml(fs.readFileSync(caseFile, 'utf8')) ?? {} : null;
  const scaffoldRel = caseYaml?.context?.scaffold_script;
  const gdir = path.join(caseDir, 'graders');
  let gfiles = [];
  try {
    gfiles = fs.readdirSync(gdir).filter((f) => f.endsWith('.md')).sort();
  } catch { /* a case with no graders: every run is "all skipped" -> FAIL */ }
  const graders = gfiles.map((f) => {
    const { data, body } = splitFrontmatter(fs.readFileSync(path.join(gdir, f), 'utf8'));
    return { name: data.name ?? f.replace(/\.md$/, ''), ...data, criteria: body.trim() };
  });
  return {
    name: caseYaml?.name ?? path.basename(caseDir),
    dir: caseDir,
    meta: prompt.data,
    prompt: prompt.body.trim(),
    scaffold: typeof scaffoldRel === 'string' ? path.resolve(caseDir, scaffoldRel) : null,
    graders,
  };
}

/** Parse `codex exec --json` stdout: only lines starting with `{` are events (as recorded); bad lines are dropped. */
export function parseJsonl(text) {
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* a truncated last line, for example after a timeout */ }
  }
  return events;
}

const SKILL_READ = /\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/g;
const CACHE_PLUGIN = /\/plugins\/cache\/[^/\s'"]+\/([a-z0-9][a-z0-9-]*)\/[^/\s'"]+\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/g;

/**
 * Signals in a Codex event stream. One entry per command_execution item: the completed event wins
 * over item.started (both carry the same id), so a command is never counted twice.
 * Returns { commands: [text], skills: [{ plugin|null, skill }] (one per item and skill) }.
 */
export function traceSignals(events) {
  const items = new Map();
  for (const e of events) {
    const it = e?.item;
    if (!it || it.type !== 'command_execution' || typeof it.command !== 'string') continue;
    if (e.type === 'item.completed' || !items.has(it.id)) items.set(it.id ?? `#${items.size}`, it);
  }
  const commands = [];
  const skills = [];
  for (const it of items.values()) {
    commands.push(it.command);
    const plugins = new Map();
    for (const m of it.command.matchAll(CACHE_PLUGIN)) plugins.set(m[2], m[1]);
    const seen = new Set();
    for (const m of it.command.matchAll(SKILL_READ)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      skills.push({ plugin: plugins.get(m[1]) ?? null, skill: m[1] });
    }
  }
  return { commands, skills };
}

/** Claude-shaped Skill tool input for a Codex skill read, so the native input_match applies as is. */
export function skillInput({ plugin, skill }) {
  return JSON.stringify({ skill: plugin ? `${plugin}:${skill}` : skill });
}

function regexOf(pattern, flags, extra = '') {
  const f = [...new Set(`${flags ?? ''}${extra}`)].join('');
  return new RegExp(pattern, f);
}

const skip = (g, reason) => ({ name: g.name, type: g.type, passed: false, skipped: true, reason });
const res = (g, passed, reason) => ({ name: g.name, type: g.type, passed, skipped: false, reason });

/** Count occurrences and compare with min (default 1) / max (default unbounded). */
function countCheck(g, n, what) {
  const min = g.min ?? 1;
  const max = g.max ?? Infinity;
  return res(g, n >= min && n <= max, `${n} ${what} (min ${min}, max ${max === Infinity ? '-' : max})`);
}

/**
 * Grade one grader against one run.
 * run = { events, trace (raw JSONL text), lastMessage, filesBefore: [rel], filesAfter: [rel] }
 * judge(criteria, lastMessage) -> Promise<{ passed, reason } | null>; null or missing = SKIPPED.
 */
export async function gradeOne(g, run, { judge } = {}) {
  try {
    switch (g.type) {
      case 'regex': {
        const target = g.target ?? 'last_message';
        let text;
        if (target === 'last_message') text = run.lastMessage ?? '';
        else if (target === 'trace') text = run.trace ?? '';
        else return skip(g, `regex target "${typeof target === 'string' ? target : JSON.stringify(target)}" is not mapped for Codex`);
        const match = String(g.match ?? 'contains');
        const count = /^count:(\d+)$/.exec(match);
        if (count) {
          const n = [...text.matchAll(regexOf(g.pattern, g.flags, 'g'))].length;
          return res(g, n === Number(count[1]), `${n} match(es), expected ${count[1]}`);
        }
        const hit = regexOf(g.pattern, g.flags).test(text);
        if (match === 'not_contains') return res(g, !hit, hit ? 'pattern found' : 'pattern absent');
        return res(g, hit, hit ? 'pattern found' : 'pattern absent');
      }
      case 'file_exists': {
        const want = g.exists ?? true;
        const after = run.filesAfter ?? [];
        const found = after.some((f) => f === g.path || matchGlob(String(g.path), f));
        return res(g, found === want, found ? `${g.path} exists after the run` : `${g.path} does not exist after the run`);
      }
      case 'tool_used': {
        const sig = traceSignals(run.events ?? []);
        const re = g.input_match ? regexOf(g.input_match, '') : null;
        if (g.tool === 'Skill') {
          const n = sig.skills.filter((s) => !re || re.test(skillInput(s))).length;
          return countCheck(g, n, 'skill read(s)');
        }
        if (g.tool === 'Bash') {
          const n = sig.commands.filter((c) => !re || re.test(c)).length;
          return countCheck(g, n, 'command(s)');
        }
        return skip(g, `tool_used "${g.tool}" has no Codex signal`);
      }
      case 'llm': {
        if ((g.focus ?? 'last_message') !== 'last_message') return skip(g, 'llm focus other than last_message is not mapped for Codex');
        if (!judge) return skip(g, 'no judge (claude is not available or not logged in)');
        const v = await judge(g.criteria, run.lastMessage ?? '');
        if (!v) return skip(g, 'judge gave no verdict');
        return res(g, !!v.passed, v.reason ?? '');
      }
      case 'tool_order':
      case 'baseline':
        return skip(g, `${g.type} is not supported by the single-arm Codex runner`);
      default:
        return skip(g, `unknown grader type "${g.type}"`);
    }
  } catch (e) {
    // A bad pattern is a failure of the case, never a silent skip.
    return res(g, false, `grader error: ${e.message}`);
  }
}

export async function gradeRun(graders, run, opts) {
  const out = [];
  for (const g of graders) out.push(await gradeOne(g, run, opts));
  return out;
}

/** Weighted mean of the non-skipped graders; null when every grader was skipped (or there are none). */
export function scoreRun(results, graders) {
  let sum = 0;
  let total = 0;
  results.forEach((r, i) => {
    if (r.skipped) return;
    const w = Number(graders[i]?.weight ?? 1);
    total += w;
    if (r.passed) sum += w;
  });
  return total > 0 ? sum / total : null;
}

/**
 * Case score = mean over runs (a run with no score counts as 0). A case where every grader of every
 * run was skipped FAILS with score 0.
 */
export function scoreCase(runScores, threshold) {
  if (!runScores.length || runScores.every((s) => s === null)) return { score: 0, passed: false, allSkipped: true };
  const score = runScores.reduce((a, s) => a + (s ?? 0), 0) / runScores.length;
  return { score, passed: score >= threshold, allSkipped: false };
}
