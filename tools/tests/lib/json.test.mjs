// Tests for tools/kit/json.mjs (strict parser, two modes, canonical serializer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, tryParse, canonical, canonicalPretty, same, compareCodePoints, JsonError } from '../../kit/json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function rejects(text, mode, code, line, column) {
  assert.throws(() => parse(text, { mode }), (e) => {
    assert.ok(e instanceof JsonError, `expected JsonError, got ${e}`);
    assert.equal(e.code, code, `code for ${JSON.stringify(String(text))}`);
    if (line !== undefined) assert.equal(e.line, line, 'line');
    if (column !== undefined) assert.equal(e.column, column, 'column');
    assert.match(e.message, / at line \d+, column \d+$/);
    return true;
  });
}

test('default mode: plain JSON values', () => {
  assert.deepEqual(parse('{"a":[1,2,{"b":null}],"c":true,"d":"x"}'), { a: [1, 2, { b: null }], c: true, d: 'x' });
  assert.equal(parse(' 0.8 '), 0.8);
  assert.deepEqual(parse('{"threshold": 0.6}'), { threshold: 0.6 });
  assert.equal(parse('1e3'), 1000);
  assert.equal(parse('"\\u00e9\\n"'), 'é\n');
  assert.deepEqual(parse('{"/r/.acme/config.json":"x","$KIT/policy/org.json":"y"}'), {
    '/r/.acme/config.json': 'x', '$KIT/policy/org.json': 'y',
  });
  assert.equal(Object.getPrototypeOf(parse('{}')), Object.prototype);
});

test('default mode: rejects duplicate and forbidden keys with position', () => {
  rejects('{"a":1,\n "a":2}', 'default', 'DUPLICATE_KEY', 2, 2);
  rejects('{"a":{"__proto__":1}}', 'default', 'FORBIDDEN_KEY', 1, 7);
  rejects('{"constructor":1}', 'default', 'FORBIDDEN_KEY');
  rejects('[{"prototype":1}]', 'default', 'FORBIDDEN_KEY');
  rejects('{"\\u0061":1,"a":2}', 'default', 'DUPLICATE_KEY'); // escapes decoded before comparing
  rejects('{"__pro\\u0074o__":1}', 'default', 'FORBIDDEN_KEY');
  assert.equal(Object.prototype.polluted, undefined);
});

test('default mode: syntax errors', () => {
  for (const t of ['', '{', '{"a":1,}', '[1,]', '01', '1.', '.5', 'NaN', "{'a':1}", '{"a":1} x', '"a\tb"', '"\\x"']) {
    rejects(t, 'default', 'SYNTAX');
  }
});

test('config mode rejects floats, exponents, 1.0 with line and column', () => {
  rejects('{"a":\n  1.5}', 'config', 'BAD_NUMBER', 2, 3);
  rejects('{"a":1e3}', 'config', 'BAD_NUMBER', 1, 6);
  rejects('{"a":1.0}', 'config', 'BAD_NUMBER', 1, 6);
  rejects('{"a":1E3}', 'config', 'BAD_NUMBER');
  rejects('{"a":9007199254740992}', 'config', 'NUMBER_RANGE');
  rejects('{"a":-9007199254740992}', 'config', 'NUMBER_RANGE');
  assert.deepEqual(parse('{"a":9007199254740991,"b":-9007199254740991,"c":0,"d":-0}', { mode: 'config' }),
    { a: 9007199254740991, b: -9007199254740991, c: 0, d: -0 });
});

test('config mode rejects a BOM (string and bytes)', () => {
  rejects('﻿{}', 'config', 'BOM', 1, 1);
  rejects(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'config', 'BOM', 1, 1);
});

test('config mode rejects lone surrogates (escaped and raw)', () => {
  rejects('{"a":"\\ud800"}', 'config', 'LONE_SURROGATE', 1, 7);
  rejects('{"a":"\\udc00\\ud800"}', 'config', 'LONE_SURROGATE');
  rejects('{"a":"\\ud800x"}', 'config', 'LONE_SURROGATE');
  rejects('{"a":"\uD800"}', 'config', 'LONE_SURROGATE');
  assert.equal(parse('"\\ud83d\\ude00"', { mode: 'config' }), '😀');
  assert.equal(parse('"😀"', { mode: 'config' }), '😀');
  assert.equal(parse('"\\ud800"').length, 1); // allowed in default mode
});

