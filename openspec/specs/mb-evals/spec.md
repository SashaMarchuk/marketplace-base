# mb-evals Specification

## Purpose
Defines how skills are evaluated live on both hosts from one native case format, and how results are scored honestly.

## Requirements

### Requirement: MB-EVL-001 Native case format
Eval cases SHALL use the native `claude plugin eval` layout, `evals/<case>/prompt.md` plus `graders/*.md`, with only the native frontmatter keys.

#### Scenario: Unknown frontmatter key fails
- **WHEN** a `prompt.md` has a key outside the native set and `./mb check` runs
- **THEN** the check fails (test tools/tests/rules/CHK-14.test.mjs)

### Requirement: MB-EVL-002 Trigger and no-trigger coverage
Each skill SHALL have at least one trigger case that requires the skill to fire and at least one no-trigger case that requires it not to fire on both arms.

#### Scenario: Missing no-trigger case
- **WHEN** a skill has only a trigger case and `./mb check` runs
- **THEN** the check fails with the hint that `mb new skill` scaffolds both (test tools/tests/rules/CHK-14.test.mjs)

### Requirement: MB-EVL-003 Claude runner flags
The Claude runner SHALL call `claude plugin eval` with `--ablation none`, the configured threshold, runs, models and cost cap, and for configurable plugins `--scaffold` and the node and sh allow rules.

#### Scenario: Command line snapshot
- **WHEN** the Claude runner builds its command for a configurable plugin
- **THEN** it equals the snapshot (test tools/tests/evals.test.mjs)

### Requirement: MB-EVL-004 Codex isolated install
The Codex runner SHALL install the marketplace into a temporary CODEX_HOME and SHALL NOT modify the real one; in CI it SHALL log in with an API key and never copy a personal session file.

#### Scenario: Real CODEX_HOME untouched
- **WHEN** the Codex runner completes
- **THEN** the real CODEX_HOME is unchanged (test tools/tests/evals.test.mjs)

### Requirement: MB-EVL-005 Grader mapping
The Codex runner SHALL map regex, file_exists and Skill and Bash tool_used graders to its JSONL stream and output files, and SHALL report graders it cannot evaluate as SKIPPED.

#### Scenario: Skill fired on Codex
- **WHEN** a recorded Codex stream reads the skill's SKILL.md
- **THEN** the skill-fired grader passes (test tools/tests/evals.test.mjs)

### Requirement: MB-EVL-006 Skipped never passes
A SKIPPED grader SHALL never count as a pass, and a case whose graders are all skipped SHALL fail.

#### Scenario: All graders skipped
- **WHEN** every grader of a case is SKIPPED
- **THEN** the case fails (test tools/tests/evals.test.mjs)

### Requirement: MB-EVL-007 CI triggers and secrets
Eval CI SHALL run only on manual dispatch (optionally only the plugins changed on a PR branch) and a nightly schedule, never on `pull_request` or `pull_request_target`, and a host whose key is missing SHALL be skipped with a notice.

#### Scenario: Missing key
- **WHEN** the eval workflow runs without `OPENAI_API_KEY`
- **THEN** the Codex leg emits a skipped notice and does not fail (test tools/tests/github.test.mjs)
