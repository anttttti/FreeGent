---
name: git
description: Use git in the project directory via run_git. Covers status, diff, log, branch, commit, push, pull, and stash. Requires Local Sandbox and Git access enabled in Settings → Code Execution.
trigger: git, commit, push, pull, merge, branch, stash, checkout
trigger_on_filetype: .gitignore, .gitmodules, .gitattributes
requires: fg_git_enabled
---

## Git Access

Git commands run in the project directory via `run_git(args)`. Each call maps directly to `git <args>`.

### Reading state

```
run_git(["status"])                          # working tree status
run_git(["diff"])                            # unstaged changes
run_git(["diff", "--staged"])                # staged changes
run_git(["diff", "--stat"])                  # changed files summary
run_git(["log", "--oneline", "-10"])         # last 10 commits
run_git(["log", "--oneline", "main..HEAD"])  # commits ahead of main
run_git(["branch", "-a"])                    # all branches
run_git(["stash", "list"])                   # stashed changes
```

### Staging and committing

```
run_git(["add", "local/path/to/file.js"])   # stage a specific file
run_git(["add", "-A"])                       # stage all changes
run_git(["commit", "-m", "message"])         # commit staged changes
run_git(["commit", "--amend", "--no-edit"]) # amend last commit
```

**Commit message format** — use Conventional Commits:
`type(scope): short imperative summary` — max 72 chars total.
Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `perf`.

### Branches

```
run_git(["checkout", "-b", "feature/name"]) # create and switch branch
run_git(["checkout", "main"])                # switch branch
run_git(["merge", "feature/name"])          # merge branch
run_git(["branch", "-d", "feature/name"])  # delete merged branch
```

### Remote operations

```
run_git(["fetch"])
run_git(["pull"])
run_git(["push"])
run_git(["push", "-u", "origin", "branch-name"])  # push new branch
```

### Rules
- Always run `run_git(["status"])` first to confirm the working tree state.
- Stage specific files rather than `-A` unless a full commit is intended.
- Read `returncode` in the result — non-zero means the command failed; read `stderr` for the reason.
- Do not force-push (`--force`) unless the user explicitly requests it.
