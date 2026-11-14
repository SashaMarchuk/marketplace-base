// tools/lib/gen/build.mjs: the generator API (SPEC §4, `mb gen`, CHK-10).
//
//   build(root) -> { files, stale, problems }    pure: reads the repo, writes nothing
//     files:    Map<POSIX rel, Buffer>  every expected G file, plus every marker-bearing file whose
//               marker bodies gen owns (README.md, USAGE.md, AGENTS.md, .gitignore, SKILL.md)
//     stale:    sorted POSIX rels of existing files under some skills/<s>/_mb/ that gen no longer
//               produces (removed kit files, deleted team files, a plugin that stopped being
//               configurable); gen deletes them
//     problems: [{ path, message }]  marker files gen could not fill (left untouched)
//   diff(root, result) -> [{ path, kind: 'changed'|'missing'|'stale' }]   sorted by path
//   apply(root, result) -> { written: [rel], removed: [rel] }            writes only what differs
//
// Data (kit, policy, plugins, rules) is always read from `root`, the repo being generated.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalPretty, compareCodePoints } from '../../kit/json.mjs';
import { fromPosix, isFile, readBytes, walk, writeFileAtomic, removePath } from '../fsx.mjs';
import { loadRepo } from './repo.mjs';
import { readKit, mbTree } from './vendor-kit.mjs';
import { stampVersion } from './version-stamp.mjs';
import { manifestFiles } from './manifests.mjs';
import { marketplaceFiles } from './marketplaces.mjs';
import { catalogBody, installBody, catalogDoc } from './catalog.mjs';
import { skillMdText, fillMarkers, gitignoreBody, configLocationsBody, agentsBody } from './markers.mjs';
import { loadRules, rulesDoc } from './docs-rules.mjs';

const json = (v) => Buffer.from(canonicalPretty(v));
const byPath = (a, b) => compareCodePoints(a, b);

export async function build(root) {
  const repo = loadRepo(root);
  const files = new Map();
  const problems = [];
  const versions = new Map();
  let kitFiles = null; // read lazily: a repo without configurable plugins does not need the kit

  // Per plugin: _mb trees, version, manifests, SKILL.md config block.
  for (const p of repo.plugins) {
    const trees = [];
    if (p.configurable) {
      kitFiles ??= readKit(repo.kitDir);
      for (const s of p.skills) trees.push({ skill: s.name, files: mbTree(repo, p, s.name, kitFiles) });
    }
    const version = stampVersion(p, trees);
    if (p.included) versions.set(p.name, version);
    for (const t of trees) for (const [rel, bytes] of t.files) files.set(`${p.dir}/skills/${t.skill}/_mb/${rel}`, bytes);
    for (const m of manifestFiles(p, repo, version)) files.set(m.rel, json(m.value));
    for (const s of p.skills) {
      const text = readBytes(fromPosix(root, s.skillMd)).toString('utf8');
      const r = skillMdText(text, p.name, p.configurable);
      if (r.problem) problems.push({ path: s.skillMd, message: r.problem });
      else files.set(s.skillMd, Buffer.from(r.text, 'utf8'));
    }
  }

  for (const m of marketplaceFiles(repo)) files.set(m.rel, json(m.value));
  files.set('docs/catalog.md', Buffer.from(catalogDoc(repo, versions)));
  files.set('docs/base/rules.md', Buffer.from(rulesDoc(await loadRules(fromPosix(root, 'tools/lib/rules')))));

  // Marker files at the repo root (S files; only their marker bodies are G). Absent files are skipped.
  const markerFiles = [
    ['README.md', { catalog: catalogBody(repo), install: installBody(repo) }],
    ['USAGE.md', { 'config-locations': configLocationsBody(repo) }],
    ['AGENTS.md', { agents: agentsBody() }],
    ['.gitignore', { gitignore: gitignoreBody(repo) }],
  ];
  for (const [rel, bodies] of markerFiles) {
    const abs = fromPosix(root, rel);
    if (!isFile(abs)) continue;
    const r = fillMarkers(readBytes(abs).toString('utf8'), bodies);
    if (r.problem) problems.push({ path: rel, message: r.problem });
    else files.set(rel, Buffer.from(r.text, 'utf8'));
  }

  // Stale files under every skills/<s>/_mb/ of every plugin dir.
  const stale = [];
  for (const p of repo.plugins) {
    for (const rel of walk(fromPosix(root, `${p.dir}/skills`))) {
      if (!/^[^/]+\/_mb\//.test(rel)) continue;
      const full = `${p.dir}/skills/${rel}`;
      if (!files.has(full)) stale.push(full);
    }
  }

  return { files, stale: stale.sort(byPath), problems };
}

export function diff(root, result) {
  const out = [];
  for (const [rel, bytes] of result.files) {
    const abs = fromPosix(root, rel);
    if (!isFile(abs)) out.push({ path: rel, kind: 'missing' });
    else if (!readBytes(abs).equals(bytes)) out.push({ path: rel, kind: 'changed' });
  }
  for (const rel of result.stale) out.push({ path: rel, kind: 'stale' });
  return out.sort((a, b) => byPath(a.path, b.path));
}

/** Remove now-empty directories from the parent of `rel` up to (and including) its `_mb` dir. */
function pruneEmpty(root, rel) {
  let dir = path.posix.dirname(rel);
  while (/\/_mb(\/|$)/.test(dir)) {
    try {
      const abs = fromPosix(root, dir);
      if (fs.readdirSync(abs).length > 0) return;
      fs.rmdirSync(abs);
    } catch {
      return;
    }
    if (dir.endsWith('/_mb')) return;
    dir = path.posix.dirname(dir);
  }
}

export function apply(root, result) {
  const written = [], removed = [];
  for (const d of diff(root, result)) {
    if (d.kind === 'stale') {
      removePath(fromPosix(root, d.path));
      pruneEmpty(root, d.path);
      removed.push(d.path);
    } else {
      writeFileAtomic(fromPosix(root, d.path), result.files.get(d.path));
      written.push(d.path);
    }
  }
  return { written, removed };
}
