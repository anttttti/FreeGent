// post-turn.js — FreeGent: post-turn background agent system
// Depends on: config.js, workers.js, state.js (agentStreaming, activeChatId).
import { agentStreaming, activeChatId } from './state.js';

export async function runPostTurnAgents(): Promise<void> {
    if (getAgentReviewLogs()) {
        try { await _saveLogAndCreateReviewTask(); } catch (e) { console.warn('[post-turn] log review:', e.message); }
    }
}


const LEDGER_HEADER = '| ID  | Status       | Priority | Title |\n|-----|--------------|----------|-------|\n';

async function _saveLogAndCreateReviewTask() {
    if (typeof conversationLog === 'undefined' || !conversationLog.length) return;

    const allTurns = conversationLog.filter(e => e.chatId === activeChatId);
    if (!allTurns.length) return;
    // Only log the last run — if the conversation was rewound/rerun, earlier attempts
    // have their own Step 0 start; find the last one and discard everything before it.
    const lastRun0 = allTurns.reduceRight((idx, t, i) => idx === -1 && (t.step === 0 || t.round === 0) ? i : idx, -1);
    const turns = (lastRun0 > 0 ? allTurns.slice(lastRun0) : allTurns)
        .filter(t => t.type !== 'validation');
    if (!turns.some(t => (t.response?.length ?? 0) >= 80)) return;

    const now      = new Date();
    const iso      = now.toISOString();
    const ts       = iso.slice(0, 19).replace(/[T:]/g, '-');
    const chatName = (turns[0].chatName || 'chat').replace(/[^a-z0-9]+/gi, '-').slice(0, 40).toLowerCase();
    const logPath  = `logs/${ts}-${chatName}.md`;

    const lines = [
        `# Session Log — ${iso.slice(0, 16).replace('T', ' ')}`,
        `Chat: ${turns[0].chatName || activeChatId}`,
        '',
    ];
    for (const t of turns) {
        lines.push(`## Step ${t.step ?? '?'} — ${t.model ?? '?'} (${t.provider ?? '?'})`);
        if (t.promptTokens) lines.push(`Tokens: ${t.promptTokens} in / ${t.responseTokens ?? '?'} out`);
        if (t.loopDetected) lines.push('⚠ Loop detected');
        if (t.toolCalls?.length) {
            lines.push('**Tool calls:**');
            for (const tc of t.toolCalls) {
                const args = typeof tc.args === 'string' ? tc.args.slice(0, 2000) : JSON.stringify(tc.args || {}).slice(0, 2000);
                lines.push(`- ${tc.name}(${args})`);
            }
        }
        if (t.response) lines.push('', '**Response:**', t.response.slice(0, 800));
        lines.push('');
    }

    const tasksDir = 'tasks';
    let nextId = '001';
    const [, filesResult] = await Promise.allSettled([
        agentWriteFile(logPath, lines.join('\n')),
        agentListFiles(),
    ]);
    if (filesResult.status === 'fulfilled') {
        const ids = (filesResult.value || [])
            .map(f => (f.name || f).match(/^(?:local\/)?tasks\/(\d+)-/))
            .filter(Boolean)
            .map(m => parseInt(m[1], 10));
        if (ids.length) nextId = String(Math.max(...ids) + 1).padStart(3, '0');
    }

    const today    = iso.slice(0, 10);
    const slug     = `review-session-log-${today}`;
    const taskPath = `${tasksDir}/${nextId}-${slug}.md`;
    const taskContent = [
        '---',
        `id: ${nextId}`,
        `title: Review session log ${today} for AI inefficiencies`,
        'status: open',
        'priority: Low',
        `created: ${today}`,
        `updated: ${today}`,
        '---',
        '',
        `# Review session log ${today} for AI inefficiencies`,
        '',
        `Read \`${logPath}\` and go through the steps the AI took.`,
        'Look for: stuck loops, redundant file reads, missed parallelism, wrong tools, unnecessary model fallbacks.',
        '',
        '## Your job',
        '1. Identify any inefficiencies or mistakes in the AI steps.',
        '2. For each issue, check whether it is still present in the **current source code** (read the relevant files).',
        '3. If it is still present: fix it directly in the code. Do NOT create a separate task for it.',
        '4. If it is not present (already fixed or no longer relevant): note it and move on.',
        '5. Do NOT redo or revert any changes that were already made as part of the reviewed session.',
        '6. Summarise findings and fixes in the task log, then mark this task done.',
        '',
        '## Acceptance Criteria',
        '- [ ] Log file read and steps reviewed',
        '- [ ] Each identified issue checked against current code',
        '- [ ] Relevant issues fixed in-place in the code (not deferred to new tasks)',
        '- [ ] Summary written to task log',
        '',
        '## Anti-cycle rules (mandatory)',
        '- Do NOT create a task to review this log or any other log.',
        '- Do NOT write to `logs/`.',
        '- Do NOT save message history.',
        '- Do NOT redo changes that were made during the reviewed session.',
        '',
        `## Log file`,
        `\`${logPath}\``,
    ].join('\n');

    const ledgerPath = `${tasksDir}/ledger.md`;
    const [, ledgerResult] = await Promise.allSettled([
        agentWriteFile(taskPath, taskContent),
        agentReadFile(ledgerPath),
    ]);
    try {
        const existing = ledgerResult.status === 'fulfilled' ? ledgerResult.value : '';
        const ledger = existing.trim() ? existing : LEDGER_HEADER;
        const newRow  = `| ${nextId} | open        | Low      | Review session log ${today} for AI inefficiencies |`;
        await agentWriteFile(ledgerPath, ledger.trimEnd() + '\n' + newRow + '\n');
    } catch {}

    refreshTasks?.();
}


