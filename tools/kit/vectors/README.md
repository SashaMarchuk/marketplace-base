# Conformance vectors

Hand-authored oracle for `MERGE-SPEC.md` (SPEC 7.3 pseudocode). Never generated from an engine.
Each `<NNN-slug>/` holds:
- `input.json`: the INPUT object, with `request.tier = "a"`;
- `expected.json`: exact bytes of compact canonical OUTPUT + `\n`;
- `expected.exit`: one digit, no newline.

Default fixture: marketplace `acme`, plugin `p`, skill `s`, the six default layers, posix,
`cwd` and `gitRoot` `/r`, `home` `/h`. Paths: org `$KIT/policy/org.json`, team
`$KIT/policy/teams/<t>.json`, project `/r/.acme/config.json`, user `/h/.config/acme/config.json`,
project-local `/r/.acme/config.local.json`.

If an engine disagrees with a vector, file the diff; do not edit vectors. A reviewer rules against
the SPEC 7.3 pseudocode, and the owner of the wrong side fixes it. Any behaviour change adds or edits
a vector first.

## Starred vectors (explicitly required; must pass in tiers a, b and c)

004-array-replace, 005-null-deletes, 011-layers-reorder, 013-enforced-lock-org, 015-org-beats-team,
019-blocked-enforced-disabled, 021-deny-union-team, 023-allow-intersection-blocks,
028-proto-key-org, 029-proto-key-user, 031-malformed-deny-org, 032-malformed-deny-user,
033-unparsable-org, 034-unparsable-team, 035-null-in-enforced, 038-walk-up-decoy-ignored
