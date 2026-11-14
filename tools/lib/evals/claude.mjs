// tools/lib/evals/claude.mjs: the Claude runner and the shared process helper.
// `mb eval --host claude` delegates to the native `claude plugin eval`. The plugin is always passed
// as a PATH (a bare name resolves to an installed plugin of the same name).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Run a command and capture its output. Never throws for a non-zero exit.
 * opts: { cwd, env, input (string for stdin; otherwise stdin is closed), timeoutMs, onStdout, onStderr }
 * Resolves { code, stdout, stderr, missing (ENOENT), timedOut }.
 */
export function execCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    const out = [];
    const err = [];
    let timedOut = false;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e.message), missing: e.code === 'ENOENT', timedOut });
      return;
    }
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs) : null;
    child.stdout.on('data', (d) => { out.push(d); opts.onStdout?.(d.toString()); });
    child.stderr.on('data', (d) => { err.push(d); opts.onStderr?.(d.toString()); });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: String(e.message), missing: e.code === 'ENOENT', timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), missing: false, timedOut });
    });
  });
}

/**
 * The exact `claude plugin eval` argv, without the leading "claude".
 * o: { pluginPath, jsonOut, outputDir, threshold, runs, model, judgeModel, maxCostUsd, caseGlob,
 *      scaffold (bool), configurable (bool), keepTemp (bool) }
 * The variadic --allow-tools comes last so it cannot swallow another argument.
 */
export function buildClaudeArgs(o) {
  const a = ['plugin', 'eval', o.pluginPath, '--trust-plugin', '--ablation', 'none', '--no-publish', '--json', o.jsonOut];
  // Keeps the native results dir out of <pdir>/evals/ (it would look like a case without prompt.md).
  if (o.outputDir) a.push('--output-dir', o.outputDir);
  if (o.threshold !== undefined) a.push('--threshold', String(o.threshold));
  if (o.runs !== undefined) a.push('--runs', String(o.runs));
  if (o.model) a.push('--model', o.model);
  if (o.judgeModel) a.push('--judge-model', o.judgeModel);
  if (o.maxCostUsd !== undefined) a.push('--max-cost-usd', String(o.maxCostUsd));
  if (o.caseGlob) a.push('--case', o.caseGlob);
  if (o.scaffold || o.configurable) a.push('--scaffold');
  if (o.keepTemp) a.push('--keep-temp'); // keeps the sandbox, so tracePath stays readable
  if (o.configurable) a.push('--allow-tools', 'Bash(node:*)', 'Bash(sh:*)');
  return a;
}

/**
 * Is Claude usable? { ok, reason }. CLI missing -> not ok. Credentials: ANTHROPIC_API_KEY, or
 * `claude auth status --json` reporting loggedIn.
 */
export async function claudeStatus({ exec = execCapture, env = process.env } = {}) {
  const v = await exec('claude', ['--version'], { env });
  if (v.missing || v.code !== 0) return { ok: false, reason: '"claude" is not installed or not on PATH' };
  if (env.ANTHROPIC_API_KEY) return { ok: true, reason: 'ANTHROPIC_API_KEY' };
  const s = await exec('claude', ['auth', 'status', '--json'], { env });
  try {
    if (JSON.parse(s.stdout).loggedIn === true) return { ok: true, reason: 'logged in' };
  } catch { /* not JSON */ }
  return { ok: false, reason: 'claude is not logged in and ANTHROPIC_API_KEY is not set' };
}

/**
 * Summary of a native result JSON (Claude Code 2.1.325: cases[].aggregates.score, suite.threshold):
 * [{ name, score|null, passed|null }].
 */
export function summarizeNative(json) {
  const cases = Array.isArray(json?.cases) ? json.cases : [];
  const threshold = json?.suite?.threshold;
  return cases.map((c) => {
    const score = typeof c.aggregates?.score === 'number' ? c.aggregates.score : null;
    return { name: c.name ?? '?', score, passed: score === null || typeof threshold !== 'number' ? null : score >= threshold };
  });
}

/**
 * The final answer in a native trace.jsonl: the `result` text of the last `result` event.
 * null when the trace is gone (the native runner deletes it unless --keep-temp) or has none.
 */
export function lastResultFromTrace(tracePath) {
  let text;
  try {
    text = fs.readFileSync(tracePath, 'utf8');
  } catch {
    return null;
  }
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'result' && typeof e.result === 'string') last = e.result;
    } catch { /* a truncated line */ }
  }
  return last;
}

/**
 * Per-run details of one native case, in the shape the Codex runner records (for failure output):
 * [{ error, graders: [{ name, passed, skipped, reason }], lastMessage|null, tracePath }].
 */
export function nativeRuns(nativeCase) {
  const runs = Array.isArray(nativeCase?.arms?.with) ? nativeCase.arms.with : [];
  return runs.map((r) => ({
    error: r.error ?? null,
    graders: (r.graders ?? []).map((g) => ({ name: g.name, passed: !!g.passed, skipped: g.scored === false, reason: g.explanation ?? '' })),
    lastMessage: typeof r.tracePath === 'string' ? lastResultFromTrace(r.tracePath) : null,
    tracePath: r.tracePath ?? null,
  }));
}

/**
 * LLM judge for the Codex runner: `claude -p` with the criteria and the last message.
 * Returns judge(criteria, lastMessage) -> { passed, reason } | null (null = no verdict -> SKIPPED).
 */
export function makeJudge({ exec = execCapture, env = process.env, model } = {}) {
  return async (criteria, lastMessage) => {
    const prompt = [
      'You are grading the final answer of an AI assistant against criteria.',
      'Criteria:', criteria, '',
      'Answer to grade (between the markers):', '<<<ANSWER', lastMessage, 'ANSWER>>>', '',
      'Reply with one line: "VERDICT: PASS" or "VERDICT: FAIL", then one short sentence of reason.',
    ].join('\n');
    const args = ['-p', '--no-session-persistence', '--tools', ''];
    if (model) args.push('--model', model);
    const r = await exec('claude', args, { env, input: prompt, timeoutMs: 180000 });
    if (r.code !== 0) return null;
    const m = [...r.stdout.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)].pop();
    if (!m) return null;
    return { passed: m[1].toUpperCase() === 'PASS', reason: r.stdout.replace(/VERDICT:\s*(PASS|FAIL)/i, '').trim().slice(0, 300) };
  };
}
