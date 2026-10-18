# Skills and rules

A skill is a short Markdown instruction that FreeGent adds to the prompt only when it is relevant. This keeps the base system prompt small, which saves tokens on every request, and still lets the agent follow a detailed procedure for debugging, testing, PDFs and so on when the situation calls for it. A **rule** is the same kind of file, but a standing instruction rather than a procedure.

## What is built in

- Skills such as `debug`, `test`, `search`, `deep-research`, `failure-recovery`, `pdf`, `sql`, `image`, `audio`, `datetime` and `location`.
- Rules for git, HTTP, JavaScript, documents, AST queries, file persistence and data fallbacks.
- In the repository's `skills/` folder: `commit`, `plan`, `research`, `tasks` and `verify-with-tests`.

Switch them on and off in **Settings → Skills**, where you can also edit the triggers of each.

## When a skill is added

Triggers are checked at the start of each turn, and some fire in the middle of a turn after a tool result.

| Trigger | Fires when |
|---|---|
| `trigger` | A whole-word match of a keyword in your message (`sql` does not match `mysql`) |
| `trigger_on_filetype` | The message mentions, or the project contains, a file with this extension |
| `trigger_on_media` | The message has an attachment of this type: image, audio, video, pdf or file |
| `trigger_on_message_pattern` | A regular expression matches the message |
| `trigger_on_event` | `session-start` (first message) or `task-start` (a task-completion request) |
| `trigger_on_tool` | A tool ran and its result contains a string or satisfies a comparison, for example `execute_code=>exit_code!=0` |
| `trigger_on_failure` | N failures of a kind (`http_error`, `tool_error`) in one turn |
| `trigger_on_repeat`, `trigger_on_history_tool`, `trigger_on_turn`, `trigger_on_file_present`, `trigger_on_completion` | A tool repeats N times, a tool appears in the history, the first turn, a path exists, or the model declares the work completed or blocked |

A skill can also be restricted: `exclude_roles` stops it for given main roles, `requires_tools` skips it when a tool it needs is disabled, and `roles` injects its body into the prompts of workers with those roles regardless of triggers.

Always-on skills stay in the system prompt, which keeps the start of the prompt stable and cacheable. Triggered skills are prepended to your message as a guidance block, and mid-turn triggers arrive as a short note. A shared budget caps the total text injected, because everything that triggers costs context on every request.

## Writing your own

A skill is `skills/<name>/SKILL.md` in the project, or created in **Settings → Skills** (a form, or **Import from file**). Front matter, then the body:

```markdown
---
name: my-skill
description: One line shown in the Skills list and in the prompt
trigger: release notes, changelog
trigger_on_filetype: .md
---

## Steps

1. Read CHANGELOG.md.
2. …
```

- `name` must match the folder name. Everything after the front matter is the body, injected as written.
- Keep skills short. Prefer a specific trigger over `session-start`.
- Writing a file under `skills/` reloads the list at once.
