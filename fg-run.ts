#!/usr/bin/env node
// fg-run.js — FreeGent headless CLI entry point.
//
// bootstrap-jsdom.js MUST be the first import so dom.window is set before any
// app module body runs. It is also imported inside headless-runner.js, but Node.js
// module caching means it only executes once — the first time (here).
import './bootstrap-jsdom.js';
import { run, prompt as llmPrompt } from './headless-runner.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

// ── .env loader ───────────────────────────────────────────────────────────────
// Reads KEY=VALUE pairs from .env files and sets any key not already present
// in process.env. Shell environment always wins; .env files fill in the gaps.
//
// Precedence:
//   1. <cwd>/.env                  — project-local; gitignored; legacy/override path
//   2. ~/.config/freegent/credentials — user-global; outside any repo, cannot be committed
//                                       Recommended location for API keys.
{
    function _loadEnvFile(path: string) {
        if (!existsSync(path)) return;
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#') || !t.includes('=')) continue;
            const eq = t.indexOf('=');
            const k  = t.slice(0, eq).trim();
            let   v  = t.slice(eq + 1).trim();
            if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
            if (k && !(k in process.env)) process.env[k] = v;
        }
    }
    _loadEnvFile(join(resolve('.'), '.env'));
    const _xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    _loadEnvFile(join(_xdg, 'freegent', 'credentials'));
}

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const _arg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
};
const _flag = (flag) => args.includes(flag);

function _usage(code = 1) {
    console.error(`Usage:
  npx tsx fg-run.ts --prompt "Ask something"      Direct LLM call, no tools
  npx tsx fg-run.ts --workflow "Do something"     Full agent workflow with tools
  npx tsx fg-run.ts --task "Task description"     Alias for --workflow
  npx tsx fg-run.ts --task-file path/to/task.txt  Read task from file (workflow)

Options:
  --llm <provider|model>    Combined LLM selector (e.g. google|gemini-2.5-flash,
                            mistral|mistral-medium-3.5). Overrides --provider/--model.
  --workspace <path>    Root directory for file operations (default: WORKSPACE_ROOT env or cwd)
  --provider  <id>      LLM provider: google|openai|mistral|nvidia|groq|… (default: openai)
  --model     <id>      Model ID
  --api-key   <key>     API key (or FREEGENT_API_KEY env var)
  --api-url   <url>     Base URL for OpenAI-compatible endpoints
  --timeout     <ms>    Abort agent after this many ms (default: 1800000 = 30 min)
  --log         <path>  JSONL log of every LLM turn (default: /tmp/fg-agent.log)
  --no-log              Disable LLM turn logging
  --sidecar-dir     <path>  Redirect fg-tasks/ and memory/ writes here (keeps workspace git tree clean)
  --context-window  <n>     Total token budget (input+output); enables per-step clamping (default: none)
  --compaction-limit <n>    Compact history when estimated tokens exceed this (default: 20000)
  --disable-tools <list>    Comma-separated tool names to disable (e.g. fetch_url,web_search)
  --temperature   <n>       Sampling temperature 0–2 (default: 0.2)
  --thinking-level <level>  Thinking budget: off|low|medium|high (default: off)
  --retry-mode <mode>       Retry delay mode: exponential (default) | fixed
  --retry-fixed-ms <ms>     Fixed retry delay in ms when --retry-mode fixed (default: 120000)
  --help                    Show this message
`);
    process.exit(code);
}

if (_flag('--help') || _flag('-h')) _usage(0);
if (args.length === 0) _usage(1);

const promptText    = _arg('--prompt');
const taskText      = _arg('--task') || _arg('--workflow');
const taskFile      = _arg('--task-file');
const workspacePath = _arg('--workspace') || process.env.WORKSPACE_ROOT || process.cwd();

// --llm PROVIDER|MODEL splits on the first '|'
const llmSpec       = _arg('--llm') || '';
const _llmParts     = llmSpec.indexOf('|') >= 0 ? llmSpec.split('|') : [];
const provider      = (_llmParts[0] || _arg('--provider') || process.env.FREEGENT_PROVIDER || 'openai');
const model         = (_llmParts.slice(1).join('|') || _arg('--model') || process.env.FREEGENT_MODEL || '');
const apiKey        = _arg('--api-key')   || process.env.FREEGENT_API_KEY  || '';
const apiUrl        = _arg('--api-url')   || process.env.FREEGENT_API_URL  || '';
// Explicit non-positive/invalid --timeout falls back to the default deliberately (0 is not "no timeout").
const _timeoutRaw   = parseInt(_arg('--timeout') ?? '', 10);
const timeoutMs     = Number.isFinite(_timeoutRaw) && _timeoutRaw > 0 ? _timeoutRaw : undefined;
const logFile       = _flag('--no-log') ? null : (_arg('--log') || '/tmp/fg-agent.log');
const sidecarDir      = _arg('--sidecar-dir') || '';
const contextWindow   = parseInt(_arg('--context-window') || '') || 0;
const compactionLimit = parseInt(_arg('--compaction-limit') || '') || 0;
const disabledTools   = _arg('--disable-tools') || '';
const mainRole          = _arg('--main-role')          || '';
const temperatureArg  = _arg('--temperature');
const temperature     = temperatureArg != null ? parseFloat(temperatureArg) : null;
const thinkingLevel   = _arg('--thinking-level') || '';
const retryMode       = _arg('--retry-mode')     || '';
const retryFixedMs    = parseInt(_arg('--retry-fixed-ms') || '') || 0;
const maxRounds       = parseInt(_arg('--max-rounds')     || '') || 0;

let task = taskText;
if (!task && taskFile) {
    try { task = readFileSync(taskFile, 'utf8').trim(); }
    catch (e) { console.error(`Cannot read task file: ${taskFile} — ${e.message}`); process.exit(1); }
}
if (!task && !promptText) { console.error('Error: provide --prompt, --workflow, --task, or --task-file'); _usage(); }

const workspaceRoot = resolve(workspacePath);
const sharedOpts = { workspaceRoot, provider, model, apiKey, apiUrl, timeoutMs, logFile, sidecarDir, contextWindow, compactionLimit, disabledTools, mainRole, temperature, thinkingLevel, retryMode, retryFixedMs, maxRounds };

// ── Run ───────────────────────────────────────────────────────────────────────

console.error(`[fg-run] workspace: ${workspaceRoot}`);
console.error(`[fg-run] provider:  ${provider}${model ? ` / ${model}` : ''}${llmSpec ? ` (--llm ${llmSpec})` : ''}`);

if (promptText) {
    console.error(`[fg-run] mode:      prompt (direct LLM call)`);
    console.error(`[fg-run] prompt:    ${promptText.slice(0, 120)}${promptText.length > 120 ? '…' : ''}`);
    if (logFile) console.error(`[fg-run] log:       ${logFile}`);
    const { output, error } = await llmPrompt(promptText, sharedOpts);
    if (error) console.error(`[fg-run] Error: ${error}`);
    console.log(output);
    process.exit(error ? 1 : 0);
} else {
    console.error(`[fg-run] mode:      workflow (agent loop)`);
    console.error(`[fg-run] task:      ${task!.slice(0, 120)}${task!.length > 120 ? '…' : ''}`);
    if (logFile) console.error(`[fg-run] log:       ${logFile}`);
    const { output, error, metrics } = await run(task!, { ...sharedOpts, workflowMode: true });
    if (error) console.error(`[fg-run] Error: ${error}`);
    process.stdout.write(`__FG_METRICS__:${JSON.stringify(metrics)}\n`);
    console.log(output);
    process.exit(error ? 1 : 0);
}
