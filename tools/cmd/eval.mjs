// tools/cmd/eval.mjs: `mb eval [<p>...] --host claude|codex|all [--case glob] [--runs n] [--scaffold] [--keep-temp]`
// One native case format, two runners:
//   claude -> `claude plugin eval <plugin path> ...` (tools/lib/evals/claude.mjs)
//   codex  -> `codex exec --json` per case in a temp CODEX_HOME (tools/lib/evals/codex.mjs)
// Scaffolds run when --scaffold is given or the plugin is configurable (config cases need them).
// A host without its CLI or credentials is SKIPPED: exit 0 in CI or with --host all, exit 7 locally
// when that host was requested explicitly. Exit 1 when any case is below the threshold.
// For a failing case it prints each run's failed graders and the start of the final answer;
// --keep-temp keeps the temp workspaces (Claude: --keep-temp; Codex: the runner's temp dir).
import fs from 'node:fs';
import path from 'node:path';
import { writeJson, mkdirp } from '../lib/fsx.mjs';
import { listPlugins, isConfigurable, readMarketplaceConfig } from './new.mjs';
import { execCapture, buildClaudeArgs, claudeStatus, makeJudge, summarizeNative, nativeRuns } from '../lib/evals/claude.mjs';
import { codexStatus, runCodexPlugin, isCi } from '../lib/evals/codex.mjs';
import { listCases, loadCase } from '../lib/evals/graders.mjs';

export const name = 'eval';
export const summary = 'Run the plugin eval cases live on Claude Code and/or Codex.';
export const usage = 'mb eval [<p>...] --host claude|codex|all [--case glob] [--runs n] [--scaffold] [--keep-temp]';
export const options = {
  host: { type: 'string' },
  case: { type: 'string' },
  runs: { type: 'string' },
  scaffold: { type: 'boolean' },
  'keep-temp': { type: 'boolean' },
};

const DEFAULTS = { threshold: 0.6, runs: 3, maxCostUsd: 5 };
const ANSWER_LINES = 20;

/**
 * Details of a failing case, so it can be debugged without other tools: per run, the error or the
 * graders that did not pass (with their reason), then the first lines of the final answer.
 * runs: [{ error, graders: [{ name, passed, skipped, reason }], lastMessage|null, tracePath? }]
 */
export function failureDetails(runs, { keep } = {}) {
  const out = [];
  runs.forEach((r, i) => {
    const head = `    run ${i + 1}:`;
    if (r.error) out.push(`${head} error: ${r.error}`);
    const bad = (r.graders ?? []).filter((g) => !g.passed);
    for (const g of bad) out.push(`${head} ${g.skipped ? 'SKIPPED' : 'failed'} ${g.name}: ${g.reason}`);
    if (!r.error && !bad.length) out.push(`${head} every grader passed`);
    if (typeof r.lastMessage === 'string') {
      const lines = r.lastMessage.trim().split(/\r?\n/);
      out.push(`${head} final answer (first ${Math.min(lines.length, ANSWER_LINES)} of ${lines.length} line(s)):`);
      for (const l of lines.slice(0, ANSWER_LINES)) out.push(`      | ${l}`);
    } else if (r.tracePath && keep) {
      out.push(`${head} trace: ${r.tracePath}`);
    }
  });
  if (!keep) out.push('    (re-run with --keep-temp to keep the workspace and trace)');
  return out.map((l) => `${l}\n`).join('');
}

export async function run(argv, ctx) {
  return runEval(ctx, {});
}

