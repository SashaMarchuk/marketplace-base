# FALLBACK: resolving configuration without the JavaScript resolver (tiers b and c)

You are an agent running a configurable skill. `<skill-dir>` is the directory that contains the
skill's SKILL.md. Everything this file mentions lives in `<skill-dir>/_mb/` unless stated otherwise.
Follow the steps in order. Do not skip a step, and never merge configuration by hand.

## 1. Use this file only when tier a cannot run
- Come here only when neither `node` (20 or later) nor `bun` exists, or when `resolve.mjs` exited
  with a code outside {0, 2, 3, 4, 5}, or printed no JSON (a crash, or a runtime that is too old).
  Exit 9 (`RUNTIME_UNSUPPORTED`) means the node it ran on is older than 20: come here.
- Exit 5 is never a reason to come here: it means "unsupported spec feature". Stop and report it.
- Exit meanings, for every tier: 0 = resolved (use `settings`, respect `locked`); 2 = usage error
  (stop, report); 3 = config or policy error (stop, show `errors`); 4 = blocked by deny, allow or
  disable (tell the user the skill is blocked and name the `layer` from `warnings`, then stop;
  exit 4 is authoritative even though the output still says `"ok":true` with `settings`);
  5 = unsupported spec feature (stop, report).
- Report the `tier` value from the output (`a`, `b` or `c`) in every summary you give the user.

## 2. Compute the key
- Read `_mb/vectors.sha256`; it holds `sha8`. The key is `K = "<specVersion>-<sha8>"`, where
  `specVersion` comes from `_mb/kit.json`.
- (`sha8` = the first 8 hex chars of sha256 over the concatenation, in sorted path order, of every
  `vectors/*/input.json`, `expected.json` and `expected.exit` file plus `MERGE-SPEC.md`.)

## 3. Find the saved-merger directory `<user-data>/<mkt>/mergers/`
- `<mkt>` is `marketplace` in `_mb/kit.json`.
- POSIX: `<user-data>` = `$XDG_DATA_HOME` if it is set and absolute, else `~/.local/share`.
- Windows: `<user-data>` = `%LOCALAPPDATA%`.
- Never use a project path or the plugin directory.

## 4. Check the generated-merger gate (every session, before tier b)
- Read `_mb/policy/org.json` as plain JSON, if it exists. If `enforced.settings.merge.allowGenerated`
  is `false`, stop and say: "configuration could not be resolved: no JavaScript runtime and generated
  mergers are disabled by policy".
- Read the user layer file (path rules in `_mb/MERGE-SPEC.md`, "Paths"). If it contains
  `"merge":{"allowGenerated":false}`, stop with the same message, ending "disabled by your settings"
  instead of "disabled by policy".
- Otherwise continue. Generated mergers are allowed by default.

## 5. Tier b: try a saved merger
- Look in the mergers dir `M` for `K.py` with `K.py.sha256`, or `K.ps1` with `K.ps1.sha256`.
- Never run a saved merger except through the guarded command below: it checks the hash and runs
  the merger only if it matches, in one command. Never hash in one command and run in another, and
  never batch a separate hash check with a run. Run it with the working directory = the user's
  working directory (`<ps>` = `pwsh`, else `powershell`):
  - POSIX (`K.py`):
    `if [ "$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "M/K.py")" = "$(tr -d ' \r\n' < "M/K.py.sha256")" ]; then MB_KIT="<skill-dir>/_mb" MB_TIER=b python3 "M/K.py" resolve; else echo HASH_MISMATCH; fi`
  - PowerShell (`K.ps1`):
    `if ((Get-FileHash -Algorithm SHA256 "M\K.ps1").Hash.ToLower() -eq (Get-Content -Raw "M\K.ps1.sha256").Trim()) { $env:MB_KIT="<skill-dir>\_mb"; $env:MB_TIER="b"; <ps> -NoProfile -File "M\K.ps1" resolve } else { "HASH_MISMATCH" }`
- `HASH_MISMATCH`: the merger was edited; ignore it and go to step 6.
- Exits 0, 2, 3, 4 and 5 mean what step 1 says; use the output (it has `"tier":"b"`) and stop here.
- Any other exit, or no JSON on stdout: ignore the saved merger and go to step 6.

## 6. Pick a runtime (first one that works)
- `python3`: run `python3 -c "import json,sys;print(sys.version_info[0])"`. It must print `3`
  (this rejects the macOS stub that only offers to install Python).
