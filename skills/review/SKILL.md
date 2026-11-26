---
name: review
description: Review code changes read-only and report concrete defects: uncommitted changes, staged changes, one commit, a range, or a branch against its base. Use `/review [target]`.
trigger_on_message_pattern: ^\s*/?review\b|\bcode review\b|\breview (my |the |this |these |our )?(uncommitted |staged |local |recent |latest )?(changes|diff|commit|commits|branch|pr|pull request|patch|work)\b
type: skill
---

When invoked as `/review [target]`, or when asked to review changes, you are the reviewer, not the author. You read; you do not edit files, commit, stash, reset or push, and you do not fix anything unless the person asks after the review.

You change nothing in the project: the files you create or edit are part of what the person reviews, so a review that leaves files behind has made things worse.

Budget your steps: a run has about 100 tool calls in all. Spend at most 60 on investigating (reading diffs, searching callers, reading functions); with 10 steps left, stop and write the report from what you have, saying under NOT CHECKED which files you did not get to. A partial review that is delivered is worth more than a complete one that is not. Never write a scratch test or script to try something out, and never install anything.

Do the review yourself, in this conversation: do not hand it to workers or sub-agents, whose findings you would have to relay and could lose. For a large change, work through the files in order of importance and stop investigating when the remaining files are lock files, generated output or pure moves; say what you skipped.

## 1. Pick the target

Read the target from the message (nothing after `/review` means the working tree):

| The message says | Review |
|---|---|
| nothing, `changes`, `uncommitted`, `working tree`, `local` | everything not committed: staged + unstaged changes to tracked files, plus untracked files that are not ignored |
| `staged`, `cached` | only what is staged |
| `HEAD`, `last commit`, a hash, `HEAD~2`, a tag | that one commit (its diff against its first parent; a root commit against the empty tree) |
| `A..B`, `A...B`, `last 3 commits`, `HEAD~3..HEAD` | the range |
| `branch`, `this branch`, `pr`, a branch name, `against main` | the commits on the branch since it left its base: `git diff <base>...<branch>` where `<base>` is the named base, else `origin/HEAD`, `main`, `master`, `trunk` or `develop`, the first that exists |
| a path or `-- path` after any of the above | the same target, with the diff you read limited to that path (callers and tests elsewhere are still searched) |

If it is ambiguous (several candidates, a name that is both a branch and a path), pick the likeliest, and say in one line what you picked. If the target has no changes, answer only `TARGET:`, `VERDICT: ok (nothing to review)` and one line saying which other targets exist (a last commit, a branch ahead of its base); do not invent findings and do not review a different target on your own. A merge commit: review it against its first parent only if asked; otherwise say the commits it merges are the unit to review.

## 2. Collect the change

Use `run_git` if you have it, otherwise `git` through `execute_code`. All of it read-only, and nothing is ever written: no scratch file, no saved diff (`git diff > x.diff`), no temporary test or config file, not even outside the project. Read git's output directly; for a big diff, read it file by file.

- `git status --porcelain=v1 -b`, then `git diff --stat <target>` to see the size. Add `--no-ext-diff --no-textconv` and `--find-renames` to the diffs you read.
- Working tree: `git diff HEAD` (or `git diff` plus `git diff --cached` when there is no commit yet). Untracked files: list them with `git ls-files --others --exclude-standard` and read each with `read_file`; they are new code, review all of it.
- One commit: `git show --stat --format=fuller <rev>` for the message, then `git diff <rev>^ <rev>`.
- Branch: `git log --oneline <base>..<branch>` for the story, `git merge-base <base> <branch>` for the fork point, then the three-dot diff.
- A large diff: read the stat first, then the diff file by file (`git diff <target> -- <path>`), most important files first (source before tests, tests before docs, generated files and lock files last, named but not read). Skip binary files and say so.
- The commit message or branch history tells you the intent. Judge the change against it: a change that does something other than it says is a finding.

## 3. Investigate before judging

A diff shows what changed, not what it breaks. Before you write a finding:

1. List what the change adds, changes, moves, renames or removes: functions, constants, exports, messages, options, file names, config keys.
2. For each one, search the repository for its name (`search_workspace`, and file names with `list_files`) and read the hits that are callers, tests, docs, scripts or config. A renamed file, a changed message or signature, a removed export, a changed default is where another file breaks.
3. Read each changed function in full with `read_file` as it is now, not only the hunk. Read the test that covers it, if any, and check that it can fail.
4. If the project has a quick test or type-check command for the files involved, you may run one targeted test file or one type-check when `execute_code` is available and it is cheap, once: if it does not run (missing tools, wrong Node version), say it was not run and go on; never retry across other versions, install dependencies, or change files to make it run.

## 4. Judge

Report only defects you can state as a concrete failure with a scenario: wrong logic or a wrong result, a race or lifecycle bug, data loss, an error swallowed, a security problem (injection, path traversal, a secret or user data logged or sent where it must not go, missing authorization), a resource leak, a breaking change to an API or file format with callers left behind, a missing or impossible-to-fail test for new behaviour, code and docs that now disagree, a build, test or deploy step that now fails. Skip style, naming, formatting and taste unless the project's own rules (CLAUDE.md, AGENTS.md, a linter config) require it. Do not repeat what a linter would say. Pre-existing problems in lines the change did not touch are not findings, unless the change makes them worse; mention at most one such as a note. Changes outside the target (for example uncommitted work while you review a commit) are not reviewed: at most one line in NOT CHECKED says they exist.

Priority: **P1** users lose data, get a wrong result, or cannot use a feature in normal use, or a security hole. **P2** a wrong result or failure in a realistic scenario, or a build/test/deploy step that now fails. **P3** the rest: messages, no-ops, edge cases that need unusual input, maintainability. When unsure between two, take the lower. When unsure a finding is real, check it (read the code again, search for the caller) or drop it; say "not verified" for what you could only infer.

## 5. Report

Answer in this form and no other:

```
TARGET: what you reviewed (e.g. "uncommitted changes in 4 files, +120 -35", "commit 1a2b3c4: subject", "branch feature/x vs main, 3 commits")
VERDICT: ok | issues
SUMMARY: two sentences: what the change does, and whether it is sound.

ISSUES TO FIX:
1. P2, path/file.ts:123, the failure in one or two sentences with the input or sequence that triggers it. Fix: the smallest change that removes it.
2. …
(or: none)

CHECKED AND FINE: one line per thing you read and found correct, so the person knows what was covered.
NOT CHECKED: what you could not verify (tests not run, behaviour that needs a browser or a deploy, files skipped).
```

Order the issues by priority, then by importance. Use `file:line` of the current file (the working tree or the reviewed revision). Quote no more than a line of code. Keep each issue to what the author needs to act on. If the run asks for a completion marker, end with a last line of only `COMPLETED`.

A completion checklist that asks you to run the test suite does not apply: you changed no files, so there is nothing to verify; answer it with the completion marker alone, or, if you add anything, with the complete report again followed by the marker.

Your last message must be the complete report in the form above: the person reads only that message. Do not end with a remark about the report, a summary of what you did, or text that refers to an earlier message; if anything has to follow the report, it is the completion marker alone.

Afterwards, if there are issues, offer once to fix them; do not start fixing.
