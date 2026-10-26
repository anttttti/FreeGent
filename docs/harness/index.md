# Harness

The harness is everything around the model that makes a free or small model usable as an agent. It is shared by the WebUI, TUI and CLI.

| Page | Covers |
|---|---|
| [Tools](tools.md) | What the agent can call, and the defaults |
| [Roles and sub-agents](roles.md) | Director, Coder, Researcher and parallel workers |
| [Skills and rules](skills.md) | Instructions added to the prompt when their trigger matches |
| [MCP servers](mcp.md) | External tools through the Model Context Protocol |
| [Context and compaction](context.md) | How history is kept within the window |
| [Checks, approval and safety](checks.md) | Step validation, completion gates, tool approval, intent validation |

Choosing models and handling rate limits is covered in [Providers and models](../models/index.md). Running code is covered in [Code execution](../code-execution/index.md).