- `pwsh`, then `powershell` (Windows ships no python3).
- None works: stop and say "configuration could not be resolved (no runtime)".

## 7. Generate a merger
- Write `merger.py` (python3) or `merger.ps1` (PowerShell) to a new temp directory.
- Use only `_mb/MERGE-SPEC.md` as the source. Do not copy logic from anywhere else.

## 8. Verify against every vector (an external loop; never inside the generated program)
- POSIX:
  `for d in _mb/vectors/*/; do <rt> merger merge < "$d/input.json" > out.json; rc=$?; cmp -s out.json "$d/expected.json" && [ "$rc" = "$(cat "$d/expected.exit")" ] || echo "FAIL $d"; done`
  (`<rt> merger` = `python3 merger.py` or `pwsh merger.ps1`; paths relative to `<skill-dir>`.)
- PowerShell: run each vector through `cmd /c "<rt> merger.ps1 merge < <d>\input.json > out.json"`
  (byte-preserving; never use PowerShell `>` redirection), then compare bytes with `Get-FileHash`
  against `<d>\expected.json` and the exit code `$LASTEXITCODE` against `<d>\expected.exit`.
- Every vector carries `"tier":"a"` in `request.tier`, so its expected output says `"tier":"a"`.

## 8b. Real-mode check (uses its own fixture kit, not this skill's kit)
- `_mb/realmode/fixture.json` has three keys: `kitFiles` (file texts of a test kit: `kit.json` and
  `policy/org.json`), `repoFiles` (file texts relative to the repo root, including the decoy
  `sub/.acme/config.json`) and `userFile` (the text of the user config file). The fixture's
  marketplace is `acme`.
- Make a new temp dir T. Write each `kitFiles` entry under `T/k`. Create `T/r`, run `git init` in it,
  and write each `repoFiles` entry under `T/r`. Write `userFile` to the user config path:
  - POSIX: `T/h/.config/acme/config.json`;
  - Windows: `T\a\acme\config.json`.
- Run the merger in `resolve` mode with working directory `T/r/sub`, `MB_KIT=T/k` (the fixture kit,
  never `<skill-dir>/_mb`) and `MB_TIER=a`, with the user config dir pointed into T:
  - POSIX: `HOME=T/h` with `XDG_CONFIG_HOME` unset;
  - Windows: `APPDATA=T\a`.
- Byte-compare stdout with `_mb/realmode/expected.json` and the exit code with
  `_mb/realmode/expected.exit`. The same expected files serve both OSes.
- If `git` is not installed, skip this step and tell the user it was skipped.

## 9. Repair (at most 2 rounds)
- Each round, fix the merger using only the failing vector names and their diffs, then rerun step 8
  and step 8b.
- If anything still fails after 2 rounds, stop and say "configuration could not be resolved
  (no runtime; generated merger failed N vectors)", with N the number of failing vectors.

## 10. Save
- Only after every vector and the real-mode check pass: write `K.<ext>` and `K.<ext>.sha256` (the
  lowercase sha256 hex of `K.<ext>`, nothing else) to the mergers dir. Create the dir if needed.
- If the write fails (a sandbox may deny paths outside the workspace), use the merger for this run
  only, tell the user "merger not cached", and suggest rerunning with approval.

## 11. Run (tier c)
- If it was saved in step 10, run it with the guarded command of step 5, but with `MB_TIER=c`.
  If it was not cached, run the verified temp merger the same way without the hash check
  (`MB_KIT=<skill-dir>/_mb MB_TIER=c <rt> merger resolve`).
- Exits 0, 2, 3, 4 and 5 mean what step 1 says. Any other exit, or no JSON: stop and say
  "configuration could not be resolved".

## 12. Writes
- Tiers b and c never write config files.
- When the user asks to remember a preference, show the user-layer path (MERGE-SPEC "Paths") and the
  exact JSON to add under `plugins.<p>.settings` (`<p>` = `plugin` in `_mb/kit.json`), and ask the
  user to apply it.
- If the user wants it for this project only, show the project-local path instead (MERGE-SPEC
  "Paths") and also ask them to make sure `<root>/.<mkt>/.gitignore` contains the line
  `config.local.json`, so the file is never committed.

## 13. Scope
- Tiers b and c serve this local resolution only. `mb policy emit`, `mb check` and CI always use
  tier a.
- The sha256 files detect accidental edits; they are not a security boundary.
