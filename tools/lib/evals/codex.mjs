// tools/lib/evals/codex.mjs: the Codex runner. Codex has no eval command, so this runs
// each native case with `codex exec --json` and grades the result with graders.mjs.
//
// Isolation: every case gets a temp CODEX_HOME. Locally, auth.json is COPIED from the real CODEX_HOME
// (read only). In CI (env CI set), the runner logs in with `codex login --with-api-key` from
// OPENAI_API_KEY and never copies a personal session file. The real CODEX_HOME is never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCapture } from './claude.mjs';
import { parseJsonl, gradeRun, scoreRun, scoreCase } from './graders.mjs';

/** The real CODEX_HOME (only ever read). */
export function realCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export const isCi = (env = process.env) => !!env.CI && env.CI !== 'false' && env.CI !== '0';

/** Exact `codex exec` argv, without the leading "codex". */
export function buildExecArgs({ workdir, lastFile, model, prompt }) {
  const a = ['exec', '--json', '-s', 'workspace-write', '--ephemeral', '-C', workdir, '-o', lastFile];
  if (model) a.push('-m', model);
  a.push(prompt);
  return a;
}

/**
 * Is Codex usable? { ok, reason, auth: 'api-key' | 'copy' }.
 * CI: needs OPENAI_API_KEY. Local: auth.json in the real CODEX_HOME, else OPENAI_API_KEY.
 */
export async function codexStatus({ exec = execCapture, env = process.env } = {}) {
  const v = await exec('codex', ['--version'], { env });
  if (v.missing || v.code !== 0) return { ok: false, reason: '"codex" is not installed or not on PATH' };
  if (isCi(env)) {
    return env.OPENAI_API_KEY ? { ok: true, auth: 'api-key', reason: 'OPENAI_API_KEY (CI)' } : { ok: false, reason: 'OPENAI_API_KEY is not set (CI)' };
  }
  if (fs.existsSync(path.join(realCodexHome(env), 'auth.json'))) return { ok: true, auth: 'copy', reason: 'auth.json' };
  if (env.OPENAI_API_KEY) return { ok: true, auth: 'api-key', reason: 'OPENAI_API_KEY' };
  return { ok: false, reason: `no ${path.join(realCodexHome(env), 'auth.json')} and OPENAI_API_KEY is not set` };
}

/** Sorted POSIX paths of every file under dir, .git excluded. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(abs, d.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

async function must(exec, cmd, args, opts, what) {
  const r = await exec(cmd, args, opts);
  if (r.missing) throw Object.assign(new Error(`"${cmd}" is not installed or not on PATH`), { exitCode: 7 });
  if (r.code !== 0) throw Object.assign(new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`), { exitCode: 1 });
  return r;
}

/** Create a temp CODEX_HOME with credentials and the marketplace + plugin installed. */
export async function prepareHome({ home, root, mkt, plugin, auth, env, exec }) {
  fs.mkdirSync(home, { recursive: true });
  const homeEnv = { ...env, CODEX_HOME: home };
  if (auth === 'api-key') {
    await must(exec, 'codex', ['login', '--with-api-key'], { env: homeEnv, input: `${env.OPENAI_API_KEY}\n` }, 'codex login --with-api-key');
  } else {
    fs.copyFileSync(path.join(realCodexHome(env), 'auth.json'), path.join(home, 'auth.json'));
  }
  await must(exec, 'codex', ['plugin', 'marketplace', 'add', root], { env: homeEnv }, 'codex plugin marketplace add');
  await must(exec, 'codex', ['plugin', 'add', `${plugin}@${mkt}`], { env: homeEnv }, 'codex plugin add');
  return homeEnv;
}

/**
 * Run the given cases of one plugin. Returns the runner JSON:
 * { host: 'codex', plugin, threshold, cases: [{ name, score, passed, allSkipped, runs: [{ score, graders: [...] }] }] }
 * o: { root, mkt, plugin, cases (loadCase results), runs, threshold, model, scaffold, judge, auth,
 *      env, exec, tmpRoot, log(text), keep }
 */
export async function runCodexPlugin(o) {
  const exec = o.exec ?? execCapture;
  const env = o.env ?? process.env;
  const log = o.log ?? (() => {});
  const tmp = fs.mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), 'mb-eval-codex-'));
  const result = { host: 'codex', plugin: o.plugin, threshold: o.threshold, cases: [] };
  if (o.keep) result.keptDir = tmp; // `mb eval --keep-temp`: workdirs, last-<n>.txt and CODEX_HOME stay
  try {
    for (const [ci, c] of o.cases.entries()) {
      const caseTmp = path.join(tmp, `case-${ci}`);
      const homeEnv = await prepareHome({ home: path.join(caseTmp, 'codex-home'), root: o.root, mkt: o.mkt, plugin: o.plugin, auth: o.auth, env, exec });
      const runs = Number(o.runs ?? c.meta.runs ?? o.defaultRuns ?? 1);
      const caseEnv = { ...homeEnv, ...(c.meta.env && typeof c.meta.env === 'object' ? c.meta.env : {}), EVAL_MB_MARKETPLACE: o.mkt };
      const runResults = [];
      for (let r = 0; r < runs; r++) {
        const work = path.join(caseTmp, `work-${r}`);
        const lastFile = path.join(caseTmp, `last-${r}.txt`); // outside the workdir: not in the file diff
        fs.mkdirSync(work, { recursive: true });
        await must(exec, 'git', ['init', '-q'], { cwd: work, env }, 'git init');
        if (c.scaffold && o.scaffold) {
          await must(exec, 'sh', [c.scaffold], { cwd: work, env: caseEnv }, `scaffold ${path.basename(c.scaffold)} of ${c.name}`);
        }
        const filesBefore = listFiles(work);
        const timeoutMs = Number(c.meta.timeout_seconds ?? 600) * 1000;
        log(`codex: ${o.plugin}/${c.name} run ${r + 1}/${runs}\n`);
        const x = await exec('codex', buildExecArgs({ workdir: work, lastFile, model: o.model, prompt: c.prompt }), { env: caseEnv, timeoutMs });
        if (x.missing) throw Object.assign(new Error('"codex" is not installed or not on PATH'), { exitCode: 7 });
        const lastMessage = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8') : '';
        const events = parseJsonl(x.stdout);
        // Like the native runner: a run that errored (non-zero exit, timeout, no turn.completed) scores 0
        // without grading. Otherwise an auth or rate-limit failure would PASS every no-trigger case.
        const error = x.timedOut ? 'timeout' : x.code !== 0 ? `codex exec exit ${x.code}`
          : !events.some((e) => e.type === 'turn.completed') ? 'no turn.completed event' : null;
        if (error) {
          log(`codex: ${c.name} run ${r + 1}: ${error}: ${(x.stderr || '').trim().slice(-300)}\n`);
          runResults.push({ score: 0, exitCode: x.code, error, graders: [], lastMessage });
          continue;
        }
        const run = { events, trace: x.stdout, lastMessage, filesBefore, filesAfter: listFiles(work) };
        const graders = await gradeRun(c.graders, run, { judge: o.judge });
        runResults.push({ score: scoreRun(graders, c.graders), exitCode: x.code, graders, lastMessage });
      }
      const s = scoreCase(runResults.map((x) => x.score), o.threshold);
      result.cases.push({ name: c.name, score: s.score, passed: s.passed, allSkipped: s.allSkipped, runs: runResults });
    }
  } finally {
    if (!o.keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return result;
}
