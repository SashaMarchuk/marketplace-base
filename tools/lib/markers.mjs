// tools/lib/markers.mjs: G-marker blocks.
//
// A marker is a WHOLE LINE (an optional trailing \r is tolerated):
//   html style: <!-- mb:<id>:begin -->   ...   <!-- mb:<id>:end -->
//   hash style: # mb:<id>:begin          ...   # mb:<id>:end          (.gitignore)
// <id> matches [a-z0-9-]+. The BODY of a pair is every character after the line feed that ends the
// begin line, up to (not including) the first character of the end line. "Emptied" means the body
// is removed, so the pair becomes "<begin line>\n<end line>".
//
// All functions work on JS strings. To work on raw bytes losslessly (the lock hash rule), decode
// with 'latin1' and re-encode with 'latin1' (markers are pure ASCII); hash.mjs does this.
// Functions never throw on malformed markers; findMarkers() reports problems for CHK-23.

export const MARKER_FILES = Object.freeze([
  { file: 'README.md', ids: ['catalog', 'install'], style: 'html' },
  { file: 'USAGE.md', ids: ['config-locations'], style: 'html' },
  { file: 'AGENTS.md', ids: ['agents'], style: 'html' },
  { file: '.gitignore', ids: ['gitignore'], style: 'hash' },
  // Every configurable skill's SKILL.md (matched by basename under a skills/<s>/ dir).
  { file: 'SKILL.md', ids: ['config'], style: 'html', basename: true },
]);

const LINE_RE = /^(?:<!-- mb:([a-z0-9-]+):(begin|end) -->|# mb:([a-z0-9-]+):(begin|end))\r?$/;

/** The begin/end line texts (no newline) for a marker id. */
export function markerLines(id, style = 'html') {
  if (style === 'hash') return { begin: `# mb:${id}:begin`, end: `# mb:${id}:end` };
  return { begin: `<!-- mb:${id}:begin -->`, end: `<!-- mb:${id}:end -->` };
}

/** Marker spec for a repo-relative POSIX path, or null if the file carries no G markers. */
export function markerSpecFor(relPath) {
  const p = relPath.replace(/\\/g, '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  for (const spec of MARKER_FILES) {
    if (spec.basename ? base === spec.file && /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(p) : p === spec.file) return spec;
  }
  return null;
}

/**
 * Scan text for marker lines.
 * Returns { pairs, problems }:
 *   pairs: [{ id, style, beginStart, bodyStart, bodyEnd, endEnd, line }] (offsets into text;
 *          body = text.slice(bodyStart, bodyEnd); line = 1-based line of the begin marker)
 *   problems: [{ id, line, problem }] with problem one of
 *          'unmatched-begin', 'unmatched-end', 'nested', 'duplicate', 'style-mismatch'
 */
export function findMarkers(text) {
  const pairs = [], problems = [];
  const seen = new Set();
  let open = null;
  let pos = 0, line = 0;
  while (pos <= text.length) {
    line++;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const next = nl === -1 ? text.length + 1 : nl + 1;
    const m = LINE_RE.exec(text.slice(pos, lineEnd));
    if (m) {
      const style = m[1] ? 'html' : 'hash';
      const id = m[1] ?? m[3];
      const kind = m[2] ?? m[4];
      if (kind === 'begin') {
        if (open) problems.push({ id, line, problem: 'nested' });
        else open = { id, style, beginStart: pos, bodyStart: Math.min(next, text.length), line };
      } else if (!open || open.id !== id) {
        problems.push({ id, line, problem: 'unmatched-end' });
      } else if (open.style !== style) {
        problems.push({ id, line, problem: 'style-mismatch' });
        open = null;
      } else {
        if (seen.has(id)) problems.push({ id, line: open.line, problem: 'duplicate' });
        seen.add(id);
        pairs.push({ ...open, bodyEnd: pos, endEnd: lineEnd });
        open = null;
      }
    }
    pos = next;
  }
  if (open) problems.push({ id: open.id, line: open.line, problem: 'unmatched-begin' });
  return { pairs, problems };
}

/** Body text of marker `id` (first well-formed pair), or null if absent. */
export function getMarkerBody(text, id) {
  const p = findMarkers(text).pairs.find((x) => x.id === id);
  return p ? text.slice(p.bodyStart, p.bodyEnd) : null;
}

/**
 * Replace the body of marker `id`. A non-empty body gets a trailing "\n" if it lacks one.
 * Throws if the id does not occur exactly once as a well-formed pair.
 */
export function replaceMarker(text, id, body) {
  const matches = findMarkers(text).pairs.filter((x) => x.id === id);
  if (matches.length !== 1) throw new Error(`marker ${id}: expected exactly one well-formed pair, found ${matches.length}`);
  const p = matches[0];
  const b = body === '' || body.endsWith('\n') ? body : body + '\n';
  return text.slice(0, p.bodyStart) + b + text.slice(p.bodyEnd);
}

/** Empty the body of every well-formed marker pair (the lock/drift hash rule). */
export function emptyMarkers(text) {
  const { pairs } = findMarkers(text);
  let out = '', last = 0;
  for (const p of pairs) {
    out += text.slice(last, p.bodyStart);
    last = p.bodyEnd;
  }
  return out + text.slice(last);
}
