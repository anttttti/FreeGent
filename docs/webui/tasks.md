# Tasks

Tasks turn a larger goal into a list of small jobs on a Kanban board that the agent works through one by one. They are plain Markdown files, so you can read, edit and version them like any other project file.

## The task files

Each task is a file in `fg-tasks/` (or `local/fg-tasks/` in an attached folder) with front matter and a body:

| Part | Meaning |
|---|---|
| `id`, `title` | Identify the task. Tasks with the same title are shown once. |
| `status` | `todo`, `open`, `blocked`, `in-progress`, `in-review` or `done`. `review` and `completed` are read as `in-review` and `done`. |
| `depends` | Optional: ids of tasks, separated by spaces or commas, that must be done before this one can start |
| `priority` | A label shown on the card |
| `## Acceptance Criteria` | A checklist the task must meet to count as done |
| `## Log` | Notes appended as the task is worked |

The built-in task guidance (the `task-setup` and `execution-workflow` skills) knows the format, and FreeGent keeps `fg-tasks/ledger.md`, an index of the tasks, up to date. To create tasks, ask the agent: "add tasks: …". It writes the files and does not start work. You can also add and edit a task by hand from the board (title, status, priority, description, acceptance criteria and attachments).

## The board

The Tasks tab shows the files as a board with columns **To do, In progress, Review, Done**. `todo`, `open` and `blocked` tasks sit in To do. Moving a task between columns changes its `status`, and the agent can do the same with `update_task_status` (available in [Cowork mode](/webui/chats/modes)).

## Running tasks

- **Run** works on the next task in To do.
- **Autopilot** keeps going, with one chat per task, until none are left. **Pause**, **Resume**, **Restart** and **Stop** control a run. Stopping a running Autopilot to import or delete a project asks first.

The runner always uses the [Cowork](/webui/chats/modes) tool set.

## Quality gates

Gates check a task before it moves to Review or Done. They are set in **Settings → Agent**; lifecycle gates are on by default in the browser and off in headless runs. Starting a task checks its `depends` list (a task waiting on an unfinished or missing one is not started) and, when the task has no Acceptance Criteria, has a model draft four to seven. Moving to Review runs a completeness check, which refuses while the task still has unchecked `- [ ]` criteria. Moving to Done runs the acceptance review and the test runner.

| Gate | What it does |
|---|---|
| Acceptance criteria review | Checks each acceptance criterion against the changed files |
| Test runner | Finds and runs test files related to the changed files; failing tests block completion. Needs a code sandbox. |
| Regression guard | Runs the project's build, lint or typecheck command (from `WORKFLOW.md` or detected from `package.json`). Off by default. |

A task that fails a gate goes back for rework. After the **rework limit** it is marked blocked instead of retried.

## Autopilot settings

Also in Settings → Agent, under Autonomous Agent Loop:

- **Task/Progress Ledger** keeps explicit ledger files for coherence over long runs.
- **Review message logs** saves each session log to `logs/` and creates a task to review it for inefficiencies.
- **Consecutive failure limit** pauses the loop when that many tasks in a row fail without progress, so you can look and redirect.
