# Changelog

All notable changes to marketplace-base. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

A release that renames, moves or reclassifies a path you own, or changes an S file schema, has a **Migration** note here and, if needed, a script in `.mb/migrations/<x.y.z>.mjs` that `./mb base-update` runs for you.

## [Unreleased]

## [0.1.0]

### Added

- `mb` CLI (Node.js 20+, zero dependencies): `init`, `new`, `gen`, `check`, `test`, `try`, `eval`, `bump`, `adopt`, `export`, `base-update`, `config resolve`, `policy emit`, `github setup`.
- One plugin tree that installs in Claude Code and Codex, generated from `plugin.src.json`; plain skills-folder export.
- Layered configuration (skill defaults, org, team, project, user, project-local) with a reference resolver, 57 conformance vectors, and a verified fallback for machines without a JavaScript runtime.
- Host policy emission for Claude Code managed settings and Codex `requirements.toml` (unverified shape).
- Native eval cases run on both hosts.
- GitHub workflows for checks, evals, releases and scheduled base updates; try-and-degrade branch protection setup for free and paid plans.
- Four example plugins: `commit-message`, `changelog-entry`, `meeting-notes`, `code-review`.
- OpenSpec requirements for every base capability in `openspec/specs/mb-*/`.

### Migration

None (first release).
