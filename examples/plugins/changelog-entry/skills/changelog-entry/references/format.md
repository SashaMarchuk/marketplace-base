# Keep a Changelog format (summary)

Source: Keep a Changelog 1.1.0 (https://keepachangelog.com/en/1.1.0/), MIT-licensed. This is a short summary for writing entries.

## Principles

- A changelog is for humans. Write what changed for users, not a dump of commit messages.
- There is one section per released version, newest first, plus an `Unreleased` section at the top.
- Each version has a release date in ISO 8601 format: `YYYY-MM-DD`.
- Changes are grouped by category. Only the categories below are used, in this order:
  `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Leave out empty categories.

## Categories

- **Added**: new features.
- **Changed**: changes in existing functionality.
- **Deprecated**: features that still work but will be removed in an upcoming release.
- **Removed**: features removed in this release.
- **Fixed**: bug fixes.
- **Security**: fixes for vulnerabilities. Use this rather than `Fixed` when the fix closes a vulnerability.

Edge cases:
- A behaviour change that breaks users goes under `Changed` (or `Removed`) and is marked, for example with a leading `**Breaking:**`.
- A pure refactor, test or CI change usually has no entry. Add one only if users notice it.
- A dependency upgrade gets an entry only when users are affected (new minimum version, security fix, behaviour change).

## Layout

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Export reports as CSV.

### Fixed
- Sorting by date no longer ignores the time of day.

## [1.2.0] - 2026-01-15

### Changed
- The settings page loads saved filters by default.

[Unreleased]: https://example.com/acme/project/compare/v1.2.0...HEAD
[1.2.0]: https://example.com/acme/project/compare/v1.1.0...v1.2.0
```

## Releasing (for context only)

When a version is released, the `Unreleased` entries move under a new `## [x.y.z] - YYYY-MM-DD` heading, and the compare links at the bottom are updated. Writing one entry never needs this step.
