// Tests for tools/lib/fsx.mjs and tools/lib/git.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as fsx from '../../lib/fsx.mjs';
import { git, runGit, hasGit, gitRoot, gitPath, isIgnored, lsFiles, showFile, lsRemoteTag, GitError } from '../../lib/git.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('fsx: POSIX rel paths, walk, atomic writes, readJson', () => {
  const dir = tmp('mb-fsx-');
  try {
    assert.equal(fsx.fromPosix(dir, 'a/b/c.txt'), path.join(dir, 'a', 'b', 'c.txt'));
    assert.equal(fsx.relPosix(dir, path.join(dir, 'a', 'b')), 'a/b');
    fsx.writeFileAtomic(path.join(dir, 'a', 'b', 'c.txt'), 'x');
    fsx.writeJson(path.join(dir, 'z.json'), { b: 1, a: [true] });
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x');
    fs.writeFileSync(path.join(dir, 'B.txt'), 'x');
    assert.deepEqual(fsx.walk(dir), ['B.txt', 'a/b/c.txt', 'z.json']);
    assert.deepEqual(fsx.walk(dir, { ignore: (rel) => rel === 'a' }), ['B.txt', 'z.json']);
    assert.deepEqual(fsx.walk(path.join(dir, 'missing')), []);
    assert.equal(fsx.readText(path.join(dir, 'z.json')), '{\n  "a": [\n    true\n  ],\n  "b": 1\n}\n');
    assert.deepEqual(fsx.readJson(path.join(dir, 'z.json')), { a: [true], b: 1 });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'a', 'b')), ['c.txt']); // no temp files left
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"a":1.5}');
    assert.throws(() => fsx.readJson(path.join(dir, 'bad.json'), { mode: 'config' }),
      (e) => e.code === 'BAD_NUMBER' && e.file === path.join(dir, 'bad.json'));
    assert.ok(fsx.exists(path.join(dir, 'B.txt')) && fsx.isFile(path.join(dir, 'B.txt')) && fsx.isDir(dir));
    assert.ok(!fsx.exists(path.join(dir, 'nope')));
    fsx.copyFile(path.join(dir, 'B.txt'), path.join(dir, 'c', 'd', 'B.txt'));
    assert.equal(fsx.readText(path.join(dir, 'c', 'd', 'B.txt')), 'x');
    fsx.removePath(path.join(dir, 'c'));
    assert.ok(!fsx.exists(path.join(dir, 'c')));
    assert.throws(() => fsx.removePath(path.parse(dir).root), /refusing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git helpers on a temp repo', { skip: !hasGit() && 'git not installed' }, () => {
  const dir = fs.realpathSync.native(tmp('mb-git-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const g = (...args) => git(args, { cwd: dir, env });
  try {
    assert.equal(gitRoot(dir), null);
    g('init', '-q');
    g('config', 'user.email', 'a@example.com');
    g('config', 'user.name', 'Alice');
    g('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), 'hello\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
    g('add', '.');
    g('commit', '-q', '-m', 'one');
    g('tag', 'v0.1.0');
    g('tag', '-a', 'v0.2.0', '-m', 'annotated');
    assert.equal(fs.realpathSync.native(gitRoot(path.join(dir, 'sub'))), dir);
    assert.ok(path.isAbsolute(gitPath(dir, 'mb-update.json')));
    assert.ok(isIgnored(dir, 'ignored.txt'));
    assert.ok(!isIgnored(dir, 'sub/f.txt'));
    assert.deepEqual(lsFiles(dir), ['.gitignore', 'sub/f.txt']);
    assert.equal(showFile(dir, 'HEAD', 'sub/f.txt').toString(), 'hello\n');
    assert.equal(showFile(dir, 'HEAD', 'nope'), null);
    const head = g('rev-parse', 'HEAD');
    assert.equal(lsRemoteTag(dir, dir, 'v0.1.0'), head); // lightweight: plain line
    assert.equal(lsRemoteTag(dir, dir, 'v0.2.0'), head); // annotated: peeled ^{} line
    assert.equal(lsRemoteTag(dir, dir, 'v9.9.9'), null);
    assert.throws(() => g('rev-parse', 'no-such-ref'), (e) => e instanceof GitError && e.exitCode === 1);
    assert.equal(runGit(['rev-parse', 'no-such-ref'], { cwd: dir }).code !== 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing git maps to exit code 7', () => {
  const script = `import('${new URL('../../lib/git.mjs', import.meta.url).href}').then((m) => {
    try { m.runGit(['--version']); console.log('ran'); } catch (e) { console.log(e.name, e.exitCode); }
  });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: path.join(os.tmpdir(), 'mb-no-such-dir') }, encoding: 'utf8',
  });
  assert.equal(r.stdout.trim(), 'MissingToolError 7');
});
