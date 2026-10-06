// qa.js — FreeGent: task lifecycle gates and Kanban transition processing
// Depends on: config.js, tools.js, workers.js, tasks.js


import { canonTaskStatus } from './task-status.js';

const QA_DEFAULT_GATES = {
    'todo->in-progress':      ['dependency-check', 'task-enrichment'],
    'open->in-progress':      ['dependency-check', 'task-enrichment'],
    'in-progress->in-review': ['completeness-check', 'self-review'],
    'in-review->done':        ['acceptance-review', 'test-runner'],
    // Direct in-progress→done (model skipped in-review): run the full review suite
    'in-progress->done':      ['completeness-check', 'self-review', 'acceptance-review', 'test-runner'],
};

// The body of the first "## <name>" section (any of `names`, case-insensitive), up to the next
// "# " or "## " heading or the end of the file. null when there is no such section. Shared by every
// gate so they agree on what a section holds; handles blank lines, CRLF and a missing final newline.
function _mdSection(content: string, ...names: string[]): string | null {
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    const want = names.map(n => n.toLowerCase());
    const start = lines.findIndex(l => {
        const m = /^##\s+(.+?)\s*$/.exec(l);
        return !!m && want.includes(m[1].toLowerCase());
    });
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
    return lines.slice(start + 1, end).join('\n');
}

