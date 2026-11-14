// tools/kit/json.mjs: the ONLY JSON parser and canonical serializer of marketplace-base.
//
// This file is vendored byte-for-byte into every configurable skill (`skills/<s>/_mb/json.mjs`)
// next to resolve.mjs. It must stay standalone: no imports at all (not even node:), so it runs
// on node >= 20 and on bun.
//
// parse(text, { mode })
//   text: string | Uint8Array (Buffer). Pass BYTES for file contents: only bytes let the parser
//         see a BOM or invalid UTF-8 (readFileSync(p, 'utf8') silently turns bad bytes into U+FFFD).
//   mode: 'default' (default) or 'config'.
//     default: strict RFC 8259 JSON, plus: duplicate keys rejected, keys __proto__ / constructor /
//              prototype rejected at any depth. Floats allowed. Used for CHK-01, marketplace.config.json,
//              generated files, vector envelopes (whose `files` keys are paths).
//     config:  default + the config-text rules, for config-FILE TEXT only (layer files,
//              config.defaults.json, the file texts inside a vector's `files`):
//              number tokens must match -?(0|[1-9][0-9]*) within +-(2^53-1); keys must match
//              ^[A-Za-z0-9_:-]{1,64}$ (top-level "$schema" allowed); lone surrogate escapes
//              (and raw lone surrogate code units) rejected.
//   Both modes reject a leading BOM and invalid UTF-8.
//   Returns plain objects (Object.prototype; safe because forbidden keys never reach assignment).
//   Throws JsonError { code, message, line, column, offset }. line/column are 1-based; column
//   counts UTF-16 code units of the decoded text; offset is the 0-based index in the decoded text
//   (byte offset for INVALID_UTF8).
//   Error codes: SYNTAX, BOM, INVALID_UTF8, DUPLICATE_KEY, FORBIDDEN_KEY, BAD_KEY, BAD_NUMBER,
//                NUMBER_RANGE, LONE_SURROGATE, TOO_DEEP.
// tryParse(text, opts) -> { ok: true, value } | { ok: false, error }
//
// canonical(value)       compact canonical JSON, NO trailing newline.
// canonicalPretty(value) pretty canonical JSON: sorted keys, 2-space indent, LF, WITH trailing "\n".
//   Keys sorted by Unicode code point. Strings raw UTF-8; only `"`, `\` and U+0000-U+001F are
//   escaped (\b \f \n \r \t, else \u00xx lowercase); a lone surrogate (only reachable from a
//   default-mode parse) is written as \udxxx lowercase. Numbers: integers as digits; -0 -> 0;
//   non-integers use the shortest round-trip form (String(n)); NaN/Infinity throw. Object members
//   whose value is undefined are omitted; undefined elsewhere, functions, symbols, bigint, and
//   non-plain objects (Map, Date, class instances) throw TypeError.
// same(a, b)          canonical text equality.
// compareCodePoints   string comparator by code point (canonical key order).

export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const CONFIG_KEY_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const CONFIG_INT_RE = /^-?(0|[1-9][0-9]*)$/;
const NUMBER_RE = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const MAX_DEPTH = 512;

export class JsonError extends Error {
  constructor(code, detail, line, column, offset) {
    super(`${detail} at line ${line}, column ${column}`);
    this.name = 'JsonError';
    this.code = code;
    this.detail = detail;
    this.line = line;
    this.column = column;
    this.offset = offset;
  }
}

