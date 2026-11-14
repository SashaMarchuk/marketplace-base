// Tests for `mb init` and `mb base-update`. Everything runs in temp dirs:
//   - a fixture BASE is built from a copy of this repo's working tree (no .git) and published to a
//     local bare repo with tags v0.1.0 (lightweight), v0.2.0 (annotated) and v0.3.0-rc.1;
//   - derived repos are made from it by template copy (fresh history) or by clone;
//   - every `mb` call is a child process of the DERIVED copy's own tools/mb.mjs, with a hermetic
//     env (PATH = node + git, empty global git config), so the real repo is never touched.
// v0.2.0 carries one scripted change per row of the base-update decision table (docs/base/r<row>-*).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, canonicalPretty } from '../kit/json.mjs';
import { hashFile } from '../lib/hash.mjs';
import { compileOwnership, loadOwnership } from '../lib/ownership.mjs';
import { compareTags, decide, highestStableTag, tagsFromLsRemote } from '../lib/lock.mjs';
import {
  commitAll, copyTree, deriveProof, deriveTemplateCopy, gitIn, hermeticEnv, mbIn, migrationEdits, scriptedEdits, snapshotDS,
} from '../lib/derive.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POSIX = process.platform !== 'win32';
// tools/tests/** is base-owned and ships to derived repos; the fixture is built from a BASE tree,
// so the fixture tests run in the base only (the derive proof runs only in the base).
const IN_DERIVED = fs.existsSync(path.join(REPO, '.mb-lock.json'));
const ftest = (name, fn) => test(name, { skip: IN_DERIVED ? 'derived repo: the init/base-update fixture tests run in the base only' : false }, fn);

let TMP, ENV, BARE, BARE_URL, SHA = {};
const p = (dir, rel) => path.join(dir, ...rel.split('/'));
const read = (dir, rel) => fs.readFileSync(p(dir, rel), 'utf8');
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(p(dir, rel)), { recursive: true });
  fs.writeFileSync(p(dir, rel), text);
};
const has = (dir, rel) => fs.existsSync(p(dir, rel));
const lockOf = (dir) => parse(fs.readFileSync(p(dir, '.mb-lock.json')));
const gitc = (dir, ...args) => gitIn(dir, args, ENV);
const mb = (dir, ...args) => mbIn(dir, args, ENV);
const out = (r) => `exit ${r.code}\n--- stdout\n${r.stdout.slice(-6000)}\n--- stderr\n${r.stderr.slice(-4000)}`;
let n = 0;
const fresh = (name) => path.join(TMP, `${name}-${++n}`);

/** Errors of the rules base-update/init are responsible for (others belong to other units). */
function ownRuleErrors(dir) {
  const r = mb(dir, 'check', '--json', '--offline', '--fast');
  const res = JSON.parse(r.stdout);
  return res.results.filter((x) => x.severity === 'error' && ['CHK-10', 'CHK-16', 'CHK-17', 'CHK-23', 'CHK-01', 'CHK-02'].includes(x.id));
}

/** Plan lines of `--dry-run`: Map path -> row. */
function planRows(stdout) {
  const m = new Map();
  for (const x of stdout.matchAll(/^ {2}row (\d)\s+\S+\s+(\S+)/gm)) m.set(x[2], Number(x[1]));
  return m;
}

function initArgs(extra = []) {
  return ['init', '--name', 'acme-skills', '--display', 'Acme Skills', '--owner', 'Alice', ...extra];
}

/** Template copy of `tag`, `mb init`, commit. */
function derived(tag = 'v0.1.0', extra = []) {
  const dir = fresh(`derived-${tag}`);
  deriveTemplateCopy(BARE_URL, tag, dir, ENV);
  const r = mb(dir, ...initArgs(extra));
  assert.equal(r.code, 0, out(r));
  commitAll(dir, ENV, 'init');
  return dir;
}

function cloneRepo(dir) {
  const d = fresh('copy');
  fs.cpSync(dir, d, { recursive: true });
  return d;
}

