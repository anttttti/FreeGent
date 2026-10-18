# TUI (terminal UI)

An interactive terminal session on the same agent core as the WebUI: same tools, skills, roles and model rotation. It needs Node.js 22+ and a clone of the repository.

```bash
npm run tui

# explicit provider and key
npm run tui -- --provider google --api-key AIza...
npm run tui -- --provider groq --model openai/gpt-oss-120b --api-key ...

# a local model
npm run tui -- --api-url http://localhost:8000/v1 --provider custom --model qwen3
```

## Keys and provider detection

The TUI loads `~/.config/freegent/credentials` and `.env` the same way the dev server does (shell variables win; see [API keys](/local/#api-keys)). With no `--provider` it picks the first of these variables that is set: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `NOUSPORTAL_API_KEY` / `NOUS_API_KEY`. For any other provider or endpoint, pass `--provider`, `--api-key` and, for a custom server, `--api-url`.

## Flags

| Flag | Meaning |
|---|---|
| `--provider <id>` | Provider ID (default: detected, else `openai`) |
| `--model <id>` | Model ID |
| `--api-key <key>` | API key |
| `--api-url <url>` | Base URL of an OpenAI-compatible server |
| `--workspace <dir>` | Project directory (default: current directory) |
| `--role <name>` | Start with a main role |
| `--prompt <text>` | Send this as the first message |
| `--resume [id]` | Resume the most recent session, or the one with this ID |
| `--log-file <path>` | Where to write the log (default `/tmp/fg-tui.log`) |

## Screen

The status bar shows the model, whether the agent is running, throughput (`↑in ↓out`) and context usage (`ctx 4.2K/128K`, yellow at 70%, red at 90%). The event log fills the middle, and messages you send while the agent is busy appear in a queue above the input. Panels (12 rows) open below the log and close with `Esc` or the key that opened them.

## Key bindings

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Esc` | Close the open panel |
| `↑` / `↓` | Scroll the event log |
| `Ctrl+C` | Break after the current step while running; exit when idle |
| `Alt+X` | Stop immediately |
| `Alt+B` | Soft break (stop after the current step) |
| `Alt+U` | Retry the last turn |
| `Alt+N` | New session |
| `Alt+M` | Model panel |
| `Alt+R` | Role panel |
| `Alt+A` | Agent panel |
| `Alt+P` | Project files |
| `Alt+T` | Tasks |
| `Alt+,` | Settings |
| `Alt+H` | Help |

## Slash commands

| Command | Effect |
|---|---|
| `/clear` | New session |
| `/stop`, `/break`, `/retry` | Same as `Alt+X`, `Alt+B`, `Alt+U` |
| `/compact` | Compact the history now |
| `/rewind` | Rewind to the last checkpoint |
| `/export` | Save the chat as a Markdown file in the workspace |
| `/resume [N]` | List previous sessions, or restore one |
| `/model [provider\|model]` | Open the model panel, or switch model |
| `/role [name]` | Open the role panel, or switch role |
| `/set <key> <value>` | Set a setting (the same keys the WebUI stores, e.g. `fg_thinking_level`) |
| `/project`, `/tasks`, `/agent`, `/settings`, `/help` | Open that panel |
| `/queue N`, `/steer N`, `/cancel N` | Change the Nth queued message: wait its turn, interrupt the current turn, or remove it |

Code execution in the TUI runs on your machine, in the project directory; see [Code execution](/code-execution/local#headless-runs) and [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md).
