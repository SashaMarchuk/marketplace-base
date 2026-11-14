# Configuration

How configurable skills get their settings: layers, file locations, merge rules, policy, writes, and what happens without a JavaScript runtime. Requirements: [openspec/specs/mb-config](../../openspec/specs/mb-config/spec.md) and [mb-merge-tiers](../../openspec/specs/mb-merge-tiers/spec.md).

**Honesty statement.**

> Config-file `enforced` values are advisory on a user's machine. Real enforcement is CI, repo rules, or host-native policy. Policy is vendored into each plugin, so a policy change reaches a user only when that user updates the plugin.

## Making a plugin configurable

Add `config.defaults.json` next to `plugin.src.json` (or run `./mb new skill <p>/<s> "..." --config`). Every skill of that plugin then becomes configurable: `./mb gen` vendors the resolver kit into `skills/<s>/_mb/` and adds a generated "Configuration" block to each SKILL.md. All skills of a plugin share one settings namespace, one set of defaults and one optional `config.schema.json`.

`config.defaults.json` is a **bare settings object**: the keys are the settings themselves, not wrapped in `{"settings": ...}` like a layer file. For example:

```json
{ "checks": { "tests": true, "security": true }, "maxItems": 10 }
```

`./mb new skill ... --config` creates it as `{}`. Fill in a default for every setting the skill reads.

Footprint: the vendored `_mb/` kit is about 180 small files and about 100 KB per configurable skill (most of it is the conformance vectors that the no-runtime fallback needs at run time). Generated, so you never edit it.

## Layers

Settings merge from low to high priority, in the order given by `config.layers` in `marketplace.config.json`:

| Layer | Where it comes from | Who controls it |
|---|---|---|
| `skill-defaults` | `config.defaults.json` of the plugin | plugin author |
| `org` | `policy/org.json` in the marketplace repo, vendored into each plugin | marketplace admins |
| `team` | `policy/teams/<team>.json`, vendored; selected by the `team` key | marketplace admins |
| `project` | `<root>/.<mkt>/config.json` | the project repo (commit it) |
| `user` | `$XDG_CONFIG_HOME/<mkt>/config.json` (absolute only), else `~/.config/<mkt>/config.json`; Windows `%APPDATA%\<mkt>\config.json` | the user |
| `project-local` | `<root>/.<mkt>/config.local.json` (gitignored) | the user, per project |

`<root>` is `git rev-parse --show-toplevel`, or the working directory outside git. Nothing else is read: there is no walk-up, so a config file in a subdirectory is ignored.

The order is data. You may drop layers or reorder them (for example `user` before `project`), but `skill-defaults` must come first and names may not repeat. `./mb check` validates this (CHK-02).

## File shape

Every layer file has the same shape:

```json
{
  "$schema": "../tools/schemas/layer-file.schema.json",
  "settings": { "language": "en" },
  "plugins": { "code-review": { "enabled": true, "settings": { "maxItems": 5 } } },
  "enforced": { "settings": {}, "plugins": { "code-review": { "settings": { "checks": { "security": true } } } } },
  "access": { "allow": ["*"], "deny": ["legacy-*"] },
  "team": "payments",
  "merge": { "allowGenerated": true }
}
```

| Key | Honoured in | Elsewhere |
|---|---|---|
| `settings`, `plugins` | all layers | |
| `enforced` | org, team | ignored with warning `ENFORCED_IGNORED` |
| `access` | all layers | |
| `team` | project, user (must be kebab-case) | ignored with warning `KEY_IGNORED` |
| `merge` | user | ignored with warning `KEY_IGNORED` |

`merge` is also a reserved top-level key inside settings: the org opt-out `enforced.settings.merge.allowGenerated` shows up in every plugin's resolved settings as the locked path `/merge/allowGenerated`. Do not name a plugin setting `merge` (`./mb check` warns, CHK-11).

Strict text rules for every config file: integers only (no `1.5`, `1.0` or `1e3`), keys match `^[A-Za-z0-9_:-]{1,64}$` (so a tool identity such as `mcp:search` works; spaces and `.` do not), no duplicate keys, no `__proto__`/`constructor`/`prototype`, no BOM, valid UTF-8. Secrets never appear as text: write `"${env:NAME}"`, which is passed through unchanged.

## Merge rules

