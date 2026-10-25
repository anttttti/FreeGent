# FreeGent

**Free agentic AI for everyone.** An AI agent that reads and edits files, runs code, searches the web and keeps a task board, on free-tier cloud models and models on your own machine.

**[Open freegent.ai](https://freegent.ai)**: no install, no account. Open **Settings → Models → API Credentials**, paste a key from one provider and start chatting. [Default providers](https://freegent.ai/docs/models/providers) lists where to get free keys.

## Why FreeGent

- **Free tiers and local models.** Several free-tier providers out of the box, or Ollama, vLLM and LM Studio on your machine. A rate-limited model is replaced by the next one.
- **Built for diverse models.** The same reliable agent for small and large models: compacted history, repaired tool calls, output checks.
- **Runs in your browser.** Project files and code execution (JavaScript, Python, bash) live in browser sandboxes. On your machine, bash can run for real.
- **A task board it works through.** Tasks are Markdown files; Autopilot runs one chat per task. Every message is a checkpoint you can rewind.
- **Your data stays with you.** Keys, chats and files stay in your browser, and you choose where requests may go ([Security](SECURITY.md)).

## Three interfaces, one agent

| | What it is | Start it |
|---|---|---|
| **WebUI** | Chat, project files, task board and settings in the browser | [freegent.ai](https://freegent.ai), or `npm run dev` |
| **TUI** | An interactive terminal session | `freegent`, or `npm run tui` |
| **CLI** | One-off and scripted runs, for CI | `freegent -p "…"` |

## Run it locally

Needs Node.js 22+.

```bash
git clone https://github.com/anttttti/FreeGent
cd FreeGent
npm install

mkdir -p ~/.config/freegent
cp .env.example ~/.config/freegent/credentials   # add at least one API key

npm run dev                                       # WebUI at http://localhost:5000
npm link                                          # optional: the `freegent` command (TUI and CLI)
```

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