export async function rebuildLedger(): Promise<void> {
    const LEDGER = 'fg-tasks/ledger.md';
    let files: Array<{ name: string; size?: number; lastModified?: number; isLocal?: boolean }>;
    try { files = await agentListFiles(); } catch { return; }

    const taskPaths = (files || [])
        .map(f => (typeof f === 'string' ? f : f.name) || '')
        .filter(n => /^(?:fg-|local\/)?tasks\/\d+-.+\.md$/i.test(n))
        .sort();

    if (!taskPaths.length) return;

    const entries = await Promise.all(taskPaths.map(async path => {
        try {
            const content = await agentReadFile(path);
            if (typeof content !== 'string') return null;
            const fm = parseFrontmatter(content);
            const id       = String(fm.id || path.match(/(\d+)/)?.[1] || '?').padStart(3, '0');
            const status   = (fm.status   || 'open').slice(0, 12).padEnd(12);
            const priority = (fm.priority || '—').slice(0, 8).padEnd(8);
            const title    = (fm.title    || path.split('/').pop().replace(/^\d+-/, '').replace(/\.md$/, '')).slice(0, 80);
            return `| ${id} | ${status} | ${priority} | ${title} |`;
        } catch { return null; }
    }));

    const rows = entries.filter(Boolean);
    if (!rows.length) return;

    const table = LEDGER_HEADER + rows.join('\n') + '\n';

    let archivePart = '';
    try {
        const existing = await agentReadFile(LEDGER);
        const archiveIdx = existing.indexOf('\n## Archive');
        if (archiveIdx >= 0) archivePart = existing.slice(archiveIdx);
    } catch {}
    await agentWriteFile(LEDGER, table + archivePart);
    console.log('[ledger] rebuilt from', rows.length, 'task files');
}

export async function repairLedgerIfBroken(): Promise<void> {
    if (!getAgentLedger?.()) return;
    await rebuildLedger().catch(() => {});
}

// ── Auto-init: write AGENTS.md when a local folder is opened with no project context ──

export async function maybeRunInitAgent(): Promise<void> {
    if (agentStreaming) return;

    let files: Array<{ name: string; size?: number; lastModified?: number; isLocal?: boolean }>;
    try { files = await agentListFiles(); } catch { return; }

    const hasContext = (files || []).some(f =>
        /^(?:local\/)?(?:AGENTS|CLAUDE|PROJECT|OPENCODE)\.md$/i.test((typeof f === 'string' ? f : f.name) || '')
    );
    if (hasContext) return;

    const today = new Date().toISOString().slice(0, 10);
    const task =
`Scan this workspace and write AGENTS.md — a concise project context file.

Steps (run in order):
1. Call list_files and repo_map in parallel.
2. In one parallel batch, read whichever of these exist (skip missing):
   package.json, pyproject.toml, setup.py, Cargo.toml, go.mod, composer.json,
   Makefile, README.md, tsconfig.json, docker-compose.yml
3. Write AGENTS.md using write_file. Target 30–60 lines. Use this structure:

# Project: [name from config or folder name]
*Generated: ${today}*

## Overview
[1–3 sentences: what this project is]

## Stack
- [language/runtime + key framework, one per line]

## Structure
\`\`\`
[top-level directories and purpose — 5–10 entries]
\`\`\`

## Commands
\`\`\`bash
# Install
[command or "not found"]
# Run / dev
[command or "not found"]
# Test
[command or "not found"]
# Lint / type-check
[command or "not found"]
\`\`\`

## Conventions
- [key conventions found in config/readme — skip obvious ones]

Omit sections where no information was found. Do not invent commands.`;

    try {
        await executeWorkers({ agents: [{ id: 'init', task, role: 'coder' }] });
        loadAgentsContext?.();
    } catch (e) {
        console.warn('[init] background init failed:', e.message);
    }
}

// Window bridge for classic scripts.
Object.assign(window, { runPostTurnAgents, rebuildLedger, repairLedgerIfBroken, maybeRunInitAgent });
