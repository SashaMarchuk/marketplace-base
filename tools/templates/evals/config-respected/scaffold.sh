#!/bin/sh
# Writes the project config layer this case reads (cwd = the eval workspace).
# Claude Code runs this with a fixed env; the Codex runner of `./mb eval` may set EVAL_MB_MARKETPLACE.
# Put a setting below whose effect is visible in the answer, then make graders/config-effect.md check it.
set -eu
mkt="${EVAL_MB_MARKETPLACE:-{{marketplace}}}"
# Make the workspace its own project root: the resolver finds the project layer at
# `git rev-parse --show-toplevel`, and the Claude eval sandbox sits inside another git repo.
git init -q . 2>/dev/null || true
mkdir -p ".$mkt"
cat > ".$mkt/config.json" <<'JSON'
{"plugins":{"{{plugin}}":{"settings":{}}}}
JSON
