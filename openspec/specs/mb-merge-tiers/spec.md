# mb-merge-tiers Specification

## Purpose
Defines how configuration is still resolved when the built-in resolver cannot run: saved and generated mergers verified against the conformance vectors.

## Requirements

### Requirement: MB-TIER-001 Tier a runtimes and fallback
Tier a SHALL run `resolve.mjs` with node 20 or later, or bun; when neither exists, or the resolver exits with a code outside 0, 2, 3, 4 and 5 or prints no JSON, the skill SHALL follow FALLBACK.md; exit 5 SHALL never trigger the fallback.

#### Scenario: Tier a resolves
- **WHEN** node 20 runs the resolver on a valid fixture
- **THEN** the output has `"tier":"a"` and matches the vector (test tools/tests/vectors.test.mjs)

### Requirement: MB-TIER-002 Saved merger key and location
A generated merger SHALL be saved as `K.<ext>` with `K = <specVersion>-<sha8>` over the vectors and MERGE-SPEC.md, only under `<user-data>/<mkt>/mergers/`, and never in a project or plugin directory.

#### Scenario: Key changes with the vectors
- **WHEN** any vector file or MERGE-SPEC.md changes
- **THEN** the key in `_mb/vectors.sha256` changes and old mergers are not used (test tools/tests/gen.test.mjs)

### Requirement: MB-TIER-003 Hash check at load
Before running a saved merger the agent SHALL compare its sha256 with `K.<ext>.sha256` and SHALL ignore the file and move to tier c on any mismatch.

#### Scenario: Edited saved merger is ignored
- **WHEN** a saved merger's bytes do not match its stored hash
- **THEN** it is not run and tier c generates a new merger

### Requirement: MB-TIER-004 Generated-merger gate
In every session, before tier b, the agent SHALL stop when org `enforced.settings.merge.allowGenerated` or the user file `merge.allowGenerated` is false, saying generated mergers are disabled.

#### Scenario: Org disables generated mergers
- **WHEN** no runtime exists and org enforces `merge.allowGenerated: false`
- **THEN** the skill stops with "generated mergers are disabled by policy"

### Requirement: MB-TIER-005 External vector verification
A generated merger SHALL pass every vector byte-for-byte and by exit code, run by a loop outside the merger, plus the real-mode check, before it is used or saved.

#### Scenario: Vectors judge the merger
- **WHEN** a generated merger is checked
- **THEN** each vector's stdout and exit are compared to `expected.json` and `expected.exit` by an external loop

### Requirement: MB-TIER-006 Repair limit and stop
The agent SHALL make at most 2 repair rounds using only failing vector names and diffs, then SHALL stop and SHALL NOT merge configuration by hand.

#### Scenario: Merger still fails after repairs
- **WHEN** vectors still fail after 2 repair rounds
- **THEN** the skill reports the failed vector count and stops

### Requirement: MB-TIER-007 Sandbox no-save
When the mergers directory cannot be written, the agent SHALL use the verified merger for that run only and say "merger not cached".

#### Scenario: Codex sandbox denies the save
- **WHEN** a verified merger cannot be written under workspace-write
- **THEN** it is used once and the skill says "merger not cached"

### Requirement: MB-TIER-008 Enforcement paths use tier a only
`mb policy emit`, `mb check` and CI SHALL use only tier a; tiers b and c SHALL serve local resolution only and SHALL never write config.

#### Scenario: Policy emit uses the reference engine
- **WHEN** `./mb policy emit` runs
- **THEN** it reads policy with the tier-a parser and runs no generated merger (test tools/tests/policy.test.mjs)
