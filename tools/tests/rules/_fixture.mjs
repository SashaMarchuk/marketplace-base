// Test helper for tools/tests/rules/*.test.mjs (not a test itself).
// makeRepo() builds a small, rule-clean repo in a temp dir; tests then break one thing and run
// a single rule through check.mjs's buildRuleContext/runRules.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRuleContext, runRules } from '../../cmd/check.mjs';

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const SKILL_MD = `---
name: demo
description: Say hello. Use when greeted.
license: MIT
---

# Demo

Greet the user. See [the guide](references/guide.md) and \`references/guide.md\`.
`;

export const TRIGGER_PROMPT = `---
name: demo-trigger
description: The skill fires on a greeting.
---
Hello there!
`;
export const SKILL_FIRED = `---
type: tool_used
tool: Skill
input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?demo"'
---
`;
export const NO_TRIGGER_PROMPT = `---
name: demo-no-trigger
description: The skill stays quiet.
---
What is 2 + 2?
`;
export const SKILL_NOT_FIRED = `---
type: tool_used
tool: Skill
input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?demo"'
min: 0
max: 0
arm: both
---
`;

const BASE_FILES = {
  'marketplace.config.json': JSON.stringify({
    name: 'acme-skills', displayName: 'Acme Skills', description: 'Skills for acme.',
    owner: { name: 'Alice' }, includeExamples: true,
    config: { layers: ['skill-defaults', 'org', 'team', 'project', 'user', 'project-local'] },
  }, null, 2) + '\n',
  'README.md': '# Acme\n<!-- mb:catalog:begin -->\n<!-- mb:catalog:end -->\n<!-- mb:install:begin -->\n<!-- mb:install:end -->\n',
  'USAGE.md': '# Usage\n<!-- mb:config-locations:begin -->\n<!-- mb:config-locations:end -->\n',
  'AGENTS.md': '# Agents\n<!-- mb:agents:begin -->\n<!-- mb:agents:end -->\n',
  '.gitignore': '# mb:gitignore:begin\n.mb/leak-denylist.txt\n.acme-skills/config.local.json\ndist/\n# mb:gitignore:end\n',
  'policy/org.json': '{"$schema":"../tools/schemas/layer-file.schema.json"}\n',
  'plugins/demo/plugin.src.json': JSON.stringify({ name: 'demo', version: '0.1.0', description: 'Demo plugin.' }, null, 2) + '\n',
  'plugins/demo/skills/demo/SKILL.md': SKILL_MD,
  'plugins/demo/skills/demo/references/guide.md': '# Guide\n',
  'plugins/demo/evals/demo-trigger/prompt.md': TRIGGER_PROMPT,
  'plugins/demo/evals/demo-trigger/graders/skill-fired.md': SKILL_FIRED,
  'plugins/demo/evals/demo-no-trigger/prompt.md': NO_TRIGGER_PROMPT,
  'plugins/demo/evals/demo-no-trigger/graders/skill-not-fired.md': SKILL_NOT_FIRED,
};

/** Temp dir root; honours TMPDIR (os.tmpdir). */
export function tmpDir(prefix = 'mb-rules-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function remove(root, rel) {
  fs.rmSync(path.join(root, ...rel.split('/')), { recursive: true, force: true });
}

/** A rule-clean repo. files: extra/overriding files (null deletes). */
export function makeRepo(files = {}) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.mb'));
  fs.copyFileSync(path.join(TOOL_ROOT, '.mb', 'ownership.json'), path.join(root, '.mb', 'ownership.json'));
  for (const [rel, content] of Object.entries({ ...BASE_FILES, ...files })) {
    if (content === null) remove(root, rel);
    else write(root, rel, content);
  }
  return root;
}

/** Run git with a neutral identity and no global/system config. */
export function git(root, ...args) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: root, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function gitInit(root) {
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/** Run one rule (by id) and return its results. */
export async function runRule(id, root, opts = {}) {
  const mod = await import(pathToFileURL(path.join(TOOL_ROOT, 'tools', 'lib', 'rules', `${id}.mjs`)).href);
  const rctx = buildRuleContext(root, { toolRoot: TOOL_ROOT, ...opts });
  return runRules([mod], rctx);
}

export const errors = (results) => results.filter((r) => r.severity === 'error');
export const warnings = (results) => results.filter((r) => r.severity === 'warning');
