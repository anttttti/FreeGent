#!/usr/bin/env node
// fg-run.js — FreeGent headless CLI entry point.
//
// bootstrap-jsdom.js MUST be the first import so dom.window is set before any
// app module body runs. It is also imported inside headless-runner.js, but Node.js
// module caching means it only executes once — the first time (here).
import './bootstrap-jsdom.js';
import { run, prompt as llmPrompt, getHeadlessPrimaryModel } from './headless-runner.js';
import { finishLines } from './finish-summary.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotenv } from './dotenv.js';
import { defaultLogPath } from './safe-log.js';

// ── .env loader ───────────────────────────────────────────────────────────────
// Reads KEY=VALUE pairs from .env files and sets any key not already present
// in process.env. Shell environment always wins; .env files fill in the gaps.
//
// Precedence:
//   1. <cwd>/.env                  — project-local; gitignored; legacy/override path
//   2. ~/.config/freegent/credentials — user-global; outside any repo, cannot be committed
//                                       Recommended location for API keys.
loadDotenv();

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
// `-p [text]` / `--print [text]` (the `freegent -p` pipeline form): run the agent on the text and the piped input, print only the answer.
// The text is optional because the input may come entirely from stdin; it is taken out of `args` here so the option checks below never see it.
let printMode = false, printText = '';
for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-p' && args[i] !== '--print') continue;
    printMode = true;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) { printText = next; args.splice(i, 2); } else args.splice(i, 1);
    break;
}
// stdout is the answer (or the metrics lines); startup diagnostics such as the endpoint's context-window probe go to stderr.
// Run before the probe prints: it came a moment after the reply and broke `--prompt … | jq` (TUI report case 025).
console.log = console.info = (...a: unknown[]) => console.error(...a);
// Every option that takes a value. A value-taking option followed by another option (or nothing) is an error, not a value:
// `--prompt --temperature 0.3` used to send the text "--temperature" as the prompt (case 086).
const _VALUE_FLAGS = new Set(['--api-key', '--api-url', '--browser-url', '--compaction-limit', '--context-window', '--disable-tools',
    '--enable-tools', '--fetch-allow', '--write-allow', '--llm', '--log', '--main-role', '--max-rounds', '--mcp-config', '--model', '--prompt', '--provider',
    '--reply-channel-hint', '--retry-fixed-ms', '--retry-mode', '--sidecar-dir', '--task', '--task-file', '--temperature', '--thinking-level',
    '--timeout', '--workflow', '--workspace']);
const _OPTION_NAMES = new Set([..._VALUE_FLAGS, '--help', '-h', '--no-log', '--print-model', '--no-tools', '-p', '--print']);
// Progress banners go to stderr; in -p mode only errors do.
const _note = (m: string) => { if (!printMode) console.error(m); };
const _fail = (msg: string): never => { console.error(`Error: ${msg}`); process.exit(2); };
const _arg = (flag: any) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = args[i + 1];
    if (v === undefined || (_VALUE_FLAGS.has(flag) && _OPTION_NAMES.has(v))) return _fail(`${flag} needs a value.`);
    return v;
};
const _flag = (flag: any) => args.includes(flag);

function _usage(code = 1) {
    console.error(`Usage:
  npx tsx fg-run.ts --prompt "Ask something"      Direct LLM call, no tools
  npx tsx fg-run.ts --workflow "Do something"     Full agent workflow with tools
  npx tsx fg-run.ts --task "Task description"     Alias for --workflow
  npx tsx fg-run.ts --task-file path/to/task.txt  Read task from file (workflow)
  freegent -p "Do something"                      Agent run for pipelines: only the answer on stdout. Text piped in is
                                                  added to the request:  git diff | freegent -p "review this"
                                                  (-p alone reads the whole request from stdin; --no-tools = a plain
                                                  model call without tools; no metrics line, no progress banners)

Options:
  --llm <provider|model>    Combined LLM selector (e.g. google|gemini-2.5-flash,
                            groq|openai/gpt-oss-120b). Overrides --provider/--model.
  --workspace <path>    Root directory for file operations (default: WORKSPACE_ROOT env or cwd)
  --provider  <id>      LLM provider: google|openai|nvidia|groq|… (default: openai)
  --model     <id>      Model ID
  --print-model        Print the resolved primary model without running a task
  --api-key   <key>     API key (or FREEGENT_API_KEY env var)
  --api-url   <url>     Base URL for OpenAI-compatible endpoints
  --timeout     <ms>    Abort agent after this many ms (default: 1800000 = 30 min)
  --log         <path>  JSONL log of every LLM turn (default: ~/.freegent/fg-agent.log)
  --no-log              Disable LLM turn logging
  --sidecar-dir     <path>  Redirect fg-tasks/ and memory/ writes here (keeps workspace git tree clean)
  --context-window  <n>     Total token budget (input+output); enables per-step clamping (default: none)
  --compaction-limit <n>    Compact history when estimated tokens exceed this (default: 20000)
  --disable-tools <list>    Comma-separated tool names to disable (e.g. fetch_url,web_search)
  --enable-tools <list>     Comma-separated tools to enable and add to the director's
                            headless tool set (e.g. fetch_url)
  --fetch-allow <origins>   Restrict fetch_url to these origins (comma-separated, e.g.
                            http://fg-gw:41234) and disable web_search and other
                            outbound-request tools. Request policy, not containment.
  --write-allow <paths>     The file-writing tools may only touch these files or directories (comma-separated,
                            workspace-relative, e.g. out/,notes/report.md); other paths are refused. A request
                            policy, not containment: execute_code can still write anywhere.
  --browser-url <url>       Text-only Playwright bridge URL (explicit opt-in)
  --reply-channel-hint <t>  The task's counterpart is reached through a tool, not chat output: text
                            to show the model when it answers in chat instead (benchmark runners)
  --mcp-config <path>       JSON array of per-run MCP servers; replaces saved servers
  --temperature   <n>       Sampling temperature 0–2 (default: 0.2)
  --thinking-level <level>  Thinking budget: off|low|medium|high (default: off)
  --retry-mode <mode>       Retry delay mode: exponential (default) | fixed
  --retry-fixed-ms <ms>     Fixed retry delay in ms when --retry-mode fixed (default: 120000)
  --help                    Show this message
`);
    process.exit(code);
}

