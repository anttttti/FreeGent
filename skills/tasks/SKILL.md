---
name: tasks
description: Create, inspect, and update task files in fg-tasks/. Automatically active when the user message mentions tasks.
trigger: task
requires_tools: update_task_status
---

## Task Management

### Creating tasks

When the user says **"Add tasks:"**, **"Add task:"**, or asks to add items to the backlog — **create task files and stop. Do not begin implementing the tasks.**

**Step 1 — Find the next ID**
Read `fg-tasks/ledger.md`. Note the highest existing task ID. New tasks start at that number + 1, counting up for each task added (gaps in the sequence are fine).

**Step 2 — Write one file per task**
Path: `fg-tasks/NNN-slug.md`, where NNN is zero-padded to 3 digits.

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

[One paragraph: what needs to be done, why, and what done looks like.]

## Acceptance Criteria
- [ ] criterion

## Log

### YYYY-MM-DD — status: open
Created.
```

Rules:
- Slug: lowercase, hyphens only, ≤30 chars — e.g. `072-remove-confirm-dialog`
- Priority: Low / Medium / High — default Medium unless the user specifies
- Do not edit `fg-tasks/ledger.md` — it updates automatically when task files are written
- Do not start implementing the tasks unless the user explicitly asks

**Step 3 — Confirm**
After writing all files, list the created task IDs and titles. Ask if the user wants to start on any of them.

---

### Working on tasks

**When starting any task:**
1. Read `fg-tasks/ledger.md` to orient — it lists every ID, title, and status.
2. Call `update_task_status(path, "in-progress")` as your **first action**.
3. Read the full task file before touching any code.

**While working:**
- Do not edit `fg-tasks/ledger.md` directly — the ledger row updates automatically via `update_task_status`.
- If you notice a mismatch between the ledger and a task file's frontmatter, the task file is the source of truth — correct the ledger row in-place.

**When finishing:**
- Call `update_task_status(path, "done")` or `"failed"` as your **last action**.
- Append a brief summary to the task's `## Log` section before closing.

---

### Inspecting tasks

- List all tasks: `list_files("fg-tasks/")`
- Find by status or keyword: `search_workspace` with `pattern: "status: open"`, `path_filter: "fg-tasks/"`
- Read the board at a glance: `read_file("fg-tasks/ledger.md")`
- If the ledger is stale (missing entries), note the discrepancy — do not rebuild the entire ledger unless asked.
