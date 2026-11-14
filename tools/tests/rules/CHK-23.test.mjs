import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors, SKILL_MD } from './_fixture.mjs';

const CONFIGURED = SKILL_MD + '<!-- mb:config:begin -->\nblock\n<!-- mb:config:end -->\n';

test('CHK-23 passes: all marker files well-formed, configurable SKILL.md has its block', async () => {
  const root = makeRepo({ 'plugins/demo/config.defaults.json': '{}', 'plugins/demo/skills/demo/SKILL.md': CONFIGURED });
  assert.deepEqual(await runRule('CHK-23', root), []);
});

test('CHK-23 fails: duplicated pair, unmatched begin, wrong style, missing config block', async () => {
  const root = makeRepo({
    'README.md': '<!-- mb:catalog:begin -->\n<!-- mb:catalog:end -->\n<!-- mb:catalog:begin -->\n<!-- mb:catalog:end -->\n<!-- mb:install:begin -->\n',
    '.gitignore': '<!-- mb:gitignore:begin -->\n<!-- mb:gitignore:end -->\n',
    'plugins/demo/config.defaults.json': '{}',
  });
  const r = errors(await runRule('CHK-23', root));
  const msgs = r.map((x) => `${x.path} ${x.message}`).join('\n');
  assert.match(msgs, /README.md .*"catalog": duplicate/);
  assert.match(msgs, /README.md .*"install": unmatched-begin/);
  assert.match(msgs, /\.gitignore marker "gitignore" must use the # mb:<id>:begin form/);
  assert.match(msgs, /SKILL.md marker "config" is missing/);
  assert.equal(r[0].fix, 'restore markers from tools/templates');
});
