# marketplace-base

A base repo for building your own **agent-skill marketplace** that works in **Claude Code**, in **Codex**, and as a plain skills folder.

- **Skills are the product.** You write `SKILL.md` files ([Agent Skills](https://agentskills.io) format). The `mb` tool generates every host manifest and marketplace file and checks it for drift.
- **One repo, both hosts.** The same plugin tree installs in Claude Code and in Codex. Examples are tested on both.
- **Layered config.** Org, team, project and personal settings merge in a fixed, tested order, with policy that fails closed.
- **Derive and keep updating.** Create your own marketplace from this base, then pull later base releases with `./mb base-update`. Your files are never merged over.
- **Zero dependencies.** `mb` needs only Node.js 20 or later and git.

## Quickstart (60 seconds)

Install a plugin from this marketplace:

<!-- mb:install:begin -->
**Claude Code**

```sh
claude plugin marketplace add SashaMarchuk/marketplace-base
claude plugin install changelog-entry@marketplace-base
```

**Codex**

```sh
codex plugin marketplace add SashaMarchuk/marketplace-base
codex plugin add changelog-entry@marketplace-base
```

**Plain skills folder** (from a clone of this repo)

```sh
./mb export skills ~/.agents/skills    # Codex
./mb export skills ~/.claude/skills    # Claude Code
```
<!-- mb:install:end -->

Then ask your agent something like "add a changelog entry for this fix". See [USAGE.md](USAGE.md) for updating, configuration and uninstalling.

## What's in the catalog

<!-- mb:catalog:begin -->
| Plugin | Skills | Description | Configurable | Host | Org policy |
|---|---|---|---|---|---|
| [changelog-entry](docs/catalog.md#changelog-entry) | `changelog-entry` | Write one Keep a Changelog entry under the right heading. | no | - | - |
| [code-review](docs/catalog.md#code-review) | `code-review-checklist` | Review a diff against a configurable, policy-lockable checklist. | yes | - | - |
| [commit-message](docs/catalog.md#commit-message) | `commit-message` | Draft a Conventional Commits message from a described or staged change. | no | - | - |
| [meeting-notes](docs/catalog.md#meeting-notes) | `meeting-notes-template` | Turn raw meeting notes into a structured template with configurable sections, language and date format. | yes | - | - |
<!-- mb:catalog:end -->

## Make your own marketplace

1. Click **Use this template** on GitHub (or `gh repo create acme-skills --template SashaMarchuk/marketplace-base`, or `git clone`).
2. In your new repo, run:

   ```sh
   ./mb init --name acme-skills --display "Acme Skills" --owner "Acme" --repo acme/acme-skills
   ```

3. Add a skill and check it:

   ```sh
   ./mb new skill release-notes/draft "Draft release notes from merged changes. Use when preparing a release."
   ./mb check
   ```

4. Commit and push. Later, pull base improvements with `./mb base-update`.

`init` keeps the examples by default (`--examples none` removes them). Examples stay under `examples/plugins/`, which `./mb base-update` overwrites: run `./mb adopt <p>` **before** you edit one (it moves it to `plugins/<p>`, which is yours). To drop an example, adopt it and delete `plugins/<p>`, or remove it from `includeExamples` in `marketplace.config.json` and delete its folder. Details: [docs/base/derive-update.md](docs/base/derive-update.md).

Moving an existing marketplace onto the base? See [docs/base/migrating.md](docs/base/migrating.md).

## Learn more

| You want to | Read |
|---|---|
| Install and use skills, set preferences | [USAGE.md](USAGE.md) |
| Add a skill in under 10 minutes | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Understand plugin and skill anatomy | [docs/base/authoring.md](docs/base/authoring.md) |
| Configure org, team and personal settings | [docs/base/config.md](docs/base/config.md) |
| Push policy to managed machines | [docs/base/policy.md](docs/base/policy.md) |
| Test skills on both hosts | [docs/base/evals.md](docs/base/evals.md) |
| Derive a marketplace and pull updates | [docs/base/derive-update.md](docs/base/derive-update.md) |
| Move an existing marketplace onto the base | [docs/base/migrating.md](docs/base/migrating.md) |
| Set up GitHub on a free or paid plan | [docs/base/github.md](docs/base/github.md) |
| Check what each host is verified to support | [docs/base/hosts.md](docs/base/hosts.md) |
| See every `mb check` rule | [docs/base/rules.md](docs/base/rules.md) |
| Report a vulnerability | [SECURITY.md](SECURITY.md) |
| Work in this repo as an AI agent | [AGENTS.md](AGENTS.md) |

Requirements live in [openspec/specs](openspec/specs) (OpenSpec format). The `mb` CLI never needs OpenSpec at runtime.

## License

[MIT](LICENSE)
