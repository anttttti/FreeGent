# Local or self-hosted

freegent.ai needs nothing beyond an API key, but it cannot run bash or Python on your machine or use `run_git`, and at the default privacy level it cannot reach models on `localhost` (Provider-only and Local reach them directly if the model server allows the page's origin). For those, run FreeGent from a clone of the repository. The same install gives you all three interfaces:

| Page | Covers |
|---|---|
| [WebUI](/local/webui) | The dev server, using it from other devices, hosting your own site and Worker |
| [TUI](/local/tui) | The terminal UI: flags, key bindings, slash commands |
| [CLI](/local/cli) | The headless runner: flags, environment variables, examples |

## Install

Requirements: Node.js 22 or newer and npm.

```bash
git clone https://github.com/anttttti/FreeGent
cd FreeGent
npm install
npm run dev          # WebUI at http://localhost:5000
npm run tui          # terminal UI
npx tsx fg-run.ts --help
```

Put your keys in a file outside the repository so they cannot be committed:

```bash
mkdir -p ~/.config/freegent
cp .env.example ~/.config/freegent/credentials
# edit the file and fill in at least one key
```

The dev server, the TUI and the CLI all read that file.

```bash
FG_PORT=8080 npm run dev     # different port (the server exits if the port is taken)
npm run dev:lan              # reachable from your phone and other devices
```

See [WebUI](/local/webui) for LAN access and its token.

## What running locally adds

| | freegent.ai | Local server, TUI, CLI |
|---|---|---|
| JavaScript and Python | browser sandboxes | WebUI: JavaScript in the browser sandbox, Python in the browser or on your machine (Local sandbox); TUI and CLI: on your machine |
| bash | WASM sandbox in the browser | real bash on your machine, optionally isolated |
| `run_git` | no | yes (opt-in) |
| Local models (Ollama, vLLM, LM Studio) | no | yes |

See [Code execution](/code-execution/) for the sandboxes and approval prompts, [Local models](/models/local-models) for connecting a model server, and [WebUI](/local/webui) for using it from other devices or hosting your own copy.

## API keys

The variable names for each provider are in [Default providers](/models/providers). On the local server you can also type keys into **Settings → Models → API Credentials** as on freegent.ai.

Where the local tools look for keys, highest priority first:

1. Variables already set in your shell
2. `.env` in the directory you start from (gitignored)
3. `~/.config/freegent/credentials` (or `$XDG_CONFIG_HOME/freegent/credentials`)

Keys loaded from the credentials file stay on the server: the page receives a placeholder and the server swaps in the real key only for requests to that provider's own host (see [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md)).
