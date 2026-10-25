# TUI (terminal UI)

An interactive terminal session on the same agent core as the WebUI: same tools, skills, roles and model rotation. It needs Node.js 22+ and a clone of the repository.

```bash
freegent             # after `npm link` in the clone (see Local or self-hosted)
npm run tui          # the same, without npm link

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
| `--role <name>` | Start with a main role (built in, or a file in the workspace's `roles/`). An unknown name is reported and the Director is used. Without it, a resumed session keeps the role it had |
| `--prompt <text>` | Send this as the first message |
| `--resume [id]` | Resume the most recent session that has messages, or the one with this ID |
| `--log-file <path>` | Where to write the log (default `/tmp/fg-tui.log`) |

## Screen

The status bar shows the model, whether the agent is running, throughput (`↑in ↓out`) and context usage (`ctx 4.2K/128K`, yellow at 70%, red at 90%). The event log fills the middle, and messages you send while the agent is busy appear in a queue above the input. Panels (12 rows) open below the log and close with `Esc` or the key that opened them. In the model and role panels, `↑`/`↓` move the marker and `Enter` (with an empty input line) uses the highlighted entry and closes the panel. In the Project and Settings panels `↑`/`↓` scroll.

## Key bindings

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Esc` | Close the open panel |
| `↑` / `↓` | Scroll the event log |
| `Ctrl+C` | Break after the current step while running; exit when idle |
| `Alt+X` | Stop immediately |
| `Alt+B` | Soft break (stop after the current step) |
| `Alt+U` | Retry the last turn: the last message is sent again in place of the last answer |
| `Alt+N` | New session |
| `Alt+M` | Model panel |
| `Alt+R` | Role panel |
| `Alt+A` | Agent panel |
| `Alt+P` | Project files |
| `Alt+T` | Tasks |
| `Alt+S` | Settings |
| `Alt+H` | Help |

## Slash commands

| Command | Effect |
|---|---|
| `/clear` | New session. Refused while a reply is running |
| `/stop`, `/break`, `/retry` | Same as `Alt+X`, `Alt+B`, `Alt+U` |
| `/compact` | Compact the history now. Refused while a reply is running: wait for it or stop it first |
| `/rewind` | Go back before your last message: the conversation, the workspace's files (as far as a snapshot reaches: large files and `.git`, `node_modules` and build folders are left as they are) and the screen. Repeat to go back further; the last ten messages are kept |
| `/export` | Save the chat as a Markdown file in the workspace |
| `/resume [N]` | List this folder's previous sessions (named from their first message, with message count), or restore one. Sessions that were never used are not listed. Restoring is refused while a reply is running: wait for it or stop it first |
| `/model [provider\|model]` | Open the model panel, or switch model |
| `/role [name]` | Open the role panel, or switch role |
| `/set <key> [value]` | Set a setting by its key, shown next to each value in `/settings` (`/set` alone opens the panel; without a value the setting returns to its default). Other keys the WebUI stores also work, e.g. `fg_thinking_level` |
| `/project`, `/tasks`, `/agent`, `/settings`, `/help` | Open that panel |
| `/queue N`, `/steer N`, `/cancel N` | Change the Nth queued message: wait its turn, interrupt the current turn, or remove it |

Code execution in the TUI runs on your machine, in the project directory; see [Code execution](/code-execution/local#headless-runs) and [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md).
