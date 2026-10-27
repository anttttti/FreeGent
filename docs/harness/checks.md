# Checks, approval and safety

The harness checks the agent's own output while it works, and asks you before risky actions.

## Step checks

- **Repaired tool calls.** When a model writes a tool call as plain text instead of a real call, FreeGent turns it into a real call.
- **Narration without action** and questions the agent could answer by looking (for example by reading a file) are flagged, and the agent is nudged to act.
- **Completion gate.** Before the agent declares a task done, checks look at what the run actually did. If the work was not verified, for example the code was never run, the agent gets one nudge to do so. A second declaration is accepted, since the agent may have a reason; a declaration that the task is blocked is never bounced.
- **Parse check after edits.** After `write_file`, `replace_in_file` or `apply_patch` (a worker's too), a file that no longer parses gets the error in the tool result (`syntax_error`, with file, line and column) and a hint to undo the edit if the fix is not obvious. In the terminal and CLI, JavaScript goes through `node --check` and Python through `compile()`. In the WebUI, JavaScript files and the inline `<script>` blocks of HTML pages are parsed with [acorn](https://github.com/acornjs/acorn), loaded from esm.sh the first time it is needed (so offline the check is skipped). JSON files are checked everywhere, except files that allow comments by convention (`tsconfig*.json`, `.vscode/`). Python is not checked in the browser: running the file reports a `SyntaxError` anyway. CSS and HTML markup are not checked, because browsers accept broken markup by design. A file that still does not parse when the agent declares the task done bounces that declaration once (`broken_syntax` in [Nudges](nudges.md)).
- **Edit review** (off by default): when `write_file` would change at least half of an existing file's lines, a second model call reviews the edit before it is applied and rejects it if content was dropped or broken. It adds latency.

## Intent validation

**Settings → Agent → Tool call intent validation** screens calls to `fetch_url`, `write_file`, `execute_code` and `delete_file` for signs of prompt injection from fetched pages. A flagged call is not run, the agent is told why, and the attempt is logged to `memory/injection-attempts.md` in the project.

| Setting | What it does |
|---|---|
| Off | No screening |
| **Heuristic** (default) | Fast pattern checks on the call's arguments: known injection phrases ("ignore previous instructions", "you are now…", `[SYSTEM]:` and similar), and for `write_file` and `delete_file` paths that climb out of the project (`../`) or point at sensitive locations (`.ssh`, `.aws`, `.env`, key files, shell history) |
| LLM-based | The heuristic checks, plus a model call that judges whether the call is something your request would lead to |

The model check is meant to catch what patterns cannot, such as a fetched page telling the agent to send your files to another address. It runs only when it can matter: after the agent has read content from outside the conversation in the same turn (a fetched page, search results, a browser page or an MCP server), and only when the heuristic found nothing. The judge sees your request and the call, treats the call as data, and decides YES (block) or NO (allow). The same call is judged once per turn, at most 15 calls are judged per turn, and a judge that fails or does not answer lets the call through. It uses the utility model when one is set. It adds a model call for each risky call it judges, so it is off unless you choose it.

## Approval and safety

**Settings → Agent → Tool approval** has three levels. A prompt offers Allow, Deny, and "Allow all *tool* calls this session".

| Level | Asks before |
|---|---|
| Off (default) | nothing |
| High-risk only | `delete_file`; `execute_code` in JavaScript or bash (Python running in the browser's Pyodide is not asked about); anything that runs on your machine through the local server (`execute_code`, `run_git`); MCP tools that are not marked non-destructive, which includes every tool the server does not annotate |
| All writes | everything above, plus every other tool that changes files (`write_file`, `replace_in_file`, `apply_patch`, `append_file`, `undo_write`), `execute_code` in any language, MCP tools not marked read-only, browser actions that act on a page (navigate, click, type, select), and `run_workers` when a requested worker's role can edit files |

When the setting has never been changed it is Off, except where code runs on your machine without isolation (the Local sandbox without bubblewrap), where it is High-risk only.

Sub-workers are asked about less: only commands that run on your machine and MCP tools. Their file edits are staged and applied when the run ends, so under All writes the delegation itself is what you approve. After you press Stop, the rest of a tool batch does not start and does not ask for approval.

See [Code execution](../code-execution/index.md) for what each sandbox protects and [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md) for the threat model.
