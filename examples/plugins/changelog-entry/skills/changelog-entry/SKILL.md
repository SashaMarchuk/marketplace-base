---
name: changelog-entry
description: Write a CHANGELOG entry in Keep a Changelog format for one change, placed under the right version and category heading (Added, Changed, Deprecated, Removed, Fixed, Security). Read-only; it shows the entry and where it goes instead of editing the file. Use when the user asks for a changelog entry, a CHANGELOG.md line, or a release-note line for a specific change, fix or feature.
license: MIT
---

# Changelog entry

Write one entry for one change, in the format described in [references/format.md](references/format.md). Read that file before you write the first entry in a session. Do not edit `CHANGELOG.md` unless the user explicitly asks you to apply the entry.

## 1. Understand the change

Use what the user gave: a description, a diff, a commit message or a pull request summary. If a shell is available and the user points at commits, `git log --oneline -n 20` or `git show --stat <ref>` may help. If you still cannot tell what changed for a user of the project, ask one short question.

## 2. Look at the existing changelog

If a `CHANGELOG.md` exists in the project root (or the file the user names), read its top part:
- Find the `## [Unreleased]` section. New entries go there unless the user names a version.
- Copy the file's local style: bullet character, tense, issue-link format, line length.
- If the file does not follow Keep a Changelog, keep its existing style and say so in one line.

If there is no changelog, show the entry inside a minimal `## [Unreleased]` section and mention that `references/format.md` has a starter header.

## 3. Pick the category

Use exactly one of these headings (see `references/format.md` for details and edge cases):

| Heading | When |
|---|---|
| `### Added` | new features |
| `### Changed` | changes to existing behaviour |
| `### Deprecated` | features that will be removed later |
| `### Removed` | features removed now |
| `### Fixed` | bug fixes |
| `### Security` | vulnerability fixes; always use this, even when it is also a fix |

A breaking change goes under `Changed` or `Removed` and starts with `**Breaking:**`.

## 4. Write the entry

- One bullet, written for users of the project, not for its developers: say what changed for them, not which function changed.
- Past or present tense to match the file; start with a verb or the affected feature.
- Keep it to one or two sentences. Add the issue or pull request reference only if the user gave one.

## 5. Reply

Show:
1. Where it goes, for example "Under `## [Unreleased]`, in `### Fixed`".
2. A markdown code block with the category heading line and the bullet, ready to paste:

```markdown
### Fixed
- Exporting a report with no rows no longer fails with an empty-file error.
```

If the heading already exists in that section, say to add only the bullet under it.
