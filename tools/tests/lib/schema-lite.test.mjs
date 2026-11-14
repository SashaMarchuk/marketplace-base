// Tests for tools/lib/schema-lite.mjs and the U2 schemas (plugin-src, marketplace-config, lock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, loadSchema, assertSupported } from '../../lib/schema-lite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ok = (schema, v) => assert.deepEqual(validate(schema, v), []);
const bad = (schema, v, keyword, p) => {
  const errs = validate(schema, v);
  assert.ok(errs.some((e) => e.keyword === keyword && (p === undefined || e.path === p)),
    `expected ${keyword} at ${p}: ${JSON.stringify(errs)}`);
};

test('core keywords', () => {
  const s = {
    type: 'object', additionalProperties: false, required: ['a'],
    properties: {
      a: { type: 'integer', minimum: 1, maximum: 3 },
      b: { type: 'string', minLength: 1, maxLength: 2, pattern: '^[a-z]+$' },
      c: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, prefixItems: [{ const: 'x' }], items: { enum: ['x', 'y'] } },
      d: { anyOf: [{ type: 'boolean' }, { const: 'strict' }] },
      e: { $ref: '#/$defs/url' },
      f: { type: 'object', propertyNames: { pattern: '^[a-z]+$' }, additionalProperties: { type: 'number' } },
      g: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      h: { not: { const: 0 }, oneOf: [{ type: 'number' }, { type: 'integer' }] },
    },
    $defs: { url: { type: 'string', format: 'uri' } },
  };
  ok(s, { a: 2, b: 'ab', c: ['x', 'y'], d: 'strict', e: 'https://example.com', f: { a: 1.5 }, g: null });
  bad(s, {}, 'required', '');
  bad(s, { a: 1.5 }, 'type', '/a');
  bad(s, { a: 4 }, 'maximum', '/a');
  bad(s, { a: 1, z: 1 }, 'additionalProperties', '/z');
  bad(s, { a: 1, b: 'abc' }, 'maxLength', '/b');
  bad(s, { a: 1, b: 'A' }, 'pattern', '/b');
  bad(s, { a: 1, c: ['y'] }, 'const', '/c/0');
  bad(s, { a: 1, c: ['x', 'x'] }, 'uniqueItems', '/c/1');
  bad(s, { a: 1, c: ['x', 'z'] }, 'enum', '/c/1');
  bad(s, { a: 1, d: 'loose' }, 'anyOf', '/d');
  bad(s, { a: 1, e: 'not a url' }, 'format', '/e');
  bad(s, { a: 1, f: { A: 1 } }, 'propertyNames', '/f/A');
  bad(s, { a: 1, f: { a: 'x' } }, 'type', '/f/a');
  bad(s, { a: 1, h: 2 }, 'oneOf', '/h'); // 2 matches both branches
  bad(s, { a: 1, h: 0 }, 'not', '/h');
  ok({ type: 'string', maxLength: 1 }, '😀'); // code points, not UTF-16 units
});

