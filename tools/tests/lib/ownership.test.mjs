// Tests for tools/lib/ownership.mjs and the literal .mb/ownership.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  globToRegExp, matchGlob, loadOwnership, parseOwnership, compileOwnership, classify, isBase, normalizeRel, CLASS_ORDER,
} from '../../lib/ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The expected literal, byte for byte (LF line endings, trailing newline).
const OWNERSHIP_LITERAL = `{
  "G": ["plugins/*/.claude-plugin/plugin.json", "plugins/*/.codex-plugin/plugin.json", "plugins/*/skills/*/_mb/**",
        "examples/plugins/*/.claude-plugin/plugin.json", "examples/plugins/*/.codex-plugin/plugin.json",
        "examples/plugins/*/skills/*/_mb/**", ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json",
        "docs/catalog.md", "docs/base/rules.md"],
  "M": [".mb-lock.json"],
  "E": ["examples/plugins/**"],
  "B": ["CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md", "mb", "mb.cmd", "tools/**", ".mb/ownership.json",
        ".mb/base-version.json", ".mb/migrations/**", "docs/base/**", "openspec/specs/mb-*/spec.md",
        "openspec/changes/archive/*-mbase-*/**", ".github/workflows/mb-*.yml", ".github/pull_request_template.md",
        ".gitattributes", ".gitleaks.toml"],
  "S": ["LICENSE", "README.md", "USAGE.md", "AGENTS.md", "marketplace.config.json", "policy/org.json",
        "plugins/.gitkeep", "openspec/config.yaml", ".github/CODEOWNERS", ".gitignore"]
}
`;

test('.mb/ownership.json is byte-for-byte the expected literal', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, '.mb', 'ownership.json'), 'utf8'), OWNERSHIP_LITERAL);
});

test('glob dialect: * stays within a segment, ** spans whole segments, rest literal', () => {
  assert.ok(matchGlob('plugins/*/x.json', 'plugins/a/x.json'));
  assert.ok(!matchGlob('plugins/*/x.json', 'plugins/a/b/x.json'));
  assert.ok(!matchGlob('plugins/*/x.json', 'plugins/a/xxjson')); // "." is literal
  assert.ok(matchGlob('tools/**', 'tools/a/b/c.mjs'));
  assert.ok(matchGlob('tools/**', 'tools/x'));
  assert.ok(matchGlob('tools/**', 'tools')); // zero segments
  assert.ok(!matchGlob('tools/**', 'toolsx/a'));
  assert.ok(matchGlob('a/**/b', 'a/b'));
  assert.ok(matchGlob('a/**/b', 'a/x/y/b'));
  assert.ok(!matchGlob('a/**/b', 'a/xb'));
  assert.ok(matchGlob('**/b', 'b'));
  assert.ok(matchGlob('**/b', 'x/y/b'));
  assert.ok(matchGlob('**', 'any/thing'));
  assert.ok(!matchGlob('mb', 'mbx'));
  assert.ok(!matchGlob('mb', 'x/mb')); // whole-path match only
  assert.ok(matchGlob('a{b,c}', 'a{b,c}')); // braces are literal
  assert.ok(matchGlob('a[bc]', 'a[bc]')); // classes are literal
  assert.ok(!matchGlob('a[bc]', 'ab'));
  assert.ok(matchGlob('mb-*.yml', 'mb-.yml')); // * may be empty
  assert.equal(globToRegExp('a/*').source, '^a\\/[^/]*$');
});

test('paths are normalised: backslashes and leading ./', () => {
  assert.equal(normalizeRel('.\\tools\\mb.mjs'), 'tools/mb.mjs');
  const o = parseOwnership(OWNERSHIP_LITERAL);
  assert.equal(classify('tools\\lib\\fsx.mjs', o), 'B');
  assert.equal(classify('./README.md', o), 'S');
});

