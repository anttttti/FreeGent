# FreeGent

**Free agentic AI for everyone.** An AI agent that reads and edits files, runs code, searches the web and keeps a task board, on free-tier cloud models and models on your own machine.

**[Open freegent.ai](https://freegent.ai)**: no install, no account. Paste an API key from one provider and start chatting.

## Why FreeGent

- **Free tiers and local models.** Gemini, OpenRouter, NVIDIA, Kilo, Groq and more out of the box, or Ollama, vLLM and LM Studio on your machine. When a model hits a rate limit, the next one takes over.
- **Built for diverse models.** Small or large, cloud or local, each model gets the same reliable agent: history is compacted before the window fills, malformed tool calls are repaired, and output is checked for known failure patterns.
- **Runs in your browser.** The project filesystem and code execution (JavaScript, Python, bash) live in browser sandboxes. On your own machine, bash can run for real, optionally isolated.
- **A task board it works through.** Tasks are Markdown files; Autopilot runs them one chat per task. Every message is a checkpoint you can rewind.
- **Your data stays with you.** Keys, chats and files stay in your browser. You choose whether requests may go through the hosted proxy, directly to providers, or stay on your local network.

## Three interfaces, one agent

| | What it is | Start it |
|---|---|---|
| **WebUI** | Chat, project files, task board and settings in the browser | [freegent.ai](https://freegent.ai), or `npm run dev` |
| **TUI** | An interactive terminal session | `freegent` |
| **CLI** | One-off and scripted runs, for CI | `freegent -p "…"` |

## Run it locally

Needs Node.js 22+.

```bash
git clone https://github.com/anttttti/FreeGent
cd FreeGent
npm install

mkdir -p ~/.config/freegent
cp .env.example ~/.config/freegent/credentials   # add at least one API key

npm run dev                                       # http://localhost:5000
```

The `freegent` command comes from `npm link` in the repository.

## Documentation

The guide is at **[freegent.ai/docs](https://freegent.ai/docs/)**; the same pages are in [`docs/`](docs).

- [Overview](docs/overview.md): the design ideas
- [WebUI](docs/webui/index.md): Project, Tasks, Chats, Settings
- [Providers and models](docs/models/index.md): providers, keys, fallbacks, local models
- [Harness](docs/harness/index.md): tools, skills, MCP, compaction, checks
- [Code execution](docs/code-execution/index.md): Python, JavaScript and bash
- [Local or self-hosted](docs/local/index.md): install, TUI, CLI, your own site
- [Security](SECURITY.md) · [Contributing](docs/contributing.md)

## License

MIT. See [LICENSE](LICENSE).
