# mb-validation Specification

## Purpose
Defines how `mb check` validates a marketplace repo, so that every rule is enforced the same way locally, in hooks and in CI.

## Requirements

### Requirement: MB-VAL-001 Check rules
`mb check` SHALL enforce every rule listed in the generated `docs/base/rules.md`, each implemented as one module under `tools/lib/rules/`, and SHALL exit 1 when any error-severity rule fails, printing a fix hint for each result.

#### Scenario: A failing rule fails the check
- **WHEN** a plugin breaks an error-severity rule and `./mb check` runs
- **THEN** it exits 1 and prints the rule id, the path and the fix hint (test tools/tests/rules/check.test.mjs)