test('config mode rejects bad keys; $schema only at top level', () => {
  rejects('{"settings":{"a b":1}}', 'config', 'BAD_KEY', 1, 14);
  rejects('{"a.b":1}', 'config', 'BAD_KEY');
  rejects('{"é":1}', 'config', 'BAD_KEY');
  rejects(`{"${'k'.repeat(65)}":1}`, 'config', 'BAD_KEY');
  rejects('{"":1}', 'config', 'BAD_KEY');
  rejects('{"settings":{"$schema":1}}', 'config', 'BAD_KEY');
  assert.deepEqual(parse(`{"$schema":"x","A_b-9":{"${'k'.repeat(64)}":1}}`, { mode: 'config' }).$schema, 'x');
  rejects('{"__proto__":{}}', 'config', 'FORBIDDEN_KEY');
  rejects('{"a":1,"a":1}', 'config', 'DUPLICATE_KEY');
});

test('invalid UTF-8 bytes are rejected with position (both modes)', () => {
  const bytes = Buffer.concat([Buffer.from('{\n "a":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  rejects(bytes, 'config', 'INVALID_UTF8', 2, 7);
  rejects(bytes, 'default', 'INVALID_UTF8');
  rejects(Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]), 'default', 'INVALID_UTF8'); // encoded surrogate
  rejects(Buffer.from([0x22, 0xc0, 0xaf, 0x22]), 'default', 'INVALID_UTF8'); // overlong
  rejects(Buffer.from([0x22, 0xe2, 0x82]), 'default', 'INVALID_UTF8'); // truncated
  assert.equal(parse(Buffer.from('"é😀"'), { mode: 'config' }), 'é😀');
});

test('tryParse returns errors instead of throwing', () => {
  assert.deepEqual(tryParse('{"a":1}'), { ok: true, value: { a: 1 } });
  const r = tryParse('{"a":1.5}', { mode: 'config' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_NUMBER');
});

test('canonical output is byte-equal to the SPEC §7.5 example', () => {
  const example = '{"blocked":false,"errors":[],"locked":["/checks/security"],"ok":true,"plugin":"code-review","provenance":{"/checks/security":"org","/maxItems":"user"},"settings":{"checks":{"security":true},"maxItems":5},"tier":"a","warnings":[{"code":"LOCKED_OVERRIDE","layer":"user","path":"/checks/security"}]}';
  const value = {
    warnings: [{ path: '/checks/security', layer: 'user', code: 'LOCKED_OVERRIDE' }],
    tier: 'a',
    settings: { maxItems: 5, checks: { security: true } },
    provenance: { '/maxItems': 'user', '/checks/security': 'org' },
    plugin: 'code-review',
    ok: true,
    locked: ['/checks/security'],
    errors: [],
    blocked: false,
  };
  assert.equal(canonical(value), example);
  assert.equal(canonical(parse(example)), example);
});

test('canonical string escaping: raw UTF-8, only " \\ and controls escaped', () => {
  assert.equal(canonical('a"b\\c\b\f\n\r\t\u0001\u001f\u007f é😀/'),
    '"a\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f\u007f é😀/"');
  assert.equal(canonical('\ud800'), '"\\ud800"');
  assert.equal(canonical(-0), '0');
  assert.equal(canonical(0.6), '0.6');
  assert.throws(() => canonical(NaN), TypeError);
  assert.throws(() => canonical(new Map()), TypeError);
  assert.throws(() => canonical([undefined]), TypeError);
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
});

test('canonical key order is by code point', () => {
  const keys = ['b', 'B', '_', '-', '0', 'a', '￿', '😀'];
  assert.equal(canonical(Object.fromEntries(keys.map((k) => [k, 1]))),
    '{"-":1,"0":1,"B":1,"_":1,"a":1,"b":1,"￿":1,"😀":1}');
  assert.equal(compareCodePoints('￿', '😀'), -1); // UTF-16 order would say the opposite
});

test('canonicalPretty: 2-space indent, LF, trailing newline', () => {
  assert.equal(canonicalPretty({ b: [1, { d: {}, c: [] }], a: 'x' }),
    '{\n  "a": "x",\n  "b": [\n    1,\n    {\n      "c": [],\n      "d": {}\n    }\n  ]\n}\n');
  assert.equal(canonicalPretty({}), '{}\n');
});

test('same() compares canonical text; missing equals nothing', () => {
  assert.ok(same({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }));
  assert.ok(!same([1, 2], [2, 1]));
  assert.ok(!same(undefined, undefined));
});

test('every committed vector expected.json is canonical compact + LF (round-trip)', () => {
  const dir = path.join(ROOT, 'tools', 'kit', 'vectors');
  if (!fs.existsSync(dir)) return;
  for (const v of fs.readdirSync(dir)) {
    const f = path.join(dir, v, 'expected.json');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(canonical(parse(fs.readFileSync(f))) + '\n', text, `${v}/expected.json`);
    parse(fs.readFileSync(path.join(dir, v, 'input.json'))); // envelope parses in default mode
  }
});
