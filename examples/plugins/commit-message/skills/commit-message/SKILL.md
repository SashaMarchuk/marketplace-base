---
name: commit-message
description: Draft a git commit message in Conventional Commits format (type, optional scope, subject, body, footers) for a code change, from a pasted diff, a description of the change, or the currently staged changes. Read-only; it never commits. Use when the user asks for a commit message, wants to word or fix a commit message, or asks what to write when committing their change.
license: MIT
---

# Commit message

Write one commit message in the Conventional Commits 1.0.0 format. Do not run `git commit`, do not stage files, and do not change the working tree.

## 1. Find the change

Use the first source that applies:
1. A diff or a description of the change in the conversation.
2. Otherwise, if a shell is available, the staged changes: `git diff --staged --stat`, then `git diff --staged`. If nothing is staged, look at `git diff` and say that the message describes unstaged changes.
3. Otherwise, ask the user to paste the diff or describe the change. Do not guess.

If the change mixes unrelated work (for example a bug fix plus a new feature), say so and suggest splitting it. Then write the message for the main change.

## 2. Choose the type

| Type | Use for |
|---|---|
| `feat` | new behaviour visible to users or callers |
| `fix` | a bug fix |
| `docs` | documentation only |
| `refactor` | a code change with no behaviour change |
| `perf` | a performance improvement |
| `test` | tests only |
| `build` | build system or dependencies |
| `ci` | CI configuration |
| `style` | formatting only |
| `chore` | maintenance that fits nothing above |
| `revert` | reverts an earlier commit |

When two types fit, pick the one that matters most to a reader of the history (`fix` over `refactor` if the refactor fixes a bug).

## 3. Write it

- Header: `<type>(<scope>): <subject>`. The scope is optional: a short noun for the area changed (`parser`, `api`, `deps`). Leave it out rather than invent one.
- Subject: imperative mood ("add", not "added" or "adds"), lower case first word, no final period, header at most 72 characters.
- Body (optional; skip it for trivial changes): a blank line after the header, then what changed and why, wrapped at 72 characters. Do not list every file.
- Breaking change: add `!` before the colon (`feat(api)!: ...`) and a footer `BREAKING CHANGE: <what breaks and how to migrate>`.
- Footers for references the user gave, such as `Refs: #123` or `Closes: #45`. Never invent issue numbers.
- Follow the repository's own convention if one is visible (for example in recent `git log --oneline -10` output), as long as it stays Conventional Commits.

## 4. Reply

Put the message alone in a `text` code block so it can be copied, with the header as the first line of the block. After the block, add at most two short lines: the type you chose and why, if it was not obvious, and any split suggestion.

Example:

```text
fix(parser): handle empty input without crashing

An empty string made the tokenizer read past the end of the buffer.
Return an empty token list instead.
```
