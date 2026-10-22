# FreeGent

**An AI agent that runs in your browser, your terminal, or a script, against free-tier cloud models and models on your own machine.**

FreeGent reads and edits files, runs code, searches the web, splits work across sub-agents and keeps a task board. It is built to stay reliable on diverse rate-limited free models: it rotates between models when one hits a limit, compacts long chats, and checks its own tool calls.

**[Open freegent.ai](https://freegent.ai)** — nothing to install. Paste an API key from any provider in [Default providers](docs/models/providers.md) and start chatting.

## Three ways to run it

| | What it is | Start it |
|---|---|---|
| **WebUI** | Chat, project files, task board, settings. Runs in the browser. | [freegent.ai](https://freegent.ai), or `npm run dev` |
| **TUI** | Interactive terminal session on the same agent core. | `freegent` (or `npm run tui`) |
| **CLI** | One-off or scripted runs, for CI and benchmarks. | `freegent -p "…"` (or `npx tsx fg-run.ts --task "…"`) |

The `freegent` command comes from `npm link` (or `npm install -g .`) in the repository. With no arguments it opens the TUI; `-p` runs the agent once and prints only the answer, and text piped in is added to the request (`git diff | freegent -p "review this"`). Without a terminal on either side it behaves as `-p`.

## Hosted site or your own machine?

| | Hosted site (freegent.ai) | Local dev server (`npm run dev`) |
|---|---|---|
| Install | none | Node.js 22+, `git clone`, `npm install` |
| API keys | typed in Settings, stored in your browser | in `~/.config/freegent/credentials`, kept on the server; the page only gets placeholders |
| Cloud providers | yes, through FreeGent's hosted proxy | yes, through the local server |
| Local models (Ollama, vLLM, LM Studio) | no | yes |
| Code the agent runs | in-browser sandboxes (JavaScript, Python, WASM bash) | the same, plus real bash on your machine (optionally isolated) |
| `run_git` | no | yes (opt-in) |

Details: [Overview](docs/overview.md) · [Providers and models](docs/models/index.md).

## Quick start (local)

```bash
git clone https://github.com/anttttti/FreeGent
cd FreeGent
npm install

mkdir -p ~/.config/freegent
cp .env.example ~/.config/freegent/credentials   # add at least one API key

npm run dev                                       # http://localhost:5000
```

Open the URL, pick a model in **Settings → Models**, and send a message. With no key at all, the Kilo route in the default model list can still answer.

## Documentation

The guide is published at **[freegent.ai/docs](https://freegent.ai/docs/)**. The same pages are in [`docs/`](docs).

| Page | Covers |
|---|---|
| [Overview](docs/overview.md) | The design ideas and where each is explained |
| [WebUI](docs/webui/index.md) | Project, Tasks, Chats and modes, Settings |
| [Providers and models](docs/models/index.md) | Default providers, keys, fallbacks and retries, the proxy, local models |
| [Harness](docs/harness/index.md) | Tools, roles, skills, MCP, compaction, checks and approval |
| [Code execution](docs/code-execution/index.md) | Python, JavaScript and bash in the browser or on your machine; git |
| [Local or self-hosted](docs/local/index.md) | Install, LAN access, your own site and Worker; TUI keys and commands; CLI flags |
| [Security](SECURITY.md) | What each component trusts, sandboxes, reporting a vulnerability |
| [Contributing](docs/contributing.md) | Tests, checks, deploying, architecture notes |

Project internals for contributors and coding agents live in [AGENTS.md](AGENTS.md) and [bench/BENCHMARKS.md](bench/BENCHMARKS.md).

## License

MIT — see [LICENSE](LICENSE).
