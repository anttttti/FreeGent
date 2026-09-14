---
name: plan
description: Decompose a goal into ordered tasks and write each as a fg-tasks/NNN-slug.md file. Shows the board before executing anything. Use at the start of any non-trivial piece of work.
---

## Instructions

When invoked with `/plan [goal]`:

### Step 1 — Read the current task board
Call `list_files("fg-tasks/")` and note the highest existing task ID number so you know where to start numbering.

### Step 2 — Decompose the goal
Break it into 3–8 concrete, independently-completable tasks:
- **Specific**: not "improve code" but "add rate limiting to /api/login in auth.py"
- **Small**: completable in one agent turn with a clear done condition
- **Ordered**: prerequisites first; later tasks may depend on earlier ones
- **Named**: use a short imperative verb phrase as the title

If the goal is already broken into subtasks by the user, respect that structure.

### Step 3 — Write the task files
For each task, write `fg-tasks/NNN-slug.md`:

```
---
id: NNN
title: Short imperative task title
status: open
priority: Medium
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Short imperative task title

[One paragraph: what needs to be done, why, and what "done" looks like.]

## Acceptance Criteria
- [ ] criterion

## Log

### YYYY-MM-DD — status: open
Created as part of plan for: [goal]
```

Rules:
- IDs are zero-padded to 3 digits: 001, 002, 003
- Slugs: lowercase, hyphens only, max 30 chars — e.g. `003-add-rate-limiting`
- Priority: Low / Medium / High — default Medium unless the user specifies
- Use today's date for both `created` and `updated`

### Step 4 — Stop and confirm
After writing all task files, output a numbered list of the created tasks. Then ask:

> "Plan written — [N] tasks on the board. Ready to start with task 001?"

**Do not begin execution until the user confirms.**

If any task is ambiguous or depends on information you don't have, flag it explicitly and ask before proceeding.
