# mb-base-update Specification

## Purpose
Defines how a derived marketplace is created from the base and how it later pulls base updates by copying files, without a 3-way merge.

## Requirements

### Requirement: MB-UPD-001 Init
`mb init` SHALL render the seed files, record the base tag and commit in `.mb-lock.json`, delete examples not selected by `--examples`, run `gen` and `check`, and SHALL refuse the name `marketplace-base` or an existing lock without `--force`; with an existing lock, `--force` SHALL write only missing seed files and the example selection, never overwriting an existing seed file.

#### Scenario: Init from a template copy
- **WHEN** `./mb init --name acme-skills --display "Acme Skills" --owner Alice` runs in a fresh copy
- **THEN** `.mb-lock.json` exists with the base tag and `./mb check` is green (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-002 Lock file
`.mb-lock.json` SHALL list only B and E paths with their hash-rule hashes, plus the base url, tag and commit and the `adopted` plugins; it SHALL never list G or S paths.

#### Scenario: Lock lists base files only
- **WHEN** `mb init` writes the lock
- **THEN** every `files` key is a B or E path (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-003 Self-update first
`mb base-update` SHALL first check out the new base tooling at the fetched commit and re-run itself with `--continue`, so the rest of the update runs with the new code.

#### Scenario: New tooling runs the update
- **WHEN** `./mb base-update --to v0.2.0` runs
- **THEN** the re-exec with `--continue` is observed (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-004 Decision table
`mb base-update` SHALL apply, per path, the first matching row of the decision table: write unchanged base files, release paths reclassified out of B or E, delete paths removed upstream, and never change D or S bytes.

#### Scenario: Clean update
- **WHEN** a derived repo with only D and S edits updates to a new tag
- **THEN** there are 0 conflicts and D and S bytes are unchanged (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-005 Self-update guard and pinned commit
Before any checkout, `mb base-update` SHALL exit 6 when a file under the base tooling paths is edited or has no lock entry, unless `--force`; `--continue` SHALL use the commit stored in the state file, never FETCH_HEAD.

#### Scenario: Edited tooling stops the update
- **WHEN** a file under `tools/` was edited and `./mb base-update` runs
- **THEN** it exits 6 before any checkout (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-006 Conflict refusal and --force/--keep
A derived edit of a B or E file, or a D file at a path the new tag adds, SHALL be a conflict that is left untouched with exit 6; `--force` SHALL overwrite it and `--keep` SHALL keep it with its old lock hash.

#### Scenario: Kept conflict stays red
- **WHEN** an update runs with `--keep` over an edited base file
- **THEN** the old lock hash is kept and the next update still reports the conflict (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-007 Migrations
`mb base-update` SHALL run each `.mb/migrations/<version>.mjs` for versions after the locked tag up to the new tag, and SHALL report the S files each migration edited.

#### Scenario: Migration edits are reported
- **WHEN** an update crosses a version with a migration that edits an S file
- **THEN** the report lists that S file (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-008 Derive proof in CI
Base CI SHALL derive a repo from the previous tag and from the tag before it, apply scripted derived edits, update to HEAD and require 0 conflicts and a green check.

#### Scenario: Derive proof runs
- **WHEN** `./mb test --derive` runs in the base
- **THEN** both derived copies update to HEAD with 0 conflicts (test tools/tests/derive.test.mjs)

### Requirement: MB-UPD-009 Scheduled PR and token limitation
The scheduled update workflow SHALL run fetched code only in a read-only job, and without `MB_UPDATE_TOKEN` SHALL push a branch and write a compare link instead of opening the PR.

#### Scenario: No token
- **WHEN** the scheduled update runs without `MB_UPDATE_TOKEN`
- **THEN** it pushes `mb/base-update-<tag>` and writes the compare link and checklist to the job summary (test tools/tests/github.test.mjs)