before(() => {
  if (IN_DERIVED) return;
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-derive-'));
  ENV = hermeticEnv(TMP);
  BARE = path.join(TMP, 'base.git');
  BARE_URL = pathToFileURL(BARE).href;
  const w = path.join(TMP, 'base-work');
  copyTree(REPO, w);
  fs.rmSync(p(w, '.mb-lock.json'), { force: true });

  // ---------- v0.1.0 (lightweight tag) ----------
  const cfg = parse(fs.readFileSync(p(w, 'marketplace.config.json')));
  cfg.base = { url: BARE_URL };
  write(w, 'marketplace.config.json', canonicalPretty(cfg));
  write(w, '.mb/base-version.json', '{\n  "version": "v0.1.0"\n}\n');
  // CHK-21 needs every cited test file; other units' tests may not exist yet in this copy.
  for (const spec of fs.readdirSync(p(w, 'openspec/specs'))) {
    const f = p(w, `openspec/specs/${spec}/spec.md`);
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\(test (tools\/tests\/[^)\s]+)\)/g)) {
      if (!has(w, m[1])) write(w, m[1], '// fixture stub\n');
    }
  }
  write(w, 'docs/base/r3-same.md', 'r3 v1\n');
  write(w, 'docs/base/r4-changed.md', 'r4 v1\n');
  write(w, 'docs/base/r5-edited.md', 'r5 v1\n');
  write(w, 'docs/base/r7-removed.md', 'r7 v1\n');
  write(w, 'docs/base/r8-edited-removed.md', 'r8 v1\n');
  write(w, 'tools/lib/obsolete-fixture.mjs', '// removed in v0.2.0\n');
  write(w, '.github/workflows/mb-fixture.yml', 'name: mb-fixture v1\non: workflow_dispatch\njobs: {}\n');
  let r = mbIn(w, ['gen'], ENV);
  assert.equal(r.code, 0, out(r));
  gitc(w, 'init', '-q', '-b', 'main');
  commitAll(w, ENV, 'base v0.1.0');
  gitc(w, 'tag', 'v0.1.0');

  // ---------- v0.2.0 (annotated tag) ----------
  write(w, '.mb/base-version.json', '{\n  "version": "v0.2.0"\n}\n');
  write(w, 'docs/base/r3-same.md', 'r3 v2\n');
  write(w, 'docs/base/r4-changed.md', 'r4 v2\n');
  write(w, 'docs/base/r4-added.md', 'r4 added in v2\n');
  write(w, 'docs/base/r5-edited.md', 'r5 v2\n');
  write(w, 'docs/base/r5-collide.md', 'r5 collide: base version\n');
  fs.rmSync(p(w, 'docs/base/r7-removed.md'));
  fs.rmSync(p(w, 'docs/base/r8-edited-removed.md'));
  fs.rmSync(p(w, 'tools/lib/obsolete-fixture.mjs'));
  write(w, 'tools/lib/added-fixture.mjs', '// added in v0.2.0\n'); // a NEW tooling file: the report must list it
  write(w, '.github/workflows/mb-fixture.yml', 'name: mb-fixture v2\non: workflow_dispatch\njobs: {}\n');
  // B -> S reclassification of CLAUDE.md (row 6).
  // Edited as text, and the base's own ownership test is updated with it (as a real release would), so the
  // derived repo's `./mb test` stays green after the update (the derive proof runs it).
  const reclassify = (t) => t.replace('"B": ["CLAUDE.md", ', '"B": [').replace('"S": ["LICENSE", ', '"S": ["CLAUDE.md", "LICENSE", ');
  const ownText = read(w, '.mb/ownership.json');
  assert.notEqual(reclassify(ownText), ownText);
  write(w, '.mb/ownership.json', reclassify(ownText));
  const ownTest = read(w, 'tools/tests/lib/ownership.test.mjs');
  write(w, 'tools/tests/lib/ownership.test.mjs', reclassify(ownTest).replace("'CLAUDE.md': 'B'", "'CLAUDE.md': 'S'"));
  // Example changes: a new file in every example (row 1 for adopted / not included, row 4 otherwise).
  for (const ex of fs.readdirSync(p(w, 'examples/plugins'))) {
    const skill = fs.readdirSync(p(w, `examples/plugins/${ex}/skills`))[0];
    write(w, `examples/plugins/${ex}/skills/${skill}/references/v2-note.md`, `Added in v0.2.0 to ${ex}.\n`);
    const src = p(w, `examples/plugins/${ex}/plugin.src.json`);
    // A minor bump of whatever version the example has now (no hardcoded version to go stale).
    fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace(/"version": "(\d+)\.(\d+)\.\d+"/, (_, a, b) => `"version": "${a}.${Number(b) + 1}.0"`));
  }
  // A migration that edits an S file (idempotent) and reports it.
  write(w, '.mb/migrations/0.2.0.mjs', [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'export default function migrate({ root }) {',
    "  const f = path.join(root, 'USAGE.md');",
    "  const t = fs.readFileSync(f, 'utf8');",
    "  if (t.includes('Migrated by 0.2.0.')) return [];",
    "  fs.writeFileSync(f, t + '\\nMigrated by 0.2.0.\\n');",
    "  return ['USAGE.md'];",
    '}',
    '',
  ].join('\n'));
  // Observable self-update: the v0.2.0 tooling prints a different report title.
  const bu = p(w, 'tools/cmd/base-update.mjs');
  const buText = fs.readFileSync(bu, 'utf8');
  assert.ok(buText.includes("REPORT_TITLE = 'base-update report'"));
  fs.writeFileSync(bu, buText.replace("REPORT_TITLE = 'base-update report'", "REPORT_TITLE = 'base-update report (v0.2.0 tooling)'"));
  r = mbIn(w, ['gen'], ENV);
  assert.equal(r.code, 0, out(r));
  commitAll(w, ENV, 'base v0.2.0');
  gitc(w, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');

  // ---------- v0.3.0-rc.1 (pre-release: never "latest") ----------
  write(w, '.mb/base-version.json', '{\n  "version": "v0.3.0-rc.1"\n}\n');
  write(w, 'docs/base/rc-only.md', 'only in the release candidate\n');
  commitAll(w, ENV, 'base v0.3.0-rc.1');
  gitc(w, 'tag', '-a', 'v0.3.0-rc.1', '-m', 'rc');

  gitc(TMP, 'clone', '-q', '--bare', w, BARE);
  for (const t of ['v0.1.0', 'v0.2.0', 'v0.3.0-rc.1']) SHA[t] = gitc(BARE, 'rev-parse', `${t}^{commit}`);
  SHA['v0.2.0-tagobj'] = gitc(BARE, 'rev-parse', 'v0.2.0');
});

after(() => {
  if (TMP && process.env.MB_KEEP_TMP !== '1') fs.rmSync(TMP, { recursive: true, force: true });
});

// ======================= pure helpers =======================

test('decide: one result per decision-table row', () => {
  const base = { skipExample: false, workflowHeld: false, force: false };
  assert.equal(decide({ ...base, skipExample: true, N: 'n', T: true, L: 'l', C: 'x' }).row, 1);
  assert.deepEqual(decide({ ...base, workflowHeld: true, N: 'n', T: true, L: 'l', C: 'l' }), { row: 2, action: 'hold', conflict: false, lockHash: 'l' });
  assert.equal(decide({ ...base, N: 'n', T: true, L: 'l', C: 'n' }).row, 3);
  assert.deepEqual(decide({ ...base, N: 'n', T: true, L: 'l', C: 'l' }), { row: 4, action: 'write', conflict: false, lockHash: 'n' });
  assert.deepEqual(decide({ ...base, N: 'n', T: true, L: null, C: null }), { row: 4, action: 'write', conflict: false, lockHash: 'n' });
  assert.deepEqual(decide({ ...base, N: 'n', T: true, L: 'l', C: 'x' }), { row: 5, action: 'hold', conflict: true, lockHash: 'l' });
  assert.deepEqual(decide({ ...base, N: 'n', T: true, L: null, C: 'x' }), { row: 5, action: 'hold', conflict: true, lockHash: null });
  assert.deepEqual(decide({ ...base, force: true, N: 'n', T: true, L: 'l', C: 'x' }), { row: 5, action: 'write', conflict: true, lockHash: 'n' });
  assert.deepEqual(decide({ ...base, N: null, T: true, L: 'l', C: 'x' }), { row: 6, action: 'release', conflict: false, lockHash: null });
  assert.deepEqual(decide({ ...base, N: null, T: false, L: 'l', C: 'l' }), { row: 7, action: 'delete', conflict: false, lockHash: null });
  assert.equal(decide({ ...base, N: null, T: false, L: 'l', C: null }).row, 7);
  assert.deepEqual(decide({ ...base, N: null, T: false, L: 'l', C: 'x' }), { row: 8, action: 'hold', conflict: true, lockHash: 'l' });
  assert.deepEqual(decide({ ...base, force: true, N: null, T: false, L: 'l', C: 'x' }), { row: 8, action: 'delete', conflict: true, lockHash: null });
});

