// tools/lib/schema-lite.mjs: a small JSON Schema (draft 2020-12 subset) validator, zero deps.
//
// Supported keywords (anything else throws, so a schema never silently half-validates):
//   annotations (ignored): $schema, $id, $comment, title, description, default, examples
//   $defs, $ref (local "#/..." JSON Pointers only)
//   type (string or array; "integer" = number with no fraction), enum, const
//   properties, required, additionalProperties (bool or schema), propertyNames
//   items, prefixItems, minItems, maxItems, uniqueItems
//   minLength, maxLength (counted in code points), pattern (ECMAScript, unanchored, 'u' flag)
//   minimum, maximum, exclusiveMinimum, exclusiveMaximum
//   anyOf, oneOf, allOf, not
//   format: "uri" (must parse with new URL()); other formats are annotations
//
// API:
//   validate(schema, value) -> [{ path, keyword, message }]   (path = JSON Pointer; [] = valid)
//   loadSchema(root, name) -> schema       reads <root>/tools/schemas/<name>.schema.json
//   assertSupported(schema)               throws if ANY subschema uses an unsupported keyword
//   SUPPORTED_KEYWORDS

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, same, canonical } from '../kit/json.mjs';

const ANNOTATIONS = ['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples'];
const ASSERTIONS = [
  '$defs', '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties',
  'propertyNames', 'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minLength',
  'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'anyOf',
  'oneOf', 'allOf', 'not', 'format',
];
export const SUPPORTED_KEYWORDS = Object.freeze([...ANNOTATIONS, ...ASSERTIONS]);

const escPtr = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // object, string, number, boolean
}

function hasType(v, t) {
  const actual = typeOf(v);
  if (t === 'integer') return actual === 'number' && Number.isInteger(v);
  return actual === t;
}

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#')) throw new Error(`schema-lite: only local $ref is supported (${ref})`);
  let node = rootSchema;
  for (const seg of ref.slice(1).split('/').filter(Boolean)) {
    const k = decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[k];
    if (node === undefined) throw new Error(`schema-lite: unresolved $ref ${ref}`);
  }
  return node;
}

const regexCache = new Map();
function re(pattern) {
  if (!regexCache.has(pattern)) regexCache.set(pattern, new RegExp(pattern, 'u'));
  return regexCache.get(pattern);
}

export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', schema, errors);
  return errors;
}

function check(schema, v, path, root, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push({ path, keyword: 'false', message: 'no value is allowed here' }); return; }
  if (!isObj(schema)) throw new Error(`schema-lite: invalid schema at ${path || '/'}`);
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(k)) throw new Error(`schema-lite: unsupported keyword "${k}"`);
  }
  const err = (keyword, message, p = path) => errors.push({ path: p, keyword, message });

  if (schema.$ref !== undefined) check(resolveRef(root, schema.$ref), v, path, root, errors);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => hasType(v, t))) {
      err('type', `expected ${types.join(' or ')}, got ${typeOf(v)}`);
      return; // further keywords would only add noise
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => same(e, v))) {
    err('enum', `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (schema.const !== undefined && !same(schema.const, v)) err('const', `must be ${JSON.stringify(schema.const)}`);

  if (typeof v === 'string') {
    const len = [...v].length;
    if (schema.minLength !== undefined && len < schema.minLength) err('minLength', `must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && len > schema.maxLength) err('maxLength', `must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !re(schema.pattern).test(v)) err('pattern', `must match ${schema.pattern}`);
    if (schema.format === 'uri') {
      let ok = true;
      try { new URL(v); } catch { ok = false; }
      if (!ok) err('format', 'must be a valid URL');
    }
  }

  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) err('minimum', `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) err('maximum', `must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum) err('exclusiveMinimum', `must be > ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && v >= schema.exclusiveMaximum) err('exclusiveMaximum', `must be < ${schema.exclusiveMaximum}`);
  }

  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) err('minItems', `must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) err('maxItems', `must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const seen = new Set();
      v.forEach((x, k) => {
        const key = canonical(x);
        if (seen.has(key)) err('uniqueItems', 'duplicate item', `${path}/${k}`);
        seen.add(key);
      });
    }
    const prefix = schema.prefixItems ?? [];
    v.forEach((x, k) => {
      if (k < prefix.length) check(prefix[k], x, `${path}/${k}`, root, errors);
      else if (schema.items !== undefined) check(schema.items, x, `${path}/${k}`, root, errors);
    });
  }

  if (isObj(v)) {
    for (const r of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(v, r)) err('required', `missing required property "${r}"`);
    }
    const props = schema.properties ?? {};
    for (const k of Object.keys(v)) {
      const p = `${path}/${escPtr(k)}`;
      if (schema.propertyNames !== undefined) {
        const sub = [];
        check(schema.propertyNames, k, p, root, sub);
        if (sub.length) err('propertyNames', `property name "${k}" is not allowed: ${sub[0].message}`, p);
      }
      if (Object.prototype.hasOwnProperty.call(props, k)) check(props[k], v[k], p, root, errors);
      else if (schema.additionalProperties === false) err('additionalProperties', `unknown property "${k}"`, p);
      else if (schema.additionalProperties !== undefined) check(schema.additionalProperties, v[k], p, root, errors);
    }
  }

  const branch = (s) => { const sub = []; check(s, v, path, root, sub); return sub; };
  if (schema.allOf) for (const s of schema.allOf) check(s, v, path, root, errors);
  if (schema.anyOf && !schema.anyOf.some((s) => branch(s).length === 0)) err('anyOf', 'does not match any allowed form');
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => branch(s).length === 0).length;
    if (n !== 1) err('oneOf', `must match exactly one allowed form (matched ${n})`);
  }
  if (schema.not !== undefined && branch(schema.not).length === 0) err('not', 'matches a forbidden form');
}

export function assertSupported(schema, where = '#') {
  if (typeof schema === 'boolean') return;
  if (!isObj(schema)) throw new Error(`schema-lite: invalid schema at ${where}`);
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(k)) throw new Error(`schema-lite: unsupported keyword "${k}" at ${where}`);
  }
  const sub = (s, p) => assertSupported(s, `${where}/${p}`);
  for (const k of ['additionalProperties', 'propertyNames', 'items', 'not']) {
    if (schema[k] !== undefined) sub(schema[k], k);
  }
  for (const k of ['prefixItems', 'anyOf', 'oneOf', 'allOf']) (schema[k] ?? []).forEach((s, n) => sub(s, `${k}/${n}`));
  for (const k of ['properties', '$defs']) for (const [n, s] of Object.entries(schema[k] ?? {})) sub(s, `${k}/${n}`);
}

export function loadSchema(root, name) {
  return parse(readFileSync(join(root, 'tools', 'schemas', `${name}.schema.json`)));
}
