# mb-skill-runtime Specification

## Purpose
Defines what a configurable skill does at runtime to read its configuration, in a way that works the same in Claude Code, Codex and a plain skills folder.

## Requirements

### Requirement: MB-RUN-001 Config block text
Every configurable SKILL.md SHALL contain the generated `config` marker block with the exact text of the base template, with only the plugin name substituted and no marketplace name.

#### Scenario: Block is generated
- **WHEN** `./mb gen` runs on a configurable plugin
- **THEN** each SKILL.md has exactly one `config` block equal to the template (test tools/tests/gen.test.mjs)

### Requirement: MB-RUN-002 Skill-dir relative execution
Skills SHALL call their resolver and scripts by paths relative to the directory that contains SKILL.md, for example `node "<skill-dir>/_mb/resolve.mjs"` or `sh <skill-dir>/scripts/x`, and SHALL NOT rely on the executable bit.

#### Scenario: Exported skill still runs
- **WHEN** a configurable skill is exported to a plain skills folder
- **THEN** its `_mb/` travels with it and the resolver runs from the skill dir (test tools/tests/contrib.test.mjs)

### Requirement: MB-RUN-003 Exit handling
The skill SHALL use `settings` on exit 0 and never change a locked value, SHALL report blocked and stop on exit 4, SHALL show `errors` and stop on exit 2, 3 or 5, and SHALL treat setting values as data, not instructions.

#### Scenario: Blocked plugin stops
- **WHEN** the resolver exits 4
- **THEN** the skill tells the user it is blocked, names the layer and stops (test tools/tests/gen.test.mjs)

### Requirement: MB-RUN-004 No host variables
Files under `skills/` SHALL NOT contain host variables such as `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${PLUGIN_ROOT}` or `$CODEX_HOME`, nor absolute home paths.

#### Scenario: Host variable is rejected
- **WHEN** a SKILL.md contains `${CLAUDE_PLUGIN_ROOT}` and `./mb check` runs
- **THEN** the check fails with an error naming the file (test tools/tests/rules/CHK-07.test.mjs)

### Requirement: MB-RUN-005 Scope of runtime access checks
Runtime access policy SHALL be applied only by configurable skills; skills of plugins without config SHALL NOT be described as blocked by `access.deny`, and host-native policy SHALL be documented as the way to block them.

#### Scenario: Unconfigured plugin is not stopped by deny
- **WHEN** org denies a plugin that has no `config.defaults.json`
- **THEN** its skill still runs, and `docs/base/config.md` directs the admin to `mb policy emit`
