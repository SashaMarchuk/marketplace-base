# Contributing a skill

You can add a working, tested skill in under 10 minutes. You need Node.js 20 or later and git. To try it live you also need `claude` (Claude Code) and/or `codex` (Codex CLI).

AI agents: also read [AGENTS.md](AGENTS.md).

This file belongs to marketplace-base and is replaced by `./mb base-update`. In a derived marketplace, put your own contributor notes in `AGENTS.md` (outside the generated block) or under `docs/`.

## The 10-minute path

**1. Scaffold** (1 minute). Pick a plugin name and a skill name (lowercase, hyphens). The description says what the skill does and *when to use it*: hosts use it to decide when the skill fires.

```sh
./mb new skill release-notes/draft "Draft release notes from merged changes. Use when preparing a release."
```

This creates (or reuses) the plugin `plugins/release-notes/` and adds:

```
plugins/release-notes/
  plugin.src.json                 # name, version 0.1.0, description: the only manifest you edit
  skills/draft/SKILL.md           # your skill (TODO body)
  evals/draft-trigger/            # a prompt that SHOULD fire the skill
  evals/draft-no-trigger/         # a prompt that should NOT fire it
```

Add `--config` if the skill needs settings: it also creates `plugins/release-notes/config.defaults.json` and a `config-respected` eval case.

- `config.defaults.json` is a bare settings object, for example `{ "language": "en", "sections": ["Summary", "Decisions"] }` (see [docs/base/config.md](docs/base/config.md#making-a-plugin-configurable)).
- The scaffolded `evals/config-respected/` case sets a value in its `scaffold.sh` and has one grader, `graders/config-effect.md`, a stub you must edit so it checks the visible effect of that setting (until then the case does not test anything). See [graders](docs/base/evals.md#graders) and [config cases](docs/base/evals.md#config-cases).

**2. Write the skill** (5 minutes). Edit `skills/draft/SKILL.md`. Keep it under 500 lines; move long detail to `skills/draft/references/`. Then make the two eval prompts realistic: `evals/draft-trigger/prompt.md` should be a request that clearly needs the skill, and `evals/draft-no-trigger/prompt.md` a nearby request that does not.

**3. Check** (30 seconds).

```sh
./mb gen && ./mb check release-notes
```

Every problem comes with a fix hint. A new skill shows one TODO warning until you replace the TODO body.

**4. Try it on both hosts** (2 minutes).

```sh
./mb try release-notes --host claude "Draft release notes for: fixed login timeout, added CSV export"
./mb try release-notes --host codex  "Draft release notes for: fixed login timeout, added CSV export"
```

`try` never touches your real host settings.

**5. Open a pull request.** CI runs the same checks (`mb-check`).

## Definition of done

- [ ] `./mb gen && ./mb check` reports 0 errors.
- [ ] The skill description says what it does and includes "Use when ...".
- [ ] At least one trigger and one no-trigger eval case (the scaffold creates both).
- [ ] `./mb try` works on Claude Code and Codex, or the PR says which host you could not test.
- [ ] No host variables or absolute home paths in `skills/`; scripts run as `sh <skill-dir>/scripts/x`.
- [ ] Changing an existing plugin? Run `./mb bump <p>` (patch, minor or major).
- [ ] No secrets, internal names or private URLs anywhere.

## Good to know

- **Skills are the portable unit.** Commands, agents, hooks and MCP servers work differently in each host; `mb check` warns about them. See [docs/base/authoring.md](docs/base/authoring.md).
- **Generated files** (`.claude-plugin/`, `.codex-plugin/`, `_mb/`, marketplaces, the README catalog) are rewritten by `./mb gen`. Never edit them by hand.
- **Examples** in `examples/plugins/` belong to the base. To change one in a derived marketplace, run `./mb adopt <p>` first.
- **Evals:** `./mb eval <p> --host all` runs the cases for real and costs model tokens. See [docs/base/evals.md](docs/base/evals.md).
- **Changes to the base itself** (`tools/`, `docs/base/`, specs): open an OpenSpec change under `openspec/changes/mbase-<slug>/` first, and add a vector or test for any behaviour change.
