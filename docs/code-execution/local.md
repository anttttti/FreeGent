# Local execution

Choose **Local** in Settings → Code Execution. Commands run on your machine through the dev server (`npm run dev`, see [Local or self-hosted](../local/index.md)), so Local is not available on freegent.ai or any other static host. The dev server picks it automatically at `localhost`; from another device on your network, choose it yourself.

- **Linux with [bubblewrap](https://github.com/containers/bubblewrap)** (`apt install bubblewrap`): each command runs in its own mount namespace. Your home directory is absent, so the credentials file, SSH keys and other projects are invisible. System directories (read-only), the command's temp directory and the toolchains on your `PATH` (conda, nvm, …) remain, and so does network access.
- **Without bubblewrap** (macOS, Windows, or user namespaces disabled): commands run as you and can read your files. Tool approval then defaults to asking before each command.
- Credentials are removed from the command's environment in both cases.
- Stop ends the command and everything it started.

Environment variables for the dev server:

| Variable | Effect |
|---|---|
| `FG_EXEC_ISOLATION` | `auto` (default), `bwrap` or `none` |
| `FG_EXEC_BIND=/path/a,/path/b` | Extra read-only paths to expose inside the sandbox |

The server logs which mode it chose at startup.

## Git

Enable **Git Integration** in Settings → Code Execution and turn on `run_git` in Settings → Tools. It needs the Local provider. The git tool runs in the directory the dev server was started from, not in the browser Project or a folder you connected, and refuses options that would make git run other programs or touch files outside that repository. With bubblewrap it runs isolated and sees only that repository, so remote operations that need your SSH keys or credential helper (for example `git push` over SSH) have to be done from your own shell.

## Headless runs

The CLI and benchmarks run commands on the host or inside a task container. Credentials are stripped from command environments; `FG_EXEC_KEEP_ENV=NAME,…` passes named variables through when a task needs them. Isolate headless runs with the container they run in. See [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md).
