import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, runRule, errors, TOOL_ROOT } from './_fixture.mjs';
import { policyProblems, enforcedConflicts } from '../../lib/rules/CHK-12.mjs';
import { loadSchema } from '../../lib/schema-lite.mjs';
import { parse } from '../../kit/json.mjs';

const SCHEMA = JSON.stringify({ type: 'object', properties: { maxItems: { type: 'integer', maximum: 50 }, checks: { type: 'object', properties: { security: { type: 'boolean' } } } } });

test('CHK-12 passes: valid org + team policy, enforced value matches the plugin schema', async () => {
  const root = makeRepo({
    'plugins/demo/config.defaults.json': '{"maxItems":10}',
    'plugins/demo/config.schema.json': SCHEMA,
    'policy/org.json': '{"enforced":{"plugins":{"demo":{"settings":{"checks":{"security":true}}}}},"access":{"deny":["legacy-*"]}}',
    'policy/teams/pay.json': '{"enforced":{"plugins":{"demo":{"settings":{"maxItems":5}}}}}',
  });
  assert.deepEqual(await runRule('CHK-12', root), []);
});

test('CHK-12 fails: unknown closed-level key, enforced value against schema, team-vs-org conflict', async () => {
  let r = errors(await runRule('CHK-12', makeRepo({ 'policy/org.json': '{"enforce":{}}' })));
  assert.match(r[0].message, /^POLICY_INVALID/);
  assert.equal(r[0].fix, 'fix policy file');
  r = errors(await runRule('CHK-12', makeRepo({
    'plugins/demo/config.defaults.json': '{}', 'plugins/demo/config.schema.json': SCHEMA,
    'policy/org.json': '{"enforced":{"plugins":{"demo":{"settings":{"maxItems":99}}}}}',
  })));
  assert.match(r[0].message, /does not match its config.schema.json/);
  r = errors(await runRule('CHK-12', makeRepo({
    'policy/org.json': '{"enforced":{"settings":{"x":2}}}',
    'policy/teams/pay.json': '{"enforced":{"settings":{"x":1}}}',
  })));
  assert.equal(r.length, 1);
  assert.equal(r[0].path, 'policy/teams/pay.json');
  assert.match(r[0].message, /ENFORCED_CONFLICT at \/x/);
});

// The conformance vectors are the judge for policy validity and ENFORCED_CONFLICT.
test('CHK-12 agrees with the vectors on policy texts and enforced conflicts', () => {
  const layerSchema = loadSchema(TOOL_ROOT, 'layer-file');
  const dir = path.join(TOOL_ROOT, 'tools', 'kit', 'vectors');
  let checked = 0;
  for (const v of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())) {
    const input = parse(fs.readFileSync(path.join(dir, v, 'input.json')));
    const expected = parse(fs.readFileSync(path.join(dir, v, 'expected.json')));
    const policyErr = (layer) => expected.errors.some((e) => e.layer === layer && /^(POLICY|ACCESS|ENFORCED)_INVALID$/.test(e.code));
    const docs = {};
    for (const [k, text] of Object.entries(input.files)) {
      const m = /^\$KIT\/policy\/(org|teams\/([a-z0-9-]+))\.json$/.exec(k);
      if (!m) continue;
      const layer = m[2] ? 'team' : 'org';
      const { doc, problems } = policyProblems(Buffer.from(text, 'utf8'), layerSchema);
      assert.equal(problems.length > 0, policyErr(layer), `${v}: ${layer} policy validity`);
      docs[layer] = doc;
      checked++;
    }
    if (docs.org && docs.team) {
      const want = expected.warnings.filter((w) => w.code === 'ENFORCED_CONFLICT').map((w) => w.path).sort();
      assert.deepEqual(enforcedConflicts(docs.team, docs.org, input.kit.plugin).sort(), want, `${v}: conflicts`);
    }
  }
  assert.ok(checked >= 10);
});

test('CHK-12 reports a plugin matched by org access.deny as info', async () => {
  const r = await runRule('CHK-12', makeRepo({ 'policy/org.json': '{"access":{"deny":["legacy-*","de*"]}}' }));
  assert.equal(errors(r).length, 0);
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'info');
  assert.equal(r[0].message, 'plugin demo matches org access.deny "de*" (blocked by org policy)');
});
