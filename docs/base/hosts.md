# Host facts

What marketplace-base relies on in each host, and how sure we are. Tags:

- **[V]** verified by running it locally (date and version given);
- **[D]** taken from the host's documentation, not run;
- **[U]** unverified; marked in the tool output where it matters.

Re-check these when a host changes. A spike that fails switches to the fallback named in the table; it never silently changes behaviour.

## Claude Code (verified 2026-11-14, Claude Code 2.1.325)

| Fact | Tag |
|---|---|
| `claude -p --plugin-dir <dir>` loads a plugin and fires its skill; `claude plugin validate` accepts a repo with root `.claude-plugin/marketplace.json` and `<plugin>/.claude-plugin/plugin.json` | [V] |
| `claude plugin marketplace add <owner>/<repo>` then `claude plugin install <p>@<mkt>` installs from GitHub | [D] |
| The generated manifest and marketplace shapes, including a `+mb.<hash>` version suffix, pass `claude plugin validate --strict` (it needs a marketplace description); no login needed with an empty `CLAUDE_CONFIG_DIR` | [V] |
| The model sees the skill's absolute directory, so `<skill-dir>/...` paths and `sh <skill-dir>/scripts/x` work without `${CLAUDE_PLUGIN_ROOT}` | [V] |
| Plugins are copied to a per-version cache: only files inside the plugin directory exist at runtime | [V] |
| `claude plugin eval` runs `evals/<case>/prompt.md` + `graders/*.md`; with a no-plugin baseline arm, `tool_used: Skill` is not scored, so `mb` uses `--ablation none` | [V] |
| A changed `+mb.<hash>` suffix alone makes Claude Code fetch the new version | [U] re-checked before each release; fallback: `mb check` then requires a version bump when `_mb/` changes |
| Managed settings drop-ins in `managed-settings.d/` merge after `managed-settings.json`; only one managed source applies unless `managedSourcesBehavior: "merge"` | [D] |
| A headless `claude -p` run needs an allow rule such as `Bash(node:*)` for the resolver call | [D] |

## Codex (verified 2026-11-14, Codex CLI 0.164.0)

| Fact | Tag |
|---|---|
| `codex plugin marketplace add <local dir>` reads root `.agents/plugins/marketplace.json`; `codex plugin add <p>@<mkt>` installs; `codex exec` fires the skill | [V] |
| `codex plugin marketplace add <owner>/<repo>` (a GitHub marketplace) | [D] |
| Plugin manifest keys `name`, `version`, `description`, `author`, `keywords`, `license` are accepted; a `+mb.<hash>` version is cached as its own version directory | [V] |
| `codex plugin marketplace upgrade` refreshes Git marketplaces only; local-directory marketplaces are read live | [V] |
| After an upgrade, `codex plugin add <p>@<mkt>` again installs the new version | [U] |
| The model sees the skill's absolute path; Codex reads SKILL.md with a shell command | [V] |
| `codex exec --json` emits JSONL events (`thread.started`, `turn.started`, `item.started`/`item.completed` with `agent_message` or `command_execution`, `turn.completed`); the first stdout line may be non-JSON | [V] |
| `CODEX_HOME=<temp dir>` isolates installs from the real `~/.codex` | [V] |
| In `-s workspace-write`, reading `~/.config/<mkt>/` works; writing `~/.config` or `~/.local/share` is denied; writing `$TMPDIR` works | [V] |
| User skills folder is `~/.agents/skills` | [D] |
| `requirements.toml` `[marketplaces]` with `restrict_to_allowed_sources` and `allowed_sources` restricts plugin sources | [U] emitted with an UNVERIFIED header |

## GitHub (checked 2026-11-14)

| Fact | Tag |
|---|---|
| The plan field of `gh api user` is null for normal tokens, so `mb` never detects the plan | [V] |
| Rulesets and branch protection are unavailable on private repos under GitHub Free; `mb github setup` degrades on HTTP 403/404/422 | [D] |
| Events created with `GITHUB_TOKEN` do not start `pull_request` workflows | [D] |

## Runtimes

| Fact | Tag |
|---|---|
| `mb` and its test suite run on Node.js 20 and 22 (macOS) | [V] |
| `resolve.mjs` runs unchanged on Node.js 20, 22 and bun | [U] checked in base CI; fallback: bun is dropped from the config block |
| Node.js is not guaranteed next to the Claude Code native binary; macOS ships a `python3` stub that may not run a script | [D] (that is why the fallback tiers exist) |

## Other hosts (adapter pattern, docs only)

Other agents read the same `SKILL.md` folders, so a plain-folder export is the adapter. These paths are from each tool's docs [D] and are not tested by `mb`:

| Tool | Project skills | User skills |
|---|---|---|
| GitHub Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.copilot/skills/`, `~/.agents/skills/` |
| Cursor | `.agents/skills/`, `.cursor/skills/` | `~/.agents/skills/`, `~/.cursor/skills/` |
| Gemini CLI | `.gemini/skills/`, `.agents/skills/` | `~/.gemini/skills/`, `~/.agents/skills/` |

To support one: `./mb export skills <that folder>`. Configurable skills work anywhere the agent can run `node` (or follow `FALLBACK.md`). Plugin and marketplace formats of these tools differ and are not generated in v1; a derived marketplace can add its own generator and workflow without touching base files.
