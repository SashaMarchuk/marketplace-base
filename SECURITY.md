# Security

## Reporting a vulnerability

Report privately through GitHub: **Security > Report a vulnerability** on this repository (GitHub private vulnerability reporting). Do not open a public issue. Include the affected file or command, steps to reproduce, and the impact. We aim to reply within 7 days.

## What to know about the trust model

**Honesty statement.**

> Config-file `enforced` values are advisory on a user's machine. Real enforcement is CI, repo rules, or host-native policy. Policy is vendored into each plugin, so a policy change reaches a user only when that user updates the plugin.

**Project config is repo content.** `.<marketplace>/config.json` and `config.local.json` are trusted like the repo's own README or AGENTS.md. Anyone who can commit to a repo can change the settings a skill sees there. Skills treat setting values as data, never as instructions.

**The resolver.** `_mb/resolve.mjs` uses only Node.js built-ins, reads only a fixed list of paths (never walks up from the working directory), runs no subprocess except `git rev-parse --show-toplevel`, and has no network access. It writes only on an explicit `set` or `unset`: the target layer file and, for the project-local layer, `.<marketplace>/.gitignore`. It rejects `__proto__`, `constructor` and `prototype` keys, duplicate keys and malformed numbers. Invalid org or team policy stops the skill (fail closed); an invalid personal file is skipped with a warning.

**Generated mergers (fallback tiers).** When no JavaScript runtime exists, the agent may generate a small merger program from `_mb/MERGE-SPEC.md`. It is used only after it passes every conformance vector, run by a loop outside the program. It is saved only in your user data directory (`~/.local/share/<marketplace>/mergers/` or `%LOCALAPPDATA%`), with a sha256 file checked before each reuse. The hash detects accidental edits; it is not a security boundary against someone who can write to your home directory. An org can forbid generated mergers with `enforced.settings.merge.allowGenerated: false`, and a user with `"merge": {"allowGenerated": false}`.

**Secrets.** Config never holds secret literals: use `${env:NAME}`. `mb check` fails on secret-named keys with literal values and runs a leak scan (secret patterns, plus an optional private denylist that is never committed). A pre-push hook runs the same scan when branch rules are unavailable.

**CI.** Pull-request workflows run with read-only permissions and no secrets, and never use `pull_request_target`. Evals run only on manual dispatch or a nightly schedule, never on pull requests.

## Supported versions

Only the latest release of marketplace-base receives fixes. Derived marketplaces get them with `./mb base-update`.
