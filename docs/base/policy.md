# Policy

How to turn org and team policy into settings the hosts enforce. Requirements: [openspec/specs/mb-policy](../../openspec/specs/mb-policy/spec.md).

**Honesty statement.**

> Config-file `enforced` values are advisory on a user's machine. Real enforcement is CI, repo rules, or host-native policy. Policy is vendored into each plugin, so a policy change reaches a user only when that user updates the plugin.

## Where policy lives

- `policy/org.json`: the org layer. See [config.md](config.md) for the file shape and [examples/policy/org.example.json](examples/policy/org.example.json) for a sample (it locks `code-review`'s `checks.security` and denies `legacy-*`).
- `policy/teams/<team>.json`: one file per team, with **the same shape as the org file** (`settings`, `plugins`, `enforced`, `access`). Team names are kebab-case.

A team file, `policy/teams/payments.json`:

```json
{
  "plugins": { "code-review": { "settings": { "maxItems": 8 } } },
  "enforced": { "plugins": { "code-review": { "settings": { "checks": { "tests": true } } } } },
  "access": { "deny": ["meeting-notes"] }
}
```

**Selecting a team.** A team applies only where a project or user names it with the `team` key:

- for everyone working in a repo: `"team": "payments"` in that repo's `.<mkt>/config.json` (the project file, committed);
- for one person: the same key in their user file (path in [config.md](config.md#layers)). The project file wins if both set it.

`team` is ignored (warning `KEY_IGNORED`) in org and team files and in `config.local.json`. A named team without a file stops configurable skills with exit 3 (`TEAM_UNKNOWN`).

**Preview before you ship.** See the merged result, with the layer and lock of every value, as a user in a given repo would get it:

```sh
./mb config resolve code-review --cwd path/to/a/project          # project file selects the team
XDG_CONFIG_HOME=/tmp/u ./mb config resolve code-review           # try a user file in /tmp/u/<mkt>/config.json
```

A blocked plugin shows `blocked: true` (exit 4). `blocked: true` overrides `ok`; see [config.md](config.md#resolver-output).

**What `deny` stops at runtime.** `access.deny`, `access.allow` and enforced `enabled: false` are applied at runtime only by **configurable** skills (they run the resolver). A skill of a plugin without `config.defaults.json` keeps working when denied. To block those, use the host policy below or remove them from the marketplace. See [config.md](config.md#scope-of-access-checks).

`./mb check` validates every policy file (CHK-12), including enforced values against the target plugin's schema and team values that conflict with org values. It also prints an info line for each plugin of this marketplace that an org `access.deny` entry matches, so an accidental block is visible. After a policy change, run `./mb gen`: it re-vendors the policy into every configurable plugin and changes their `+mb.<hash>` version suffix, so users receive it on their next plugin update.

## Emitting host policy

```sh
./mb policy emit --host claude [--team <t>] [--out dir]
./mb policy emit --host codex  [--team <t>] [--out dir]
```

Output goes to `dist/policy/<host>/<org|team-t>/` with a `SHA256SUMS` file. `marketplace.config.json` must have `distribution` set.

Without `--team`, only `policy/org.json` is used. With `--team <t>`, that team's file is applied on top of org (org still wins a conflict), and the output goes to `team-<t>/`. What that changes:

- Claude: the team's `access` and enforced `enabled` values change `enabledPlugins`. If the team file sets neither, the drop-in is identical to the org one.
- Codex: `requirements.toml` does not change (it holds only the marketplace-source restriction).
- Both: `README.txt` also lists the team's blocks and its enforced settings as advisory.

Emit one set per team and deliver each to that team's machines.

**Claude Code** gets a managed-settings drop-in, `managed-settings.d/50-<mkt>.json`:

```json
{ "extraKnownMarketplaces": { "<mkt>": { "source": { "source": "github", "repo": "<owner>/<repo>" } } },
  "strictKnownMarketplaces": [ { "source": "github", "repo": "<owner>/<repo>" }, { "source": "skills-dir" } ],
  "enabledPlugins": { "<p>@<mkt>": true, "<q>@<mkt>": false } }
```

- `enabledPlugins` is `true` where org or team enforces `enabled: true`, and `false` where a `deny` matches, an `allow` excludes the plugin (patterns are expanded against the current catalog), or enforced `enabled` is `false`.
- `strictKnownMarketplaces` (only this marketplace may be used) is emitted only when `policyEmit.marketplaceOnly` is `true` or `"strict"`. It keeps the user's own skills folder (`skills-dir`) allowed, except under `"strict"`.
- `enforced.settings` are not emitted (the host does not know them); `README.txt` lists them as advisory.

**Codex** gets `requirements.toml` with the marketplace-source restriction only, and **only when `policyEmit.marketplaceOnly` is `true` or `"strict"`**. Otherwise the Codex output is `README.txt` alone. The `requirements.toml` shape is not yet verified against a live Codex, so the file starts with an `UNVERIFIED` header:

```toml
[marketplaces]
restrict_to_allowed_sources = true
[marketplaces.allowed_sources.<mkt>]
source = "git"
url = "https://github.com/<owner>/<repo>.git"
```

Per-plugin enable or block and `enforced.settings` are written to `README.txt` as "advisory on Codex (no verified host control)".

## What is actually guaranteed

Every emit prints this table. `[D]` = from host docs, not yet run; `[U]` = unverified.

| Policy | Claude managed | Codex | No host artifact |
|---|---|---|---|
| only this marketplace | enforced `[D]` | enforced `[U]` | advisory |
| plugin enabled when installed | enforced `[D]` | advisory | advisory |
| plugin blocked | enforced `[D]` | advisory | advisory (configurable skills: exit 4) |
| enforced setting | advisory | advisory | advisory |

Policy is vendored into each plugin; a policy change reaches a user only when that user updates the plugin.

## Delivering the files

| Host | Where the file goes |
|---|---|
| Claude Code | the `managed-settings.d/` directory next to the system `managed-settings.json`: macOS `/Library/Application Support/ClaudeCode/`, Linux and WSL `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`. Or deliver the same keys through server-managed settings or MDM |
| Codex | `/etc/codex/requirements.toml` (macOS and Linux), `%ProgramData%\OpenAI\Codex\requirements.toml` (Windows), or MDM (macOS domain `com.openai.codex`, key `requirements_toml_base64`) |

Verify `SHA256SUMS` before you deploy.

**Single-managed-source trap (Claude Code).** By default Claude Code applies only **one** managed source, in the order server-managed, then MDM, then files. If your organisation already pushes managed settings through a server or MDM, a file drop-in is silently ignored. Either deliver the keys through the same channel, or set `"managedSourcesBehavior": "merge"` in the active source so all sources combine. Check which source is active with `/status`.

An unparsable managed-settings file stops Claude Code from starting: always deploy the emitted file unchanged.
