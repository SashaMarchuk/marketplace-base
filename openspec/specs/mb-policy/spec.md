# mb-policy Specification

## Purpose
Defines how org and team policy is turned into host-native policy files, and how honestly each guarantee is reported.

## Requirements

### Requirement: MB-POL-001 Claude drop-in
`mb policy emit --host claude` SHALL write `managed-settings.d/50-<mkt>.json` with `extraKnownMarketplaces`, `enabledPlugins` and, when `policyEmit.marketplaceOnly` is true or "strict", `strictKnownMarketplaces`, plus a `SHA256SUMS` file.

#### Scenario: Org and team fixture
- **WHEN** policy emit runs for Claude on the org and team fixture
- **THEN** the drop-in equals the golden file and `SHA256SUMS` is correct (test tools/tests/policy.test.mjs)

### Requirement: MB-POL-002 Codex requirements (unverified flag)
`mb policy emit --host codex` SHALL emit only the marketplace-source restriction in `requirements.toml`, with an UNVERIFIED header until the shape is verified against a live Codex release, and SHALL write every other policy to `README.txt` as advisory.

#### Scenario: Codex output is labelled
- **WHEN** policy emit runs for Codex
- **THEN** the output carries the UNVERIFIED header or is README-only (test tools/tests/policy.test.mjs)

### Requirement: MB-POL-003 Guarantee table
Every policy emit SHALL print the guarantee table stating, per policy and host, whether it is enforced or advisory, with unverified cells tagged.

#### Scenario: Table is printed
- **WHEN** policy emit runs
- **THEN** stdout contains the guarantee table (test tools/tests/policy.test.mjs)

### Requirement: MB-POL-004 Catalog expansion of allow
`access.allow` patterns SHALL be expanded against the current catalog, and each plugin denied, not allowed or enforced disabled SHALL be emitted as disabled.

#### Scenario: Allow list disables the rest
- **WHEN** org allows only `code-*` and the catalog has three plugins
- **THEN** plugins not matching are emitted as `false` (test tools/tests/policy.test.mjs)

### Requirement: MB-POL-005 Honesty statement
Docs and emit output SHALL state that config-file `enforced` values are advisory on a user's machine, that real enforcement is CI, repo rules or host-native policy, and that a policy change reaches a user only when that user updates the plugin.

#### Scenario: Statement is printed
- **WHEN** policy emit runs
- **THEN** stdout ends with the sentence that a policy change reaches a user only when that user updates the plugin (test tools/tests/policy.test.mjs)