/** deps: { exec, env } (tests inject a fake exec; nothing else is mocked). */
export async function runEval(ctx, deps) {
  const exec = deps.exec ?? execCapture;
  const env = deps.env ?? process.env;
  const v = ctx.args.values;
  const host = v.host;
  if (!['claude', 'codex', 'all'].includes(host)) throw ctx.usageError('--host must be claude, codex or all');
  let runsFlag;
  if (v.runs !== undefined) {
    if (!/^[1-9][0-9]*$/.test(v.runs)) throw ctx.usageError('--runs must be a positive integer');
    runsFlag = Number(v.runs);
  }

  const cfg = readMarketplaceConfig(ctx.root) ?? {};
  const ev = { ...DEFAULTS, ...(cfg.evals ?? {}) };
  const models = ev.models ?? {};
  const all = listPlugins(ctx.root).filter((p) => p.included);
  let plugins = all;
  if (ctx.args.positionals.length) {
    plugins = ctx.args.positionals.map((n) => all.find((p) => p.name === n) ?? (() => { throw ctx.usageError(`unknown plugin "${n}"`); })());
  }
  if (!plugins.length) {
    ctx.stdout('mb eval: no plugins to evaluate\n');
    return 0;
  }

  const hosts = host === 'all' ? ['claude', 'codex'] : [host];
  const outDir = path.join(ctx.root, 'dist', 'evals');
  let failed = false;
  let missing = false;

  for (const h of hosts) {
    const st = h === 'claude' ? await claudeStatus({ exec, env }) : await codexStatus({ exec, env });
    if (!st.ok) {
      ctx.stdout(`SKIPPED ${h}: ${st.reason}\n`);
      if (host !== 'all' && !isCi(env)) missing = true;
      continue;
    }
    mkdirp(outDir);
    if (h === 'claude') {
      for (const p of plugins) {
        const args = buildClaudeArgs({
          pluginPath: p.dir, // a PATH, never a bare name
          jsonOut: path.join(outDir, `claude-${p.name}.json`),
          outputDir: path.join(outDir, `claude-${p.name}`),
          threshold: ev.threshold,
          runs: runsFlag ?? ev.runs,
          model: models.claude,
          judgeModel: models.judge,
          maxCostUsd: ev.maxCostUsd,
          caseGlob: v.case,
          scaffold: !!v.scaffold,
          configurable: isConfigurable(p.dir),
          keepTemp: !!v['keep-temp'],
        });
        ctx.stderr(`$ claude ${args.map((a) => JSON.stringify(a)).join(' ')}\n`);
        const r = await exec('claude', args, { cwd: ctx.root, env, onStdout: ctx.stdout, onStderr: ctx.stderr });
        if (r.missing) throw ctx.fail(7, '"claude" is not installed or not on PATH');
        const jsonFile = path.join(outDir, `claude-${p.name}.json`);
        if (fs.existsSync(jsonFile)) {
          try {
            const native = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
            summarizeNative(native).forEach((c, i) => {
              const verdict = c.passed === null ? '?' : c.passed ? 'PASS' : 'FAIL';
              ctx.stdout(`${verdict} claude ${p.name}/${c.name}: ${c.score === null ? '-' : c.score.toFixed(2)}\n`);
              if (c.passed === false) ctx.stdout(failureDetails(nativeRuns(native.cases[i]), { keep: !!v['keep-temp'] }));
            });
          } catch { /* the native report already printed the details */ }
        }
        if (r.code !== 0) {
          ctx.stdout(`FAIL claude ${p.name} (claude plugin eval exit ${r.code})\n`);
          failed = true;
        }
      }
    } else {
      const mkt = cfg.name;
      if (!mkt) throw ctx.fail(3, 'marketplace.config.json#name is needed for the Codex install');
      if (!fs.existsSync(path.join(ctx.root, '.agents', 'plugins', 'marketplace.json'))) {
        throw ctx.fail(1, '.agents/plugins/marketplace.json is missing: run ./mb gen');
      }
      const judgeOk = (await claudeStatus({ exec, env })).ok;
      const judge = judgeOk ? makeJudge({ exec, env, model: models.judge }) : null;
      for (const p of plugins) {
        const cases = listCases(p.dir, v.case).map(loadCase);
        if (!cases.length) {
          ctx.stdout(`codex ${p.name}: no eval cases${v.case ? ` match "${v.case}"` : ''}\n`);
          continue;
        }
        const res = await runCodexPlugin({
          root: ctx.root, mkt, plugin: p.name, cases, runs: runsFlag, defaultRuns: ev.runs,
          threshold: ev.threshold, model: models.codex, scaffold: !!v.scaffold || isConfigurable(p.dir),
          judge, auth: st.auth, env, exec, log: ctx.stderr, keep: !!v['keep-temp'],
        });
        writeJson(path.join(outDir, `codex-${p.name}.json`), res);
        for (const c of res.cases) {
          const skipped = c.runs.reduce((n, r) => n + r.graders.filter((g) => g.skipped).length, 0);
          const verdict = c.passed ? 'PASS' : 'FAIL';
          const errors = c.runs.filter((r) => r.error).map((r) => r.error);
          ctx.stdout(`${verdict} codex ${p.name}/${c.name}: ${c.score.toFixed(2)}${skipped ? ` (${skipped} grader result(s) SKIPPED)` : ''}${c.allSkipped ? ' (every grader skipped)' : ''}${errors.length ? ` (${errors.length} run(s) errored: ${errors[0]})` : ''}\n`);
          if (!c.passed) {
            failed = true;
            ctx.stdout(failureDetails(c.runs, { keep: !!v['keep-temp'] }));
          }
        }
        if (res.keptDir) ctx.stdout(`kept codex ${p.name}: ${res.keptDir} (case-<i>/work-<n>/ = workdirs, case-<i>/last-<n>.txt = final answers)\n`);
      }
    }
  }
  if (failed) return 1;
  return missing ? 7 : 0;
}