// Returns the byte offset of the first invalid UTF-8 sequence, or -1.
function firstInvalidUtf8(b) {
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    let n, min;
    if (c >= 0xc2 && c <= 0xdf) { n = 1; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { n = 2; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { n = 3; min = 0x10000; }
    else return i;
    let cp = c & (0x3f >> n);
    for (let k = 1; k <= n; k++) {
      const cc = b[i + k];
      if (cc === undefined || (cc & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += n + 1;
  }
  return -1;
}

function decodeBytes(bytes) {
  const bad = firstInvalidUtf8(bytes);
  if (bad >= 0) {
    // Position: count lines in the valid prefix, column in decoded code units.
    const prefix = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, bad));
    const nl = prefix.lastIndexOf('\n');
    const line = prefix.split('\n').length;
    throw new JsonError('INVALID_UTF8', 'invalid UTF-8', line, prefix.length - nl, bad);
  }
  // ignoreBOM: true keeps a leading U+FEFF in the output so the parser can reject it.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function lineCol(s, offset) {
  let line = 1, last = -1;
  for (let i = 0; i < offset && i < s.length; i++) if (s.charCodeAt(i) === 10) { line++; last = i; }
  return [line, offset - last];
}

export function parse(text, opts = {}) {
  const mode = opts.mode ?? 'default';
  if (mode !== 'default' && mode !== 'config') throw new TypeError(`json.parse: unknown mode ${mode}`);
  const cfg = mode === 'config';
  let s;
  if (typeof text === 'string') s = text;
  else if (text instanceof Uint8Array) s = decodeBytes(text);
  else throw new TypeError('json.parse: text must be a string or Uint8Array');

  let i = 0;
  const fail = (code, detail, at = i) => {
    const [line, column] = lineCol(s, at);
    throw new JsonError(code, detail, line, column, at);
  };
  const ws = () => {
    for (;;) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else return;
    }
  };
  const describe = () => (i >= s.length ? 'unexpected end of input' : `unexpected character ${JSON.stringify(s[i])}`);

  if (s.charCodeAt(0) === 0xfeff) fail('BOM', 'byte order mark is not allowed', 0);

  function parseString() {
    const start = i;
    i++; // opening quote
    let out = '';
    for (;;) {
      if (i >= s.length) fail('SYNTAX', 'unterminated string', start);
      const c = s.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) fail('SYNTAX', 'control character in string');
      if (c === 0x5c) {
        const e = s[i + 1];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
        if (simple !== undefined) { out += simple; i += 2; continue; }
        if (e !== 'u') fail('SYNTAX', 'invalid escape', i);
        const cu = readHex4(i + 2);
        if (cfg && cu >= 0xd800 && cu <= 0xdfff) {
          // Must be a high surrogate escape immediately followed by a low surrogate escape.
          const okPair = cu <= 0xdbff && s[i + 6] === '\\' && s[i + 7] === 'u' &&
            (() => { const lo = readHex4(i + 8); return lo >= 0xdc00 && lo <= 0xdfff; })();
          if (!okPair) fail('LONE_SURROGATE', 'lone surrogate escape', i);
          out += String.fromCharCode(cu, readHex4(i + 8));
          i += 12;
          continue;
        }
        out += String.fromCharCode(cu);
        i += 6;
        continue;
      }
      if (cfg && c >= 0xd800 && c <= 0xdfff) {
        const n = s.charCodeAt(i + 1);
        if (c > 0xdbff || !(n >= 0xdc00 && n <= 0xdfff)) fail('LONE_SURROGATE', 'lone surrogate', i);
        out += s[i] + s[i + 1];
        i += 2;
        continue;
      }
      out += s[i];
      i++;
    }
  }

  function readHex4(at) {
    const h = s.slice(at, at + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(h)) fail('SYNTAX', 'invalid \\u escape', at);
    return parseInt(h, 16);
  }

  function parseNumber() {
    const start = i;
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(s);
    if (!m || m[0] === '' || m[0] === '-') fail('SYNTAX', describe());
    const tok = m[0];
    i += tok.length;
    if (cfg) {
      if (!CONFIG_INT_RE.test(tok)) fail('BAD_NUMBER', `number ${tok} is not an integer token`, start);
      const n = Number(tok);
      if (!Number.isSafeInteger(n)) fail('NUMBER_RANGE', `number ${tok} is outside +-(2^53-1)`, start);
      return n;
    }
    return Number(tok);
  }

  function parseValue(depth) {
    if (depth > MAX_DEPTH) fail('TOO_DEEP', 'nesting too deep');
    ws();
    const c = s[i];
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    for (const [lit, val] of [['true', true], ['false', false], ['null', null]]) {
      if (s.startsWith(lit, i)) { i += lit.length; return val; }
    }
    return fail('SYNTAX', describe());
  }

  function parseObject(depth) {
    i++; // {
    const obj = {};
    ws();
    if (s[i] === '}') { i++; return obj; }
    for (;;) {
      ws();
      if (s[i] !== '"') fail('SYNTAX', `expected string key, ${describe()}`);
      const at = i;
      const key = parseString();
      if (FORBIDDEN_KEYS.includes(key)) fail('FORBIDDEN_KEY', `forbidden key ${JSON.stringify(key)}`, at);
      if (Object.prototype.hasOwnProperty.call(obj, key)) fail('DUPLICATE_KEY', `duplicate key ${JSON.stringify(key)}`, at);
      if (cfg && !CONFIG_KEY_RE.test(key) && !(depth === 0 && key === '$schema')) {
        fail('BAD_KEY', `key ${JSON.stringify(key)} does not match ^[A-Za-z0-9_:-]{1,64}$`, at);
      }
      ws();
      if (s[i] !== ':') fail('SYNTAX', `expected ':', ${describe()}`);
      i++;
      obj[key] = parseValue(depth + 1);
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return obj; }
      fail('SYNTAX', `expected ',' or '}', ${describe()}`);
    }
  }

  function parseArray(depth) {
    i++; // [
    const arr = [];
    ws();
    if (s[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(parseValue(depth + 1));
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return arr; }
      fail('SYNTAX', `expected ',' or ']', ${describe()}`);
    }
  }

  const value = parseValue(0);
  ws();
  if (i < s.length) fail('SYNTAX', `${describe()} after the JSON value`);
  return value;
}

