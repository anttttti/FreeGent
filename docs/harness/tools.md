# Tools

Tools are the actions the agent can take. Each can be turned on or off per [mode](/webui/chats/modes) in **Settings → Tools**. Fewer tools mean a shorter prompt and fewer wrong choices, so the defaults leave specialised tools off.

| Tool | What it does | Default |
|---|---|---|
| `execute_code` | Run JavaScript, Python or bash. See [Code execution](/code-execution/). | on |
| `list_files`, `read_file`, `search_workspace` | Browse and search the project. `read_file` takes a line range. | on |
| `write_file`, `replace_in_file`, `apply_patch`, `append_file`, `delete_file`, `undo_write` | Edit project files | off in Chat, `write_file` and `replace_in_file` on in Cowork |
| `web_search` | Tavily, Brave or Wikipedia, or a named source: Hacker News, GitHub, Stack Overflow, dev.to, GDELT, DuckDuckGo | on |
| `fetch_url` | HTTP request (GET/POST/…) with headers and body; HTML is reduced to text, and an optional `extract` goal returns only the relevant passages | on |
| `check_page` | Load a project HTML page in a hidden sandbox and report errors, failed resources and console output | on |
| `generate_image` | Pollinations.ai (no key), Hugging Face fallback | on |
| `run_workers` | Run sub-agents in parallel | on |
| `deep_research` | Multi-round research that plans sub-questions, reads sources and writes a cited report | off |
| `academic_search`, `package_search`, `context7_docs` | Papers; npm and PyPI; library documentation from Context7 | off |
| `repo_map`, `ast_query` | Compact code map; symbol queries with exact line numbers (`ast_query` needs the AST setting) | off |
| `run_git` | Git in the repository the dev server runs in; needs the Local sandbox and the git setting | off |
| `update_task_status` | Move a task on the board | on in Cowork only |
| `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, … | Drive a text-only browser through a Playwright bridge (CLI: `--browser-url`) | off |

Tool results are truncated before they enter the history; see [Keeping tool results small](/harness/context#keeping-tool-results-small). [MCP servers](/harness/mcp) add more tools, named `mcp__<server>__<tool>`.