test('tags: pre-release tags are never the latest; semver order', () => {
  const tags = tagsFromLsRemote('a\trefs/tags/v0.2.0\nb\trefs/tags/v0.2.0^{}\nc\trefs/tags/v0.3.0-rc.1\nd\trefs/tags/v0.10.0-rc.2\ne\trefs/tags/v0.1.0\nf\trefs/tags/nightly\n');
  assert.deepEqual(tags.sort(), ['v0.1.0', 'v0.10.0-rc.2', 'v0.2.0', 'v0.3.0-rc.1']);
  assert.equal(highestStableTag(tags), 'v0.2.0');
  assert.ok(compareTags('v0.3.0-rc.1', 'v0.3.0') < 0);
  assert.ok(compareTags('v0.3.0-rc.2', 'v0.3.0-rc.10') < 0);
  assert.ok(compareTags('v0.10.0', 'v0.9.9') > 0);
});

// ======================= init =======================

ftest('init from a template copy (lightweight tag v0.1.0): seeds, lock with the tag commit, gen, check', () => {
  const dir = fresh('tpl');
  deriveTemplateCopy(BARE_URL, 'v0.1.0', dir, ENV);
  const r = mb(dir, ...initArgs(['--email', 'alice@example.com', '--repo', 'acme/acme-skills']));
  assert.equal(r.code, 0, out(r));
  assert.match(r.stdout, /\$ \.\/mb gen/);
  assert.match(r.stdout, /\$ \.\/mb check/);
  assert.match(r.stdout, /Next steps:/);
  const lock = lockOf(dir);
  assert.equal(lock.lockVersion, 1);
  assert.deepEqual(lock.base, { url: BARE_URL, tag: 'v0.1.0', commit: SHA['v0.1.0'] });
  assert.deepEqual(lock.adopted, []);
  // MB-UPD-002: only B and E paths, each with its hash-rule hash.
  const classify = compileOwnership(loadOwnership(dir));
  const keys = Object.keys(lock.files);
  assert.ok(keys.length > 50);
  for (const k of keys) {
    assert.ok(['B', 'E'].includes(classify(k)), `${k} is ${classify(k)}`);
    assert.equal(lock.files[k], hashFile(p(dir, k)), k);
  }
  assert.ok(keys.includes('tools/mb.mjs') && keys.includes('CLAUDE.md'));
  assert.ok(keys.some((k) => k.startsWith('examples/plugins/code-review/')));
  for (const k of ['README.md', 'LICENSE', 'marketplace.config.json', '.gitignore', 'examples/plugins/code-review/.claude-plugin/plugin.json']) {
    assert.ok(!keys.includes(k), `${k} must not be locked`);
  }
  // Seeds rendered.
  const cfg = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  assert.equal(cfg.name, 'acme-skills');
  assert.equal(cfg.displayName, 'Acme Skills');
  assert.deepEqual(cfg.owner, { email: 'alice@example.com', name: 'Alice' });
  assert.deepEqual(cfg.distribution, { repo: 'acme/acme-skills', source: 'github' });
  assert.equal(cfg.base.url, BARE_URL);
  assert.equal(cfg.includeExamples, true);
  const license = read(dir, 'LICENSE');
  assert.match(license, /^Copyright \(c\) 2026 marketplace-base contributors$/m);
  assert.match(license, new RegExp(`^Copyright \\(c\\) ${new Date().getUTCFullYear()} Alice$`, 'm'));
  assert.match(read(dir, 'README.md'), /^# Acme Skills/);
  assert.match(read(dir, 'USAGE.md'), /acme\/acme-skills/);
  assert.match(read(dir, '.gitignore'), /^\.acme-skills\/config\.local\.json$/m);
  // The CODEOWNERS seed is copied byte-exact: `mb github setup` matches its placeholder lines.
  assert.ok(fs.readFileSync(p(dir, '.github/CODEOWNERS')).equals(fs.readFileSync(p(dir, 'tools/templates/seeds/.github/CODEOWNERS'))));
  for (const f of ['README.md', 'USAGE.md', 'AGENTS.md', 'openspec/config.yaml', 'marketplace.config.json']) assert.doesNotMatch(read(dir, f), /\{\{/, f);
  // gen ran: the marketplace manifests carry the new name.
  assert.match(read(dir, '.claude-plugin/marketplace.json'), /"acme-skills"/);
  assert.deepEqual(ownRuleErrors(dir), []);
});

ftest('init without --email/--repo drops those keys; init from a clone of the annotated tag records the peeled commit', () => {
  const dir = fresh('clone');
  gitc(TMP, 'clone', '-q', '--branch', 'v0.2.0', BARE_URL, dir);
  const r = mb(dir, ...initArgs());
  assert.equal(r.code, 0, out(r));
  const lock = lockOf(dir);
  assert.equal(lock.base.tag, 'v0.2.0');
  assert.equal(lock.base.commit, SHA['v0.2.0']);
  assert.notEqual(lock.base.commit, SHA['v0.2.0-tagobj']);
  const cfg = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  assert.deepEqual(cfg.owner, { name: 'Alice' });
  assert.equal(cfg.distribution, undefined);
  assert.match(read(dir, 'USAGE.md'), /<owner>\/<repo>/);
});

ftest('init refusals write nothing', () => {
  const dir = fresh('refuse');
  deriveTemplateCopy(BARE_URL, 'v0.1.0', dir, ENV);
  const status = () => gitc(dir, 'status', '--porcelain');
  let r = mb(dir, 'init', '--name', 'marketplace-base', '--display', 'X', '--owner', 'Alice');
  assert.equal(r.code, 2, out(r));
  r = mb(dir, 'init', '--display', 'X', '--owner', 'Alice');
  assert.equal(r.code, 2, out(r));
  r = mb(dir, ...initArgs(['--examples', 'no-such-example']));
  assert.equal(r.code, 2, out(r));
  r = mb(dir, 'init', '--name', 'Bad_Name', '--display', 'X', '--owner', 'Alice');
  assert.equal(r.code, 2, out(r));
  r = mb(dir, ...initArgs(['--owner', 'Alice\nBob']));
  assert.equal(r.code, 2, out(r));
  assert.equal(status(), '');
  // Not a pristine base copy.
  const cfg = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  write(dir, 'marketplace.config.json', canonicalPretty({ ...cfg, name: 'someone-else' }));
  commitAll(dir, ENV, 'renamed');
  r = mb(dir, ...initArgs());
  assert.equal(r.code, 1, out(r));
  assert.equal(status(), '');
  // An existing lock.
  const done = derived();
  r = mb(done, ...initArgs());
  assert.equal(r.code, 1, out(r));
  assert.match(r.stderr, /already initialised/);
  assert.equal(gitc(done, 'status', '--porcelain'), '');
});

ftest('init --examples none deletes E files and leaves them out of the lock; base-update never brings them back', () => {
  const dir = fresh('none');
  deriveTemplateCopy(BARE_URL, 'v0.1.0', dir, ENV);
  const init = mb(dir, ...initArgs(['--examples', 'none']));
  assert.equal(init.code, 0, out(init));
  commitAll(dir, ENV, 'init');
  assert.ok(!has(dir, 'examples'));
  const lock = lockOf(dir);
  assert.ok(!Object.keys(lock.files).some((k) => k.startsWith('examples/')));
  assert.equal(parse(fs.readFileSync(p(dir, 'marketplace.config.json'))).includeExamples, false);
  const r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 0, out(r));
  assert.match(r.stdout, /^conflicts \(left untouched\) \(0\)$/m);
  assert.ok(!has(dir, 'examples'), 'examples came back');
  assert.ok(!Object.keys(lockOf(dir).files).some((k) => k.startsWith('examples/')));
});

// ======================= base-update: clean path =======================

ftest('clean update: D/S edits only -> 0 conflicts, D/S bytes unchanged, removed files deleted, re-exec observed, rc ignored', () => {
  const dir = derived('v0.1.0', ['--examples', 'changelog-entry,code-review,commit-message']);
  assert.deepEqual(parse(fs.readFileSync(p(dir, 'marketplace.config.json'))).includeExamples, ['changelog-entry', 'code-review', 'commit-message']);
  const steps = scriptedEdits(dir, ENV); // new plugin, README text, policy, local workflow, adopt changelog-entry
  assert.equal(steps.length, 5, steps.join(', '));
  commitAll(dir, ENV, 'derived edits');
  const commitsBefore = gitc(dir, 'rev-list', '--count', 'HEAD');
  const adoptedBytes = hashFile(p(dir, 'plugins/changelog-entry/plugin.src.json'));
  const before = snapshotDS(dir);

  const r = mb(dir, 'base-update'); // no --to: v0.2.0, never v0.3.0-rc.1
  assert.equal(r.code, 0, out(r));
  assert.match(r.stdout, new RegExp(`^base v0\\.2\\.0 -> ${SHA['v0.2.0']}$`, 'm'));
  assert.match(r.stdout, /^continuing base-update with tooling v0\.2\.0 /m);
  assert.match(r.stdout, /^base-update report \(v0\.2\.0 tooling\): v0\.1\.0 -> v0\.2\.0/m); // the NEW code ran the rest
  assert.match(r.stdout, /^conflicts \(left untouched\) \(0\)$/m);
  assert.match(r.stdout, /^ {2}v0\.2\.0: edited USAGE\.md$/m);
  assert.ok(!has(dir, 'docs/base/rc-only.md'));
  // Tooling files that are new in v0.2.0 are listed as changed, like the dry run shows them (not "up to date").
  const changedList = r.stdout.split(/^changed \(\d+\):?$/m)[1].split(/^deleted /m)[0];
  assert.match(changedList, /^ {2}tools\/lib\/added-fixture\.mjs$/m);
  assert.match(changedList, /^ {2}tools\/cmd\/base-update\.mjs$/m);

  const lock = lockOf(dir);
  assert.deepEqual(lock.base, { url: BARE_URL, tag: 'v0.2.0', commit: SHA['v0.2.0'] });
  assert.deepEqual(lock.adopted, ['changelog-entry']);
  // D and S bytes unchanged, except the S file the migration reported.
  const edited = migrationEdits(r.stdout);
  assert.deepEqual([...edited], ['USAGE.md']);
  for (const [rel, h] of before) {
    if (edited.has(rel)) continue;
    assert.ok(has(dir, rel), `${rel} vanished`);
    assert.equal(hashFile(p(dir, rel)), h, `${rel} changed`);
  }
  assert.match(read(dir, 'USAGE.md'), /Migrated by 0\.2\.0\./);
  assert.equal(hashFile(p(dir, 'plugins/changelog-entry/plugin.src.json')), adoptedBytes);
  assert.ok(!has(dir, 'plugins/changelog-entry/skills/' + fs.readdirSync(p(dir, 'plugins/changelog-entry/skills'))[0] + '/references/v2-note.md'));
  // Removed upstream -> deleted (also under tools/, which `git checkout` alone would leave behind).
  assert.ok(!has(dir, 'docs/base/r7-removed.md'));
  assert.ok(!has(dir, 'tools/lib/obsolete-fixture.mjs'));
  assert.ok(!('tools/lib/obsolete-fixture.mjs' in lock.files));
  // Updated and added base files, released CLAUDE.md, not-included example untouched.
  assert.equal(read(dir, 'docs/base/r4-changed.md'), 'r4 v2\n');
  assert.equal(read(dir, 'docs/base/r4-added.md'), 'r4 added in v2\n');
  assert.ok(has(dir, 'CLAUDE.md') && !('CLAUDE.md' in lock.files));
  assert.ok(!has(dir, 'examples/plugins/meeting-notes'));
  assert.ok(has(dir, 'examples/plugins/code-review/skills/' + fs.readdirSync(p(dir, 'examples/plugins/code-review/skills'))[0] + '/references/v2-note.md'));
  assert.equal(read(dir, 'tools/cmd/base-update.mjs'), gitc(BARE, 'show', 'v0.2.0:tools/cmd/base-update.mjs') + '\n');
  if (POSIX) assert.ok(fs.statSync(p(dir, 'mb')).mode & 0o100, 'mb lost its exec bit');
  // Lock matches the worktree; no state file left; history intact.
  for (const [k, h] of Object.entries(lock.files)) assert.equal(hashFile(p(dir, k)), h, k);
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'mb-update.json')));
  assert.equal(gitc(dir, 'rev-list', '--count', 'HEAD'), commitsBefore);
  assert.deepEqual(ownRuleErrors(dir), []);
});

