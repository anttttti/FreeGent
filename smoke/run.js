#!/usr/bin/env node
// smoke/run.js — FreeGent smoke test runner.
//
// Runs each case in cases.jsonl through fg-run.js (real LLM, real tools),
// checks the output against pass/fail criteria, and prints a summary.
//
// Usage:
//   node smoke/run.js                              # all cases, default LLM (google|gemma-4-31b-it)
//   node smoke/run.js --llm google|gemma-4-31b-it
//   node smoke/run.js --id s03-write,s05-write-run  # specific cases
//   node smoke/run.js --group basic                  # cases in a group
//   node smoke/run.js --dry-run                      # print cases, don't run

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

// ── Arg parsing ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const _arg = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] ?? null : null; };
const _flag = f => argv.includes(f);

const llmSpec       = _arg('--llm')           || process.env.FREEGENT_LLM || 'google|gemma-4-31b-it';
const idFilter      = new Set((_arg('--id') || '').split(',').filter(Boolean));
const groupFilter   = _arg('--group')          || '';
const dryRun        = _flag('--dry-run');
const timeoutMs     = parseInt(_arg('--timeout') || '') || 120_000;  // 2 min per case
const workspace     = _arg('--workspace')      || join(__dir, 'tmp-workspace');
const keepWs        = _flag('--keep-workspace');

// fg-run model/parameter overrides (forwarded per-case, overridable in cases.jsonl)
const temperature   = _arg('--temperature');
const thinkingLevel = _arg('--thinking-level');
const contextWindow = _arg('--context-window');
const compactionLim = _arg('--compaction-limit');
const disableTools  = _arg('--disable-tools');
const retryMode     = _arg('--retry-mode');
const retryFixedMs  = _arg('--retry-fixed-ms');
const apiKey        = _arg('--api-key');
const apiUrl        = _arg('--api-url');
const mainRole      = _arg('--main-role');

if (_flag('--help') || _flag('-h')) {
    console.log(`Usage: node smoke/run.js [options]

  Case selection:
  --llm <provider|model>      LLM to use (default: google|gemma-4-31b-it, override with FREEGENT_LLM env)
  --id <id1,id2>              Run only specific case IDs
  --group <name>              Run only cases in this group
  --dry-run                   Print cases without running

  Execution:
  --timeout <ms>              Per-case timeout (default: 120000)
  --workspace <path>          Directory for file-writing tests (default: smoke/tmp-workspace)
  --keep-workspace            Don't clean workspace between cases

  Model parameters (forwarded to fg-run; per-case fields in cases.jsonl override these):
  --temperature <n>           Sampling temperature (0–2)
  --thinking-level <level>    Thinking level: none | low | medium | high | max
  --context-window <n>        Context window token limit
  --compaction-limit <n>      Compaction trigger limit
  --disable-tools <list>      Comma-separated tool names to disable
  --retry-mode <mode>         Retry mode: default | fixed | none
  --retry-fixed-ms <ms>       Fixed retry delay in ms
  --api-key <key>             API key (overrides env)
  --api-url <url>             API base URL (for local/custom endpoints)
  --main-role <role>          System prompt role override

  --help
`);
    process.exit(0);
}

// Build the set of extra fg-run args from global CLI flags.
// Per-case overrides are applied in the runner loop below.
function buildFgExtras(overrides = {}) {
    const pairs = [
        ['--llm',              overrides.llm          ?? llmSpec],
        ['--temperature',      overrides.temperature  ?? temperature],
        ['--thinking-level',   overrides.thinking_level ?? thinkingLevel],
        ['--context-window',   overrides.context_window ?? contextWindow],
        ['--compaction-limit', overrides.compaction_limit ?? compactionLim],
        ['--disable-tools',    overrides.disable_tools  ?? disableTools],
        ['--retry-mode',       overrides.retry_mode   ?? retryMode],
        ['--retry-fixed-ms',   overrides.retry_fixed_ms ?? retryFixedMs],
        ['--api-key',          overrides.api_key      ?? apiKey],
        ['--api-url',          overrides.api_url      ?? apiUrl],
        ['--main-role',        overrides.main_role    ?? mainRole],
    ];
    return pairs.flatMap(([flag, val]) => val != null && val !== '' ? [flag, String(val)] : []);
}

// ── Load cases ───────────────────────────────────────────────────────────────

const casesPath = join(__dir, 'cases.jsonl');
const allCases = readFileSync(casesPath, 'utf8')
    .split('\n').filter(l => l.trim() && !l.trim().startsWith('//'))
    .map(l => JSON.parse(l));

const cases = allCases.filter(c => {
    if (idFilter.size && !idFilter.has(c.id)) return false;
    if (groupFilter && c.group !== groupFilter) return false;
    return true;
});

console.log(`\nFreeGent smoke tests — ${cases.length} of ${allCases.length} cases\n`);
if (dryRun) {
    for (const c of cases) console.log(`  ${c.id.padEnd(25)} [${c.group}] ${c.desc}`);
    process.exit(0);
}

// ── Log file ─────────────────────────────────────────────────────────────────

const logDir = join(__dir, 'logs');
mkdirSync(logDir, { recursive: true });
const runId  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logPath = join(logDir, `smoke-${runId}.jsonl`);
const log = entry => writeFileSync(logPath, JSON.stringify(entry) + '\n', { flag: 'a' });

// ── Workspace helpers ─────────────────────────────────────────────────────────

function resetWorkspace() {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true });
    mkdirSync(workspace, { recursive: true });
}