export function tryParse(text, opts) {
  try {
    return { ok: true, value: parse(text, opts) };
  } catch (error) {
    if (error instanceof JsonError) return { ok: false, error };
    throw error;
  }
}

// ---- canonical serialization ----

export function compareCodePoints(a, b) {
  const ia = a[Symbol.iterator](), ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(), y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0), cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

const SHORT_ESCAPES = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
const hex4 = (c) => '\\u' + c.toString(16).padStart(4, '0');

function serString(str) {
  let out = '"';
  for (let k = 0; k < str.length; k++) {
    const c = str.charCodeAt(k);
    if (SHORT_ESCAPES[c] !== undefined) out += SHORT_ESCAPES[c];
    else if (c < 0x20) out += hex4(c);
    else if (c >= 0xd800 && c <= 0xdbff) {
      const n = str.charCodeAt(k + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[k] + str[k + 1]; k++; }
      else out += hex4(c);
    } else if (c >= 0xdc00 && c <= 0xdfff) out += hex4(c);
    else out += str[k];
  }
  return out + '"';
}

function serNumber(n) {
  if (!Number.isFinite(n)) throw new TypeError(`canonical JSON: non-finite number ${n}`);
  if (Object.is(n, -0)) return '0';
  return String(n);
}

function ser(v, indent, cur) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number': return serNumber(v);
    case 'string': return serString(v);
    case 'object': break;
    default: throw new TypeError(`canonical JSON: unsupported ${typeof v} value`);
  }
  const inner = indent === null ? '' : cur + indent;
  const nl = indent === null ? '' : '\n';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((x) => {
      if (x === undefined) throw new TypeError('canonical JSON: undefined array element');
      return inner + ser(x, indent, inner);
    });
    return '[' + nl + items.join(',' + nl) + nl + cur + ']';
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new TypeError('canonical JSON: non-plain object');
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(compareCodePoints);
  if (keys.length === 0) return '{}';
  const colon = indent === null ? ':' : ': ';
  const members = keys.map((k) => inner + serString(k) + colon + ser(v[k], indent, inner));
  return '{' + nl + members.join(',' + nl) + nl + cur + '}';
}

export function canonical(value) {
  if (value === undefined) throw new TypeError('canonical JSON: undefined value');
  return ser(value, null, '');
}

export function canonicalPretty(value) {
  if (value === undefined) throw new TypeError('canonical JSON: undefined value');
  return ser(value, '  ', '') + '\n';
}

export function same(a, b) {
  if (a === undefined || b === undefined) return false; // a missing value equals nothing
  return canonical(a) === canonical(b);
}
