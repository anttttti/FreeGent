// qa.js — FreeGent: task lifecycle gates and Kanban transition processing
// Depends on: config.js, tools.js, workers.js, tasks.js


const QA_DEFAULT_GATES = {
    'todo->in-progress':      ['dependency-check', 'task-enrichment'],
    'open->in-progress':      ['dependency-check', 'task-enrichment'],
    'in-progress->in-review': ['completeness-check', 'self-review'],
    'in-review->done':        ['acceptance-review', 'test-runner'],
    // Direct in-progress→done (model skipped in-review): run the full review suite
    'in-progress->done':      ['completeness-check', 'self-review', 'acceptance-review', 'test-runner'],
};

async function loadWorkflow() {
    try {
        return parseWorkflowMd(await agentReadFile('WORKFLOW.md'));
    } catch {
        return { gates: QA_DEFAULT_GATES, config: {} };
    }
}

function parseWorkflowMd(text) {
    const gates: Record<string, any> = {};
    const config: Record<string, any> = {};
    let section: string | null = null;
    for (const line of text.split('\n')) {
        const secM = line.match(/^##\s+Gates:\s*(.+?)\s*$/i);
        if (secM) { section = secM[1].trim().toLowerCase().replace(/\s*[→>]\s*/g, '->'); continue; }
        if (/^##\s+Config/i.test(line)) { section = 'config'; continue; }
        if (section === 'config') {
            const m = line.match(/^([\w-]+):\s*(.+)$/);
            if (m) config[m[1]] = m[2].trim();
        } else if (section) {
            const m = line.match(/^-\s+(\S+)/);
            if (m) { if (!gates[section]) gates[section] = []; gates[section].push(m[1]); }
        }
    }
    for (const [k, v] of Object.entries(QA_DEFAULT_GATES)) {
        if (!gates[k]) gates[k] = v;
    }
    return { gates, config };
}


async function setTaskStatus(taskPath, newStatus) {
    try {
        let content: string;
        try {
            content = await agentReadFile(taskPath);
        } catch {
            // File doesn't exist yet — synthesise a minimal stub in memory.
            // The final agentWriteFile below will create it with the correct status.
            const title = taskPath.replace(/^.*\/\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
            const date  = new Date().toISOString().slice(0, 10);
            content = `---\nstatus: todo\ntitle: ${title}\ncreated: ${date}\n---\n\n# ${title}\n`;
        }
        const before = content;
        // Match "status: value" or bare "status:" (no value) so partial frontmatter is handled.
        content = content.replace(/^status:[ \t]*\S*/m, `status: ${newStatus}`);
        if (content === before) {
            // No status: line at all — insert one into the frontmatter block.
            if (/^---[ \t]*\r?\n/m.test(content)) {
                content = content.replace(/^(---[ \t]*\r?\n)/m, `$1status: ${newStatus}\n`);
            } else {
                // No frontmatter — prepend a minimal block so the file is now valid.
                content = `---\nstatus: ${newStatus}\n---\n\n${content}`;
            }
            console.warn(`[QA] setTaskStatus: inserted missing status field into "${taskPath}"`);
        }
        const date = new Date().toISOString().slice(0, 10);
        const logLine = `\n### ${date} — status: ${newStatus}\n`;
        if (!content.includes(logLine.trim())) {
            content = content.trimEnd() + logLine;
        }
        await agentWriteFile(taskPath, content);
    } catch (e) {
        // Do not swallow (audit §4.3). Every caller treats a normal return as success:
        // transitionTask reports { transitioned: true }, update_task_status reports
        // { ok: true }, and the autopilot/agent-loop episodes advance. A silent failure
        // here therefore becomes a fabricated success — and, because the status never
        // changes on disk, the task loops re-select the same task forever. Throwing stops
        // the loop instead, which is the correct outcome for an unwritable workspace.
        console.error(`[QA] setTaskStatus failed for "${taskPath}":`, e);
        throw new Error(`setTaskStatus: could not write "${taskPath}": ${e.message}`);
    }
    // Only reached when the task file was written — never advance the ledger past the
    // task's real state.
    await _updateLedgerRow(taskPath, newStatus);
}

async function _updateLedgerRow(taskPath, newStatus) {
    const idMatch = taskPath.match(/[/\\](\d+)-/);
    if (!idMatch) return;
    const id = idMatch[1];
    const ledgerCandidates = ['fg-tasks/ledger.md', 'tasks/ledger.md', 'local/tasks/ledger.md'];
    for (const ledgerPath of ledgerCandidates) {
        let ledger: string;
        try { ledger = await agentReadFile(ledgerPath); } catch { continue; }
        // Only update rows in the main table — stop at ## Archive
        const archiveSplit = ledger.indexOf('\n## Archive');
        const mainPart    = archiveSplit >= 0 ? ledger.slice(0, archiveSplit) : ledger;
        const archivePart = archiveSplit >= 0 ? ledger.slice(archiveSplit)    : '';
        const updated = mainPart.replace(
            new RegExp(`^(\\|\\s*${id}\\s*\\|\\s*)\\S[^|]*(\\|)`, 'm'),
            (_, pre, post) => `${pre}${newStatus.padEnd(12)}${post}`
        );
        if (updated !== mainPart) {
            await agentWriteFile(ledgerPath, updated + archivePart);
            return;
        }
        console.warn(`[QA] _updateLedgerRow: no row found for ID ${id} in "${ledgerPath}"`);
    }
}

function _setFrontmatterField(content, key, value) {
    const re = new RegExp(`^${key}:[ \\t]*.+$`, 'm');
    if (re.test(content)) return content.replace(re, `${key}: ${value}`);
    return content.replace(/^(---[\s\S]*?)(^---[ \t]*$)/m, `$1${key}: ${value}\n$2`);
}

async function appendGateNote(taskPath, text) {
    try {
        const content = await agentReadFile(taskPath);
        if (content.includes(text.trim())) {
            return;
        }
        await agentWriteFile(taskPath, content.trimEnd() + '\n\n' + text + '\n');
    } catch {}
}

async function writeBackgroundReport(message) {
    try {
        await agentWriteFile('memory/bg-report.md',
            `[QA] ${new Date().toISOString()}\n${message}\n`);
    } catch {}
}

async function appendMemoryLog(taskPath, fromStatus, toStatus, gates) {
    const name  = taskPath.split('/').pop().replace('.md', '');
    const gList = gates.length ? ` [${gates.join(', ')} ✓]` : '';
    const line  = `${new Date().toISOString().slice(0, 16)}Z  ${name}  ${fromStatus} → ${toStatus}${gList}\n`;
    try {
        let log: string = '';
        try { log = await agentReadFile('memory/log.md'); } catch {}
        await agentWriteFile('memory/log.md', log + line);
    } catch {}
}


async function gate_dependency_check(taskPath, content) {
    const fm      = parseFrontmatter(content);
    const depends = fm.depends ? String(fm.depends).split(/[\s,]+/).filter(Boolean) : [];
    if (!depends.length) return { blocks: false };

    const allTasks = await loadTaskFiles();
    const byId     = new Map(allTasks.map(t => [String(t.fm.id || ''), t] as [string, any]));
    const blocking = [];

    for (const dep of depends) {
        const dt: any = byId.get(dep);
        if (!dt) { blocking.push(`#${dep} (not found)`); continue; }
        const s = (dt.fm.status || 'todo').toLowerCase();
        if (s !== 'done' && s !== 'completed')
            blocking.push(`#${dep} (${s}): ${dt.fm.title || dep}`);
    }

    if (blocking.length)
        return { blocks: true, reason: `Blocked: waiting on ${blocking.join(', ')}` };
    return { blocks: false };
}


async function gate_completeness_check(taskPath, content) {
    const unchecked = [...content.matchAll(/^-\s+\[ \]/gm)];
    if (unchecked.length)
        return { blocks: true, reason: `Plan incomplete: ${unchecked.length} unchecked step${unchecked.length > 1 ? 's' : ''}` };

    const fileSec = content.match(/^## Files\n([\s\S]*?)(?=^##|\s*$)/m);
    if (fileSec) {
        const paths = [...fileSec[1].matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1]).slice(0, 8);
        for (const fp of paths) {
            try {
                const fc   = await agentReadFile(fp);
                const hits = [...fc.matchAll(/\b(TODO|FIXME|STUB|NOT IMPLEMENTED)\b/g)];
                if (hits.length)
                    return { blocks: true, reason: `${hits.length} TODO/FIXME in ${fp}` };
            } catch {}
        }
    }
    return { blocks: false };
}


async function gate_scope_check(taskPath, content) {
    const sections = [...content.matchAll(/^###\s+/gm)];
    if (sections.length > 7)
        return { blocks: false, detail: `Scope note: ${sections.length} sub-sections — consider splitting` };
    return { blocks: false };
}


async function gate_task_enrichment(taskPath, content) {
    if (/^## Acceptance/m.test(content)) return { blocks: false };
    const fm   = parseFrontmatter(content);
    const body = content.replace(/^---[\s\S]*?---\n/, '').slice(0, 2000);
    const prompt =
        `Given this task, write 4–7 concrete, verifiable acceptance criteria as a markdown list ` +
        `under the heading "## Acceptance". Output ONLY that section.\n\nTask: ${fm.title || taskPath}\n\n${body}`;
    try {
        const criteria = await callLLMComplete(prompt, { maxTokens: 1024 });
        if (criteria?.trim()) await appendGateNote(taskPath, criteria.trim());
    } catch {}
    return { blocks: false };
}


async function gate_self_review(taskPath, content) {
    const fileSec  = content.match(/^## Files\n([\s\S]*?)(?=^##|\s*$)/m);
    const filePaths = fileSec
        ? [...fileSec[1].matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1]).slice(0, 4)
        : [];

    let fileContents: string = '';
    for (const fp of filePaths) {
        try { fileContents += `\n### ${fp}\n\`\`\`\n${(await agentReadFile(fp)).slice(0, 2000)}\n\`\`\`\n`; }
        catch {}
    }

    const fm = parseFrontmatter(content);
    const prompt =
        `Write a 4–6 bullet self-review for this completed task: what changed, why, and which ` +
        `acceptance criteria appear met. No preamble — bullets only.\n\nTask: ${fm.title || taskPath}` +
        (fileContents ? `\n\nChanged files:${fileContents}` : '');
    try {
        const summary = await callLLMComplete(prompt, { maxTokens: 1024 });
        if (summary?.trim()) {
            const ts = new Date().toISOString().slice(0, 16) + 'Z';
            await appendGateNote(taskPath, `## Self-Review: ${ts}\n${summary.trim()}`);
        }
    } catch {}
    return { blocks: false };
}


async function gate_acceptance_review(taskPath, content) {
    if (!getQaAcceptanceReview()) return { blocks: false };

    const acceptM = content.match(/^## Acceptance\n([\s\S]*?)(?=^##|\s*$)/m);
    if (!acceptM) return { blocks: false, detail: 'No acceptance criteria — skipping review' };

    const criteria = acceptM[1].trim();
    const fileSec  = content.match(/^## Files\n([\s\S]*?)(?=^##|\s*$)/m);
    const filePaths = fileSec
        ? [...fileSec[1].matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1]).slice(0, 5)
        : [];

    let fileContents: string = '';
    for (const fp of filePaths) {
        try { fileContents += `\n### ${fp}\n\`\`\`\n${(await agentReadFile(fp)).slice(0, 2500)}\n\`\`\`\n`; }
        catch {}
    }

    const prompt =
        `Check whether each acceptance criterion is met in the provided code.\n\n` +
        `Criteria:\n${criteria}\n\nCode:${fileContents || '\n(no files available)'}\n\n` +
        `For EACH criterion output exactly one line:\n` +
        `- ✓ [criterion] — if clearly met\n` +
        `- ✗ [criterion] — [reason] — if not met\n` +
        `- ? [criterion] — if cannot verify\n\n` +
        `Final line: VERDICT: PASS or VERDICT: FAIL`;

    try {
        // temperature: 0 — binary PASS/FAIL verdict against criteria; deterministic is better.
        const result = await callLLMComplete(prompt, { temperature: 0, maxTokens: 1024 });
        const ts     = new Date().toISOString().slice(0, 16) + 'Z';
        await appendGateNote(taskPath, `## QA: Acceptance Review (${ts})\n${result.trim()}`);

        const failed = [...result.matchAll(/^- ✗ (.+)/gm)].map(m => m[1]);
        if (result.includes('VERDICT: FAIL') || failed.length > 0)
            return { blocks: true, reason: `Criteria not met: ${failed.slice(0, 2).join('; ')}${failed.length > 2 ? ` (+${failed.length - 2} more)` : ''}` };
    } catch (e) {
        return { blocks: false, detail: `Acceptance review error: ${e.message}` };
    }
    return { blocks: false };
}


async function gate_test_runner(taskPath, content) {
    if (!getQaTestRunner()) return { blocks: false };
    if (!_hasBashOrCode())  return { blocks: false, detail: 'No sandbox — skipping tests' };

    const fileSec  = content.match(/^## Files\n([\s\S]*?)(?=^##|\s*$)/m);
    const filePaths = fileSec
        ? [...fileSec[1].matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1])
        : [];

    const testFiles = [];
    for (const fp of filePaths) {
        const base = fp.replace(/\.[^.]+$/, '');
        const name = fp.split('/').pop().replace(/\.[^.]+$/, '');
        for (const c of [`${base}.test.js`, `${base}.spec.js`, `tests/${name}.test.js`, `__tests__/${name}.js`]) {
            try { await agentReadFile(c); testFiles.push(c); break; } catch {}
        }
    }
    if (!testFiles.length) return { blocks: false, detail: 'No test files found for changed files' };

    let cmd: string | null = null;
    try {
        const pkg = JSON.parse(await agentReadFile('package.json'));
        if (pkg.scripts?.test) cmd = 'npm test 2>&1 | tail -40';
    } catch {}
    if (!cmd) cmd = `node ${testFiles.join(' ')} 2>&1 | tail -40`;

    try {
        const res    = await executeToolAsync('execute_code', { language: 'bash', code: cmd }, null);
        const output = ((res.stdout || '') + (res.stderr || '')).slice(0, 1200);
        if (res.exit_code !== 0) {
            const ts = new Date().toISOString().slice(0, 16) + 'Z';
            await appendGateNote(taskPath, `## QA: Test Failures (${ts})\nCommand: ${cmd}\n${output}`);
            return { blocks: true, reason: `Tests failed (exit ${res.exit_code}): ${output.split('\n').find(l => /fail|error/i.test(l)) || 'see task file'}` };
        }
    } catch (e) {
        return { blocks: false, detail: `Test runner error: ${e.message}` };
    }
    return { blocks: false };
}


async function gate_regression_guard(taskPath) {
    if (!getQaRegressionGuard()) return { blocks: false };
    if (!_hasBashOrCode())       return { blocks: false, detail: 'No sandbox — skipping regression guard' };

    const { config }: { config: any } = await loadWorkflow();
    let cmd: string | null = config?.regression_guard_command || null;
    if (!cmd) {
        try {
            const pkg = JSON.parse(await agentReadFile('package.json'));
            cmd = pkg.scripts?.typecheck ? 'npm run typecheck'
                : pkg.scripts?.build    ? 'npm run build'
                : pkg.scripts?.lint     ? 'npm run lint'
                : null;
        } catch {}
    }
    if (!cmd) return { blocks: false, detail: 'No build command detected — skipping' };

    try {
        const res = await executeToolAsync('execute_code', { language: 'bash', code: `${cmd} 2>&1 | tail -30` }, null);
        if (res.exit_code !== 0) {
            const ts  = new Date().toISOString().slice(0, 16) + 'Z';
            const out = ((res.stdout || '') + (res.stderr || '')).slice(0, 600);
            await appendGateNote(taskPath, `## QA: Regression Guard (${ts})\nCommand: ${cmd}\nExit: ${res.exit_code}\n${out}`);
            return { blocks: true, reason: `Regression: \`${cmd}\` failed (exit ${res.exit_code})` };
        }
    } catch (e) {
        return { blocks: false, detail: `Regression guard error: ${e.message}` };
    }
    return { blocks: false };
}


const GATES = {
    'dependency-check':   gate_dependency_check,
    'completeness-check': gate_completeness_check,
    'scope-check':        gate_scope_check,
    'task-enrichment':    gate_task_enrichment,
    'self-review':        gate_self_review,
    'acceptance-review':  gate_acceptance_review,
    'test-runner':        gate_test_runner,
    'regression-guard':   gate_regression_guard,
};


async function transitionTask(taskPath, toStatus) {
    if (!getQaEnabled()) {
        await setTaskStatus(taskPath, toStatus);
        return { transitioned: true };
    }

    let content: string;
    try { content = await agentReadFile(taskPath); }
    catch { await setTaskStatus(taskPath, toStatus); return { transitioned: true }; }

    const fm          = parseFrontmatter(content);
    const fromStatus  = (fm.status || 'todo').toLowerCase();
    const reworkCount = parseInt(fm.rework_count || '0', 10);

    if (toStatus === 'in-progress' && fromStatus === 'in-review' && reworkCount >= getQaReworkLimit()) {
        const reason = `Rework limit reached (${reworkCount}/${getQaReworkLimit()}). Human review required.`;
        await appendGateNote(taskPath, `## Blocked: Rework Limit (${new Date().toISOString().slice(0, 16)}Z)\n${reason}`);
        await setTaskStatus(taskPath, 'blocked');
        await writeBackgroundReport(`[Task QA] ${taskPath}\n${reason}`);
        return { transitioned: false, reason };
    }

    const { gates: workflowGates } = await loadWorkflow();
    // If the model jumped straight from in-progress to done (skipping in-review),
    // in-progress->done is in QA_DEFAULT_GATES with the full review suite.
    const gateKey  = `${fromStatus}->${toStatus}`;
    const gateNames = workflowGates[gateKey] || [];
    const passed   = [];

    const failures = [];
    for (const gateName of gateNames) {
        const gateFn = GATES[gateName];
        if (!gateFn) continue;

        let result: { blocks: boolean; reason?: string; detail?: string };
        try   { result = await gateFn(taskPath, content); }
        catch (e) { result = { blocks: false, detail: `Gate error: ${e.message}` }; }

        const ts = new Date().toISOString().slice(0, 16) + 'Z';
        if (result.blocks) {
            await appendGateNote(taskPath, `## Gate: ${gateName} FAILED (${ts})\n${result.reason || ''}`);
            failures.push({ gate: gateName, reason: result.reason });
        } else {
            passed.push(gateName);
        }
    }

    if (failures.length) {
        if (toStatus === 'done' || fromStatus === 'in-review') {
            content = _setFrontmatterField(content, 'rework_count', reworkCount + 1);
            await agentWriteFile(taskPath, content);
        }
        const summary = failures.map(f => `Gate "${f.gate}": ${f.reason}`).join('\n');
        await writeBackgroundReport(`[Task QA failed] ${taskPath}\n${summary}\nTask held at ${fromStatus}.`);
        return { transitioned: false, reason: failures.map(f => `[${f.gate}] ${f.reason}`).join(' | ') };
    }

    await setTaskStatus(taskPath, toStatus);
    await appendMemoryLog(taskPath, fromStatus, toStatus, passed);
    try { await refreshTasks(); } catch {}
    return { transitioned: true };
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { setTaskStatus, _updateLedgerRow, transitionTask });
