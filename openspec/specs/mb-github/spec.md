# mb-github Specification

## Purpose
Defines the GitHub integration that works on free and paid plans: PR checks, branch rules with graceful degradation, hooks and releases.

## Requirements

### Requirement: MB-GH-001 PR checks without secrets
The check workflow SHALL run on `pull_request` and pushes to the default branch with read-only permissions and no secrets, SHALL NOT use `pull_request_target`, and SHALL report one aggregate status named `mb-check`.

#### Scenario: Aggregate check
- **WHEN** any matrix leg of the check workflow fails
- **THEN** the `mb-check` job fails (test tools/tests/github.test.mjs)

### Requirement: MB-GH-002 Try-and-degrade setup (no plan detection)
`mb github setup` SHALL NOT detect the GitHub plan; it SHALL try each protection API call and degrade on HTTP 403, 404 or 422.

#### Scenario: Ruleset refused
- **WHEN** the ruleset call returns 403 and the classic protection call returns 200
- **THEN** setup reports that classic protection is applied (test tools/tests/github.test.mjs)

### Requirement: MB-GH-003 Ruleset or protection
`mb github setup` SHALL require pull requests and the `mb-check` status, block force-push and deletion of the default branch, and protect `v*` tags, using a ruleset or else classic branch protection.

#### Scenario: Ruleset applied
- **WHEN** the ruleset call returns 200
- **THEN** no classic protection call is made (test tools/tests/github.test.mjs)

### Requirement: MB-GH-004 Free-private degradation and hooks
When neither rulesets nor branch protection are available, `mb github setup` SHALL say that checks report but do not block and SHALL set `core.hooksPath` to `tools/hooks`, whose pre-push hook runs the fast checks and the leak scan.

#### Scenario: Both calls refused
- **WHEN** both protection calls return 403
- **THEN** setup prints the degradation notice and installs the hooks (test tools/tests/github.test.mjs)

### Requirement: MB-GH-005 Release artifacts
The release workflow SHALL run on `v*` tags, run `check` and, when `distribution` is set, `policy emit` for both hosts, and publish the outputs with `SHA256SUMS`; in the base it SHALL first fail unless `.mb/base-version.json` equals the tag.

#### Scenario: Base version mismatch
- **WHEN** a base tag differs from `.mb/base-version.json`
- **THEN** the release workflow fails before publishing (test tools/tests/github.test.mjs)
