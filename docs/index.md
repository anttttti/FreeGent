---
layout: home
hero:
  name: FreeGent
  text: Free Agentic AI for Everyone
  tagline: An AI agent that reads and edits files, runs code, searches the web and keeps a task board, on free-tier cloud models and local models.
  actions:
    - theme: brand
      text: Open freegent.ai
      link: https://freegent.ai/
      target: _self
    - theme: alt
      text: Overview
      link: /overview
features:
  - title: Free tiers and local models
    details: Gemini, OpenRouter, NVIDIA, Kilo, Groq and more out of the box, or Ollama, vLLM and LM Studio on your machine. A rate-limited model goes on a cooldown and the next one takes over.
    link: /models/
    linkText: Providers and models
  - title: Built for diverse models
    details: Small or large, cloud or local, each model gets the same reliable agent. History is compacted before the window fills, malformed tool calls are repaired, and steps are checked. Workers run subtasks in parallel.
    link: /harness/
    linkText: Harness
  - title: WebUI, TUI and CLI
    details: One agent core behind a browser app, an interactive terminal session and a headless runner for scripts and CI.
    link: /overview#one-agent-core-three-interfaces
    linkText: The three interfaces
  - title: Runs code safely
    details: The WebUI keeps a project filesystem and a bash terminal inside your browser, so JavaScript, Python and shell commands run in sandboxes there, not on a server. On your own machine, bash can run for real, isolated with bubblewrap.
    link: /code-execution/
    linkText: Code execution
---

## Getting started

1. Open [freegent.ai](https://freegent.ai). There is no install and no account.
2. Go to **Settings → Models → API Credentials** and paste a key for one provider. [Default providers](/models/providers) lists where to get free ones.
3. Start a chat. The agent may call tools; each call shows as a step, and files it creates appear in **Project**. For longer jobs, switch to **Cowork** mode and start **Autopilot** on the [task board](/webui/tasks): it works through the tasks on its own for as long as the browser tab stays open.

Keys, chats and files stay in your browser. Browsers block direct calls to most model APIs, so freegent.ai sends model requests, with your key, through a small Cloudflare proxy that forwards only to a fixed list of provider hosts and stores nothing ([details](/models/proxy)). **Settings → Privacy** can switch the Worker off or restrict FreeGent to your local network. For local models, bash on your machine, the terminal and the CLI, see [Local or self-hosted](/local/).

## Documentation

| Section | What it covers |
|---|---|
| [Overview](/overview) | The design ideas and where each is explained |
| [WebUI](/webui/) | Project, Tasks, Chats and modes, Settings |
| [Providers and models](/models/) | Default providers, keys, fallbacks, retries, rotation, local models |
| [Harness](/harness/) | Tools, roles, skills, MCP, compaction and checks |
| [Code execution](/code-execution/) | Python, JavaScript and bash, in the browser or on your machine |
| [Local or self-hosted](/local/) | Install, TUI, CLI, LAN access, your own site and Worker |