test('unknown keywords and non-local refs throw', () => {
  assert.throws(() => validate({ type: 'string', contentMediaType: 'x' }, 'a'), /unsupported keyword/);
  assert.throws(() => validate({ $ref: 'other.json#' }, 1), /local \$ref/);
  assert.throws(() => assertSupported({ properties: { a: { items: { if: {} } } } }), /unsupported keyword "if" at #\/properties\/a\/items/);
  assertSupported({ $defs: { a: { anyOf: [true, { type: 'string' }] } } });
  assert.throws(() => validate({ $ref: '#/$defs/nope' }, 1), /unresolved/);
});

test('plugin-src schema (SPEC §3)', () => {
  const s = loadSchema(ROOT, 'plugin-src');
  const good = {
    $schema: '../../tools/schemas/plugin-src.schema.json', name: 'code-review', version: '0.1.0',
    description: 'Review a diff against a configurable checklist. Read-only.',
    author: { name: 'Example Author', email: 'a@example.com', url: 'https://example.com' },
    keywords: ['review', 'quality'], category: 'Productivity', license: 'MIT',
    homepage: 'https://example.com/h', repository: 'https://example.com/r',
    codex: { policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  };
  ok(s, good);
  ok(s, { name: 'a', version: '1.2.3', description: 'X.' });
  ok(s, { ...good, codex: { policy: { authentication: 'SOMETHING_ELSE' } } }); // CHK warning, not schema
  bad(s, { ...good, name: 'Code_Review' }, 'pattern', '/name');
  bad(s, { ...good, name: 'a'.repeat(65) }, 'maxLength', '/name');
  bad(s, { ...good, version: '0.1' }, 'pattern', '/version');
  bad(s, { ...good, version: '0.1.0-rc.1' }, 'pattern', '/version');
  bad(s, { ...good, description: 'No period' }, 'pattern', '/description');
  bad(s, { ...good, description: '' }, 'minLength', '/description');
  bad(s, { ...good, keywords: Array.from({ length: 11 }, (_, k) => `k${k}`) }, 'maxItems', '/keywords');
  bad(s, { ...good, homepage: 'nope' }, 'format', '/homepage');
  bad(s, { ...good, codex: { policy: { installation: 'MAYBE' } } }, 'enum', '/codex/policy/installation');
  bad(s, { ...good, interface: {} }, 'additionalProperties', '/interface');
  bad(s, { version: '1.0.0', description: 'x.' }, 'required', '');
});

test('marketplace-config schema (SPEC §5)', () => {
  const s = loadSchema(ROOT, 'marketplace-config');
  const good = {
    $schema: './tools/schemas/marketplace-config.schema.json', name: 'marketplace-base',
    displayName: 'Marketplace Base', description: 'A base for agent-skill marketplaces.',
    owner: { name: 'Example Owner', email: 'owner@example.com' },
    distribution: { source: 'github', repo: 'acme/skills' }, includeExamples: true,
    config: { layers: ['skill-defaults', 'org', 'team', 'project', 'user', 'project-local'] },
    codex: { defaultCategory: 'Productivity', policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    base: { url: 'https://github.com/acme/marketplace-base' }, ci: { osMatrix: ['ubuntu-latest'] },
    policyEmit: { marketplaceOnly: false },
    evals: { threshold: 0.6, runs: 3, maxCostUsd: 5, models: { claude: 'm1', codex: 'm2', judge: 'm3' } },
  };
  ok(s, good);
  ok(s, { ...good, includeExamples: ['code-review'], policyEmit: { marketplaceOnly: 'strict' } });
  ok(s, { ...good, config: { layers: ['skill-defaults', 'org', 'user', 'project'] } }); // reorder is data
  for (const n of ['claude-tools', 'anthropic', 'openai-x', 'codexy', 'Bad']) bad(s, { ...good, name: n }, 'pattern', '/name');
  bad(s, { ...good, config: { layers: ['org', 'skill-defaults'] } }, 'const', '/config/layers/0');
  bad(s, { ...good, config: { layers: ['skill-defaults', 'org', 'org'] } }, 'uniqueItems');
  bad(s, { ...good, config: { layers: ['skill-defaults', 'global'] } }, 'enum', '/config/layers/1');
  bad(s, { ...good, policyEmit: { marketplaceOnly: 'yes' } }, 'anyOf');
  bad(s, { ...good, evals: { threshold: 1.5 } }, 'maximum', '/evals/threshold');
  bad(s, { ...good, evals: { runs: 1.5 } }, 'type', '/evals/runs');
  bad(s, { ...good, owner: { email: 'a@example.com' } }, 'required', '/owner');
  bad(s, { ...good, extra: 1 }, 'additionalProperties', '/extra');
});

test('lock schema (SPEC §14.2)', () => {
  const s = loadSchema(ROOT, 'lock');
  const good = {
    adopted: ['code-review'], lockVersion: 1,
    base: { url: 'https://github.com/acme/marketplace-base', tag: 'v1.2.0', commit: 'a'.repeat(40) },
    files: { 'tools/mb.mjs': 'b'.repeat(64) },
  };
  ok(s, good);
  ok(s, { ...good, base: { ...good.base, commit: null } }); // offline init
  bad(s, { ...good, base: { ...good.base, commit: 'abc' } }, 'anyOf', '/base/commit');
  bad(s, { ...good, files: { x: 'nothex' } }, 'pattern', '/files/x');
  bad(s, { ...good, lockVersion: 2 }, 'const', '/lockVersion');
  bad(s, { ...good, base: { ...good.base, tag: '1.2.0' } }, 'pattern', '/base/tag');
});

test('all schemas in tools/schemas parse and use only supported keywords', () => {
  const dir = path.join(ROOT, 'tools', 'schemas');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.schema.json'))) {
    const schema = loadSchema(ROOT, f.slice(0, -'.schema.json'.length));
    assertSupported(schema); // walks every subschema
  }
});