ftest('clone derivation: update keeps the full history (no shallow fetch of an existing commit)', () => {
  const dir = fresh('clone-upd');
  gitc(TMP, 'clone', '-q', '--branch', 'v0.1.0', BARE_URL, dir);
  gitc(dir, 'switch', '-q', '-c', 'main');
  let r = mb(dir, ...initArgs());
  assert.equal(r.code, 0, out(r));
  commitAll(dir, ENV, 'init');
  const count = gitc(dir, 'rev-list', '--count', 'HEAD');
  r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 0, out(r));
  assert.equal(lockOf(dir).base.commit, SHA['v0.2.0']);
  assert.equal(gitc(dir, 'rev-list', '--count', 'HEAD'), count);
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'shallow')));
});

// ======================= base-update: decision table =======================

let CONFLICT_REPO;
/** Derived repo (v0.1.0, meeting-notes not included, commit-message adopted) with conflicting edits. */
function conflictRepo() {
  if (!CONFLICT_REPO) {
    const dir = derived('v0.1.0', ['--examples', 'changelog-entry,code-review,commit-message']);
    assert.equal(mb(dir, 'adopt', 'commit-message').code, 0);
    write(dir, 'docs/base/r3-same.md', 'r3 v2\n'); // already equals the new base
    write(dir, 'docs/base/r5-edited.md', 'r5 mine\n'); // derived edit of a B file
    write(dir, 'docs/base/r5-collide.md', 'r5 collide: mine\n'); // D file where v0.2.0 adds a B file
    write(dir, 'docs/base/r8-edited-removed.md', 'r8 mine\n'); // edited, removed upstream
    commitAll(dir, ENV, 'conflicting edits');
    CONFLICT_REPO = dir;
  }
  return cloneRepo(CONFLICT_REPO);
}