// Run `cmd`, show only the last `n` lines of its output, and keep the command's own exit status:
// a plain `cmd | tail` reports tail's status, so a failing test run or build looked like a pass.
const _tailKeepStatus = (cmd: string, n: number) =>
    `fg_qa_out=$(${cmd} 2>&1); fg_qa_rc=$?; printf '%s\\n' "$fg_qa_out" | tail -n ${n}; exit $fg_qa_rc`;

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
        // Edit the frontmatter block only. Detecting "no status line" by comparing the text before
        // and after the replace is wrong when the status is already `newStatus` (the replace
        // changes nothing): that inserted another `status:` line on every same-status write —
        // the runner re-marks an in-progress task in-progress on each retry/resume.
        const fmRe = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;
        const fmMatch = content.match(fmRe);
        if (fmMatch) {
            // One status line: the first is rewritten, any duplicates (from that bug) are dropped.
            const lines: string[] = [];
            let seen = false;
            for (const l of fmMatch[1].split(/\r?\n/)) {
                if (/^status:/.test(l)) { if (!seen) { lines.push(`status: ${newStatus}`); seen = true; } }
                else lines.push(l);
            }
            if (!seen) {
                lines.unshift(`status: ${newStatus}`);
                console.warn(`[QA] setTaskStatus: inserted missing status field into "${taskPath}"`);
            }
            content = `---\n${lines.join('\n')}\n---${fmMatch[2] ? '\n' : ''}` + content.slice(fmMatch[0].length);
        } else {
            // No frontmatter — prepend a minimal block so the file is now valid.
            content = `---\nstatus: ${newStatus}\n---\n\n${content}`;
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

    const fileSec = _mdSection(content, 'Files');
    if (fileSec) {
        const paths = [...fileSec.matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1]).slice(0, 8);
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


// QA gate input sizes. Reviewers judging code they can only partly see give unreliable verdicts,
// so files go in nearly whole (4–5 files × 20K ≈ 25K tokens, within the ~80K working budget).
// Test/build output is already tail-limited by the command itself.
const _QA_TEXT_MAX   = 20_000;
const _QA_FILE_MAX   = 20_000;
const _QA_OUTPUT_MAX = 10_000;

async function gate_task_enrichment(taskPath, content) {
    if (/^## Acceptance/m.test(content)) return { blocks: false };
    const fm   = parseFrontmatter(content);
    const body = content.replace(/^---[\s\S]*?---\n/, '').slice(0, _QA_TEXT_MAX);
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
    const fileSec  = _mdSection(content, 'Files');
    const filePaths = fileSec
        ? [...fileSec.matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1]).slice(0, 4)
        : [];

    let fileContents: string = '';
    for (const fp of filePaths) {
        try { fileContents += `\n### ${fp}\n\`\`\`\n${(await agentReadFile(fp)).slice(0, _QA_FILE_MAX)}\n\`\`\`\n`; }
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

    const acceptM = _mdSection(content, 'Acceptance', 'Acceptance Criteria');
    if (acceptM === null || !acceptM.trim()) return { blocks: false, detail: 'No acceptance criteria — skipping review' };

    const criteria = acceptM.trim();
    const fileSec  = _mdSection(content, 'Files');
    const filePaths = fileSec
        ? [...fileSec.matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1]).slice(0, 5)
        : [];
    // No readable `## Files` list: the reviewer would only see "(no files available)" and fail
    // every criterion ("no code provided to inspect"). Fall back to source paths named in the log.
    if (!filePaths.length) {
        const found = [...content.matchAll(/\b((?:[\w.-]+\/)*[\w.-]+\.(?:js|ts|mjs|css|html|json|py))\b/g)].map(m => m[1]);
        for (const f of found) if (!filePaths.includes(f) && !/^fg-tasks\//.test(f) && filePaths.length < 5) filePaths.push(f);
    }

    let fileContents: string = '';
    for (const fp of filePaths) {
        try { fileContents += `\n### ${fp}\n\`\`\`\n${(await agentReadFile(fp)).slice(0, _QA_FILE_MAX)}\n\`\`\`\n`; }
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

    // Pass only on an explicit "VERDICT: PASS" with every criterion marked met. An empty reply, a
    // refusal, a "?" (cannot verify) line or prose that never states a verdict leaves the task
    // unverified. One retry for a reply with no verdict; a failed call blocks rather than waves
    // the task through.
    try {
        let result = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            // temperature: 0 — binary PASS/FAIL verdict against criteria; deterministic is better.
            result = await callLLMComplete(prompt, { temperature: 0, maxTokens: 1024 });
            if (/VERDICT:\s*(PASS|FAIL)/i.test(result)) break;
        }
        const ts     = new Date().toISOString().slice(0, 16) + 'Z';
        await appendGateNote(taskPath, `## QA: Acceptance Review (${ts})\n${result.trim()}`);

        // The leading "- " is optional: reviewers often drop the bullet, and a strict match gave a
        // blocking verdict with an empty reason ("Criteria not met: ") that agents could not act on.
        const failed     = [...result.matchAll(/^\s*(?:[-*]\s*)?✗\s*(.+)/gm)].map(m => m[1]);
        const unverified = [...result.matchAll(/^\s*(?:[-*]\s*)?\?\s+(.+)/gm)].map(m => m[1]);
        if (/VERDICT:\s*FAIL/i.test(result) || failed.length > 0) {
            if (failed.length > 0)
                return { blocks: true, reason: `Criteria not met: ${failed.slice(0, 2).join('; ')}${failed.length > 2 ? ` (+${failed.length - 2} more)` : ''}` };
            const why = result.replace(/VERDICT:.*$/im, '').trim().replace(/\s+/g, ' ').slice(0, 300);
            return { blocks: true, reason: `Acceptance review failed${why ? `: ${why}` : ' without naming a criterion — see the "QA: Acceptance Review" section of the task file'}` };
        }
        if (unverified.length > 0)
            return { blocks: true, reason: `Criteria could not be verified: ${unverified.slice(0, 2).join('; ')}${unverified.length > 2 ? ` (+${unverified.length - 2} more)` : ''}` };
        if (!/VERDICT:\s*PASS/i.test(result))
            return { blocks: true, reason: 'Acceptance review gave no VERDICT: PASS — task left unverified' };
    } catch (e) {
        return { blocks: true, reason: `Acceptance review could not run: ${e.message}` };
    }
    return { blocks: false };
}


async function gate_test_runner(taskPath, content) {
    if (!getQaTestRunner()) return { blocks: false };
    if (!_hasBashOrCode())  return { blocks: false, detail: 'No sandbox — skipping tests' };

    const fileSec  = _mdSection(content, 'Files');
    const filePaths = fileSec
        ? [...fileSec.matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1])
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
        if (pkg.scripts?.test) cmd = _tailKeepStatus('npm test', 40);
    } catch {}
    if (!cmd) cmd = _tailKeepStatus(`node ${testFiles.join(' ')}`, 40);

    try {
        const res    = await executeToolAsync('execute_code', { language: 'bash', code: cmd }, null);
        const output = ((res.stdout || '') + (res.stderr || '')).slice(0, _QA_OUTPUT_MAX);
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
        const res = await executeToolAsync('execute_code', { language: 'bash', code: _tailKeepStatus(cmd, 30) }, null);
        if (res.exit_code !== 0) {
            const ts  = new Date().toISOString().slice(0, 16) + 'Z';
            const out = ((res.stdout || '') + (res.stderr || '')).slice(0, _QA_OUTPUT_MAX);
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
    const fromStatus  = canonTaskStatus(fm.status);
    toStatus          = canonTaskStatus(toStatus);
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
            // Re-read: the gates appended their findings to the file after `content` was read, and
            // writing the old copy back would erase them.
            const latest = await agentReadFile(taskPath).catch(() => content);
            await agentWriteFile(taskPath, _setFrontmatterField(latest, 'rework_count', reworkCount + 1));
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