function readWsFile(path) {
    const full = join(workspace, path);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

function wsFileSize(path) {
    const full = join(workspace, path);
    return existsSync(full) ? readFileSync(full).length : -1;
}

// ── Check evaluation ─────────────────────────────────────────────────────────

function evalChecks(c, output, logEntries) {
    const ch = c.checks || {};
    const failures = [];
    const info = [];

    if (ch.contains) {
        for (const s of ch.contains) {
            if (!output.includes(s)) failures.push(`output missing "${s}"`);
        }
    }
    if (ch.not_contains) {
        for (const s of ch.not_contains) {
            if (output.includes(s)) failures.push(`output contains forbidden "${s}"`);
        }
    }
    if (ch.output_nonempty && !output.trim()) {
        failures.push('output is empty');
    }

    // tool_called: check log entries for tool use
    if (ch.tool_called) {
        const calledNames = new Set(
            logEntries.flatMap(e => (e.toolCalls || []).map(tc => tc.name || tc.function?.name))
        );
        for (const t of ch.tool_called) {
            if (!calledNames.has(t)) failures.push(`tool "${t}" was not called`);
        }
        info.push(`tools: [${[...calledNames].join(', ')}]`);
    }

    // max_steps: count non-user non-system turns
    if (ch.max_steps != null) {
        const steps = logEntries.filter(e => e.role !== 'user' && e.role !== 'system' && e.role !== 'tool').length;
        if (steps > ch.max_steps) failures.push(`used ${steps} steps, limit is ${ch.max_steps}`);
        info.push(`steps: ${steps}`);
    }

    // file_contains: single object or array
    const fileChecks = Array.isArray(ch.file_contains) ? ch.file_contains
        : ch.file_contains ? [ch.file_contains] : [];
    for (const fc of fileChecks) {
        const content = readWsFile(fc.path);
        if (content === null) { failures.push(`file "${fc.path}" not found`); continue; }
        if (!content.includes(fc.text)) failures.push(`file "${fc.path}" does not contain "${fc.text}"`);
    }

    // file_not_contains: verify file does NOT contain text
    const fileNotChecks = Array.isArray(ch.file_not_contains) ? ch.file_not_contains
        : ch.file_not_contains ? [ch.file_not_contains] : [];
    for (const fc of fileNotChecks) {
        const content = readWsFile(fc.path);
        if (content === null) { failures.push(`file "${fc.path}" not found (for not_contains check)`); continue; }
        if (content.includes(fc.text)) failures.push(`file "${fc.path}" still contains forbidden "${fc.text}"`);
    }

    // file_min_bytes
    if (ch.file_min_bytes) {
        const size = wsFileSize(ch.file_min_bytes.path);
        if (size < 0) failures.push(`file "${ch.file_min_bytes.path}" not found`);
        else if (size < ch.file_min_bytes.bytes)
            failures.push(`file "${ch.file_min_bytes.path}" is ${size} bytes, need ${ch.file_min_bytes.bytes}`);
        else info.push(`file size: ${size} bytes`);
    }

    return { pass: failures.length === 0, failures, info };
}

// ── Runner ────────────────────────────────────────────────────────────────────

const results = [];
let passed = 0, failed = 0, errored = 0;

for (const c of cases) {
    if (!keepWs) resetWorkspace();

    process.stdout.write(`  ${c.id.padEnd(25)} ${c.desc.slice(0, 55).padEnd(55)} `);

    const caseTimeoutMs = c.timeout ? parseInt(c.timeout) : timeoutMs;

    const fgArgs = [
        '--task', c.task,
        '--workspace', workspace,
        '--timeout', String(caseTimeoutMs),
        ...buildFgExtras(c),
    ];

    // Seed workspace files required by this case before running
    if (c.workspace_files) {
        for (const [name, content] of Object.entries(c.workspace_files)) {
            writeFileSync(join(workspace, name), content, 'utf8');
        }
    }

    // Ask fg-run to write a per-case log we can parse
    const caseLog = join(logDir, `case-${c.id}-${runId}.jsonl`);
    fgArgs.push('--log', caseLog);

    const t0 = Date.now();
    let output = '';
    let runError = null;

    try {
        const fgRun    = resolve(ROOT, 'fg-run.ts');
        const tsx      = resolve(ROOT, 'node_modules/.bin/tsx');
        const result = spawnSync(tsx, ['--env-file-if-exists=.env', fgRun, ...fgArgs], {
            cwd: ROOT,
            timeout: caseTimeoutMs + 10_000,
            encoding: 'utf8',
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        output = (result.stdout || '').trim();
        if (result.status !== 0 && !output) {
            runError = (result.stderr || '').slice(0, 300) || `exit ${result.status}`;
        }
    } catch (e) {
        runError = e.message;
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);

    // Parse case log for tool calls and step count
    let logEntries = [];
    if (existsSync(caseLog)) {
        logEntries = readFileSync(caseLog, 'utf8')
            .split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    }

    if (runError) {
        const r = { id: c.id, status: 'error', error: runError, elapsed };
        results.push(r);
        log({ ...r, desc: c.desc, task: c.task });
        console.log(`ERROR  ${elapsed}s  ${runError.slice(0, 60)}`);
        errored++;
        continue;
    }

    const { pass, failures, info } = evalChecks(c, output, logEntries);
    const status = pass ? 'pass' : 'fail';
    const r = { id: c.id, status, failures, info, elapsed, output: output.slice(0, 500) };
    results.push(r);
    log({ ...r, desc: c.desc, task: c.task });

    if (pass) {
        console.log(`PASS   ${elapsed}s  ${info.join(' | ')}`);
        passed++;
    } else {
        console.log(`FAIL   ${elapsed}s  ${failures.join('; ')}`);
        failed++;
    }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(80)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${errored} errored  (${cases.length} total)`);
console.log(`Log: ${logPath}`);

if (failed + errored > 0) process.exit(1);
