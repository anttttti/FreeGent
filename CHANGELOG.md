# Changelog

## v1.0

The first stable release. FreeGent is an agentic AI platform for chat and cowork that runs on free model tiers and local models, in the browser or in your terminal, with no install and no account on [freegent.ai](https://freegent.ai).

### What it is

- **Three interfaces, one agent.** The WebUI (chat, project files, task board, settings), an interactive terminal UI (`freegent`) and a headless CLI (`git diff | freegent -p "review this"`) all run the same agent harness.
- **Free tiers and local models.** Use the free tiers of Gemini, Groq, OpenRouter, NVIDIA, Kilo, Nous and others, or your own OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, llama.cpp). When a model hits its rate limit or quota mid-task, the next one in the rotation takes over and the work carries on.
- **Built for small and large models alike.** Compacted history, repaired tool calls and output checks keep weaker models on track.
- **Autonomous cowork.** Autopilot drives a project from idea to completion on an integrated Kanban task board, with every step visible as a card and a Rerun button.
- **Runs in your browser.** Project files and code execution (JavaScript, Python and bash) run inside the page, in sandboxes the page's own storage cannot be reached from.
- **Extensible.** Skills, rules, roles and sub-agents, and MCP servers.

### Code execution

- JavaScript runs in a sandboxed frame inside a Worker, Python in Pyodide, and bash in WebAssembly in the browser, or as real bash on your machine through the local dev server.
- The in-browser bash is built on [Shiro](https://github.com/williamsharkey/shiro). FreeGent extended it so that 248 commands, builtins and keywords match real bash byte for byte on a corpus of over a thousand test cases (1,430 in the latest sweep, with no bash mismatches). See [Code execution](docs/code-execution/index.md).

### Privacy and security

- Keys, chats and files stay in your browser. The default privacy level, **Provider-only**, sends requests straight from your browser to the model provider and uses no FreeGent server. **Routed** goes through a small Cloudflare Worker that forwards to a fixed list of providers and stores nothing. **Local** reaches only your own network. See [Privacy](docs/privacy.md).
- Agent code in the browser runs in an opaque-origin sandbox. On the local dev server every API call needs a per-install token, credentials never reach the page, and commands run isolated (bubblewrap on Linux) with a credential-free environment. See [SECURITY.md](SECURITY.md).
- Third-party software and licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### Known limits

- API keys typed into Settings are stored in the browser's `localStorage` in plain text.
- JavaScript and Python runs in the browser do not see workspace files larger than about 10 MB (the Local provider: 1 MB). The in-browser bash has no such limit.
- Without bubblewrap (macOS, Windows), local bash runs as you; tool approval then defaults to asking before each command.
- NVIDIA, Kilo and Brave search do not allow browser calls, so they need the Routed level on a hosted page.
- Free tiers have their own rate limits; the rotation works around them but cannot remove them.

### Documentation

- New [Privacy](docs/privacy.md) page and [third-party notices](THIRD-PARTY-NOTICES.md).
- The Code execution page credits Shiro and describes the bash parity testing.
- Links between documentation pages work on GitHub as well as on freegent.ai.
