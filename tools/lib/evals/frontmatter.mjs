// tools/lib/evals/frontmatter.mjs: a small YAML-subset reader for eval files (SPEC §15.1).
// It reads `prompt.md` and `graders/*.md` frontmatter and whole `case.yaml` files.
//
// Supported: block maps (any depth, by indentation), block lists (`- x`), flow lists (`[a, b]`),
// plain scalars (int/float/true/false/null/~ or string), 'single-quoted' (backslashes literal,
// '' = '), "double-quoted" (JSON-style escapes), block scalars `|` / `>` (with optional `-`),
// full-line and trailing ` #` comments. Anything else throws a YamlError with a line number.
// Not supported on purpose: anchors, tags, flow maps, multi-document streams.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

/** Split `---\n<yaml>\n---\n<body>`. No frontmatter -> { data: {}, body: text, hasFrontmatter: false }. */
export function splitFrontmatter(text) {
  const t = String(text).replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m || !t.startsWith('---')) return { data: {}, body: t, hasFrontmatter: false };
  return { data: parseYaml(m[1]) ?? {}, body: t.slice(m[0].length), hasFrontmatter: true };
}

/** Parse a YAML-subset document. Empty document -> null. */
export function parseYaml(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((raw, i) => ({ raw, no: i + 1 }));
  const st = { lines, i: 0 };
  skipBlank(st);
  if (st.i >= lines.length) return null;
  const value = parseNode(st, indentOf(lines[st.i].raw));
  skipBlank(st);
  if (st.i < lines.length) throw new YamlError('unexpected indentation', lines[st.i].no);
  return value;
}

const indentOf = (s) => /^ */.exec(s)[0].length;
const isBlank = (s) => /^\s*(#.*)?$/.test(s);

function skipBlank(st) {
  while (st.i < st.lines.length && isBlank(st.lines[st.i].raw)) st.i++;
}

/** Parse the map or list that starts at the current line with exactly `indent` spaces. */
function parseNode(st, indent) {
  const { raw, no } = st.lines[st.i];
  if (/\t/.test(/^\s*/.exec(raw)[0])) throw new YamlError('tabs are not allowed for indentation', no);
  return /^ *- |^ *-$/.test(raw) ? parseList(st, indent) : parseMap(st, indent);
}

function parseMap(st, indent) {
  const out = {};
  while (true) {
    skipBlank(st);
    if (st.i >= st.lines.length) return out;
    const { raw, no } = st.lines[st.i];
    const ind = indentOf(raw);
    if (ind < indent) return out;
    if (ind > indent) throw new YamlError('unexpected indentation', no);
    const m = /^ *([^\s:'"#\-[\]{}][^:]*?|'[^']*'|"[^"]*"):(?:[ \t]+(.*))?$/.exec(raw);
    if (!m) throw new YamlError(`cannot parse "${raw.trim()}"`, no);
    let key = m[1];
    if (/^['"]/.test(key)) key = key.slice(1, -1);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, no);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new YamlError(`forbidden key "${key}"`, no);
    st.i++;
    out[key] = parseValue(st, stripComment(m[2] ?? ''), indent, no);
  }
}

function parseList(st, indent) {
  const out = [];
  while (true) {
    skipBlank(st);
    if (st.i >= st.lines.length) return out;
    const { raw, no } = st.lines[st.i];
    const ind = indentOf(raw);
    if (ind < indent) return out;
    if (ind > indent) throw new YamlError('unexpected indentation', no);
    const m = /^ *-(?:[ \t]+(.*))?$/.exec(raw);
    if (!m) return out; // a map key at the same indent ends the list
    st.i++;
    const rest = stripComment(m[1] ?? '');
    if (/^[^'"[\s][^:]*:(\s|$)/.test(rest)) throw new YamlError('maps inside lists are not supported', no);
    out.push(parseValue(st, rest, indent, no));
  }
}

/** The value after `key:` or `- `: inline scalar, flow list, block scalar, or a nested block. */
function parseValue(st, rest, indent, no) {
  if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') return blockScalar(st, rest, indent);
  if (rest !== '') return scalar(rest, no);
  skipBlank(st);
  if (st.i >= st.lines.length) return null;
  const ind = indentOf(st.lines[st.i].raw);
  // `key:` followed by a deeper block, or by a list at the same indent (common YAML style).
  if (ind > indent || (ind === indent && /^ *-( |$)/.test(st.lines[st.i].raw))) return parseNode(st, ind);
  return null;
}

function blockScalar(st, style, indent) {
  const body = [];
  let blockIndent = null;
  while (st.i < st.lines.length) {
    const { raw } = st.lines[st.i];
    if (raw.trim() === '') { body.push(''); st.i++; continue; }
    const ind = indentOf(raw);
    if (ind <= indent) break;
    if (blockIndent === null) blockIndent = ind;
    if (ind < blockIndent) break;
    body.push(raw.slice(blockIndent));
    st.i++;
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  const text = style.startsWith('|') ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
  return style.endsWith('-') ? text : `${text}\n`;
}

/** Remove a trailing ` # comment` that is outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[,]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trim();
}

/** Inline scalar or flow list. */
export function scalar(s, no) {
  const t = s.trim();
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError(`unterminated flow list: ${t}`, no);
    return splitFlow(t.slice(1, -1), no).map((x) => scalar(x, no));
  }
  if (t.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(t)) throw new YamlError(`bad single-quoted scalar: ${t}`, no);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      throw new YamlError(`bad double-quoted scalar: ${t}`, no);
    }
  }
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?(0|[1-9][0-9]*)$/.test(t)) return Number(t);
  if (/^-?(0|[1-9][0-9]*)?\.[0-9]+$/.test(t)) return Number(t);
  if (/^[{&*!|>%@`]/.test(t)) throw new YamlError(`unsupported YAML syntax: ${t}`, no);
  return t;
}

function splitFlow(s, no) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else if (c === '[' || c === '{') {
      throw new YamlError('nested flow collections are not supported', no);
    } else cur += c;
  }
  if (q) throw new YamlError('unterminated quote in flow list', no);
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out.filter((x, i, a) => !(x === '' && i === a.length - 1));
}
