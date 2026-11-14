# Migrating an existing marketplace

How to move an existing plugin marketplace (hand-written manifests, commands, agents, hooks, maybe your own config resolver and tests) onto marketplace-base. It also lists what the base does not do, with a workaround for each.

## Steps

1. **Derive a fresh repo** without the examples: `./mb init --name acme-skills --display "Acme Skills" --owner "Acme" --repo acme/acme-skills --examples none`. See [derive-update.md](derive-update.md).
2. **Copy one plugin at a time** into `plugins/<p>/` and map its files with the table below. Start with a simple plugin.
3. **Run `./mb gen && ./mb check <p>`** and follow the fix hint of each result. Repeat until there are no errors.
4. **Add eval cases.** Each skill needs at least one trigger and one no-trigger case (CHK-14). The format is in [evals.md](evals.md); a skill scaffolded with `./mb new skill` shows both.
5. **Move your tests** (see [Tests](#tests)) and **your own workflows** to `.github/workflows/<name>.yml` (names starting with `mb-` are reserved for the base).
6. **Try it live**: `./mb try <p> --host claude` (and `--host codex`), then commit.

## Artifact mapping

| You have | Put it in | Notes |
|---|---|---|
| Hand-written plugin manifest | `plugins/<p>/plugin.src.json` | Only the keys in [authoring.md](authoring.md#plugin-anatomy). `description` is at most 1024 characters and ends with a period; move longer text and any extra keys to the plugin's `README.md`. Host manifests are generated. |
| Hand-written marketplace file | nothing (generated) | A per-plugin category becomes `category` in `plugin.src.json`. |
| `SKILL.md` | `plugins/<p>/skills/<s>/SKILL.md` | Frontmatter: the portable Agent Skills keys; known Claude Code-only keys (`user-invocable`, `disable-model-invocation`, `allowed-tools`, `argument-hint`, `model`) get a warning; anything else is an error. |
| A hidden skill that commands call | same, with `user-invocable: false` | Accepted with the warning "host-specific (ignored by Codex)". Claude Code hides it from the slash menu; Codex still lists it. Keep the commands in `commands/`. |
| `references/`, `scripts/`, `assets/` at the plugin root | `plugins/<p>/skills/<s>/references/` (and `scripts/`, `assets/`) | A plain-folder export copies only the skill folder. Move these folders together so relative paths between them keep working. Scripts that find the plugin root from their own location (`scripts/..`, or a search for `.claude-plugin/plugin.json`) now get the skill folder: a guard meant to cover the whole plugin covers only the skill, and a manifest lookup finds nothing. `mb check` cannot see this; review such scripts by hand. |
| `${CLAUDE_PLUGIN_ROOT}` or other host variables in skills | `<skill-dir>/...` | The model sees the skill's absolute directory. Run scripts as `node <skill-dir>/scripts/x.mjs` or `sh <skill-dir>/scripts/x.sh`. |
| `commands/`, `agents/`, `hooks/`, MCP config | same folders in `plugins/<p>/` | Kept; `mb check` warns that they are host-specific (CHK-09). A plain-folder export drops them without a warning, so a skill that hands work to an agent does not work from a plain folder. Say so in the plugin README. |
| Your own config resolver and config files | `config.defaults.json` plus the layers ([config.md](config.md)) | Mapping below. Or keep your resolver as plain plugin files; the plugin is then not "configurable" for `mb`. |
| Advice or recommendation files (hints, not values) | `skills/<s>/references/` | Config holds values only; there is no advice slot. The skill reads the file as data. |
| A plugin-root data folder (static data, schemas), for example `config/` | `skills/<s>/config/`: move the folder whole and keep its name | Every mention (`config/...` in prose, `new URL('../config/...')` in scripts) keeps working. Renaming it to `assets/` or `references/` breaks those paths, and `mb check` stays green: CHK-06 only checks paths that start with `scripts/`, `references/` or `assets/`. Config key rules do not apply to these files. |
| Helper scripts shared by several plugins | your own sync script | See [Shared files](#shared-files). |
| Third-party notices and licenses | inside the skill folder | A plain-folder export copies only the skill folder. |
| Root `CLAUDE.md`, `CONTRIBUTING.md`, `.gitattributes` | `AGENTS.md` (outside the generated block) or `docs/` | These paths are owned by the base and replaced on update. |
| Root `README.md`, `LICENSE`, `.gitignore` | merge by hand once | They are seeds: yours after `init`, outside the generated marker blocks. |
| Other docs, specs, scripts | anywhere that is not base-owned (`docs/<name>.md`, `scripts/`, ...) | `docs/base/` is base-owned; `mb check` (CHK-17) flags files you add there. |

## Config: mapping your layers

The base merges these layers, low to high priority: `skill-defaults`, `org`, `team`, `project`, `user`, `project-local`. Inside each layer, the shared `settings` apply first and `plugins.<p>.settings` second, so each layer has a "general" and a "per-plugin" slot.

- **Order.** If you had general and per-plugin files for project, user and a personal per-project file, they map one-to-one onto `project`, `user` and `project-local`, each with its two slots. Reorder or drop layers in `config.layers` of `marketplace.config.json` (for example, remove `org` and `team` if you have no policy). Check the result with `./mb config resolve <p> --cwd <dir>`.
- **Paths are fixed.** Project files are `<root>/.<mkt>/config.json` and `config.local.json`; the user file is `$XDG_CONFIG_HOME/<mkt>/config.json` (or `~/.config/...`, `%APPDATA%\...`). One user file serves the whole marketplace, under its name. There is no path option.
- **File shape.** Values sit under `settings` and `plugins.<p>.settings`, not at the top of the file. Keys match `^[A-Za-z0-9_:-]{1,64}$` (tool identities like `mcp:search` work; spaces do not); integers only; `null` deletes a key instead of storing it.
- **Defaults.** `config.defaults.json` is a bare settings object (no `settings` wrapper).

### Config merge recipes

The merge is RFC 7386 merge patch: objects merge key by key, arrays and scalars replace whole. There is no per-key merge strategy. Model what you need instead:

| You need | Model it as | Caveat |
|---|---|---|
| A list that every layer adds to (union) | an object whose keys are the entries and whose values are `true`: `{"blocked": {"mcp:search": true}}` | A higher layer can still remove an entry with `null` (or set it to `false`; the skill should treat `false` as "not in the list"). |
| A list entry nobody may remove (a veto) | the union object above, with the entry in `enforced` in `policy/org.json` or a team file | `enforced` locks the path. It is advisory on a user's machine, like all config-file policy ([policy.md](policy.md)). |
| An object that a higher layer replaces whole | a one-element array: `{"binding": [{"tool": "x", "mode": "read"}]}` | Arrays always replace whole, so no keys mix between layers. The skill reads element 0. |

## Shared files

`mb gen` vendors only the base config kit into skills. If several plugins need the same helper script:

1. Keep one source copy, for example `shared/<name>.mjs` (your own path, not base-owned).
2. Write a small sync script, for example `scripts/sync-shared.mjs`, that copies it into each plugin's `skills/<s>/scripts/` and, with `--check`, fails if a copy differs.
3. Run it with `--check` in your own workflow (`.github/workflows/sync-check.yml`).
4. After a sync changes a plugin, run `./mb bump <p>`; `mb check` (CHK-15) requires it.

## Tests

- `*.test.mjs` files under `plugins/<p>/tests/` run with `./mb test` (Node.js `node:test`, no dependencies), so CI runs them too.
- Tests anywhere else, including tests kept next to their scripts (they end up under `skills/<s>/scripts/` after the move), are not run. Move them to `plugins/<p>/tests/`, then fix their relative imports, data-file URLs and any constant that names their own folder.
- Other harnesses (shell, Python, mutation tests) run from your own workflow.
- Tests that pin file paths or document structure need updating for the new layout (skill-relative paths, generated manifests).

## Known gaps

These are not built into the base. Each has a workaround that keeps `mb check` green.

| Gap | Workaround |
|---|---|
| Per-key merge strategies (union, whole replace) | [Config merge recipes](#config-merge-recipes) |
| Vendoring your own shared files | [Shared files](#shared-files) |
| Importing existing user config files | A one-time script that reads each old file and writes the base shape, or calls `./mb config set <p> --layer user <pointer> '<json>'` per value. Or ask users to state their preferences again; skills save them. |
| An advice or recommendations slot in config | a data file in `skills/<s>/references/` |
| Eval cases that need a live connector or service | Eval scaffolds only write files. Keep such cases as manual checks, or stub the service in the scaffold. |
| A warning when an exported skill depends on agents or commands | Say so in the plugin README. A plain-folder export drops `agents/` and `commands/`. |

## Footprint

Each configurable skill gets a generated `_mb/` kit of about 180 small files and about 100 KB, mostly conformance vectors that the no-runtime fallback reads at run time. Forty configurable skills add about 4 MB to the repo.
