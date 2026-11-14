# mb-config Specification

## Purpose
Defines the layered configuration that configurable skills resolve at runtime: layer files, locations, merge rules, policy, output and writes.

## Requirements

### Requirement: MB-CFG-001 Layer order is data
The merge order SHALL be `config.layers` from `marketplace.config.json`, a subset of skill-defaults, org, team, project, user and project-local in low-to-high order, starting with skill-defaults and without duplicates; reordering SHALL need no code change.

#### Scenario: Reordered layers change the winner
- **WHEN** layers list user before project and both set the same key
- **THEN** the project value wins (vector 011-layers-reorder)

#### Scenario: Invalid layer list fails
- **WHEN** layers are `["org","skill-defaults"]`
- **THEN** the resolver exits 3 with LAYERS_INVALID (vector 049-layers-invalid)

### Requirement: MB-CFG-002 Fixed locations, no walk-up
The resolver SHALL read config only from the fixed paths: project and project-local under `<root>/.<mkt>/`, where root is the git top level or else the cwd, and the user file under XDG_CONFIG_HOME (absolute only), `~/.config` or `%APPDATA%`. It SHALL NOT walk up from the cwd.

#### Scenario: Decoy in a subdirectory is ignored
- **WHEN** a config file exists in `<root>/sub/.acme/` and the cwd is `<root>/sub`
- **THEN** that file is not read (vector 038-walk-up-decoy-ignored)

#### Scenario: Relative XDG is ignored
- **WHEN** XDG_CONFIG_HOME is a relative path
- **THEN** the user file is read from `<home>/.config/<mkt>/` (vector 041-xdg-relative-ignored)

### Requirement: MB-CFG-003 File shape
Every layer file SHALL use one shape with the top-level keys `$schema`, settings, plugins, enforced, access, team and merge; unknown keys at a closed level SHALL be POLICY_INVALID in org or team files and an UNKNOWN_KEY warning in personal files.

#### Scenario: Unknown top key in a personal file
- **WHEN** the user file has an unknown top-level key
- **THEN** the resolver warns UNKNOWN_KEY and exits 0 (vector 048-unknown-top-key)

#### Scenario: Unknown key in a policy file
- **WHEN** the org file has the key `enforce` instead of `enforced`
- **THEN** the resolver exits 3 with POLICY_INVALID (vector 054-unknown-key-policy)

### Requirement: MB-CFG-004 RFC 7386 cascade
Settings SHALL be merged low to high with RFC 7386 merge-patch: objects merge, arrays and scalars replace, null deletes the key and its provenance; within one layer `plugins.<p>.settings` SHALL apply after `settings`.

#### Scenario: Arrays replace whole
- **WHEN** org sets an array and user sets a shorter one
- **THEN** the user array replaces the org array (vector 004-array-replace)

#### Scenario: Null deletes
- **WHEN** user sets a key to null that org set
- **THEN** the key and its provenance are removed (vector 005-null-deletes)

### Requirement: MB-CFG-005 Enforced only from org and team
`enforced` values SHALL be honoured only in org and team files; they SHALL lock their pointers, and a personal value at an overlapping pointer SHALL be overridden with a LOCKED_OVERRIDE warning.

#### Scenario: Org lock overrides a user value
- **WHEN** org enforces a value and user sets a different one
- **THEN** the org value is used, the pointer is locked and LOCKED_OVERRIDE is warned (vector 013-enforced-lock-org)

#### Scenario: Enforced in a user file is ignored
- **WHEN** the user file contains `enforced`
- **THEN** it is dropped with ENFORCED_IGNORED and nothing is locked (vector 017-enforced-in-user-ignored)

### Requirement: MB-CFG-006 Org beats team
When org and team enforce different values at overlapping pointers, the org value SHALL win and the resolver SHALL warn ENFORCED_CONFLICT.

#### Scenario: Same pointer, different values
- **WHEN** team and org lock the same pointer with different values
- **THEN** the org value is used and ENFORCED_CONFLICT is warned (vector 015-org-beats-team)

### Requirement: MB-CFG-007 Allow intersection
Every layer that declares `access.allow` SHALL have a pattern matching the plugin, or the plugin SHALL be blocked with BLOCKED_NOT_ALLOWED and exit 4.

#### Scenario: Team narrows the org allow list
- **WHEN** org allows `[p,q]` and team allows `[q]`
- **THEN** plugin p is blocked with exit 4 (vector 023-allow-intersection-blocks)

### Requirement: MB-CFG-008 Deny union
A plugin matched by `access.deny` in any layer SHALL be blocked with BLOCKED_DENY and exit 4, even when another layer allows it.

