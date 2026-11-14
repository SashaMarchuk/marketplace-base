// Tests for tools/lib/markers.mjs and tools/lib/hash.mjs (G markers and the lock hash rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  findMarkers, emptyMarkers, replaceMarker, getMarkerBody, markerLines, markerSpecFor,
} from '../../lib/markers.mjs';
import { sha256, sha8, lockHash, hashFile, sha256Concat } from '../../lib/hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');

const README = '# Title\n\n<!-- mb:catalog:begin -->\n| a | b |\n<!-- mb:catalog:end -->\n\nIntro\n<!-- mb:install:begin -->\nrun this\n<!-- mb:install:end -->\n';

test('findMarkers returns well-formed pairs with bodies', () => {
  const { pairs, problems } = findMarkers(README);
  assert.deepEqual(problems, []);
  assert.deepEqual(pairs.map((p) => p.id), ['catalog', 'install']);
  assert.equal(getMarkerBody(README, 'catalog'), '| a | b |\n');
  assert.equal(getMarkerBody(README, 'install'), 'run this\n');
  assert.equal(getMarkerBody(README, 'nope'), null);
});

test('hash-style markers (.gitignore) and CRLF lines', () => {
  const gi = 'x\n# mb:gitignore:begin\ndist/\n# mb:gitignore:end\n';
  assert.equal(getMarkerBody(gi, 'gitignore'), 'dist/\n');
  const crlf = 'a\r\n<!-- mb:agents:begin -->\r\nbody\r\n<!-- mb:agents:end -->\r\n';
  assert.equal(getMarkerBody(crlf, 'agents'), 'body\r\n');
});

test('emptyMarkers removes every body and keeps the marker lines', () => {
  assert.equal(emptyMarkers(README),
    '# Title\n\n<!-- mb:catalog:begin -->\n<!-- mb:catalog:end -->\n\nIntro\n<!-- mb:install:begin -->\n<!-- mb:install:end -->\n');
  assert.equal(emptyMarkers('no markers\n'), 'no markers\n');
  // inline mentions (not whole lines) are not markers
  const inline = 'see `<!-- mb:config:begin -->` and\n';
  assert.equal(emptyMarkers(inline), inline);
});

test('replaceMarker replaces exactly one pair and adds a final newline', () => {
  const out = replaceMarker(README, 'install', 'new');
  assert.equal(getMarkerBody(out, 'install'), 'new\n');
  assert.equal(getMarkerBody(out, 'catalog'), '| a | b |\n');
  assert.equal(getMarkerBody(replaceMarker(README, 'install', ''), 'install'), '');
  assert.throws(() => replaceMarker(README, 'agents', 'x'), /exactly one/);
});

test('malformed markers are reported, never thrown', () => {
  const bad = '<!-- mb:a:begin -->\n<!-- mb:b:begin -->\n<!-- mb:a:end -->\n<!-- mb:c:end -->\n<!-- mb:d:begin -->\n';
  const { problems } = findMarkers(bad);
  assert.deepEqual(problems.map((p) => [p.id, p.problem, p.line]), [
    ['b', 'nested', 2], ['c', 'unmatched-end', 4], ['d', 'unmatched-begin', 5],
  ]);
  const dup = '<!-- mb:a:begin -->\n<!-- mb:a:end -->\n<!-- mb:a:begin -->\n<!-- mb:a:end -->\n';
  assert.deepEqual(findMarkers(dup).problems.map((p) => p.problem), ['duplicate']);
  const mixed = '<!-- mb:a:begin -->\n# mb:a:end\n';
  assert.deepEqual(findMarkers(mixed).problems.map((p) => p.problem), ['style-mismatch']);
});

test('markerLines and markerSpecFor', () => {
  assert.deepEqual(markerLines('config'), { begin: '<!-- mb:config:begin -->', end: '<!-- mb:config:end -->' });
  assert.deepEqual(markerLines('gitignore', 'hash'), { begin: '# mb:gitignore:begin', end: '# mb:gitignore:end' });
  assert.deepEqual(markerSpecFor('README.md').ids, ['catalog', 'install']);
  assert.equal(markerSpecFor('.gitignore').style, 'hash');
  assert.deepEqual(markerSpecFor('plugins/p/skills/s/SKILL.md').ids, ['config']);
  assert.deepEqual(markerSpecFor('examples\\plugins\\p\\skills\\s\\SKILL.md').ids, ['config']);
  assert.equal(markerSpecFor('docs/README.md'), null);
  assert.equal(markerSpecFor('SKILL.md'), null);
});

test('hash rule: marker bodies are emptied before hashing', () => {
  const a = Buffer.from(README);
  const b = Buffer.from(replaceMarker(README, 'catalog', 'totally different\nrows\n'));
  assert.equal(lockHash(a), lockHash(b));
  assert.equal(lockHash(a), sha(emptyMarkers(README)));
  // outside-marker edits do register
  assert.notEqual(lockHash(Buffer.from(README.replace('Intro', 'Intro!'))), lockHash(a));
  // file without markers: plain sha256 of the bytes, binary-safe
  const bin = Buffer.from([0, 255, 254, 10, 0xc3, 0x28]);
  assert.equal(lockHash(bin), sha(bin));
  assert.equal(lockHash('é'), sha(Buffer.from('é')));
  // non-ASCII bytes around markers survive the latin1 round trip
  const u = Buffer.from('é\n<!-- mb:x:begin -->\nü\n<!-- mb:x:end -->\n😀\n');
  assert.equal(lockHash(u), sha(Buffer.from('é\n<!-- mb:x:begin -->\n<!-- mb:x:end -->\n😀\n')));
});

test('sha256 / sha8 / sha256Concat / hashFile', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha8('abc'), 'ba7816bf');
  assert.equal(sha256Concat([Buffer.from('a'), Buffer.from('bc')]), sha256('abc'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-hash-'));
  try {
    const f = path.join(dir, 'README.md');
    fs.writeFileSync(f, README);
    assert.equal(hashFile(f), lockHash(Buffer.from(README)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.gitattributes is the SPEC §2 literal', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'),
    '* text=auto eol=lf\n**/_mb/** linguist-generated -diff\n');
});

test('.gitignore seed carries exactly one gitignore marker with the §2 entries', () => {
  const text = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.deepEqual(findMarkers(text).problems, []);
  const body = getMarkerBody(text, 'gitignore');
  for (const line of ['.mb/leak-denylist.txt', '.marketplace-base/config.local.json', 'dist/']) {
    assert.ok(body.split('\n').includes(line), line);
  }
});
