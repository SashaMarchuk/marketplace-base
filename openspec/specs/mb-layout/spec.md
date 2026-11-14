# mb-layout Specification

## Purpose
Defines the repo layout of a marketplace built on marketplace-base: who owns each path, which text is generated, and how drift is hashed.

## Requirements

### Requirement: MB-LAY-001 Ownership classes
Every path in the repo SHALL belong to exactly one ownership class: B (base-owned), S (seed), D (derived-owned), G (generated), E (example plugin) or M (written only by `mb init` and `mb base-update`).

#### Scenario: Every path has one class
- **WHEN** any repo-relative path is classified with `.mb/ownership.json`
- **THEN** exactly one of the classes G, M, E, B, S or D is returned (test tools/tests/lib/ownership.test.mjs)

### Requirement: MB-LAY-002 Ownership resolution order
The ownership of a path SHALL be the class of the first matching glob in `.mb/ownership.json`, checked in the order G, M, E, B, S; a path that matches no glob SHALL be D.

#### Scenario: Generated files inside an example are G
- **WHEN** `examples/plugins/code-review/.claude-plugin/plugin.json` is classified
- **THEN** the class is G, not E (test tools/tests/lib/ownership.test.mjs)

#### Scenario: Unmatched path is derived-owned
- **WHEN** `openspec/changes/archive/2026-03-01-add-mb-support/x` is classified
- **THEN** the class is D (test tools/tests/lib/ownership.test.mjs)

### Requirement: MB-LAY-003 G-marker set
Generated text inside hand-written files SHALL appear only between whole-line marker pairs: `catalog` and `install` in README.md, `config-locations` in USAGE.md, `agents` in AGENTS.md, `gitignore` in `.gitignore`, and `config` in every configurable SKILL.md.

#### Scenario: Marker pairs are found and replaced
- **WHEN** a file contains one well-formed whole-line marker pair for an id
- **THEN** the marker library finds it and replaces only its body (test tools/tests/lib/markers-hash.test.mjs)

### Requirement: MB-LAY-004 Hash rule
The lock and drift hash of a file SHALL be the sha256 of its bytes after every marker body has been emptied, so marker bodies never register as drift.

#### Scenario: Marker body change is not drift
- **WHEN** two files differ only inside a marker body
- **THEN** their lock hashes are equal (test tools/tests/lib/markers-hash.test.mjs)

### Requirement: MB-LAY-005 Zero-dependency tooling
The `mb` tool SHALL run on Node 20 or later using only `node:` built-in modules, with no npm dependencies and no network installs.

#### Scenario: CLI runs from a fresh clone
- **WHEN** `./mb --help` runs in a fresh clone without `npm install`
- **THEN** it lists the discovered commands and exits 0 (test tools/tests/lib/mb.test.mjs)
