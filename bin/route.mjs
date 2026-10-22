// bin/route.mjs — which FreeGent program a `freegent …` command line runs. Pure, so it can be tested.
//   freegent                       the terminal UI (fg-tui.tsx)
//   freegent -p "request"          one agent run for pipelines (fg-run.ts), only the answer on stdout
//   some-output | freegent -p "…"  the piped text is added to the request
//   some-text | freegent           no terminal to draw a UI on: same as -p with the piped text as the request
// The older fg-run options (--workflow, --task, --task-file, --print-model) also select the command-line program. `--prompt` stays
// the terminal UI's "send this message at start"; the plain model call is `-p … --no-tools`.
const CLI_FLAGS = new Set(['-p', '--print', '--workflow', '--task', '--task-file', '--print-model']);

export function route(args, { stdinTTY, stdoutTTY }) {
    if (args.includes('--help') || args.includes('-h')) return { program: 'help', args };
    if (args.includes('--version') || args.includes('-v')) return { program: 'version', args };
    if (args.some(a => CLI_FLAGS.has(a))) return { program: 'cli', args };
    // The terminal UI needs a terminal on both sides; without one, the pipeline form is the only thing that can work.
    if (!stdinTTY || !stdoutTTY) return { program: 'cli', args: args.includes('-p') || args.includes('--print') ? args : ['-p', ...args] };
    return { program: 'tui', args };
}

export const HELP = `freegent — the FreeGent agent in your terminal

  freegent                         interactive terminal UI
  freegent -p "request"            run the agent once and print only the answer (for scripts and pipes)
  git diff | freegent -p "review"  text piped in is added to the request
  freegent -p "request" --no-tools plain model call, no tools

Common options (both modes):  --provider <id>  --model <id>  --api-key <key>  --api-url <url>  --workspace <dir>
Terminal UI:   --resume [id] (no id: choose from a list)   --prompt "message sent at start"   --role <name>
With -p:       --llm <provider|model>  --timeout <ms>  --disable-tools <list>  --max-rounds <n>  --no-log   (see: npx tsx fg-run.ts --help)

Keys are read from the environment, ./.env and ~/.config/freegent/credentials.`;
