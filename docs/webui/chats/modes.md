# Modes: Chat and Cowork

The mode selector in the chat toolbar switches between two tool sets, configured separately in **Settings → Tools**. The difference is whether the agent may change project files directly.

| | Chat | Cowork |
|---|---|---|
| For | Normal conversation, questions, research, small scripts | Changing files in the project and working through the task board |
| File-writing tools | Off. The agent writes files through code execution instead. | `write_file` and `replace_in_file` on |
| `update_task_status` | Off | On |
| Tasks runner | Not used | Uses this tool set, including Autopilot |

The read-only tools (`list_files`, `read_file`, `search_workspace`), `execute_code`, `web_search`, `fetch_url`, `check_page` and `run_workers` are on in both by default. `apply_patch`, `append_file`, `delete_file` and `undo_write` are off in both until you turn them on. The full list is in [Tools](../../harness/tools.md).

## Choosing a mode

Stay in **Chat** when you want answers or want to see code in the conversation before anything touches the project. Switch to **Cowork** when the agent should edit project files directly, or when you run [Tasks](../tasks.md).

Turning a tool on in Settings → Tools affects only that mode. [Tool approval](../../harness/checks.md#approval-and-safety) applies in both.

The TUI has no mode switch. In the CLI, `--enable-tools` and `--disable-tools` select tools per run.
