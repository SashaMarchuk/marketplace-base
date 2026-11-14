# mb-examples Specification

## Purpose
Defines the example plugins shipped with the base, which show each feature and prove that skills work on both hosts.

## Requirements

### Requirement: MB-EX-001 Four generic examples
The base SHALL ship exactly four example plugins under `examples/plugins/`: commit-message, changelog-entry, meeting-notes and code-review, each with one skill, MIT license and category Productivity, and no company-specific content.

#### Scenario: Examples pass check
- **WHEN** `./mb check` runs in the base
- **THEN** all four examples pass with 0 errors

### Requirement: MB-EX-002 Skills-only
Example plugins SHALL contain only skills and their files, with no commands, agents, hooks, MCP servers or binaries.

#### Scenario: Host-specific component in an example
- **WHEN** an example plugin gains a `commands/` directory
- **THEN** `./mb check` fails (test tools/tests/rules/CHK-09.test.mjs)

### Requirement: MB-EX-003 Both-host passing evals before release
A base release SHALL attach eval results for the tagged commit showing every example case at or above the threshold on both Claude Code and Codex.

#### Scenario: Release checklist
- **WHEN** a base release is prepared
- **THEN** both-host eval results for the tagged commit are attached
