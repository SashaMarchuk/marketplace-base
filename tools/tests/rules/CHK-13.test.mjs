import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runRule, errors } from './_fixture.mjs';

test('CHK-13 passes: maxTokens is not a secret key; secrets use ${env:NAME}', async () => {
  const root = makeRepo({
    'plugins/demo/config.defaults.json': '{"maxTokens":500,"api_key":"${env:ACME_API_KEY}","token":""}',
    'policy/org.json': '{"settings":{"credentials":{"user":"${env:ACME_USER}"}}}',
  });
  assert.deepEqual(await runRule('CHK-13', root), []);
});

test('CHK-13 fails on literal secrets in defaults, policy and the committed project config', async () => {
  const root = makeRepo({
    'plugins/demo/config.defaults.json': '{"apiKey":"literal-value"}',
    'policy/teams/pay.json': '{"settings":{"Passwords":["a"]}}',
    '.acme-skills/config.json': '{"settings":{"secret":"x"}}',
  });
  const r = errors(await runRule('CHK-13', root));
  assert.deepEqual(r.map((x) => x.path), ['.acme-skills/config.json', 'plugins/demo/config.defaults.json', 'policy/teams/pay.json']);
  assert.equal(r[0].fix, 'use ${env:NAME}');
});
