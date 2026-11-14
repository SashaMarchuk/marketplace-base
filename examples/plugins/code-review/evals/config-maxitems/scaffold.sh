#!/bin/sh
# Project layer: report at most 2 findings.
# Runs (bash or sh) in the eval workspace. Writes .<mkt>/config.json, where <mkt> is
# EVAL_MB_MARKETPLACE if set, else the "name" in the nearest marketplace.config.json above
# this script (claude plugin eval gives scaffolds a minimal env without EVAL_* variables),
# else "marketplace-base".
set -eu
mkt="${EVAL_MB_MARKETPLACE:-}"
if [ -z "$mkt" ]; then
  d=$(cd "$(dirname "$0")" && pwd)
  while [ "$d" != "/" ] && [ ! -f "$d/marketplace.config.json" ]; do d=$(dirname "$d"); done
  if [ -f "$d/marketplace.config.json" ] && command -v node >/dev/null 2>&1; then
    mkt=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name || ""))' "$d/marketplace.config.json" 2>/dev/null || true)
  fi
fi
mkt="${mkt:-marketplace-base}"
# Make the workspace its own project root: the resolver finds the project layer at
# `git rev-parse --show-toplevel`, and the Claude eval sandbox sits inside another git repo.
git init -q . 2>/dev/null || true
mkdir -p ".$mkt"
cat > ".$mkt/config.json" <<'JSON'
{"plugins":{"code-review":{"settings":{"maxItems":2}}}}
JSON
