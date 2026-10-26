# CLI (headless)

`fg-run.ts` runs the agent without a UI, for scripts, CI and benchmarks. It needs Node.js 22+ and a clone of the repository.

```bash
# Agent with tools, working in a directory
npx tsx fg-run.ts --task "Refactor the auth module to use async/await" \
  --workspace ./myproject --provider google --api-key $GEMINI_API_KEY

# Task text from a file
npx tsx fg-run.ts --task-file task.txt --workspace ./myproject

# One model call, no tools
npx tsx fg-run.ts --prompt "Summarise this: $(cat notes.txt)" --provider google

# Provider and model in one flag
npx tsx fg-run.ts --task "Write unit tests" --llm "google|gemini-2.5-flash"

# A local model
npx tsx fg-run.ts --task "Write unit tests for src/api.py" \
  --api-url http://localhost:8000/v1 --provider custom --model qwen3
```

`freegent -p` (after `npm link`, see [Local or self-hosted](index.md#install)) is the short form of `npx tsx fg-run.ts`. For pipelines, `-p` (`--print`) runs the agent and prints only the answer on stdout (no metrics line, no progress banners). Text piped in is added to the request, and `-p` with no text reads the whole request from stdin:

```bash
git diff | freegent -p "review this"
echo "What does this error mean: $(tail -3 build.log)" | freegent -p --no-tools
```

Exactly one of `--task` (alias `--workflow`), `--task-file` or `--prompt` is needed; giving two is an error, as is an option that needs a value and has none. Output goes to stdout (only the answer, and for a task the metrics lines; progress and diagnostics go to stderr), and every model turn is logged as JSON lines. The workspace's `AGENTS.md` and `roles/*.md` are read, as in the web app. Run `npx tsx fg-run.ts --help` for the authoritative list.

## Keys

`fg-run.ts` loads `.env` and `~/.config/freegent/credentials` and maps these variables to providers: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `TOKENHARBOR_API_KEY`, `NOUSPORTAL_API_KEY` / `NOUS_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`, `HF_API_KEY`, `STACKEXCHANGE_API_KEY`. `--api-key` (or `FREEGENT_API_KEY`) overrides the key for the selected provider. For providers that are not in that list, such as Kilo and Vercel AI Gateway, point `--api-url` at their OpenAI-compatible endpoint with `--provider custom` and pass the key with `--api-key`.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--task`, `--workflow`, `--task-file` | | Run the agent with tools |
| `--prompt` | | One model call, no tools |
| `--workspace` | `$WORKSPACE_ROOT`, else cwd | Root for file operations |
| `--llm "provider\|model"` | | Combined selector; overrides `--provider` and `--model` |
| `--provider`, `--model` | `openai`, none | Also `FREEGENT_PROVIDER`, `FREEGENT_MODEL` |
| `--api-key`, `--api-url` | | Also `FREEGENT_API_KEY`, `FREEGENT_API_URL` |
| `-p`, `--print` | | Pipeline form: only the answer on stdout, piped text added to the request (see above) |
| `--no-tools` | | With `-p`: a plain model call without tools |
| `--print-model` | | Print the resolved primary model and exit |
| `-h`, `--help` | | Print the usage and exit |
| `--main-role` | the Director | Role of the main agent. Also `FREEGENT_MAIN_ROLE`. An unknown name prints `unknown role "x" — using Director` and the run goes on as the Director |
| `--max-rounds` | the setting `fg_agent_max_rounds` (100) | Step limit of the turn, 1 to 500. Also `FREEGENT_MAX_ROUNDS`. Unset or 0 leaves the saved setting alone |
| `--reply-channel-hint` | | For runners whose counterpart is reached through a tool, not chat output: text shown to the model when it answers in chat instead. Also `FREEGENT_REPLY_CHANNEL_HINT` |
| `--thinking-level` | `off` | `off`, `low`, `medium`, `high` |
| `--temperature` | `0.2` | 0 to 2; a value outside it is refused |
| `--timeout` | 1800000 | Abort after this many ms (also for `--prompt`) |
| `--context-window` | none | Total token budget; enables per-step clamping |
| `--compaction-limit` | 20000 | Compact when the estimated history passes this many tokens |
| `--retry-mode`, `--retry-fixed-ms` | `exponential`, 120000 | Retry delay style |
| `--disable-tools`, `--enable-tools` | | Comma-separated tool names |
| `--fetch-allow` | | Restrict `fetch_url` to these origins and disable other outbound tools (a request policy, not containment) |
| `--write-allow` | | Comma-separated files or directories (`out/,notes/report.md`): `write_file`, `append_file`, `replace_in_file`, `apply_patch`, `delete_file` and `undo_write` may only touch these, any other path is refused with the allowed list in the message. Request policy, not containment: `execute_code` can still write anywhere. Also `FREEGENT_WRITE_ALLOW` |
| `--browser-url` | | Text-only Playwright bridge for the `browser_*` tools |
| `--mcp-config` | | JSON array of MCP servers for this run; replaces saved ones |
| `--sidecar-dir` | | Write `fg-tasks/` and `memory/` here instead of the workspace |
| `--log`, `--no-log` | `/tmp/fg-agent.log` | JSONL turn log |

QA gates are off by default in headless runs, unlike in the browser.

## Safety

Headless commands run on the host (or in a task container) without bubblewrap. Run untrusted work inside a container. Credentials are removed from command environments; `FG_EXEC_KEEP_ENV=NAME,…` passes named variables through. See [Security](https://github.com/anttttti/FreeGent/blob/main/SECURITY.md).
