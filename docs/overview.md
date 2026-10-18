# Overview

FreeGent is an AI agent for free-tier cloud models and for models on your own machine. It reads and edits project files, runs code, searches the web, splits work across sub-agents and keeps a task board. Everything in its design serves one goal: stay reliable on diverse rate-limited free models.

## Free and local models first

FreeGent ships with default providers (Gemini, OpenRouter, NVIDIA, Kilo, Groq and others) and works with any OpenAI-compatible endpoint, including Ollama, vLLM and LM Studio. FreeGent updates the latest available models and ranks them for priority. A model that returns a rate-limit error goes on a cooldown and the next one takes over, so a free tier running out mid-task does not stop the work.

- [Default providers](/models/providers): which providers are built in and where to get keys
- [Priority, fallbacks and retries](/models/rotation): cooldowns, rotation, retries, thinking level
- [Local models](/models/local-models): connecting a model server on your machine

## Built for diverse models

The models FreeGent rotates through differ in size, context window and tool-call habits. Small and free models in particular drop tool-call syntax, wander off task and degrade long before their window fills. The harness evens this out:

- History is compacted at about 80K tokens, not when the window is full.
- Tool calls written as text are repaired into real calls, and each step is validated.
- A completion gate checks that work was verified before the agent stops.
- Guidance is injected only when it applies: skills trigger on keywords, file types, tool results and failures, so the system prompt stays short.

See [Context and compaction](/harness/context), [Checks and approval](/harness/checks) and [Skills and rules](/harness/skills).

## One agent core, three interfaces

The same agent loop, tools, skills, roles and model rotation are behind every interface.

| Interface | What it is | Start it |
|---|---|---|
| **WebUI** | Chat, project files, task board and settings in the browser | [freegent.ai](https://freegent.ai), or `npm run dev` |
| **TUI** | An interactive terminal session | `npm run tui` |
| **CLI** | One-off and scripted runs, for CI and benchmarks | `npx tsx fg-run.ts --task "…"` |

freegent.ai needs no install and no account; you add API keys in Settings. To run any interface on your own machine, or host your own copy, see [Local or self-hosted](/local/). The [WebUI section](/webui/) describes the browser app.

## Sub-agents

The main agent can hand parts of a job to workers that run in parallel. Each worker gets a snapshot of the workspace, and its file edits are merged afterwards, with a model-assisted merge when two workers touched the same file. Roles (Director, Coder, Researcher) set a worker's prompt and tools. See [Roles and sub-agents](/harness/roles).

## Code runs in sandboxes

The `execute_code` tool runs JavaScript, Python and bash. In the browser they run in an isolated frame: JavaScript in a Worker, Python in Pyodide, bash in a WebAssembly x86-64 emulator. On your own machine, bash can run for real, isolated with bubblewrap on Linux. See [Code execution](/code-execution/).

## Project, tasks and modes

The **Project** is the agent's workspace, kept in your browser or in a folder you connect. **Tasks** are Markdown files shown on a board, and Autopilot works through them one chat per task, with quality gates between columns. **Chat** and **Cowork** modes switch the tool set between conversation and task work. See [Project](/webui/project/), [Tasks](/webui/tasks) and [Chats and modes](/webui/chats/).

## Extensible

- [Skills and rules](/harness/skills) are Markdown files you can add.
- [MCP servers](/harness/mcp) add external tools.
- [Profiles](/webui/settings#profiles) save and share model lists, tools and agent settings (never keys).

## Your data stays with you

Keys, chats, settings and project files are stored in your browser, or on your machine when you run locally. The hosted proxy forwards requests to a fixed list of provider hosts and stores nothing. See [How requests reach providers](/models/proxy) and [Where your data lives](/webui/settings#where-your-data-lives).
