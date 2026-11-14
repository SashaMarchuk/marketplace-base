# Evals

Evals check that a skill fires when it should, stays quiet when it should not, and respects its configuration, on both Claude Code and Codex. Requirements: [openspec/specs/mb-evals](../../openspec/specs/mb-evals/spec.md).

## Case format

Cases use the native `claude plugin eval` layout, so no custom keys are needed:

```
plugins/<p>/evals/<case>/
  prompt.md          # frontmatter + the user prompt
  graders/*.md       # one grader per file
  case.yaml          # only when a scaffold script is needed
```

`prompt.md` frontmatter keys: `name, description, tags, plugins, runs, expected_outcome, model, max_turns, timeout_seconds, allowed_tools, append_system_prompt, env`. Any other key is an error.

Grader frontmatter: `type`, `weight`, `arm` (`with-only | both`), plus options for the type:

| Type | Options |
|---|---|
| `regex` | `pattern`, `flags` (JS letters, e.g. `flags: i`), `match: contains\|not_contains\|count:N` (default `contains`; `count:N` = exactly N), `target: last_message\|trace` (default `last_message`) |
| `tool_used` | `tool`, `input_match`, `min`, `max` |
| `tool_order` | `before`, `after` |
| `file_exists` | `path`, `exists` |
| `llm` | the body is the criteria; `focus` |
| `baseline` | none |

Every skill needs at least one **trigger** case and one **no-trigger** case (CHK-14). `./mb new skill` scaffolds both with these graders (shown indented):

    # graders/skill-fired.md
    ---
    type: tool_used
    tool: Skill
    input_match: '"skill"\s*:\s*"(?:[\w-]+:)?<s>"'
    min: 1
    ---

    # graders/skill-not-fired.md
    ---
    type: tool_used
    tool: Skill
    input_match: '"skill"\s*:\s*"(?:[\w-]+:)?<s>"'
    min: 0
    max: 0
    arm: both
    ---

Config cases write a project config with a scaffold script (`case.yaml`: `schema_version: "1.0"`, `name`, `context.scaffold_script`), set `allowed_tools: [Read, Glob, Grep, Skill, Bash]`, and run with `--scaffold` (automatic for configurable plugins). Claude Code runs the scaffold with a fixed environment, so `EVAL_*` variables do not reach it: the script uses `EVAL_MB_MARKETPLACE` when set (the Codex runner sets it) and otherwise the marketplace name written into it when the case was created. Keep scaffolds POSIX `sh`.

A local Claude run under a temporary `CLAUDE_CONFIG_DIR` is not logged in: pass `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the environment (never write it to a file).

## Running

```sh
./mb eval [<p>...] --host claude|codex|all [--case <glob>] [--runs n] [--scaffold]
```

Settings come from `evals` in `marketplace.config.json`: `threshold` (default 0.6), `runs` (default 3; 0.6 with 3 runs means 2 of 3 must pass), `maxCostUsd`, and optional pinned `models` (`claude`, `codex`, `judge`). Results go to `dist/evals/<host>-<p>.json`. The command exits 1 if any case is below the threshold.

**Claude runner.** `claude plugin eval <pdir> --trust-plugin --ablation none --no-publish --json dist/evals/claude-<p>.json --output-dir dist/evals/claude-<p>` with the threshold, runs, models and cost cap, and for configurable plugins `--scaffold --allow-tools "Bash(node:*)" "Bash(sh:*)"`. `--ablation none` is required: with a no-plugin baseline arm, `tool_used: Skill` is not scored. `--output-dir` keeps the HTML report out of the plugin's `evals/` dir.

**Codex runner.** Codex has no eval command, so `mb` runs each case itself:

1. Install the marketplace into a temporary `CODEX_HOME` (your real one is never touched). Locally it copies your `auth.json` read-only (or uses `OPENAI_API_KEY` when there is none); in CI it logs in with `OPENAI_API_KEY`.
2. Create a temporary git workdir and run the scaffold script (`sh`) if `--scaffold` is set or the plugin is configurable.
3. Run `codex exec --json -s workspace-write --ephemeral -C <workdir> -o last.txt "<prompt>"`.

| Grader | How the Codex runner scores it |
|---|---|
| `regex` on the last message | `last.txt` |
| `regex` on the trace | the JSONL event stream |
| `file_exists` | workdir file list before and after |
| `tool_used: Skill` | a command in the stream that reads `.../skills/<s>/SKILL.md` |
| `tool_used: Bash` | `command_execution` events, `input_match` applied to the command |
| other `tool_used`, `tool_order`, `baseline` | SKIPPED |
| `llm` | judged by `claude -p` when Claude is logged in, else SKIPPED |

**Scoring.** SKIPPED never counts as a pass, and a case whose graders are all skipped fails. A Codex run that exits non-zero, times out or ends without `turn.completed` scores 0 without grading. A `tool_used` grader without `min` counts as `min: 1`, so the templates always set `min`. Run score = weighted mean of the scored graders; case score = mean over runs.

A host without its CLI or credentials is reported SKIPPED: exit 0 in CI or with `--host all`; exit 7 locally when you named that host (`--host claude` or `--host codex`).

## Costs

Evals call real models. Budget roughly `cases × runs × hosts` agent sessions per run; `maxCostUsd` caps the Claude runner. To keep costs down:

- run one plugin and one case while iterating: `./mb eval <p> --host claude --case '<name>' --runs 1`;
- in CI, evals run only on manual dispatch (set `changed-only` on a PR branch to evaluate just the changed plugins) and nightly, never on `pull_request`. A missing `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` skips that host with a notice.

Base releases attach both-host eval results for the tagged commit.
