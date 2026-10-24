#!/usr/bin/env node
// nudge-index.mjs — an index of every harness nudge and completion gate by NAME: docs/harness/nudges.md.
//   node scripts/nudge-index.mjs            print the index
//   node scripts/nudge-index.mjs --update   write docs/harness/nudges.md
//   node scripts/nudge-index.mjs --check    exit 1 when the committed index lacks a name found in the code (or lists one that is gone)
// The names are what appears in the per-turn logs (`type: nudge`, field `name`), in `nudge_min` / `nudge_absent` sim checks and in
// reports about the harness. Before this index, the doc docs/prompts/nudges-and-completion-gate.txt listed texts by constant
// and 30 of 31 names could not be found in it (self-analysis T12: an audit of "all nudges" missed every completion gate).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'docs/harness/nudges.md');
const EMITTERS = ['llm-loops.ts', 'workers.ts'];
const GATE_FILES = ['completion-gates.ts', 'bench-policy.ts'];

/** What each nudge or gate is for (one line). A new name must get an entry here: `--check` fails without one. */
export const WHEN = {
    bad_args: 'the arguments of a tool call were not valid JSON or arrived damaged (call markers of the model itself inside the argument names)',
    bad_tool_format: 'the model wrote a tool call together with a fabricated result',
    blocked_untried_fix: 'benchmark policy: BLOCKED declared before a fix was tried',
    broken_tool_call: 'a tool call written as text (markup in the message), so nothing ran',
    calls_overflow: 'more than 20 tool calls in one response: only the first 20 ran',
    completion_gate: 'first COMPLETED after edits: the completion checklist (and, in benchmark runs, the graded-test bounce)',
    dup_cycle: 'the same sequence of calls repeating in a cycle',
    empty_code: 'execute_code called with no code argument',
    env_config_edits: 'gate: test or packaging configuration edited, or a new top-level package added, instead of fixing the code',
    env_failure: 'execute_code failing repeatedly with the same error (3) or in total (8); also two inline python3 -c syntax failures in a row',
    failed_check_complete: 'gate: COMPLETED while the last test/compile check after the last change failed',
    invented_data: 'gate: the work created stand-in data or files nobody supplied',
    no_change_fix: 'benchmark policy: a "fix" that changed nothing',
    no_edit_complete: 'benchmark policy: COMPLETED on a task that needs an edit, with no edit made',
    output_cut_off: 'the response was cut off by the output cap or ended in a degenerate repeated tail',
    output_stalled: 'generation stalled mid-response and was discarded; nothing ran',
    quality_check: 'runaway or low-quality response (repeated characters, long loops)',
    reactive_guidance: 'a skill whose trigger matched the situation this step; forces a tool call',
    replace_fail: 'repeated replace_in_file failures on the same file',
    rewrite_loop: 'the same file written in full 4, 8, 12 ... times with no passing check between',
    same_error: 'the same error repeated several times in a row',
    scratch_only_edits: 'gate: COMPLETED but only scratch/repro files were changed',
    step_validation: 'a step output check (pseudo tool call, missing state line, ...) failed',
    steps_left: 'few steps left in the turn',
    stuck_detected: 'three identical full results in a row',
    tool_failure: 'two to four consecutive tool errors',
    tool_failures: 'five or more consecutive failing tool calls',
    tool_repeat: 'a tool call repeated within the turn: cached results are returned',
    turn_state: 'protocol reminder: reply has no COMPLETED/BLOCKED line',
    worker_empty_report: 'a worker ended with an empty message',
    worker_env_fail: 'a worker\'s commands failing repeatedly (environment)',
    worker_no_tools: 'a worker answered without calling any tool',
    worker_runaway: 'a worker\'s response ran away (repetition / quality check)',
    worker_stuck: 'a worker got identical results repeatedly',
};

/** [{name, kind: 'nudge'|'gate', file}] sorted by name. */
export function collectNudges(root = ROOT) {
    const found = new Map();
    const add = (name, kind, file) => { if (!found.has(name)) found.set(name, { name, kind, file }); };
    for (const f of EMITTERS) {
        for (const line of readFileSync(join(root, f), 'utf8').split('\n')) {
            const m = /\b_?emitNudge\(\s*'([a-z_0-9]+)'/.exec(line);
            if (m) add(m[1], 'nudge', f);
        }
    }
    for (const f of GATE_FILES) {
        const p = join(root, f);
        if (!existsSync(p)) continue;
        for (const m of readFileSync(p, 'utf8').matchAll(/^ {4}name: '([a-z_0-9]+)',/gm)) add(m[1], 'gate', f);
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderIndex(items) {
    const rows = items.map(i => `| \`${i.name}\` | ${i.kind} | \`${i.file}\` | ${WHEN[i.name] ?? '(undescribed)'} |`);
    return `# Harness nudges and completion gates, by name

Generated by \`node scripts/nudge-index.mjs --update\` (checked by \`tests/nudge-index.test.ts\`; the descriptions live in \`WHEN\` in that script). A **nudge** is a user-role message
the loop appends after a step (\`type: nudge\` in the turn log); a **gate** is a check at COMPLETED that can bounce the reply with its own nudge. The texts are in the files named;
\`docs/prompts/nudges-and-completion-gate.txt\` has the long ones by constant. Benchmark-only gates live in \`bench-policy.ts\` and are installed only when an \`FG_*\` switch is set.

| name | kind | defined in | when |
|---|---|---|---|
${rows.join('\n')}
`;
}

const names = (md) => new Set([...md.matchAll(/^\| `([a-z_0-9]+)` \|/gm)].map(m => m[1]));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const items = collectNudges();
    const arg = process.argv[2];
    if (arg === '--update') { writeFileSync(DOC, renderIndex(items)); console.log(`${items.length} nudges and gates -> docs/harness/nudges.md`); }
    else if (arg === '--check') {
        const have = existsSync(DOC) ? names(readFileSync(DOC, 'utf8')) : new Set();
        const want = new Set(items.map(i => i.name));
        const missing = [...want].filter(n => !have.has(n)), gone = [...have].filter(n => !want.has(n)), undescribed = [...want].filter(n => !WHEN[n]);
        if (undescribed.length) { console.error(`add a description to WHEN in scripts/nudge-index.mjs for: ${undescribed.join(', ')}`); process.exit(1); }
        if (missing.length || gone.length) { console.error(`nudge index is stale: missing ${missing.join(', ') || '-'}; gone ${gone.join(', ') || '-'}. Run: node scripts/nudge-index.mjs --update`); process.exit(1); }
        console.log(`nudge index current (${want.size} names)`);
    } else process.stdout.write(renderIndex(items));
}
