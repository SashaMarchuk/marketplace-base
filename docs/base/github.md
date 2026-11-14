# GitHub setup (free and paid plans)

Requirements: [openspec/specs/mb-github](../../openspec/specs/mb-github/spec.md).

## What each plan allows

| Feature | Public repo (any plan) | Private repo, GitHub Free | Private repo, Pro / Team / Enterprise |
|---|---|---|---|
| Actions (`mb-check`, evals, release) | yes, free minutes | yes, limited minutes | yes, more minutes |
| Rulesets / branch protection (block merge on red checks) | yes | **no** | yes |
| Required code-owner review | yes | no | yes |

`mb` never detects your plan (the API does not report it for normal tokens). It tries each step and degrades when GitHub refuses.

## `./mb github setup`

```sh
./mb github setup [--dry-run] [--require-codeowners]
```

1. Reads the repo: private or public, user or organisation owner, default branch.
2. Tries to create a **ruleset**: require a PR, require the `mb-check` status, block force-push and deletion of the default branch, and protect `v*` tags.
3. If that is refused (HTTP 403, 404 or 422), tries **classic branch protection** with the same rules.
4. If that is refused too (for example a private repo on GitHub Free), it prints "branch rules are not available for this repo: checks will report but not block" and installs the **git hooks** (`git config core.hooksPath tools/hooks`). The `pre-push` hook runs `./mb check --fast`, `./mb gen --check` and the leak scan before every push. Each contributor runs setup (or that `git config` line) once per clone.
5. **CODEOWNERS.** For a user-owned repo it enables `* @<owner>` and `/policy/org.json @<owner>`. For an organisation it leaves the lines commented and asks you to add `@<org>/<team>` lines. Code-owner review is required only with `--require-codeowners` (useful with 2 or more maintainers).

`--dry-run` makes only the read-only repository GET and prints every other call it would make. Needs the `gh` CLI, logged in.

## Workflows

| Workflow | Runs on | Does |
|---|---|---|
| `mb-check.yml` | pull requests, pushes to the default branch | `./mb check`, `./mb test`, OpenSpec validation; base only: derive proof. Read-only, no secrets. Its aggregate job `mb-check` is the one required status |
| `mb-evals.yml` | manual dispatch, nightly | live evals; never on `pull_request`. To evaluate a PR, run it on the PR branch with `changed-only` |
| `mb-release.yml` | `v*` tags | check, `policy emit` for both hosts (skipped with a notice when `marketplace.config.json` has no `distribution`), release with artifacts and `SHA256SUMS` |
| `mb-base-update.yml` | weekly, when variable `MB_BASE_UPDATE` is `true` | pulls the latest base release into a branch ([derive-update.md](derive-update.md#scheduled-updates)) |

Add your own workflows under any other name (not `mb-*.yml`).

## Secrets and variables

| Name | Kind | Needed for |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Claude evals (skipped without it) |
| `OPENAI_API_KEY` | secret | Codex evals (skipped without it) |
| `MB_UPDATE_TOKEN` | secret, optional | scheduled base update opens the PR itself and updates workflow files |
| `MB_LEAK_DENYLIST` | secret, optional | private leak-scan patterns, one regex per line (used by `mb-release` and `mb-evals`, never on PRs) |
| `MB_BASE_UPDATE` | variable | `true` enables the scheduled base update |

## Saving Actions minutes

- Private repos default to an ubuntu-only matrix (`ci.osMatrix` in `marketplace.config.json`).
- Evals never run on PRs; run `mb-evals` by hand with `changed-only` when a PR needs them.
- A newer push to the same PR cancels the running check.

## Release checklist

1. `./mb gen --check && ./mb check && ./mb test` are green on the release commit.
2. Base only: set `.mb/base-version.json` to the new tag in the release commit (the release workflow fails if they differ), and add the release to [CHANGELOG.md](CHANGELOG.md) with any "Migration" notes.
3. Attach both-host eval results for the tagged commit (`./mb eval --host all`). Required for base releases; a derived marketplace without eval keys may write "evals not run" in its release notes.
4. Tag `vX.Y.Z` and push the tag.
