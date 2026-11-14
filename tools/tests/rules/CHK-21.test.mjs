import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors } from './_fixture.mjs';

const GOOD = '# mb-demo\n\n### Requirement: MB-DEMO-001 Greets\nThe skill SHALL greet.\n\n#### Scenario: hello\n- WHEN greeted THEN it greets (test tools/x.test.mjs)\n';

test('CHK-21 passes on a well-formed spec with an existing cited test', async () => {
  const root = makeRepo({ 'openspec/specs/mb-demo/spec.md': GOOD, 'tools/x.test.mjs': '\n', 'openspec/specs/billing/spec.md': '### Requirement: Local\n#### Scenario: s\n' });
  assert.deepEqual(await runRule('CHK-21', root), []);
});

test('CHK-21 fails: requirement without scenario, missing ID, duplicate ID, missing citation', async () => {
  const root = makeRepo({
    'openspec/specs/mb-demo/spec.md': GOOD + '\n### Requirement: No id here\n\n### Requirement: MB-DEMO-001 Again\n#### Scenario: s (vector 999-nope)\n',
  });
  const msgs = errors(await runRule('CHK-21', root)).map((x) => x.message).join('\n');
  assert.match(msgs, /cited test "tools\/x.test.mjs" does not exist/);
  assert.match(msgs, /cited vector "999-nope"/);
  assert.match(msgs, /"No id here" has no "#### Scenario:"/);
  assert.match(msgs, /must start with its ID/);
  assert.match(msgs, /duplicate requirement ID MB-DEMO-001/);
});

test('CHK-21 fails when a base spec cites an example file; a derived spec may', async () => {
  const cite = '# s\n\n### Requirement: MB-DEMO-001 X\n#### Scenario: s (test examples/plugins/a/evals/c/prompt.md)\n';
  const files = { 'examples/plugins/a/evals/c/prompt.md': 'x\n' };
  const base = errors(await runRule('CHK-21', makeRepo({ ...files, 'openspec/specs/mb-demo/spec.md': cite })));
  assert.match(base.map((x) => x.message).join('\n'), /base spec cites example file/);
  const own = cite.replace('MB-DEMO-001 X', 'Local');
  assert.deepEqual(await runRule('CHK-21', makeRepo({ ...files, 'openspec/specs/billing/spec.md': own })), []);
});
