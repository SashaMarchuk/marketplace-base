#!/bin/sh
# Writes the project config layer this case reads (cwd = the eval workspace).
# Claude Code runs this with a fixed env; the Codex runner of `./mb eval` may set EVAL_MB_MARKETPLACE.
# Put a setting below whose effect is visible in the answer, then add a grader that checks it.
set -eu
mkt="${EVAL_MB_MARKETPLACE:-{{marketplace}}}"
mkdir -p ".$mkt"
cat > ".$mkt/config.json" <<'JSON'
{"plugins":{"{{plugin}}":{"settings":{}}}}
JSON
