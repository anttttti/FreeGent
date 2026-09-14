# FreeGent

**Run AI agents against free-tier cloud LLMs and local models — no per-token billing.**

FreeGent is an open-source AI agent runner that works against Gemini free tier, OpenRouter, NVIDIA, Mistral, Groq, and local models via Ollama, vLLM, or LM Studio. It ships three interfaces: a browser WebUI, an interactive terminal TUI, and a headless CLI for scripting.

---

## Supported Providers

| Provider | Free tier | Key env var |
|---|---|---|
| **Google Gemini** | ✓ 30 RPM / 1 500 RPD | `GEMINI_API_KEY` |
| **OpenRouter** | ✓ many free models | `OPENROUTER_API_KEY` |
| **NVIDIA NIM** | ✓ free API credits | `NVIDIA_API_KEY` |
| **OpenCode Zen** | ✓ rotating free models | `OPENCODE_API_KEY` |
| **Kilo** | ✓ `:free` models (200 req/hr anon) | `KILO_API_KEY` |
| **Nous Portal** | ✓ 50 RPM / 500K TPM rotating | `NOUSPORTAL_API_KEY` |
| **TokenHarbor** | ✓ weekly quota | `TOKENHARBOR_API_KEY` |
| **Vercel AI Gateway** | ✓ $0/token select models | `VERCEL_API_KEY` |
| **Groq** | ✓ free tier (rate limited) | `GROQ_API_KEY` |
| **Mistral** | — | `MISTRAL_API_KEY` |
| **Cerebras** | — | `CEREBRAS_API_KEY` |
| **OpenAI** | — | `OPENAI_API_KEY` |
| **HuggingFace** | ✓ free token (image gen fallback) | `HF_API_KEY` |
| **Ollama / vLLM / LM Studio** | local | `--api-url http://...` |

---

## Installation

**Requirements:** Node.js 22+ and npm.

```bash
# 1. Clone and install
git clone https://github.com/anttttti/FreeGent
cd FreeGent
npm install

# 2. Set up credentials (outside the repo — safe from accidental commits)
mkdir -p ~/.config/freegent
cp .env.example ~/.config/freegent/credentials
# edit ~/.config/freegent/credentials and add at least one API key

# 3. Start the dev server
npm run dev          # → http://localhost:5000
```

That's it. Open the URL, pick a model in **Settings → Models**, and start chatting.

---

## WebUI

A browser-based chat interface served by the Vite dev server.

```bash
npm run dev          # localhost only  →  http://localhost:5000
npm run dev:lan      # all interfaces  →  also reachable from phone / other devices
FG_PORT=8080 npm run dev              # custom port
```

`npm run dev:lan` is equivalent to `vite --host`. Vite prints the Network URL on startup; open it on any device on the same LAN. The CORS allowlist is automatically extended to include all local IPv4 addresses when binding to all interfaces.