function treeState(dir) {
  const m = new Map();
  for (const f of gitc(dir, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) m.set(f, has(dir, f) ? hashFile(p(dir, f)) : null);
  return m;
}

ftest('--dry-run lists only changes and conflicts; --verbose prints one row per path (rows 1-8); nothing is written', () => {
  const dir = conflictRepo();
  const lockBytes = fs.readFileSync(p(dir, '.mb-lock.json'));
  const state = treeState(dir);
  const short = mb(dir, 'base-update', '--to', 'v0.2.0', '--dry-run');
  assert.equal(short.code, 0, out(short));
  assert.deepEqual([...new Set(planRows(short.stdout).values())].sort(), [4, 5, 7, 8]);
  assert.match(short.stdout, /paths change or conflict \(--verbose lists all\)/);
  assert.match(short.stdout, /3 conflict\(s\); nothing was written/);
  const r = mb(dir, 'base-update', '--to', 'v0.2.0', '--dry-run', '--verbose');
  assert.equal(r.code, 0, out(r));
  const rows = planRows(r.stdout);
  const cm = fs.readdirSync(p(BARE_WORK(), 'examples/plugins/commit-message/skills'))[0];
  const mn = fs.readdirSync(p(BARE_WORK(), 'examples/plugins/meeting-notes/skills'))[0];
  assert.equal(rows.get(`examples/plugins/commit-message/skills/${cm}/references/v2-note.md`), 1, 'adopted example');
  assert.equal(rows.get(`examples/plugins/meeting-notes/skills/${mn}/references/v2-note.md`), 1, 'not included example');
  assert.equal(rows.get('docs/base/r3-same.md'), 3);
  assert.equal(rows.get('CONTRIBUTING.md'), 3);
  assert.equal(rows.get('docs/base/r4-changed.md'), 4);
  assert.equal(rows.get('docs/base/r4-added.md'), 4);
  assert.equal(rows.get('.github/workflows/mb-fixture.yml'), 4);
  assert.equal(rows.get('docs/base/r5-edited.md'), 5);
  assert.equal(rows.get('docs/base/r5-collide.md'), 5);
  assert.equal(rows.get('CLAUDE.md'), 6);
  assert.equal(rows.get('docs/base/r7-removed.md'), 7);
  assert.equal(rows.get('tools/lib/obsolete-fixture.mjs'), 7);
  assert.equal(rows.get('docs/base/r8-edited-removed.md'), 8);
  assert.match(r.stdout, /3 conflict\(s\); nothing was written/);
  const r2 = mb(dir, 'base-update', '--to', 'v0.2.0', '--dry-run', '--verbose', '--no-workflows');
  assert.equal(planRows(r2.stdout).get('.github/workflows/mb-fixture.yml'), 2);
  // Nothing written.
  assert.ok(fs.readFileSync(p(dir, '.mb-lock.json')).equals(lockBytes));
  assert.deepEqual(treeState(dir), state);
  assert.equal(gitc(dir, 'status', '--porcelain'), '');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'mb-update.json')));
});

