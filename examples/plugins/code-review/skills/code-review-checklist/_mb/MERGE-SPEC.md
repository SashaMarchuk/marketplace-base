# MERGE-SPEC v1  (implement exactly; vectors in ./vectors are the judge)
Program: one file, standard library only. No network, no subprocess except `git rev-parse --show-toplevel`
in mode `resolve`, no eval/dynamic import. Mode `merge`: read INPUT JSON on stdin. Mode `resolve`
(default): build INPUT from disk as in "Real mode". Write OUTPUT + "\n" to stdout; exit with the code below.
Write stdout as UTF-8 bytes with LF only, in binary mode (Python: sys.stdout.buffer;
PowerShell: [Console]::OpenStandardOutput()). Never let the runtime add CR, a BOM or UTF-16.
INPUT = {specVersion, request:{plugin,tier}, kit:{marketplace,plugin,skill,layers,defaults},
         env:{platform:"posix"|"win32", cwd, gitRoot|null, home, XDG_CONFIG_HOME|null, APPDATA|null},
         files:{<path>: <raw file text>}}   (absent path = layer absent)
Real mode: KIT = env MB_KIT if set, else the directory containing this program. kit = KIT/kit.json;
specVersion = kit.specVersion; "$KIT/" paths below = KIT; gitRoot from git (null on failure); env from
the process; files = only the candidate paths below that exist. tier = env MB_TIER ("a"|"b"|"c").
Paths: root = gitRoot ?? cwd; sep = "\\" on win32 else "/".
  project = root/.<mkt>/config.json ; project-local = root/.<mkt>/config.local.json
  user = win32: APPDATA\<mkt>\config.json (APPDATA null -> absent + warning USER_DIR_UNKNOWN)
         posix: (XDG_CONFIG_HOME if absolute and non-empty else home/.config)/<mkt>/config.json
  org = $KIT/policy/org.json ; team = $KIT/policy/teams/<team>.json
  NEVER read any other path (no walk-up from cwd).
Parsing: INPUT itself is plain JSON (its `files` keys are paths). Every FILE TEXT (each value of
  `files`, each file read in real mode) is strict: reject duplicate keys; number tokens not matching
  -?(0|[1-9][0-9]*) (so 1e3 and 1.0 are errors) or outside +-(2^53-1); a leading BOM; invalid UTF-8;
  lone surrogate escapes (\ud800-\udfff not in a valid pair); keys not matching ^[A-Za-z0-9_-]{1,64}$
  (top-level "$schema" allowed); keys __proto__, constructor, prototype at any depth.
  Use maps / null-prototype objects.
Shape: top keys $schema, settings{}, plugins{<p>:{enabled:bool, settings:{}}}, enforced{settings, plugins},
  access{allow:[pattern], deny:[pattern]}, team:string, merge{allowGenerated:bool}.
  pattern ^[a-z0-9*][a-z0-9*-]{0,63}$ ; "*" matches any run of chars.
  Closed levels: top, plugins.<p>, enforced, enforced.plugins.<p> (settings objects are free-form).
  Unknown key at a closed level: policy layer -> exit 3 POLICY_INVALID; personal -> UNKNOWN_KEY warning.
  A key other than allow/deny inside access = bad access (ACCESS_INVALID, every layer).
Layer classes: policy = org, team. personal = project, user, project-local.
  policy file bad (parse/shape/access) or null anywhere in enforced -> exit 3
     (POLICY_INVALID | ACCESS_INVALID | ENFORCED_INVALID, layer).
  personal file: parse/shape error outside access -> ignore file, warning FILE_SKIPPED;
     bad access in a parseable file -> exit 3 ACCESS_INVALID; enforced -> drop + ENFORCED_IGNORED;
  team key outside project/user, merge key outside user -> KEY_IGNORED.
Team = project.team ?? user.team ?? none (only layers listed in kit.layers count). A team value not
  matching ^[a-z0-9]+(-[a-z0-9]+)*$ -> KEY_IGNORED (that layer) and is treated as absent.
  team named but file absent -> exit 3 TEAM_UNKNOWN (layer = team name).
Cascade over kit.layers (low->high); skill-defaults = {settings: kit.defaults}:
  acc = patch(acc, layer.settings); acc = patch(acc, layer.plugins[P].settings)
  patch = RFC 7386 (objects merge; arrays/scalars replace; null deletes).
  provenance[JSON-Pointer of each leaf] = layer that wrote it; deleting removes entries at/below.
  plugins[P].enabled (bool) -> last one wins.
Enforced (only org, team; apply team then org): E = patch(patch({}, enforced.settings),
  enforced.plugins[P].settings). Leaves = scalars, arrays and EMPTY objects. Pointers a, b overlap if
  equal or one is a prefix of the other on a "/" boundary. "differs" = canonical texts differ (missing
  differs from any value). For each leaf (ptr, v): if org, differs, and a team-locked pointer overlaps
  ptr -> ENFORCED_CONFLICT (path ptr); for each provenance entry overlapping ptr whose layer is
  personal, if differs -> LOCKED_OVERRIDE (path ptr, layer = that personal layer); set it
  (create/replace parents); remove every provenance and locked entry overlapping ptr; then
  provenance[ptr] = enforcing layer and add ptr to locked. enforced.plugins[P].enabled overrides enabled.
Access: deny = union over every layer -> each matching layer adds BLOCKED_DENY.
  allow = intersection: each layer that declares allow and has no matching pattern adds BLOCKED_NOT_ALLOWED.
  enabled == false -> DISABLED (layer = where it was set). Any of these -> blocked, exit 4.
OUTPUT keys (always all): blocked, errors, locked, ok, plugin, provenance, settings, tier, warnings.
  Error exits: ok=false, settings={}, locked=[], provenance={}, errors=[{code,layer?,path?}].
  Canonical: sorted keys, no whitespace, integers, raw UTF-8, escape only " \ and U+0000-001F
  (\b \f \n \r \t else \u00xx lowercase); warnings/errors sorted by their canonical text, deduped.
Exit: 0 ok | 3 error | 4 blocked | 5 specVersion > 1 (SPEC_UNSUPPORTED) | 2 usage.
