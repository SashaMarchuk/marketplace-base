import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, warnings, TRIGGER_PROMPT } from './_fixture.mjs';

test('CHK-14 passes with a trigger and a no-trigger case', async () => {
  assert.deepEqual(await runRule('CHK-14', makeRepo()), []);
});

test('CHK-14 fails without a no-trigger case', async () => {
  const r = errors(await runRule('CHK-14', makeRepo({ 'plugins/demo/evals/demo-no-trigger': null })));
  assert.equal(r.length, 1);
  assert.match(r[0].message, /no no-trigger eval case/);
  assert.equal(r[0].fix, './mb new skill scaffolds both');
});

test('CHK-14 fails on a non-native prompt.md frontmatter key', async () => {
  const r = errors(await runRule('CHK-14', makeRepo({ 'plugins/demo/evals/demo-trigger/prompt.md': TRIGGER_PROMPT.replace('name:', 'priority: high\nname:') })));
  assert.equal(r.length, 1);
  assert.match(r[0].message, /"priority" is not in the native set/);
});

test('CHK-14 does not count a grader for skill "demo-two" as naming "demo"', async () => {
  const fired = "---\ntype: tool_used\ntool: Skill\ninput_match: '\"skill\"\\s*:\\s*\"demo-two\"'\n---\n";
  const r = errors(await runRule('CHK-14', makeRepo({ 'plugins/demo/evals/demo-trigger/graders/skill-fired.md': fired })));
  assert.match(r[0].message, /no trigger eval case/);
});

test('CHK-14 fails on an unknown grader type, a missing type and a regex without a pattern', async () => {
  const at = 'plugins/demo/evals/demo-trigger/graders/extra.md';
  for (const [text, re] of [
    ['---\ntype: output_contains\npattern: x\n---\n', /grader type "output_contains" is not a native type/],
    ['---\npattern: x\n---\n', /grader type is missing/],
    ['---\ntype: regex\ntarget: last_message\n---\n', /regex grader has no "pattern"/],
    ['no frontmatter at all\n', /grader has no valid frontmatter/],
  ]) {
    const r = errors(await runRule('CHK-14', makeRepo({ [at]: text })));
    assert.equal(r.length, 1, text);
    assert.match(r[0].message, re);
    assert.equal(r[0].path, at);
    assert.equal(r[0].fix, 'see docs/base/evals.md#graders');
  }
  for (const ok of ['---\ntype: llm\n---\nThe answer is polite.\n', '---\ntype: baseline\n---\n', '---\ntype: file_exists\npath: out.txt\n---\n']) {
    assert.deepEqual(errors(await runRule('CHK-14', makeRepo({ [at]: ok }))), [], ok);
  }
});

test('CHK-14 fails on "---" inside grader or prompt frontmatter (the native loader cuts there)', async () => {
  const at = 'plugins/demo/evals/demo-trigger/graders/table.md';
  let r = errors(await runRule('CHK-14', makeRepo({ [at]: '---\n# a |---| b\ntype: llm\n---\nA table.\n' })));
  assert.equal(r.length, 1);
  assert.equal(r[0].path, at);
  assert.match(r[0].message, /frontmatter line "# a \|---\| b" contains "---"/);
  const prompt = 'plugins/demo/evals/demo-trigger/prompt.md';
  r = errors(await runRule('CHK-14', makeRepo({ [prompt]: TRIGGER_PROMPT.replace('name:', 'description: a---b\nname:') })));
  assert.equal(r.length, 1);
  assert.equal(r[0].path, prompt);
});

test('CHK-14 warns on the scaffold placeholder prompt and on extra graders in config-respected', async () => {
  const prompt = 'plugins/demo/evals/demo-trigger/prompt.md';
  let r = await runRule('CHK-14', makeRepo({ [prompt]: '---\nmax_turns: 5\n---\n\nReplace this text with a realistic user request.\n' }));
  assert.equal(errors(r).length, 0);
  assert.deepEqual(warnings(r).map((x) => [x.path, x.message]), [[prompt, 'prompt.md still holds the scaffold placeholder text']]);
  const cfg = 'plugins/demo/evals/config-respected';
  const grader = "---\ntype: regex\ntarget: last_message\npattern: 'x'\n---\n";
  const files = { [`${cfg}/prompt.md`]: 'Summarise the notes.\n', [`${cfg}/graders/config-effect.md`]: grader };
  assert.deepEqual(await runRule('CHK-14', makeRepo(files)), []);
  r = await runRule('CHK-14', makeRepo({ ...files, [`${cfg}/graders/second.md`]: grader }));
  assert.equal(errors(r).length, 0);
  assert.equal(warnings(r).length, 1);
  assert.match(warnings(r)[0].message, /config case has 2 graders; it should have ONE/);
});
