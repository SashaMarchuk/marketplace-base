// tools/lib/policy/load.mjs: read and validate the policy inputs of `mb policy emit`.
//
// Policy files (policy/org.json, policy/teams/<t>.json) get the resolver's POLICY parse: fail closed.
//   - lexical errors (config-mode JSON: BOM, duplicate keys, floats, bad key syntax, ...)  POLICY_INVALID
//   - a shape error from the layer-file schema (unknown key at a closed level, wrong type) POLICY_INVALID
//   - a bad `access` (unknown key, non-array, bad pattern)                                ACCESS_INVALID
//   - `null` anywhere under `enforced`                                                    ENFORCED_INVALID
//   - `--team t` with no policy/teams/<t>.json                                             TEAM_UNKNOWN
// Every one of them throws PolicyError (exit 3). `team` and `merge` keys are honoured only in
// personal layers, so in a policy file they are ignored with a KEY_IGNORED warning (as the resolver does).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../kit/json.mjs';
import { fromPosix, isFile, readBytes } from '../fsx.mjs';
import { validate, loadSchema } from '../schema-lite.mjs';

// Schemas are tooling: read from the repo that owns this code.
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const TEAM_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class PolicyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PolicyError';
    this.code = code;
    this.exitCode = 3;
  }
}

/** JSON Pointers of every `null` under `value` (the root itself included). */
function nullPointers(value, ptr = '') {
  if (value === null) return [ptr || '/'];
  if (typeof value !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(value)) out.push(...nullPointers(v, `${ptr}/${k}`));
  return out;
}

/**
 * Parse and validate one policy file. Returns the parsed object.
 * `rel` is the repo-relative POSIX path used in messages; `warnings` collects {code, file, key}.
 */
export function parsePolicy(bytes, rel, warnings = []) {
  let doc;
  try {
    doc = parse(bytes, { mode: 'config' });
  } catch (e) {
    if (e && e.name === 'JsonError') throw new PolicyError('POLICY_INVALID', `${rel}:${e.line}:${e.column}: ${e.message}`);
    throw e;
  }
  const errs = validate(loadSchema(TOOL_ROOT, 'layer-file'), doc);
  if (errs.length) {
    const e = errs[0];
    const code = e.path === '/access' || e.path.startsWith('/access/') ? 'ACCESS_INVALID' : 'POLICY_INVALID';
    throw new PolicyError(code, `${rel}: ${e.path || '/'}: ${e.message}`);
  }
  if (doc.enforced !== undefined) {
    const nulls = nullPointers(doc.enforced, '/enforced');
    if (nulls.length) throw new PolicyError('ENFORCED_INVALID', `${rel}: ${nulls[0]}: null is not allowed under enforced`);
  }
  for (const key of ['team', 'merge']) {
    if (doc[key] !== undefined) warnings.push({ code: 'KEY_IGNORED', file: rel, key });
  }
  return doc;
}

/**
 * Load the org policy and, with `team`, the team policy of the repo at `root`.
 * A missing policy/org.json means "no org layer" (empty policy). Returns
 * { layers: [{ name: 'org'|'team', file, doc }], warnings }, ordered team first, org last
 * (the resolver's authority order: org applied last wins).
 */
export function loadPolicy(root, team = null) {
  const warnings = [];
  const layers = [];
  if (team !== null) {
    if (!TEAM_NAME.test(team)) throw new PolicyError('TEAM_UNKNOWN', `"${team}" is not a valid team name`);
    const rel = `policy/teams/${team}.json`;
    if (!isFile(fromPosix(root, rel))) throw new PolicyError('TEAM_UNKNOWN', `${rel} does not exist`);
    layers.push({ name: 'team', file: rel, doc: parsePolicy(readBytes(fromPosix(root, rel)), rel, warnings) });
  }
  const orgRel = 'policy/org.json';
  if (isFile(fromPosix(root, orgRel))) {
    layers.push({ name: 'org', file: orgRel, doc: parsePolicy(readBytes(fromPosix(root, orgRel)), orgRel, warnings) });
  }
  return { layers, warnings };
}
