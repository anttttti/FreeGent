# Roles and sub-agents

The main agent can hand parts of a job to workers with `run_workers`. Workers run in parallel, each on a snapshot of the workspace. When they finish their file edits are merged back, with a model-assisted merge when two workers changed the same file. A role sets a worker's prompt and the tools it may use.

| Role | What it is for |
|---|---|
| **Director** | The default main role. As a worker it is a fork of the main agent with its full context and tools. |
| **Coder** | Multi-file edits. Sees the request and the task it was given, not the whole conversation. |
| **Researcher** | Searching and reading: workspace search, code structure, code execution and, when enabled, web tools. Also sees only its task. |

Workers are useful when a job splits into independent parts, such as researching three libraries or editing unrelated modules. Each worker costs its own model calls, so on a tight free tier fewer, larger tasks go further.

## Configuring roles

- **Settings → Roles** shows and edits each role's system prompt and its tool ceiling (the most tools a worker in that role can get). Uncheck a role to stop workers using it; **Reset** restores the built-in prompt.
- Extra roles are files under `roles/` in the project and appear in Settings → Roles next to the built-in ones.

## Worker settings

In **Settings → Agent → Workers**:

| Setting | Effect |
|---|---|
| Lean worker context | Workers get scoped context and a minimal tool set instead of the full system prompt (on by default) |
| Director workers fork the full context | A Director worker starts with the main agent's prompt, tools and conversation, which providers can serve from the prompt cache (on by default). Coder and Researcher workers always get only their task. |
| Worker output reduce | When workers return more than about 2,000 characters in total, their outputs are merged into one compact summary |
| Max delegation depth | Whether workers may start workers of their own (0 to 2) |
| Worker thinking budget | Reasoning budget for workers; see [Thinking level](/models/rotation#thinking-level) |
| Role model routing | Planning workers use your first model, execution workers the later ones |