#### Scenario: Team deny beats org allow
- **WHEN** org allows all plugins and team denies p
- **THEN** plugin p is blocked with exit 4 (vector 021-deny-union-team)

### Requirement: MB-CFG-009 Fail closed for policy
An org or team file that is unparsable, badly shaped, has a bad `access` or holds null under `enforced` SHALL stop resolution with exit 3; a bad `access` in a parseable personal file SHALL also exit 3.

#### Scenario: Truncated org file
- **WHEN** the org file is truncated JSON
- **THEN** the resolver exits 3 with POLICY_INVALID (vector 033-unparsable-org)

#### Scenario: Malformed user deny list
- **WHEN** a parseable user file has `access.deny` as a string
- **THEN** the resolver exits 3 with ACCESS_INVALID (vector 032-malformed-deny-user)

### Requirement: MB-CFG-010 Skip invalid personal file
A project, user or project-local file with a lexical or shape error outside `access` SHALL be skipped with a FILE_SKIPPED warning while the other layers still apply.

#### Scenario: Unparsable user file
- **WHEN** the user file cannot be parsed
- **THEN** it is skipped with FILE_SKIPPED and the resolver exits 0 (vector 036-unparsable-user-skipped)

#### Scenario: Float in a project file
- **WHEN** the project file holds `1.5`
- **THEN** it is skipped with FILE_SKIPPED (vector 037-float-in-project)

### Requirement: MB-CFG-011 Forbidden keys
The keys `__proto__`, `constructor` and `prototype` SHALL be rejected at any depth: a policy file holding one SHALL fail with POLICY_INVALID, and a personal file holding one SHALL be skipped without polluting the result.

#### Scenario: Proto key in org
- **WHEN** the org file contains `__proto__`
- **THEN** the resolver exits 3 with POLICY_INVALID (vector 028-proto-key-org)

#### Scenario: Proto key in user
- **WHEN** the user file contains `__proto__`
- **THEN** the file is skipped with FILE_SKIPPED and exit is 0 (vector 029-proto-key-user)

### Requirement: MB-CFG-012 Team selection
The team SHALL be taken from the project file, else the user file, SHALL match `^[a-z0-9]+(-[a-z0-9]+)*$` or be ignored with KEY_IGNORED, and a named team without a policy file SHALL fail with TEAM_UNKNOWN and exit 3.

#### Scenario: Path traversal in the team name
- **WHEN** the project sets `team` to `../../r/.acme/x`
- **THEN** it is ignored with KEY_IGNORED and no team file is read (vector 053-team-path-traversal)

#### Scenario: Unknown team
- **WHEN** a team is named but has no policy file
- **THEN** the resolver exits 3 with TEAM_UNKNOWN (vector 044-team-unknown)

### Requirement: MB-CFG-013 Canonical output
The resolver SHALL print exactly one compact canonical JSON object with the keys blocked, errors, locked, ok, plugin, provenance, settings, tier and warnings, followed by a newline.

#### Scenario: Control characters are escaped canonically
- **WHEN** settings contain non-ASCII text and control characters
- **THEN** output keeps non-ASCII raw and escapes controls in lowercase (vector 046-canonical-unicode-controls)

### Requirement: MB-CFG-014 Exit codes
The resolver SHALL exit 0 when resolved, 2 on usage errors, 3 on config or policy errors, 4 when blocked and 5 when the spec version is unsupported.

#### Scenario: Unsupported spec version
- **WHEN** the kit has specVersion 2
- **THEN** the resolver exits 5 with SPEC_UNSUPPORTED (vector 050-spec-unsupported)

### Requirement: MB-CFG-015 Secrets as references
Secret values SHALL appear only as `${env:NAME}` references, which the resolver SHALL pass through unexpanded, and `mb check` SHALL fail when a secret-named key holds a literal.

#### Scenario: Env reference passes through
- **WHEN** a setting holds `${env:TOKEN}`
- **THEN** the output holds the same string unchanged (vector 045-env-ref-passthrough)

### Requirement: MB-CFG-016 Config writes
`resolve.mjs set` and `unset` SHALL write only the user, project or project-local layer, atomically, preserving unknown keys, and SHALL refuse with exit 3 LOCKED when the target overlaps a locked pointer or WRITE_DENIED when the file cannot be written.

#### Scenario: Locked target is refused
- **WHEN** `set` targets a pointer that org enforces
- **THEN** it exits 3 with LOCKED and writes nothing (test tools/tests/resolve-real.test.mjs)
