# mb-contrib Specification

## Purpose
Defines the contributor commands that create, version, adopt, export and smoke-test plugins and skills.

## Requirements

### Requirement: MB-CON-001 Scaffold plugin
`mb new plugin <p>` SHALL create `plugins/<p>/plugin.src.json` with version 0.1.0 and an empty `skills/` directory.

#### Scenario: New plugin
- **WHEN** `./mb new plugin demo` runs
- **THEN** `plugins/demo/plugin.src.json` exists with version 0.1.0 (test tools/tests/contrib.test.mjs)

### Requirement: MB-CON-002 Scaffold skill with evals
`mb new skill <p>/<s> "<description>"` SHALL create the plugin if missing, a SKILL.md with a TODO body and the eval cases `<s>-trigger` and `<s>-no-trigger`; with `--config` it SHALL also create the plugin-level `config.defaults.json` and a `config-respected` case.

#### Scenario: New skill passes check with one warning
- **WHEN** `./mb new skill demo/hello "Say hello. Use when greeted."` runs
- **THEN** `./mb check demo` reports 0 errors and 1 TODO warning (test tools/tests/contrib.test.mjs)

### Requirement: MB-CON-003 Bump
`mb bump <p>` SHALL raise the plugin's source version by patch, minor or major, `--changed` SHALL select plugins failing the version-bump rule, and example plugins SHALL be refused until adopted.

#### Scenario: Example plugin cannot be bumped
- **WHEN** `./mb bump` targets a plugin under `examples/plugins/`
- **THEN** it is refused with a hint to adopt it first (test tools/tests/contrib.test.mjs)

### Requirement: MB-CON-004 Adopt
`mb adopt <p>` SHALL move an example plugin to `plugins/<p>`, remove its lock entries, add it to the lock's `adopted` list without changing `includeExamples`, and run `gen`.

#### Scenario: Adopted example becomes derived-owned
- **WHEN** `./mb adopt code-review` runs in a derived repo
- **THEN** the plugin is under `plugins/`, listed in `adopted`, and `./mb check` stays green (test tools/tests/contrib.test.mjs)

### Requirement: MB-CON-005 Export skills
`mb export skills <dir>` SHALL copy each skill directory, including `_mb/`, flat into `<dir>` and SHALL refuse to overwrite a different existing directory unless `--force` is given.

#### Scenario: Flat export
- **WHEN** `./mb export skills out` runs
- **THEN** `out/<s>/SKILL.md` and `out/<s>/_mb/` exist for configurable skills (test tools/tests/contrib.test.mjs)

### Requirement: MB-CON-006 Try
`mb try <p> --host claude|codex` SHALL run a live smoke prompt against the plugin, using `claude -p --plugin-dir` for Claude and an isolated install plus `codex exec` for Codex, without touching the user's real host config.

#### Scenario: Codex try is isolated
- **WHEN** `./mb try demo --host codex` runs
- **THEN** it uses a temporary CODEX_HOME and leaves the real one unchanged (test tools/tests/contrib.test.mjs)
