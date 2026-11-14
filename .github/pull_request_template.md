## What and why

<!-- One or two sentences. Link the OpenSpec change (openspec/changes/<id>/) if behaviour changes. -->

## Checklist

- [ ] `./mb gen && ./mb check` pass locally (CI reports one status: `mb-check`).
- [ ] Every changed plugin is bumped (`./mb bump <p>`), unless only `evals/` or `README.md` changed.
- [ ] Behaviour changes start as an OpenSpec change; requirements in `openspec/specs/` are updated.
- [ ] No secrets, tokens, personal names or internal URLs (secret config values use `${env:NAME}`).
- [ ] Skills stay portable: no host variables or absolute home paths under `skills/`.

## Release checklist (release PRs only)

- [ ] Base releases: `.mb/base-version.json` is set to the new tag in this release commit (mb-release fails otherwise).
- [ ] Both-host eval results for the tagged commit are attached (required for base releases), or a derived repo without eval keys writes "evals not run" in the release notes.
- [ ] `docs/base/CHANGELOG.md` updated, with a "Migration" note for any reclassified path or new required key.
