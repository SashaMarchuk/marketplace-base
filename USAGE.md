# Using the skills

This page is for people who **use** the skills. To add skills, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Install

Add the marketplace once, then install the plugins you want (replace `<p>` with a plugin name from the catalog in [README.md](README.md)).

| Host | Add the marketplace | Install a plugin |
|---|---|---|
| Claude Code | `claude plugin marketplace add SashaMarchuk/marketplace-base` | `claude plugin install <p>@marketplace-base` |
| Codex | `codex plugin marketplace add SashaMarchuk/marketplace-base` | `codex plugin add <p>@marketplace-base` |
| Plain skills folder | clone the repo | `./mb export skills ~/.agents/skills` (Codex) or `~/.claude/skills` (Claude Code) |

## Use a skill

Just ask. A skill fires when your request matches its description, for example "draft a changelog entry for this fix". You can also call it by name:

- Claude Code: `/<p>:<s>`, for example `/commit-message:commit-message`
- Codex: `$<s>`, for example `$commit-message`

## Update

| Host | Command |
|---|---|
| Claude Code | `claude plugin marketplace update marketplace-base`, then `claude plugin update <p>@marketplace-base` |
| Codex | `codex plugin marketplace upgrade` (Git marketplaces), then `codex plugin add <p>@marketplace-base` again (not yet verified; see [docs/base/hosts.md](docs/base/hosts.md)) |
| Plain folder | `git pull`, then `./mb export skills <dir> --force` |

Org and team policy is shipped inside each plugin, so you receive a policy change only when you update the plugin.

## Configure

Some skills are **configurable** (marked in the catalog). They read settings from small JSON files, merged from low to high priority:

1. skill defaults (shipped with the plugin)
2. org policy and 3. team policy (shipped with the plugin; can lock values)
4. project: `.marketplace-base/config.json` in your repo (commit it to share with your team)
5. user: your personal file (path below)
6. project-local: `.marketplace-base/config.local.json` in your repo (gitignored, just for you)

Example user file, setting the meeting-notes sections and a shared language:

```json
{
  "settings": { "language": "en" },
  "plugins": { "meeting-notes": { "settings": { "sections": ["Context", "Decisions", "Next steps"] } } }
}
```

Exact file locations on each OS:

<!-- mb:config-locations:begin -->
| Layer | macOS / Linux | Windows |
|---|---|---|
| skill-defaults | `<skill-dir>/_mb/kit.json` (`defaults`) | `<skill-dir>\_mb\kit.json` (`defaults`) |
| org | `<skill-dir>/_mb/policy/org.json` (from `policy/org.json`) | `<skill-dir>\_mb\policy\org.json` |
| team | `<skill-dir>/_mb/policy/teams/<team>.json` | `<skill-dir>\_mb\policy\teams\<team>.json` |
| project | `<repo>/.marketplace-base/config.json` | `<repo>\.marketplace-base\config.json` |
| user | `$XDG_CONFIG_HOME/marketplace-base/config.json` if `XDG_CONFIG_HOME` is absolute, else `~/.config/marketplace-base/config.json` | `%APPDATA%\marketplace-base\config.json` |
| project-local | `<repo>/.marketplace-base/config.local.json` (gitignored) | `<repo>\.marketplace-base\config.local.json` (gitignored) |
<!-- mb:config-locations:end -->

`<repo>` is the top of your git repo (or the current directory outside git). Files in subdirectories are never read.

You can also just tell the skill your preference ("always use German"). It saves it to your user file. If a value is locked by policy, the skill says so and keeps the locked value.

Values like API keys never go in these files as text. Use a reference such as `"${env:MY_TOKEN}"`.

## Permissions

A configurable skill runs one command to read its settings: `node "<skill-dir>/_mb/resolve.mjs"` (Node.js 20 or later, or `bun`). Your host may ask before running it.

| Host | To allow it without a prompt |
|---|---|
| Claude Code | Add `"Bash(node:*)"` to `permissions.allow` in your settings, or pass `--allowedTools "Bash(node:*)"` to `claude -p` (headless runs need this) |
| Codex | Approve the `node …/_mb/resolve.mjs` command when asked. Reading settings works in the `workspace-write` sandbox; saving a preference to your user file needs approval, or use the project-local file |

Without Node.js or bun, the skill follows a slower fallback (it may generate and test a small helper program, once). See [docs/base/config.md](docs/base/config.md#tiers).

## Uninstall

| Host | Command |
|---|---|
| Claude Code | `claude plugin uninstall <p>@marketplace-base`; remove the marketplace with `claude plugin marketplace remove marketplace-base` |
| Codex | `codex plugin remove <p>@marketplace-base`; remove the marketplace with `codex plugin marketplace remove marketplace-base` |
| Plain folder | delete the skill directories you exported |

Your config files are not deleted. Remove them by hand if you want.