if (_flag('--help') || _flag('-h')) _usage(0);
if (args.length === 0 && !printMode) _usage(1);

let stdinText = '';
if (printMode && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    stdinText = Buffer.concat(chunks).toString('utf8').trim();
}
const printRequest = [printText, stdinText].filter(Boolean).join('\n\n');
if (printMode && !printRequest) _fail('-p needs a request: freegent -p "what to do", or pipe text in.');
const promptArg    = _arg('--prompt');
const promptText    = printMode && _flag('--no-tools') ? printRequest : promptArg;
const taskText      = _arg('--task') || _arg('--workflow');
const taskFile      = _arg('--task-file');
// Exactly one input: with --task and --prompt together the task was silently ignored and the model called in prompt mode (case 006). The -p request (its
// text and what is piped in) is an input too: it won over --task and --prompt, which were dropped without a word (codex R8-001).
if ([printMode ? printRequest : null, promptArg, taskText, taskFile].filter(v => v != null && v !== '').length > 1)
    _fail('give exactly one of -p/--print (with text piped in), --prompt, --task/--workflow and --task-file.');
const workspacePath = _arg('--workspace') || process.env.WORKSPACE_ROOT || process.cwd();

// --llm PROVIDER|MODEL splits on the first '|'
const llmSpec       = _arg('--llm') || '';
const _llmParts     = llmSpec.indexOf('|') >= 0 ? llmSpec.split('|') : [];
const provider      = (_llmParts[0] || _arg('--provider') || process.env.FREEGENT_PROVIDER || 'openai');
const model         = (_llmParts.slice(1).join('|') || _arg('--model') || process.env.FREEGENT_MODEL || '');
const apiKey        = _arg('--api-key')   || process.env.FREEGENT_API_KEY  || '';
// A key on the command line is visible to every local user in the process list (`ps`). The environment, ./.env and ~/.config/freegent/credentials are not (hermes C10 note).
if (_arg('--api-key')) console.error('freegent: --api-key puts the key in the process list where other users of this machine can read it; prefer the environment, ./.env or ~/.config/freegent/credentials.');
const apiUrl        = _arg('--api-url')   || process.env.FREEGENT_API_URL  || '';
// Explicit non-positive/invalid --timeout falls back to the default deliberately (0 is not "no timeout").
const _timeoutRaw   = parseInt(_arg('--timeout') ?? '', 10);
const timeoutMs     = Number.isFinite(_timeoutRaw) && _timeoutRaw > 0 ? _timeoutRaw : undefined;
const logFile       = _flag('--no-log') ? null : (_arg('--log') || defaultLogPath('fg-agent.log'));
const sidecarDir      = _arg('--sidecar-dir') || '';
const contextWindow   = parseInt(_arg('--context-window') || '') || 0;
const compactionLimit = parseInt(_arg('--compaction-limit') || '') || 0;
const disabledTools   = _arg('--disable-tools') || '';
const fetchAllow      = _arg('--fetch-allow') || '';
const writeAllow      = _arg('--write-allow') || '';
const enableTools     = _arg('--enable-tools') || '';
const browserUrl      = _arg('--browser-url') || '';
const replyChannelHint = _arg('--reply-channel-hint') || '';
const mcpConfigFile   = _arg('--mcp-config');
let mcpServers = null;
if (mcpConfigFile) {
    try {
        mcpServers = JSON.parse(readFileSync(mcpConfigFile, 'utf8'));
        if (!Array.isArray(mcpServers)) throw new Error('Expected an array of MCP servers');
    } catch (e: any) { console.error(`Cannot read MCP config: ${e.message}`); process.exit(1); }
}
const mainRole          = _arg('--main-role')          || '';
const temperatureArg  = _arg('--temperature');
const temperature     = temperatureArg != null ? parseFloat(temperatureArg) : null;
// Documented range 0–2 (--help); 3.5 used to go to the provider as it was (case 031).
if (temperature != null && !(temperature >= 0 && temperature <= 2)) _fail(`--temperature must be a number in the range 0–2 (got "${temperatureArg}").`);
const thinkingLevel   = _arg('--thinking-level') || '';
const retryMode       = _arg('--retry-mode')     || '';
const retryFixedMs    = parseInt(_arg('--retry-fixed-ms') || '') || 0;
const maxRounds       = parseInt(_arg('--max-rounds')     || '') || 0;