Enter your API key in **Settings → Profiles**, or put it in `~/.config/freegent/credentials` — it loads automatically on startup (see [API keys](#api-keys) below).

**Key features:**

- Streaming responses with auto-scroll (pauses when you scroll up; jump-to-latest button re-engages)
- Syntax-highlighted code blocks (highlight.js) with one-click copy and `▶ Run` / `▶ Preview` buttons
- Math rendering (KaTeX): `$$…$$`, `\[…\]` block math; `\(…\)` inline math
- Dark / light mode toggle in the left rail (persisted across sessions)
- Context window usage shown as `4.2k / 128k` in the chat toolbar — turns yellow at 70%, red at 90%
- Full-text search across all chat history (`Ctrl/Cmd+Shift+F`)
- Draft preservation — typed text survives page reload and chat switches
- Keyboard shortcuts: `Enter` send · `Shift+Enter` newline · `Esc` stop generation · `Ctrl/Cmd+K` new chat

---

## TUI (Terminal UI)

Interactive terminal session running the same agent core as the WebUI.

```bash
npm run tui

# With explicit credentials:
npm run tui -- --provider google --api-key AIza...
npm run tui -- --provider mistral --model mistral-medium-3.5 --api-key ...

# Against a local model:
npm run tui -- --api-url http://localhost:8000/v1 --provider custom --model qwen3
```

The TUI auto-detects your provider from standard environment variable names (`GEMINI_API_KEY`, `OPENAI_API_KEY`, etc.) and from `~/.config/freegent/credentials` (loaded automatically).

**Status bar** shows model, running state, session throughput (`↑in ↓out`), and current context window usage (`ctx 4.2K/128K` — yellow at 70%, red at 90%).

**Key bindings:**

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Esc` | Stop generation (if running) · close panel (if open) |
| `Ctrl+C` | Stop after current step (if running) · exit (if idle) |
| `Alt+X` | Stop generation immediately |
| `Alt+N` | New session |
| `Alt+,` | Settings panel |
| `Alt+M` | Model selector |
| `Alt+A` | Agent panel |
| `Alt+P` | Project panel |
| `Alt+?` | Help |
| `↑ / ↓` | Scroll event log |

---

## CLI (Headless)

Non-interactive agent runs for scripting, benchmarks, or CI.

```bash
# Run a task (agent with tools)
npx tsx fg-run.ts --task "Refactor the auth module to use async/await" \
  --workspace ./myproject \
  --provider google --api-key $GEMINI_API_KEY

# Read task from a file
npx tsx fg-run.ts --task-file task.txt --workspace ./myproject

# One-shot LLM call (no tools)
npx tsx fg-run.ts --prompt "Summarise this: $(cat notes.txt)" \
  --provider google --api-key $GEMINI_API_KEY

# Combined provider+model selector
npx tsx fg-run.ts --task "Write unit tests" --llm "google|gemini-3.6-flash"

# Against a local model
npx tsx fg-run.ts --task "Write unit tests for src/api.py" \
  --api-url http://localhost:8000/v1 --provider custom --model qwen3
```

**Key flags:**

| Flag | Default | Description |
|---|---|---|
| `--task` / `--workflow` | — | Task description (agent + tools) |
| `--prompt` | — | Direct LLM call, no tools |
| `--task-file` | — | Read task from file |
| `--workspace` | cwd | Root directory for file operations |
| `--llm` | — | Combined selector: `provider\|model` |
| `--provider` | `openai` | Provider ID |
| `--model` | — | Model ID |
| `--api-key` | — | API key (or `FREEGENT_API_KEY` env var) |
| `--api-url` | — | Custom OpenAI-compatible base URL |
| `--thinking-level` | `off` | `off \| low \| medium \| high` |
| `--timeout` | 1800000 | Abort after N ms (default 30 min) |
| `--disable-tools` | — | Comma-separated tool names to disable |
| `--log` | `/tmp/fg-agent.log` | JSONL turn log path |
| `--no-log` | — | Disable turn logging |

---

## Configuration

### API keys

**Recommended: `~/.config/freegent/credentials`**

This file lives outside every git repo on your machine, so it can never be accidentally committed.

```bash
mkdir -p ~/.config/freegent
cp .env.example ~/.config/freegent/credentials
# edit with your keys
```

The file uses the same `KEY=VALUE` format as `.env`:

```ini
# ~/.config/freegent/credentials

GEMINI_API_KEY=AIza...
OPENROUTER_API_KEY=sk-or-...
MISTRAL_API_KEY=...
GROQ_API_KEY=gsk_...
CEREBRAS_API_KEY=csk-...
NVIDIA_API_KEY=nvapi-...
OPENAI_API_KEY=sk-...
HF_API_KEY=hf_...        # optional: HuggingFace image fallback
TAVILY_API_KEY=tvly-...  # optional: web search
BRAVE_API_KEY=...        # optional: web search
GITHUB_TOKEN=ghp_...     # optional: raises GitHub search rate limit
```

The dev server, TUI, and CLI all load this file automatically. Keys are forwarded to the browser's `localStorage` and go directly to each provider — never stored server-side.

**Alternatives**

Shell exports (also work, take highest precedence):

```bash
# ~/.bashrc or ~/.zshrc
export GEMINI_API_KEY=AIza...
```

Project `.env` at the repo root (gitignored, overrides the credentials file):

```bash
cp .env.example .env   # fill in keys — git will never commit this
```

### Local LLMs (vLLM, Ollama, LM Studio)

Any OpenAI-compatible endpoint works. In the WebUI go to **Settings → Model → Custom Endpoint** and enter the base URL. For CLI/TUI use `--api-url`.

**vLLM example (Qwen3 27B):**

```bash
vllm serve cyankiwi/Qwen3.6-27B-AWQ-INT4 \
  --port 8000 \
  --max-model-len 20000 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3
# Endpoint: http://localhost:8000/v1
```

**Ollama example:**

```bash
ollama run qwen2.5-coder:7b
# Endpoint: http://localhost:11434/v1
```

---

## Skills

Skills are Markdown files in `skills/<name>/SKILL.md` that are injected into the agent's system prompt based on triggers: keywords in the user message, file types in the workspace, tool call results, or lifecycle events. They let you shape agent behaviour for your project without touching source code.

Enable skills in **Settings → Skills**, or drop a `SKILL.md` into the workspace `skills/` directory.

---

## License

MIT — see [LICENSE](LICENSE).