1. **Cascade.** For each layer, low to high: apply `settings`, then `plugins.<p>.settings`, as an RFC 7386 merge patch. Objects merge key by key; arrays and scalars replace whole; `null` deletes a key. `plugins.<p>.enabled` set by the highest layer wins.
2. **Enforced.** `enforced` values from team, then org, overwrite the result and **lock** those paths. A personal value at a locked path is overridden (`LOCKED_OVERRIDE` warning). If team and org lock the same path with different values, org wins (`ENFORCED_CONFLICT`; `./mb check` also reports it in CI).
3. **Access.** `deny` is a union: a match in any layer blocks the plugin. `allow` is an intersection: every layer that declares `allow` must match the plugin. `*` matches any run of characters. A blocked or disabled plugin makes the resolver exit 4.

There is no per-key merge strategy. To get a list that higher layers add to (a union) or an object that a higher layer replaces whole, model it as shown in [migrating.md](migrating.md#config-merge-recipes).

Failure handling:

| Problem | Org or team file | Project, user or project-local file |
|---|---|---|
| Unparsable, bad shape, forbidden key | stop, exit 3 (`POLICY_INVALID`) | skip the file, warning `FILE_SKIPPED` |
| Bad `access` (e.g. `"deny": "p"`) | stop, exit 3 (`ACCESS_INVALID`) | stop, exit 3 (`ACCESS_INVALID`) |
| `null` inside `enforced` | stop, exit 3 (`ENFORCED_INVALID`) | n/a |
| Unknown key at a closed level | stop, exit 3 | warning `UNKNOWN_KEY` |
| Named team has no file | stop, exit 3 (`TEAM_UNKNOWN`) | |
| File exists but cannot be read | stop, exit 3 (`FILE_UNREADABLE` + `POLICY_INVALID`) | treated as absent, warning `FILE_UNREADABLE` |

A missing or broken `_mb/kit.json` is exit 3 `KIT_INVALID`. A bad command line is exit 2 and still prints the JSON line, with `errors: [{"code":"USAGE"}]`.

The exact algorithm is [tools/kit/MERGE-SPEC.md](../../tools/kit/MERGE-SPEC.md); the conformance vectors in `tools/kit/vectors/` are the judge.

## Resolver output

`node "<skill-dir>/_mb/resolve.mjs" --plugin <p>` prints one JSON line:

```json
{"blocked":false,"errors":[],"locked":["/checks/security"],"ok":true,"plugin":"code-review","provenance":{"/checks/security":"org","/maxItems":"user"},"settings":{"checks":{"security":true},"maxItems":5},"tier":"a","warnings":[{"code":"LOCKED_OVERRIDE","layer":"user","path":"/checks/security"}]}
```

**`blocked: true` overrides `ok`.** A blocked plugin still prints `"ok": true` and the merged `settings` (for diagnosis), with exit 4. Exit 4 is authoritative: a program that reads the JSON must check `blocked` (or the exit code) before using `settings`.

| Exit | Meaning | The skill |
|---|---|---|
| 0 | resolved | uses `settings`, never changes a `locked` path |
| 2 | usage error | stops and reports |
| 3 | config or policy error | stops and shows `errors` |
| 4 | blocked or disabled | says it is blocked (and by which layer) and stops |
| 5 | unsupported spec version | stops and reports |
| 9 | `RUNTIME_UNSUPPORTED`: node older than 20 | follows the fallback tiers below |
| other, or no JSON | the runtime could not run it | follows the fallback tiers below |

Inspect the result from the repo with `./mb config resolve <p> [--skill s] [--cwd dir]`, which prints a table of pointer, value, layer and locked. `--cwd` selects the project; the user layer follows `XDG_CONFIG_HOME` as usual, so `XDG_CONFIG_HOME=/tmp/u ./mb config resolve <p>` previews another user file.

The generated SKILL.md block that tells the agent all this looks like this (indented here):

    <!-- mb:config:begin -->
    ## Configuration (do this first)
    `<skill-dir>` means the absolute directory that contains this SKILL.md (not the working directory).
    1. Your first tool call must be this command, alone; make no other tool call until it returns:
       `node "<skill-dir>/_mb/resolve.mjs" --plugin <p>` (node 20 or later). ...
    <!-- mb:config:end -->

## Writing settings

People can write a setting from a clone of the marketplace with `./mb config set <p> --layer user|project|project-local [--shared] <json-pointer> '<json>' [--cwd dir]`, and remove one with `./mb config unset <p> --layer ... [--shared] <json-pointer> [--cwd dir]`. Both run the same command as the skill (below), print the resolver JSON on stdout and the file they wrote on stderr (`resolve.mjs: wrote <path>`). The value is JSON, so a string needs its quotes inside the shell quotes: `'"table"'`, not `table` (an unquoted string fails with exit 2 and says so). The skill saves a stated preference with:

```sh
node "<skill-dir>/_mb/resolve.mjs" set   --plugin <p> --layer user|project|project-local [--shared] <json-pointer> '<json>'
node "<skill-dir>/_mb/resolve.mjs" unset --plugin <p> --layer user|project|project-local [--shared] <json-pointer>
```

- The value goes under `plugins.<p>.settings` (or top-level `settings` with `--shared`).
- It is checked against the strict text rules and, if present, the plugin's `config.schema.json`.
- A path that overlaps a locked path is refused (`LOCKED`, exit 3) and nothing is written.
- The write is atomic and keeps unknown keys. An unparsable existing file is left untouched (exit 3).
- File modes: a new config directory is created `0700`, and every write leaves the file `0600` (it is replaced by a new file, so an older `0644` file becomes `0600` too). This also applies to the committed project file in your checkout; git records no read permissions, so other clones get their usual default mode.
- If the file cannot be written (`WRITE_DENIED`, for example the user file inside the Codex sandbox), the skill asks you before it writes `--layer project-local` instead, or asks you to approve the write. The stderr hint names the right fallback for the layer (a failed `project-local` write is never told to write `project-local`).
- `project` and `project-local` writes never follow a symlink: if `<root>/.<mkt>`, the target config file or `<root>/.<mkt>/.gitignore` is a symlink (even a dangling one), the write is refused with `WRITE_DENIED` and nothing is written, because a checkout could point them outside the project. The user layer may be a symlink (dotfile managers).
- A `project-local` write also makes sure `<root>/.<mkt>/.gitignore` lists `config.local.json` (it creates or extends that file; it never runs git), so the file stays out of git in any repo. This happens silently and on purpose: ignoring the file is stronger than warning that it is not ignored. The file is added even when the root `.gitignore` already covers it; that is harmless. The derived marketplace's own `.gitignore` lists it too.
- `project-local` is per checkout: another clone or worktree of the same repo has its own `config.local.json`.
- Other exit-3 codes of `set`/`unset`: `SCHEMA_INVALID` (value violates `config.schema.json`), `FILE_INVALID` (target file unparsable; never rewritten).

## Schema

`config.schema.json` (optional, plugin level) may use only `type`, `enum`, `properties`, `items`, `minimum`, `maximum`, `maxLength` (plus the annotations `$schema`, `title` and `description`). It is used by `set` and by `./mb check` (CHK-11, CHK-12: defaults and enforced values must validate). The merge itself never uses the schema.

## Tiers

| Tier | When | What runs |
|---|---|---|
| a | `node` 20+ or `bun` exists | `_mb/resolve.mjs` |
| b | no runtime, but a verified merger was saved before | the saved merger, after its sha256 matches |
| c | no runtime and no saved merger | the agent generates a merger from `_mb/MERGE-SPEC.md` in Python or PowerShell, verifies it against every vector and a real-mode check, then saves and runs it |

The agent follows `_mb/FALLBACK.md` step by step. Key points:

- Saved mergers live only in `$XDG_DATA_HOME/<mkt>/mergers/` or `~/.local/share/<mkt>/mergers/` (Windows `%LOCALAPPDATA%`), named by spec version and a hash of the vectors, so a kit change makes old mergers unused.
- At most 2 repair rounds. If vectors still fail, the skill stops; it never merges config by hand.
- If the save is denied (Codex `workspace-write`), the merger is used once and the skill says "merger not cached".
- Tiers b and c never write config. They show you the file and JSON to add instead.
- **Opt out:** the org sets `"enforced": {"settings": {"merge": {"allowGenerated": false}}}` in `policy/org.json`, or a user sets `"merge": {"allowGenerated": false}` in the user file. The skill then stops when no runtime exists.
- `./mb check`, `./mb policy emit` and CI always use tier a.

**Size.** The resolver's 450-line cap counts code lines only (blank lines and `//` comment lines are free). `./mb test` prints the current numbers on every run: a `size:` diagnostic line with the code lines of `resolve.mjs` and the total code lines of all non-test tooling under `tools/`.

## Scope of access checks

Access policy (`deny`, `allow`, `enabled: false`) is applied at runtime **only by configurable skills**, because only they run the resolver. Skills of plugins without `config.defaults.json` are not stopped by `access.deny`. To block those, use host-native policy (`./mb policy emit`, see [policy.md](policy.md)) or remove them from the marketplace.

## Trust

Project and project-local files are repo content, trusted like the repo's README or AGENTS.md: whoever can commit to the repo controls them. Skills treat every setting value as data and never follow instructions found inside one.
