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

The Tasks tab shows the files as a board with columns **To do, In progress, Review, Done**. `todo`, `open` and `blocked` tasks sit in To do. Moving a task between columns changes its `status`, and the agent can do the same with `update_task_status` (available in [Cowork mode](chats/modes.md)).

## Running tasks

- **Run** works on the next task in To do.
- **Autopilot** keeps going, with one chat per task, until none are left. **Pause**, **Resume**, **Restart** and **Stop** control a run. Stopping a running Autopilot to import or delete a project asks first.

The runner uses the [Cowork](chats/modes.md) tool set: started in Chat mode, it switches to Cowork and says so in the run log.

When the run ends, the log says "All tasks complete" only if no task is left; otherwise it names the tasks left blocked (usually waiting for your answer), failed, or refused by a start gate. A run ends when the page reloads (or the browser reloads a tab it had put to sleep). The reloaded page opens the Tasks tab and says the run was interrupted, which task it was on and how many are open; press Autopilot to continue. It does not restart by itself.

## Quality gates

Gates check a task before it moves to Review or Done. They are set in **Settings → Agent**; lifecycle gates are on by default in the browser and off in headless runs. Starting a task checks its `depends` list (a task waiting on an unfinished or missing one is not started) and, when the task has no Acceptance Criteria, has a model draft four to seven. Moving to Review runs a completeness check, which refuses while the task still has unchecked `- [ ]` criteria. Moving to Done runs the acceptance review, the test runner and the page check.

| Gate | What it does |
|---|---|
| Acceptance criteria review | Checks each acceptance criterion against the changed files |
| Test runner | Runs the project's tests: `npm test` when `package.json` has a real test script, otherwise each test file on its own (`test_*.mjs`/`.js`/`.py`, `*.test.js`, `*.spec.js`, `*_test.py`, also under `tests/`; JavaScript with `node`, Python with `python3`, which runs its `test_*` functions and `unittest` cases without pytest). A failing test blocks Done and names the file. Needs a code sandbox. |
| Page check | In the browser, with the test runner on: loads the project's root `index.html` (or its only root page) as `check_page` does; an error on load blocks Done. |

The test runner and the page check bounce a given failure once. If the agent marks the task done again with the same failure (it may predate the task), the task moves to Done marked `qa: unverified`, and the agent is told to say so. A test tool the sandbox lacks (for example `node:test` or pytest) is not counted as a failure.
| Regression guard | Runs the project's build, lint or typecheck command (from `WORKFLOW.md` or detected from `package.json`). Off by default. |

A task that fails a gate goes back for rework. After the **rework limit** it is marked blocked instead of retried.

## Autopilot settings

Also in Settings → Agent, under Autonomous Agent Loop:

- **Task/Progress Ledger** keeps explicit ledger files for coherence over long runs.
- **Review message logs** saves each session log to `logs/` and creates a task to review it for inefficiencies.
- **Consecutive failure limit** pauses the loop when that many tasks in a row fail without progress, so you can look and redirect.