test('classifies every sample path', () => {
  const o = loadOwnership(ROOT);
  const cases = {
    'LICENSE': 'S', 'README.md': 'S', 'USAGE.md': 'S', 'AGENTS.md': 'S', 'CLAUDE.md': 'B',
    'CONTRIBUTING.md': 'B', 'SECURITY.md': 'B', 'marketplace.config.json': 'S', 'mb': 'B', 'mb.cmd': 'B',
    'tools/mb.mjs': 'B', 'tools/cmd/gen.mjs': 'B', 'tools/lib/fsx.mjs': 'B', 'tools/lib/rules/CHK-01.mjs': 'B',
    'tools/kit/resolve.mjs': 'B', 'tools/kit/json.mjs': 'B', 'tools/kit/realmode/fixture.json': 'B',
    'tools/kit/MERGE-SPEC.md': 'B', 'tools/kit/FALLBACK.md': 'B', 'tools/kit/vectors/001-defaults-only/input.json': 'B',
    'tools/schemas/lock.schema.json': 'B', 'tools/templates/seeds/README.md': 'B', 'tools/hooks/pre-push': 'B',
    'tools/tests/lib/json.test.mjs': 'B', '.mb/ownership.json': 'B', '.mb/base-version.json': 'B',
    '.mb/migrations/1.2.0.mjs': 'B', '.mb/leak-denylist.txt': 'D', '.mb-lock.json': 'M',
    'policy/org.json': 'S', 'policy/teams/payments.json': 'D', 'plugins/.gitkeep': 'S',
    'plugins/demo/plugin.src.json': 'D', 'plugins/demo/skills/hello/SKILL.md': 'D',
    'examples/plugins/code-review/plugin.src.json': 'E', 'examples/plugins/code-review/skills/x/SKILL.md': 'E',
    'plugins/demo/.claude-plugin/plugin.json': 'G', 'plugins/demo/.codex-plugin/plugin.json': 'G',
    'plugins/demo/skills/hello/_mb/resolve.mjs': 'G', 'plugins/demo/skills/hello/_mb/vectors/001-x/input.json': 'G',
    'examples/plugins/code-review/.claude-plugin/plugin.json': 'G', // G wins over E
    'examples/plugins/code-review/.codex-plugin/plugin.json': 'G',
    'examples/plugins/code-review/skills/x/_mb/kit.json': 'G',
    '.claude-plugin/marketplace.json': 'G', '.agents/plugins/marketplace.json': 'G',
    'docs/base/config.md': 'B', 'docs/base/CHANGELOG.md': 'B', 'docs/catalog.md': 'G',
    'docs/base/rules.md': 'G', // G wins over B
    'openspec/config.yaml': 'S', 'openspec/specs/mb-config/spec.md': 'B', 'openspec/specs/billing/spec.md': 'D',
    'openspec/changes/archive/2026-01-10-mbase-initial/proposal.md': 'B',
    'openspec/changes/archive/2026-03-01-add-mb-support/x': 'D',
    'openspec/changes/add-thing/proposal.md': 'D',
    '.github/workflows/mb-check.yml': 'B', '.github/workflows/deploy.yml': 'D', '.github/CODEOWNERS': 'S',
    '.github/pull_request_template.md': 'B', '.gitignore': 'S', '.gitattributes': 'B', '.gitleaks.toml': 'B',
    'dist/policy/claude/org/SHA256SUMS': 'D',
  };
  const cls = compileOwnership(o);
  for (const [p, want] of Object.entries(cases)) assert.equal(cls(p), want, p);
});

test('class order is G, M, E, B, S and parseOwnership validates', () => {
  assert.deepEqual([...CLASS_ORDER], ['G', 'M', 'E', 'B', 'S']);
  assert.throws(() => parseOwnership('{"X":[]}'), /unknown class/);
  assert.throws(() => parseOwnership('{"G":"a"}'), /array/);
  assert.deepEqual(parseOwnership('{"G":["a"]}').S, []);
});

test('isBase: true without .mb-lock.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-own-'));
  try {
    assert.equal(isBase(dir), true);
    fs.writeFileSync(path.join(dir, '.mb-lock.json'), '{}');
    assert.equal(isBase(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