let task = printMode && !_flag('--no-tools') ? printRequest : taskText;
if (!task && taskFile) {
    try { task = readFileSync(taskFile, 'utf8').trim(); }
    catch (e: any) { console.error(`Cannot read task file: ${taskFile} — ${e.message}`); process.exit(1); }
}
if (!task && !promptText && !_flag('--print-model')) { console.error('Error: provide --prompt, --workflow, --task, or --task-file'); _usage(); }

const workspaceRoot = resolve(workspacePath);
const sharedOpts = { workspaceRoot, provider, model, apiKey, apiUrl, timeoutMs, logFile, sidecarDir, contextWindow, compactionLimit, disabledTools, fetchAllow, writeAllow, enableTools, browserUrl, replyChannelHint, mcpServers, mainRole, temperature, thinkingLevel, retryMode, retryFixedMs, maxRounds };

if (_flag('--print-model')) {
    // A pipe is asynchronous on some platforms; wait for it before process.exit().
    await new Promise<void>(resolve => process.stdout.write(
        (getHeadlessPrimaryModel(sharedOpts) || '(no active model)') + '\n', () => resolve()));
    process.exit(0);
}

// ── Run ───────────────────────────────────────────────────────────────────────

_note(`[fg-run] workspace: ${workspaceRoot}`);
_note(`[fg-run] provider:  ${provider}${model ? ` / ${model}` : ''}${llmSpec ? ` (--llm ${llmSpec})` : ''}`);

if (promptText) {
    _note(`[fg-run] mode:      prompt (direct LLM call)`);
    _note(`[fg-run] prompt:    ${promptText.slice(0, 120)}${promptText.length > 120 ? '…' : ''}`);
    if (logFile) _note(`[fg-run] log:       ${logFile}`);
    const { output, error } = await llmPrompt(promptText, sharedOpts);
    if (error) await new Promise<void>(resolve => process.stderr.write(`[fg-run] Error: ${error}\n`, () => resolve()));
    await new Promise<void>(resolve => process.stdout.write(output + '\n', () => resolve()));
    process.exit(error ? 1 : 0);
} else {
    _note(`[fg-run] mode:      workflow (agent loop)`);
    _note(`[fg-run] task:      ${task!.slice(0, 120)}${task!.length > 120 ? '…' : ''}`);
    if (logFile) _note(`[fg-run] log:       ${logFile}`);
    // Piped stdout (benchmark containers): print running totals after every LLM step so a task
    // killed by the wall-clock limit still leaves its token counts. Consumers take the last line.
    const onMetrics = process.stdout.isTTY || printMode ? undefined
        : (m: unknown) => { process.stdout.write(`__FG_METRICS__:${JSON.stringify(m)}\n`); };
    const { output, error, metrics, finish } = await run(task!, { ...sharedOpts, workflowMode: true, onMetrics });
    if (error) await new Promise<void>(resolve => process.stderr.write(`[fg-run] Error: ${error}\n`, () => resolve()));
    if (!printMode) process.stdout.write(`__FG_METRICS__:${JSON.stringify(metrics)}\n`);
    await new Promise<void>(resolve => process.stdout.write(output + '\n', () => resolve()));
    // How the run ended and which files it changed, from the tool log and the disk, not from the model's own account of it.
    // On stderr, so what a pipeline or a benchmark reads from stdout is unchanged; a pipeline (-p) only hears about broken files.
    if (finish) {
        const summary = finishLines(finish, finish.changedFiles ?? []).filter(l => !printMode || l.includes('WARNING'));
        if (summary.length) await new Promise<void>(resolve => process.stderr.write(summary.join('\n') + '\n', () => resolve()));
    }
    process.exit(error ? 1 : 0);
}
