---
name: commit
description: Generate a conventional commit message for the current session's work. Uses run_git when available; otherwise reconstructs from conversation history.
---

When invoked with `/commit [optional hint]`:

1. **Understand what changed.** If `run_git` is available: `run_git(["diff", "--stat"])` and `run_git(["diff", "--staged"])`. Otherwise reconstruct from `write_file`/`replace_in_file` calls and any `fg-tasks/*.md` context.

2. **Write the message.** Use Conventional Commits: `type(scope): subject` (≤72 chars). Types: `feat fix refactor docs chore test perf`. Subject is imperative mood, no period. Body bullets explain **why**, not what — the diff shows what.

3. **Commit or display.** If `run_git` is available and the user asked to commit: `run_git(["add", "-A"])` then `run_git(["commit", "-m", "..."])`. Otherwise display the message in a code block to copy.

**Notes:**
- If the session touched unrelated things, suggest splitting into multiple commits.
- If nothing changed, say so rather than inventing a commit.
