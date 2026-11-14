import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, warnings, SKILL_MD } from './_fixture.mjs';

const REL = 'plugins/demo/skills/demo/SKILL.md';

test('CHK-04 passes on valid frontmatter (folded description, metadata block)', async () => {
  const md = '---\nname: demo\ndescription: >\n  Say hello.\n  Use when greeted.\nmetadata:\n  owner: acme\nlicense: MIT\n---\nBody\n';
  assert.deepEqual(await runRule('CHK-04', makeRepo({ [REL]: md })), []);
});

test('CHK-04 unquotes double- and single-quoted descriptions', async () => {
  const md = '---\nname: demo\ndescription: "Run: a \\"quoted\\" thing. Use when asked."\n---\nBody\n';
  assert.deepEqual(await runRule('CHK-04', makeRepo({ [REL]: md })), []);
  const md2 = "---\nname: 'demo'\ndescription: 'It''s here: use when asked.'\n---\nBody\n";
  assert.deepEqual(await runRule('CHK-04', makeRepo({ [REL]: md2 })), []);
});

test('CHK-04 fails: name != dir, unknown key, missing description', async () => {
  const md = '---\nname: hello\nhooks: x\n---\nBody\n';
  const r = errors(await runRule('CHK-04', makeRepo({ [REL]: md })));
  assert.deepEqual(r.map((x) => x.message).sort(), [
    'description must be a string of 1-1024 characters',
    'frontmatter key "hooks" is not an Agent Skills key',
    'name "hello" differs from its directory "demo"',
  ]);
});

test('CHK-04 fails without frontmatter', async () => {
  const r = errors(await runRule('CHK-04', makeRepo({ [REL]: '# no frontmatter\n' })));
  assert.match(r[0].message, /missing frontmatter/);
});

test('CHK-04 gives exactly one TODO warning for a scaffolded body', async () => {
  const r = await runRule('CHK-04', makeRepo({ [REL]: SKILL_MD + '\nTODO: write the steps.\nTODO: add examples.\n' }));
  assert.equal(errors(r).length, 0);
  assert.equal(warnings(r).length, 1);
  assert.equal(warnings(r)[0].message, 'SKILL.md still contains TODO');
});

test('CHK-04 fails on ": " inside an unquoted value (strict YAML)', async () => {
  const md = '---\nname: demo\ndescription: Write type(scope): subject lines. Use when committing.\n---\nBody\n';
  const r = errors(await runRule('CHK-04', makeRepo({ [REL]: md })));
  assert.equal(r.length, 1);
  assert.match(r[0].message, /unquoted value/);
});

test('CHK-04 warns (does not fail) on known host-only keys', async () => {
  const md = '---\nname: demo\ndescription: Hidden helper. Use when the command calls it.\nuser-invocable: false\ndisable-model-invocation: true\nallowed-tools: [Read]\nargument-hint: "<file>"\nmodel: opus\n---\nBody\n';
  const r = await runRule('CHK-04', makeRepo({ [REL]: md }));
  assert.equal(errors(r).length, 0);
  assert.deepEqual(warnings(r).map((x) => x.message).sort(), [
    'frontmatter key "allowed-tools" is host-specific (ignored by Codex)',
    'frontmatter key "argument-hint" is host-specific (ignored by Codex)',
    'frontmatter key "disable-model-invocation" is host-specific (ignored by Codex)',
    'frontmatter key "model" is host-specific (ignored by Codex)',
    'frontmatter key "user-invocable" is host-specific (ignored by Codex)',
  ]);
});