ftest('rows 3-8 applied: conflicts (row 5: edit and D-file collision; row 8) left untouched with exit 6; the next update reports them again', () => {
  const dir = conflictRepo();
  const oldLock = lockOf(dir);
  const r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 6, out(r));
  assert.match(r.stdout, /^conflicts \(left untouched\) \(3\):$/m);
  // Row 5/8: untouched, old lock hash kept (none for the collision).
  assert.equal(read(dir, 'docs/base/r5-edited.md'), 'r5 mine\n');
  assert.equal(read(dir, 'docs/base/r5-collide.md'), 'r5 collide: mine\n');
  assert.equal(read(dir, 'docs/base/r8-edited-removed.md'), 'r8 mine\n');
  const lock = lockOf(dir);
  assert.equal(lock.files['docs/base/r5-edited.md'], oldLock.files['docs/base/r5-edited.md']);
  assert.ok(!('docs/base/r5-collide.md' in lock.files));
  assert.equal(lock.files['docs/base/r8-edited-removed.md'], oldLock.files['docs/base/r8-edited-removed.md']);
  // Row 3, 4, 6, 7 applied.
  assert.equal(lock.files['docs/base/r3-same.md'], hashFile(p(dir, 'docs/base/r3-same.md')));
  assert.equal(read(dir, 'docs/base/r4-changed.md'), 'r4 v2\n');
  assert.equal(read(dir, '.github/workflows/mb-fixture.yml'), 'name: mb-fixture v2\non: workflow_dispatch\njobs: {}\n');
  assert.ok(has(dir, 'CLAUDE.md') && !('CLAUDE.md' in lock.files));
  assert.ok(!has(dir, 'docs/base/r7-removed.md'));
  // Row 1: adopted plugin and not-included example untouched.
  assert.ok(!has(dir, 'examples/plugins/commit-message') && !has(dir, 'examples/plugins/meeting-notes'));
  assert.equal(lock.base.tag, 'v0.2.0');
  // The next update still reports the conflicts (old hashes kept), instead of overwriting.
  commitAll(dir, ENV, 'partial update');
  const again = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(again.code, 6, out(again));
  assert.match(again.stdout, /docs\/base\/r5-edited\.md {2}# row 5/);
  assert.match(again.stdout, /docs\/base\/r8-edited-removed\.md {2}# row 8/);
  assert.equal(read(dir, 'docs/base/r5-edited.md'), 'r5 mine\n');
  // The printed recovery works as written: commit, then --to <tag> --force|--keep.
  assert.match(r.stderr, /git add -A && git commit/);
  assert.match(r.stderr, /\.\/mb base-update --to v0\.2\.0 --force/);
  const kept = cloneRepo(dir);
  const k = mb(kept, 'base-update', '--to', 'v0.2.0', '--keep');
  assert.equal(k.code, 1, out(k)); // applied; CHK-16 red on purpose for the kept conflicts
  const f = mb(dir, 'base-update', '--to', 'v0.2.0', '--force');
  assert.equal(f.code, 0, out(f));
  assert.equal(read(dir, 'docs/base/r5-edited.md'), 'r5 v2\n');
  assert.ok(!ownRuleErrors(dir).some((x) => x.id === 'CHK-16'));
});

ftest('--keep keeps the OLD lock hash (CHK-16 stays red) and the next update still reports the conflict', () => {
  const dir = conflictRepo();
  const oldHash = lockOf(dir).files['docs/base/r5-edited.md'];
  const r = mb(dir, 'base-update', '--to', 'v0.2.0', '--keep');
  assert.notEqual(r.code, 6, out(r));
  assert.match(r.stdout, /^conflicts \(kept by --keep\) \(3\):$/m);
  assert.equal(lockOf(dir).files['docs/base/r5-edited.md'], oldHash);
  assert.equal(read(dir, 'docs/base/r5-edited.md'), 'r5 mine\n');
  const chk = JSON.parse(mb(dir, 'check', '--json', '--offline', '--fast').stdout);
  assert.ok(chk.results.some((x) => x.id === 'CHK-16' && x.path === 'docs/base/r5-edited.md'));
  commitAll(dir, ENV, 'kept');
  const again = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(again.code, 6, out(again));
  assert.match(again.stdout, /docs\/base\/r5-edited\.md {2}# row 5/);
});

ftest('--force overwrites row 5 conflicts and deletes row 8 files; lock gets the new hashes', () => {
  const dir = conflictRepo();
  const r = mb(dir, 'base-update', '--to', 'v0.2.0', '--force');
  assert.match(r.stdout, /^conflicts \(overwritten by --force\) \(3\):$/m, out(r));
  assert.equal(read(dir, 'docs/base/r5-edited.md'), 'r5 v2\n');
  assert.equal(read(dir, 'docs/base/r5-collide.md'), 'r5 collide: base version\n');
  assert.ok(!has(dir, 'docs/base/r8-edited-removed.md'));
  const lock = lockOf(dir);
  assert.equal(lock.files['docs/base/r5-edited.md'], hashFile(p(dir, 'docs/base/r5-edited.md')));
  assert.equal(lock.files['docs/base/r5-collide.md'], hashFile(p(dir, 'docs/base/r5-collide.md')));
  assert.ok(!('docs/base/r8-edited-removed.md' in lock.files));
  assert.ok(!ownRuleErrors(dir).some((x) => x.id === 'CHK-16'));
});

ftest('row 2: --no-workflows leaves mb-*.yml untouched with their OLD lock hashes', () => {
  const dir = derived();
  const oldHash = lockOf(dir).files['.github/workflows/mb-fixture.yml'];
  assert.ok(oldHash);
  const r = mb(dir, 'base-update', '--to', 'v0.2.0', '--no-workflows');
  assert.equal(r.code, 0, out(r));
  assert.match(r.stdout, /workflows left untouched \(--no-workflows\) \(\d+\):\n(?: {2}.*\n)*? {2}\.github\/workflows\/mb-fixture\.yml/);
  assert.equal(read(dir, '.github/workflows/mb-fixture.yml'), 'name: mb-fixture v1\non: workflow_dispatch\njobs: {}\n');
  assert.equal(lockOf(dir).files['.github/workflows/mb-fixture.yml'], oldHash);
  assert.ok(!ownRuleErrors(dir).some((x) => x.id === 'CHK-16'), 'CHK-16 must stay green on a token-less branch');
});

// ======================= base-update: guards =======================

ftest('an edited tools/ file, or a local file under tools/, stops the update before any checkout (exit 6) unless --force', () => {
  const base = derived();
  for (const [what, edit] of [
    ['edited', (d) => fs.appendFileSync(p(d, 'tools/lib/fsx.mjs'), '// local edit\n')],
    ['local', (d) => write(d, 'tools/lib/local-helper.mjs', '// ours\n')],
    ['deleted', (d) => fs.rmSync(p(d, 'tools/lib/obsolete-fixture.mjs'))],
  ]) {
    const dir = cloneRepo(base);
    edit(dir);
    commitAll(dir, ENV, what);
    const head = gitc(dir, 'rev-parse', 'HEAD');
    const r = mb(dir, 'base-update', '--to', 'v0.2.0');
    assert.equal(r.code, 6, `${what}: ${out(r)}`);
    assert.match(r.stderr, /base tooling/);
    assert.doesNotMatch(r.stdout, /^base v0\.2\.0 ->/m, `${what}: fetched/checked out before refusing`);
    assert.equal(gitc(dir, 'status', '--porcelain'), '', `${what}: something was changed`);
    assert.equal(gitc(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(lockOf(dir).base.tag, 'v0.1.0');
  }
  const dir = cloneRepo(base);
  fs.appendFileSync(p(dir, 'tools/lib/fsx.mjs'), '// local edit\n');
  commitAll(dir, ENV, 'edited');
  const r = mb(dir, 'base-update', '--to', 'v0.2.0', '--force');
  assert.equal(lockOf(dir).base.tag, 'v0.2.0', out(r));
  assert.equal(read(dir, 'tools/lib/fsx.mjs'), gitc(BARE, 'show', 'v0.2.0:tools/lib/fsx.mjs') + '\n');
});

ftest('argument and state guards: dirty tree, --force with --keep, --continue without state, state without --continue, base repo, downgrade', () => {
  const dir = derived();
  write(dir, 'notes.txt', 'uncommitted\n');
  let r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 2, out(r));
  assert.match(r.stderr, /not clean/);
  fs.rmSync(p(dir, 'notes.txt'));
  r = mb(dir, 'base-update', '--force', '--keep');
  assert.equal(r.code, 2, out(r));
  r = mb(dir, 'base-update', '--continue');
  assert.equal(r.code, 2, out(r));
  assert.match(r.stderr, /no update in progress/);
  const st = gitc(dir, 'rev-parse', '--git-path', 'mb-update.json');
  fs.writeFileSync(path.resolve(dir, st), '{}\n');
  r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 2, out(r));
  assert.match(r.stderr, /in progress/);
  fs.rmSync(path.resolve(dir, st));
  const up = derived('v0.2.0');
  r = mb(up, 'base-update', '--to', 'v0.1.0');
  assert.equal(r.code, 2, out(r));
  assert.match(r.stderr, /older/);
  // The base itself has no lock.
  const baseCopy = fresh('basecopy');
  gitc(TMP, 'clone', '-q', '--branch', 'v0.1.0', BARE_URL, baseCopy);
  r = mb(baseCopy, 'base-update');
  assert.equal(r.code, 2, out(r));
});

ftest('worktree: the state file lives at `git rev-parse --git-path mb-update.json`; --continue uses the stored commit, not FETCH_HEAD', () => {
  const main = derived();
  const wt = fresh('wt');
  gitc(main, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  const st = path.resolve(wt, gitc(wt, 'rev-parse', '--git-path', 'mb-update.json'));
  assert.ok(!st.startsWith(path.join(fs.realpathSync(main), '.git') + path.sep + 'mb-update.json'));
  assert.match(st.split(path.sep).join('/'), /\/\.git\/worktrees\/[^/]+\/mb-update\.json$/);

  // Phase 1 by hand: snapshot, fetch v0.2.0, check out SELF, store the state.
  const lock = lockOf(wt);
  const pre = {};
  for (const f of Object.keys(lock.files)) pre[f] = has(wt, f) ? hashFile(p(wt, f)) : null;
  gitc(wt, 'fetch', '-q', '--no-tags', BARE_URL, 'refs/tags/v0.2.0');
  const commit = gitc(wt, 'rev-parse', 'FETCH_HEAD^{commit}');
  assert.equal(commit, SHA['v0.2.0']);
  gitc(wt, 'checkout', commit, '--', 'tools', '.mb/ownership.json', '.mb/base-version.json', '.mb/migrations', 'mb', 'mb.cmd');
  fs.writeFileSync(st, JSON.stringify({ tag: 'v0.2.0', commit, pre }) + '\n');
  // FETCH_HEAD now points at the release candidate; --continue must ignore it.
  gitc(wt, 'fetch', '-q', '--no-tags', BARE_URL, 'refs/tags/v0.3.0-rc.1');
  assert.equal(gitc(wt, 'rev-parse', 'FETCH_HEAD^{commit}'), SHA['v0.3.0-rc.1']);
  const r = mb(wt, 'base-update', '--continue');
  assert.equal(r.code, 0, out(r));
  assert.deepEqual(lockOf(wt).base, { url: BARE_URL, tag: 'v0.2.0', commit: SHA['v0.2.0'] });
  assert.ok(!has(wt, 'docs/base/rc-only.md'));
  assert.ok(!fs.existsSync(st), 'state file not removed');
  // The main checkout was not touched.
  assert.equal(gitc(main, 'status', '--porcelain'), '');
  assert.equal(lockOf(main).base.tag, 'v0.1.0');

  // A full run inside a second worktree works too.
  const wt2 = fresh('wt2');
  gitc(main, 'worktree', 'add', '-q', '-b', 'wt2-branch', wt2);
  const r2 = mb(wt2, 'base-update', '--to', 'v0.2.0');
  assert.equal(r2.code, 0, out(r2));
  assert.equal(lockOf(wt2).base.commit, SHA['v0.2.0']);
  assert.equal(gitc(main, 'status', '--porcelain'), '');
});

ftest('--continue is idempotent after a partial apply', () => {
  const dir = derived();
  const lock = lockOf(dir);
  const pre = {};
  for (const f of Object.keys(lock.files)) pre[f] = hashFile(p(dir, f));
  gitc(dir, 'fetch', '-q', '--no-tags', BARE_URL, 'refs/tags/v0.2.0');
  const commit = gitc(dir, 'rev-parse', 'FETCH_HEAD^{commit}');
  gitc(dir, 'checkout', commit, '--', 'tools', '.mb', 'mb', 'mb.cmd');
  fs.writeFileSync(path.resolve(dir, gitc(dir, 'rev-parse', '--git-path', 'mb-update.json')), JSON.stringify({ tag: 'v0.2.0', commit, pre }) + '\n');
  // Simulate an interrupted first --continue: some files already written / deleted.
  write(dir, 'docs/base/r4-changed.md', 'r4 v2\n');
  fs.rmSync(p(dir, 'docs/base/r7-removed.md'));
  const r = mb(dir, 'base-update', '--continue');
  assert.equal(r.code, 0, out(r));
  assert.match(r.stdout, /^conflicts \(left untouched\) \(0\)$/m);
  for (const [k, h] of Object.entries(lockOf(dir).files)) assert.equal(hashFile(p(dir, k)), h, k);
});

ftest('init --force re-init keeps the recorded hash of an edited B file (no laundering): the update still reports it', () => {
  const dir = derived();
  const oldHash = lockOf(dir).files['docs/base/r5-edited.md'];
  write(dir, 'docs/base/r5-edited.md', 'r5 mine\n');
  commitAll(dir, ENV, 'edit');
  const r = mb(dir, ...initArgs(['--force']));
  assert.equal(lockOf(dir).files['docs/base/r5-edited.md'], oldHash, out(r));
  commitAll(dir, ENV, 're-init');
  const up = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(up.code, 6, out(up));
  assert.match(up.stdout, /docs\/base\/r5-edited\.md {2}# row 5/);
  assert.equal(read(dir, 'docs/base/r5-edited.md'), 'r5 mine\n');
});

ftest('single-branch clone (base commit not local): depth-1 fetch keeps the derived history', () => {
  const dir = fresh('single');
  gitc(TMP, 'clone', '-q', '--single-branch', '--branch', 'v0.1.0', BARE_URL, dir);
  gitc(dir, 'switch', '-q', '-c', 'main');
  assert.equal(mb(dir, ...initArgs()).code, 0);
  commitAll(dir, ENV, 'init');
  const count = gitc(dir, 'rev-list', '--count', 'HEAD');
  const r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 0, out(r));
  assert.equal(lockOf(dir).base.commit, SHA['v0.2.0']);
  assert.equal(gitc(dir, 'rev-list', '--count', 'HEAD'), count);
});

ftest('offline init: an unreachable base.url records commit null and the lock still validates', () => {
  const dir = fresh('offline');
  deriveTemplateCopy(BARE_URL, 'v0.1.0', dir, ENV);
  const cfg = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  write(dir, 'marketplace.config.json', canonicalPretty({ ...cfg, base: { url: pathToFileURL(path.join(TMP, 'no-such-base.git')).href } }));
  commitAll(dir, ENV, 'offline base url');
  const r = mb(dir, ...initArgs());
  assert.equal(lockOf(dir).base.commit, null, out(r));
  assert.match(r.stdout, /commit unknown: could not reach .*no-such-base\.git; no local tag v0\.1\.0/);
  assert.ok(!ownRuleErrors(dir).some((x) => x.id === 'CHK-16'));
});

ftest('init: tag missing at base.url but present locally (a clone) records the local tag commit; a reachable URL without the tag says so', () => {
  const dir = fresh('localtag');
  gitc(TMP, 'clone', '-q', '--branch', 'v0.1.0', BARE_URL, dir);
  gitc(dir, 'switch', '-q', '-c', 'main');
  const cfg = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  write(dir, 'marketplace.config.json', canonicalPretty({ ...cfg, base: { url: pathToFileURL(path.join(TMP, 'no-such-base.git')).href } }));
  commitAll(dir, ENV, 'unreachable base url');
  let r = mb(dir, ...initArgs());
  assert.equal(lockOf(dir).base.commit, SHA['v0.1.0'], out(r));
  // Reachable, tag absent, no local tag: names the missing tag, not "offline".
  const empty = path.join(TMP, `empty-${++n}.git`);
  gitc(TMP, 'init', '-q', '--bare', empty);
  const tpl = fresh('notag');
  deriveTemplateCopy(BARE_URL, 'v0.1.0', tpl, ENV);
  write(tpl, 'marketplace.config.json', canonicalPretty({ ...cfg, base: { url: pathToFileURL(empty).href } }));
  commitAll(tpl, ENV, 'tagless base url');
  r = mb(tpl, ...initArgs());
  assert.equal(lockOf(tpl).base.commit, null, out(r));
  assert.match(r.stdout, /commit unknown: tag v0\.1\.0 not found at .* or locally/);
});

ftest('init --force on an initialised repo never overwrites S files: writes missing seeds, patches includeExamples, drops deselected examples', () => {
  const dir = derived('v0.1.0', ['--email', 'alice@example.com', '--repo', 'acme/acme-skills']);
  write(dir, 'README.md', read(dir, 'README.md').replace(/\n/, '\n\nOur own intro.\n'));
  write(dir, 'policy/org.json', '{\n  "$schema": "../tools/schemas/layer-file.schema.json"\n}\n');
  fs.rmSync(p(dir, 'AGENTS.md'));
  commitAll(dir, ENV, 'customise');
  const readme = read(dir, 'README.md'), org = read(dir, 'policy/org.json'), cfg = read(dir, 'marketplace.config.json');
  // No --examples: selection kept, config untouched, the missing seed comes back.
  let r = mb(dir, ...initArgs(['--force']));
  assert.match(r.stdout, /seeds written \(missing or includeExamples changed\): AGENTS\.md\n/, out(r));
  assert.equal(read(dir, 'README.md'), readme);
  assert.equal(read(dir, 'policy/org.json'), org);
  assert.equal(read(dir, 'marketplace.config.json'), cfg);
  assert.ok(has(dir, 'AGENTS.md'));
  // --examples <subset>: only includeExamples changes; the other examples are deleted and unlocked.
  r = mb(dir, ...initArgs(['--force', '--examples', 'code-review']));
  assert.match(read(dir, 'README.md'), /Our own intro\./, out(r)); // gen refreshes only its marker blocks
  assert.equal(read(dir, 'policy/org.json'), org);
  const after = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  assert.deepEqual(after, { ...parse(Buffer.from(cfg)), includeExamples: ['code-review'] });
  assert.deepEqual(fs.readdirSync(p(dir, 'examples/plugins')), ['code-review']);
  assert.ok(!Object.keys(lockOf(dir).files).some((k) => k.startsWith('examples/') && !k.startsWith('examples/plugins/code-review/')));
  assert.ok(!ownRuleErrors(dir).some((x) => x.id === 'CHK-16'));
});

ftest('dropping an example after init (edit includeExamples + rm) keeps CHK-16 green and base-update never restores it', () => {
  const dir = derived();
  const cfg = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  const all = fs.readdirSync(p(dir, 'examples/plugins')).sort();
  write(dir, 'marketplace.config.json', canonicalPretty({ ...cfg, includeExamples: all.filter((x) => x !== 'meeting-notes') }));
  fs.rmSync(p(dir, 'examples/plugins/meeting-notes'), { recursive: true });
  let r = mb(dir, 'gen');
  assert.equal(r.code, 0, out(r));
  commitAll(dir, ENV, 'drop meeting-notes');
  assert.ok(!ownRuleErrors(dir).some((x) => x.id === 'CHK-16'));
  r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 0, out(r));
  assert.ok(!has(dir, 'examples/plugins/meeting-notes'));
  assert.ok(!Object.keys(lockOf(dir).files).some((k) => k.startsWith('examples/plugins/meeting-notes/')));
  // The other documented route: adopt, delete, gen.
  const ad = derived();
  assert.equal(mb(ad, 'adopt', 'code-review').code, 0);
  fs.rmSync(p(ad, 'plugins/code-review'), { recursive: true });
  r = mb(ad, 'gen');
  assert.equal(r.code, 0, out(r));
  commitAll(ad, ENV, 'drop code-review');
  assert.deepEqual(ownRuleErrors(ad), []);
  r = mb(ad, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 0, out(r));
  assert.ok(!has(ad, 'examples/plugins/code-review') && !has(ad, 'plugins/code-review'));
});

ftest('base.url in marketplace.config.json wins over the lock copy (fork/mirror) and is recorded in the new lock', () => {
  const dir = derived();
  const mirror = path.join(TMP, `mirror-${++n}.git`);
  gitc(TMP, 'clone', '-q', '--mirror', BARE, mirror);
  const mirrorUrl = pathToFileURL(mirror).href;
  const cfg = parse(fs.readFileSync(p(dir, 'marketplace.config.json')));
  write(dir, 'marketplace.config.json', canonicalPretty({ ...cfg, base: { url: mirrorUrl } }));
  commitAll(dir, ENV, 'point at a mirror');
  const r = mb(dir, 'base-update', '--to', 'v0.2.0');
  assert.equal(r.code, 0, out(r));
  assert.match(r.stdout, /from marketplace\.config\.json; the lock had/);
  assert.equal(lockOf(dir).base.url, mirrorUrl);
});

ftest('derive proof SKIP (no earlier stable tag) prints a ::warning:: under GitHub Actions and exits 0', async () => {
  const dir = fresh('noprior');
  deriveTemplateCopy(BARE_URL, 'v0.1.0', dir, ENV); // fresh history, no tags
  const saved = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  let text = '';
  try {
    const code = await deriveProof({ root: dir, stdout: (t) => { text += t; }, stderr: (t) => { text += t; } });
    assert.equal(code, 0, text);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = saved;
  }
  assert.match(text, /SKIPPED/);
  assert.match(text, /^::warning /m);
});

// ======================= derive proof =======================

ftest('derive proof (mb test --derive) passes from N-1 and N-2 on the fixture base', async () => {
  const w = BARE_WORK();
  let text = '';
  const code = await deriveProof({ root: w, stdout: (t) => { text += t; }, stderr: (t) => { text += t; } });
  assert.equal(code, 0, text);
  assert.match(text, /derive proof: v0\.2\.0 -> v0\.2\.1/); // HEAD = v0.3.0-rc.1 (no stable tag) -> synthetic v0.2.1
  assert.match(text, /derive proof: v0\.1\.0 -> /);
  assert.doesNotMatch(text, /^FAIL/m);
});

function BARE_WORK() {
  return path.join(TMP, 'base-work');
}
