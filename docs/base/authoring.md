# Authoring plugins and skills

A **skill** is a folder with a `SKILL.md` ([Agent Skills](https://agentskills.io/specification) format). A **plugin** packages one or more skills for Claude Code and Codex. Skills are the product; plugins are packaging.

## Plugin anatomy

```
plugins/<p>/
  plugin.src.json            # hand-edited: the only manifest source
  config.defaults.json       # optional: makes every skill of the plugin configurable
  config.schema.json         # optional: schema for the settings (used by `set` and `mb check`)
  README.md                  # optional
  skills/<s>/
    SKILL.md                 # frontmatter + instructions
    references/  scripts/  assets/   # optional, loaded on demand
    _mb/                     # GENERATED (configurable skills only): resolver kit
  evals/<case>/              # eval cases (see evals.md)
  .claude-plugin/plugin.json # GENERATED
  .codex-plugin/plugin.json  # GENERATED
```

`plugin.src.json`:

```json
{
  "$schema": "../../tools/schemas/plugin-src.schema.json",
  "name": "release-notes",
  "version": "0.1.0",
  "description": "Draft release notes from merged changes.",
  "keywords": ["release", "notes"],
  "category": "Productivity",
  "license": "MIT"
}
```

Required: `name` (equals the folder name, kebab-case, ≤ 64), `version` (SemVer), `description` (ends with a period). Optional: `author` (defaults to the marketplace owner), `keywords` (≤ 10), `category`, `license`, `homepage`, `repository`, `codex.policy`.

`./mb gen` writes both host manifests and both marketplace files from it. A configurable plugin's generated version gets a `+mb.<hash>` suffix that changes when its vendored kit or policy changes, so hosts see a new version without a manual bump.

## SKILL.md

```markdown
---
name: draft
description: Draft release notes from merged changes. Use when preparing a release or asked for release notes.
---

# Draft release notes

1. ...
```

- Frontmatter keys allowed: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Host-specific keys go elsewhere.
- `name` equals the folder name; skill names are unique across the whole marketplace (a flat export needs that).
- `description` (1-1024 characters) says what the skill does **and when to use it**. Hosts decide when to fire the skill from it alone.
- Keep the body under 500 lines. Put long material in `references/` and link to it with a relative path.

## Portability rules

These keep a skill working in Claude Code, Codex and a plain skills folder (`mb check` enforces them):

- **Refer to files relative to the skill folder.** Write `<skill-dir>/references/format.md`, meaning "the directory that contains this SKILL.md". Both hosts give the model the skill's absolute path.
- **No host variables** such as `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${PLUGIN_ROOT}` or `$CODEX_HOME`, and no absolute home paths.
- **Run scripts with an interpreter:** `sh <skill-dir>/scripts/x.sh` or `node <skill-dir>/scripts/x.mjs`. Do not rely on the executable bit.
- **Stay inside the plugin.** Hosts copy each plugin into a cache; a plain-folder install copies only the skill folder. No symlinks, no `../` paths out of the plugin.
- **LF line endings** for every text file.
- **Skills only for portability.** `commands/`, `agents/`, `hooks/`, MCP config and `bin/` behave differently per host. `mb check` warns about them (and rejects them in examples).

## Configurable skills

Add `config.defaults.json` to the plugin and read [config.md](config.md). `./mb gen` then vendors `_mb/` into each skill and inserts a generated "Configuration" block into each SKILL.md. Write the rest of the skill assuming the settings are known, for example "use the `sections` setting as the headings".

## Versioning

Bump `version` in `plugin.src.json` (`./mb bump <p> [patch|minor|major]`) whenever you change a plugin's hand-edited files other than `evals/` and `README.md`. `mb check` (CHK-15) fails otherwise.

## Commands you will use

| Command | Does |
|---|---|
| `./mb new plugin <p>` | create an empty plugin |
| `./mb new skill <p>/<s> "<description>" [--config]` | create a skill with two eval cases |
| `./mb gen` | regenerate manifests, marketplaces, kit and docs |
| `./mb check [<p>...]` | validate everything (rules: [rules.md](rules.md)) |
| `./mb try <p> --host claude\|codex [prompt]` | live smoke test |
| `./mb eval [<p>...] --host claude\|codex\|all` | run eval cases |
| `./mb bump <p>` | raise the version |
| `./mb export skills <dir>` | copy skills flat into a skills folder |
