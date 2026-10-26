# Documentation

The user guide below is built with VitePress and published at <https://freegent.ai/docs/> (`npm run docs:dev` to preview, `npm run docs:build` to build into `dist/docs`; the sidebar is in `.vitepress/config.mts`). Everything else in this folder stays in the repository.

## For users

| Page | Covers |
|---|---|
| [Overview](overview.md) | The design ideas and where each is explained |
| [WebUI](webui/index.md) | Project, Tasks, Chats and modes, Settings |
| [Providers and models](models/index.md) | Default providers, keys, fallbacks and retries, the proxy, local models |
| [Harness](harness/index.md) | Tools, roles, skills, MCP, compaction, checks and approval |
| [Code execution](code-execution/index.md) | Python, JavaScript and bash in the browser or on your machine; git |
| [Local or self-hosted](local/index.md) | Install, LAN access, your own site and Worker; TUI keys and commands; CLI flags |

## For contributors

| Where | What |
|---|---|
| [contributing.md](contributing.md) | Checks, tests, deploying |
| [../AGENTS.md](../AGENTS.md) | Module model, rules, agent-loop architecture |
| [prompts/](prompts/README.md) | Generated snapshots of the runtime system prompts |
| [shiro/](shiro) | Coverage of the in-browser shell's commands |
