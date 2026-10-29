// qa.js — FreeGent: task lifecycle gates and Kanban transition processing
// Depends on: config.js, tools.js, workers.js, tasks.js


import { canonTaskStatus, TASK_DIRS } from './task-status.js';
import { buildFrontmatter, splitFrontmatter, setFrontmatterFields } from './frontmatter.js';
import { validateOutput, judgeDecision } from './step-validator.js';
import { runtime } from './runtime.js';

const QA_DEFAULT_GATES = {
    'todo->in-progress':      ['dependency-check', 'task-enrichment'],
    'open->in-progress':      ['dependency-check', 'task-enrichment'],
    'in-progress->in-review': ['completeness-check'],
    'in-review->done':        ['acceptance-review', 'test-runner', 'page-check', 'kept-features'],
    // Direct in-progress→done (model skipped in-review): run the full review suite
    'in-progress->done':      ['completeness-check', 'acceptance-review', 'test-runner', 'page-check', 'kept-features'],
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
        if (secM) { section = secM[1].trim().toLowerCase().replace(/\s*(?:→|->|=>|>)\s*/g, '->'); continue; }
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


const _isMissingFile = (e: any): boolean => /not found|ENOENT|no such file|does not exist/i.test(String(e?.message ?? e));
async function setTaskStatus(taskPath, newStatus) {
    try {
        let content: string;
        try {
            content = await agentReadFile(taskPath);
        } catch (e) {
            // Only a file that is not there is created. One that exists and could not be read must not be replaced by a stub: the write below would
            // destroy the task (codex R126).
            if (!_isMissingFile(e)) throw new Error(`could not read the task first (${(e as any)?.message ?? e}); nothing was changed`);
            // File doesn't exist yet — synthesise a minimal stub in memory.
            // The final agentWriteFile below will create it with the correct status.
            const title = taskPath.replace(/^.*\/\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
            const date  = new Date().toISOString().slice(0, 10);
            content = `${buildFrontmatter({ status: 'todo', title, created: date })}\n# ${title}\n`;
        }
        // Edit the frontmatter block only. Detecting "no status line" by comparing the text before
        // and after the replace is wrong when the status is already `newStatus` (the replace
        // changes nothing): that inserted another `status:` line on every same-status write —
        // the runner re-marks an in-progress task in-progress on each retry/resume.
        const hadStatus = !!splitFrontmatter(content)?.lines.some(l => /^status:/.test(l));
        content = setFrontmatterFields(content, { status: newStatus }, { missing: 'top' });
        if (!hadStatus) console.warn(`[QA] setTaskStatus: inserted missing status field into "${taskPath}"`);
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
    const ledgerCandidates = TASK_DIRS.map(d => `${d}ledger.md`);
    for (const ledgerPath of ledgerCandidates) {
        let ledger: string;
        try { ledger = await agentReadFile(ledgerPath); } catch { continue; }
        // Only update rows in the main table — stop at ## Archive
        const archiveSplit = ledger.indexOf('\n## Archive');
        const mainPart    = archiveSplit >= 0 ? ledger.slice(0, archiveSplit) : ledger;
        const archivePart = archiveSplit >= 0 ? ledger.slice(archiveSplit)    : '';
        const rowRe = new RegExp(`^(\\|\\s*${id}\\s*\\|\\s*)\\S[^|]*(\\|)`, 'm');
        // A row that already carries this status is done: the status is written once by the lifecycle
        // engine and again by update_task_status, and the second call used to read as "no row".
        const row = rowRe.exec(mainPart);
        if (row) {
            const current = new RegExp(`^\\|\\s*${id}\\s*\\|\\s*([^|]*?)\\s*\\|`, 'm').exec(mainPart)?.[1];
            if (current === newStatus) return;
            const updated = mainPart.replace(rowRe, (_, pre, post) => `${pre}${newStatus.padEnd(12)}${post}`);
            if (updated !== mainPart) await agentWriteFile(ledgerPath, updated + archivePart);
            return;
        }
        console.warn(`[QA] _updateLedgerRow: no row found for ID ${id} in "${ledgerPath}"`);
    }
    // No ledger had a row for this task: it was created without one (a file written outside the
    // board's add-task path, or a ledger that predates it). The task file already holds the new
    // status, so rebuilding the ledger from the files gives the row, and every other row, correctly.
    if (typeof rebuildLedger === 'function') {
        try { await rebuildLedger(); } catch (e) { console.warn('[QA] ledger rebuild failed:', e); }
    }
}

function _setFrontmatterField(content, key, value) {
    // Only a document that already has front matter is changed (the old regex also rewrote a matching line in the body).
    return splitFrontmatter(content) ? setFrontmatterFields(content, { [key]: value }) : content;
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

// Gates are listed by what they established: `name ✓` passed, `name ?` could not decide, `name –` skipped.
async function appendMemoryLog(taskPath, fromStatus, toStatus, gates: string[], unknown: string[] = [], skipped: string[] = []) {
    const name  = taskPath.split('/').pop().replace('.md', '');
    const parts = [...gates.map(g => `${g} ✓`), ...unknown.map(g => `${g} ?`), ...skipped.map(g => `${g} –`)];
    const gList = parts.length ? ` [${parts.join(', ')}]` : '';
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
    const unchecked = [...content.matchAll(/^-\s+\[ \][ \t]*(.*)$/gm)];
    if (unchecked.length) {
        // Name them: the bare count was answered by trying `done` again (uploaded chat logs of
        // 2026-10-08: five tries in a row with 3 boxes never ticked).
        const items = unchecked.slice(0, 3).map(m => `"${m[1].trim().slice(0, 70)}"`).join(', ');
        return { blocks: true, reason: `Plan incomplete: ${unchecked.length} unchecked step${unchecked.length > 1 ? 's' : ''} in ${taskPath}: ${items}${unchecked.length > 3 ? ', …' : ''}. Mark each one that is done as "- [x]" in the task file (replace_in_file), then set the status again.` };
    }

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

// What the acceptance reviewer is shown. It used to get only the files named in the task's
// `## Files` section, or paths mentioned in the task text, at most five. Tasks written by the
// agent usually have no Files section, so the reviewer saw one or two files or none and answered
// "js/game.js is referenced and not provided" / "no code provided" for code that existed: in the
// uploaded chat logs of 2026-10-06 to 2026-10-08, 21 `done` attempts in four chats were blocked
// that way, each costing the agent several steps (one chat ended at its step cap). Named files come
// first; then the project's source files, most recently changed first, until the size budget is used.
const _QA_REVIEW_TOTAL = 100_000;
// Per-file window for the reviewer: a 38k-character render.js was cut at 20k, so the criteria about
// its drawing code could not be verified and the review failed on every attempt (chat #021).
const _QA_REVIEW_FILE_MAX = 50_000;
const _QA_REVIEW_FILES = 12;
const _QA_SOURCE_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|css|html?|py|rb|go|rs|java|c|cc|cpp|h|hpp|sh|glsl|vert|frag)$/i;
const _QA_NOT_SOURCE_RE = /^(?:fg-tasks|memory|node_modules|dist|build|\.git)\/|(?:^|\/)(?:_t-|_probe)[^/]*$|\.min\.(?:js|css)$/;

// Paths of source files left out of the prompt are listed as a sample and a count: a repository of thousands of files
// would otherwise put every path in the prompt, far past the 100K the file bodies are held to.
const _QA_OMITTED_LISTED = 20;
const _QA_PATH_MAX = 200;

export async function gatherReviewCode(namedPaths: string[]): Promise<{ text: string; shown: string[]; omitted: string[]; omittedCount: number }> {
    let all: Array<{ name: string; lastModified?: number; isLocal?: boolean }> = [];
    try { all = (await agentListFiles()) || []; } catch {}
    // A project kept in the Local Folder (or an imported local/ snapshot) is listed with isLocal and a local/ prefix;
    // it is the project, so it is reviewed too. The noise filter looks at the path inside the folder.
    const inProject = (name: string) => name.replace(/^local\//, '');
    const recent = all
        .filter(f => f?.name && _QA_SOURCE_RE.test(f.name) && !_QA_NOT_SOURCE_RE.test(f.isLocal ? inProject(f.name) : f.name))
        .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0) || a.name.localeCompare(b.name))
        .map(f => f.name);
    const order = [...new Set([...namedPaths, ...recent])];
    let text = '', total = 0;
    const shown: string[] = [], omitted: string[] = [];
    let omittedCount = 0;
    const recentSet = new Set(recent);
    for (const fp of order) {
        if (shown.length >= _QA_REVIEW_FILES || total >= _QA_REVIEW_TOTAL) {
            if (recentSet.has(fp)) { omittedCount++; if (omitted.length < _QA_OMITTED_LISTED) omitted.push(fp.slice(0, _QA_PATH_MAX)); }
            continue;
        }
        let body: string;
        try { body = await agentReadFile(fp); } catch { continue; }
        if (typeof body !== 'string') continue;
        const room = Math.min(_QA_REVIEW_FILE_MAX, Math.max(2_000, _QA_REVIEW_TOTAL - total));
        const cut = body.length > room;
        text += `\n### ${fp}\n\`\`\`\n${body.slice(0, room)}${cut ? `\n[… cut at ${room} of ${body.length} characters]` : ''}\n\`\`\`\n`;
        total += Math.min(body.length, room);
        shown.push(fp);
    }
    return { text, shown, omitted, omittedCount };
}

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

    // Without the changed files the model only has the title to go on and invents what changed
    // (chat logs of 2026-10-12: a "LavaExplosionManager" and a "5-min stress test" that do not exist).
    if (!fileContents) return { blocks: false, outcome: 'skipped', detail: 'No changed files named — self-review skipped' };

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


// One check through the shared three-band validator (step-validator.ts). `text` is the code the
// reviewer was shown; YES means "at least one criterion is clearly not met" and carries the failing
// criteria in a `payload:` line. A short YES/NO answer replaces the old per-criterion essay that
// ran past maxTokens before reaching its VERDICT line (task 043, chat logs of 2026-10-12), and a
// reviewer that is down or cannot decide no longer blocks the task.
const _ACCEPTANCE_CHECKS = [{
    name: 'acceptance_not_met',
    max: Infinity,
    extract: () => '',   // the default extractor would pull a "command" out of the code under review
    llmPrompt: (_code: string, ctx: any) =>
        `Check whether each acceptance criterion is met by the code below.\n\nCriteria:\n${ctx.criteria}\n\n` +
        (ctx.omitted.length ? `Source files that exist in the project but are not shown: ${ctx.omitted.join(', ')}${ctx.omittedCount > ctx.omitted.length ? ` (and ${ctx.omittedCount - ctx.omitted.length} more)` : ''}. Do not treat a file as missing because it is not shown.\n` : '') +
        (ctx.missing.length ? `Names from the criteria that appear in none of the code shown: ${ctx.missing.join(', ')}.\n` : '') +
        `A behaviour that happens at run time, such as input handling or what is saved, is judged from the code that produces it. ` +
        `Answer YES only when at least one criterion is clearly NOT met or is contradicted by the code. ` +
        `Answer NO when every criterion is met or the code needed to decide is not shown.\n` +
        `Reply with the first line YES or NO. When YES, add a second line "payload: " followed by the unmet criteria, each with a short reason, separated by "; ".`,
}];

async function gate_acceptance_review(taskPath, content) {
    if (!getQaAcceptanceReview()) return { blocks: false, outcome: 'skipped', detail: 'Acceptance review is turned off' };

    const acceptM = _mdSection(content, 'Acceptance', 'Acceptance Criteria');
    if (acceptM === null || !acceptM.trim()) return { blocks: false, outcome: 'skipped', detail: 'No acceptance criteria — skipping review' };

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

    const { text: fileContents, shown, omitted, omittedCount } = await gatherReviewCode(filePaths);

    // Backticked names in the criteria that the code never mentions: a hint for the judge, not a
    // verdict, because a criterion may be about something that was removed.
    const missing = shown.length && !omittedCount
        ? [...new Set([...criteria.matchAll(/`([^`\n]{3,60})`/g)].map(m => m[1].trim()))].filter(n => !fileContents.includes(n)).slice(0, 10)
        : [];

    // Record what the reviewer said (or that it could not answer) for the task file and the reason.
    let reply = '', unavailable = false;
    const llm = async (p: string, o: any) => {
        try { reply = await callLLMComplete(p, { ...o, allowPartial: true }); return reply; }   // a judge's first line is the answer; it is cut on purpose
        catch (e) { unavailable = true; throw e; }
    };
    const hit = await validateOutput(fileContents || '(no files available)', _ACCEPTANCE_CHECKS, {
        llm, maxTokens: 300, budget: Infinity, ctx: { criteria, omitted, omittedCount, missing },
    });

    // The answer is about the criteria, the code and the status the reviewer was shown. If any of them changed while it thought (the criteria edited, the
    // code replaced, the task blocked), the answer says nothing about the task as it is now and must not complete it or override the newer decision
    // (codex R35-001). It is not a verdict either way, so the transition is declined without counting as a failed review.
    if (!unavailable && reply.trim()) {
        const fresh = await agentReadFile(taskPath).catch(() => null);
        const criteriaNow = fresh == null ? null : (_mdSection(fresh, 'Acceptance', 'Acceptance Criteria') ?? '').trim();
        const statusNow   = fresh == null ? null : canonTaskStatus(parseFrontmatter(fresh).status);
        const codeNow     = (await gatherReviewCode(filePaths)).text;
        if (criteriaNow !== criteria || statusNow !== canonTaskStatus(parseFrontmatter(content).status) || codeNow !== fileContents)
            return { blocks: false, outcome: 'stale', detail: 'The task or the code changed while the acceptance review was running, so its answer does not apply to what is there now. Run the transition again.' };
    }

    const ts = new Date().toISOString().slice(0, 16) + 'Z';
    if (hit) {
        const why = hit.payload || 'see the reviewer note in the task file';
        await appendGateNote(taskPath, `## QA: Acceptance Review (${ts})\nNot met: ${why}`);
        return { blocks: true, reason: `Criteria not met: ${why}` };
    }
    // A pass needs a readable NO. The validator returns null both for NO and for a reply it could not
    // read (a refusal, prose with no verdict): the second is "unknown", not "met" (uploads review
    // 2026-10-14, 4.2). Same decision rule as validateOutput: the last line that starts with YES or NO.
    const readable = judgeDecision(reply) === 'no';
    if (unavailable || !reply.trim()) {
        await appendGateNote(taskPath, `## QA: Acceptance Review (${ts})\nNot verified: the reviewer could not be reached or gave no answer. Check the criteria by hand.`);
        return { blocks: false, outcome: 'unknown', detail: 'Reviewer unavailable — acceptance not verified' };
    }
    if (!readable) {
        await appendGateNote(taskPath, `## QA: Acceptance Review (${ts})\nNot verified: the reviewer's answer was not YES or NO (${reply.trim().replace(/\s+/g, ' ').slice(0, 160)}). Check the criteria by hand.`);
        return { blocks: false, outcome: 'unknown', detail: 'Reviewer answer unreadable — acceptance not verified' };
    }
    await appendGateNote(taskPath, `## QA: Acceptance Review (${ts})\nNo criterion was judged unmet by the code shown.`);
    return { blocks: false };
}


// The project's own test files, by the conventions people use without a test framework: `test_x.mjs` / `test_x.py` run with
// node or python3, `x.test.js`, `x_test.py`, anything of those shapes under tests/. The gate used to look only for `X.test.js`
// next to files named in a `## Files` section, which tasks written by users do not have: in the Autopilot exploration of
// 2026-10-27 it was skipped in 144 of 144 done transitions, and tasks that broke a test written by an earlier task were done.
const _QA_TEST_FILE_RE = /(?:^|\/)(?:test_[^/]+\.(?:mjs|cjs|js|py)|[^/]+[._](?:test|spec)\.(?:mjs|cjs|js)|[^/]+_test\.py)$/;
const _QA_TEST_FILES_MAX = 12;
const _QA_TEST_TIMEOUT_MS = 90_000;
const _QA_PY_TEST_FILES_MAX = 6;   // each python3 start costs seconds in the browser
// Runs a test module the way pytest would without needing pytest: its test_* functions that take no arguments, then any
// unittest.TestCase in it, with the file's folder on sys.path. A file that runs its own tests under `__main__` runs as a script.
const _QA_PY_RUNNER = 'import sys,os,runpy,inspect,unittest\n' +
    'p=sys.argv[1]; sys.path.insert(0, os.path.dirname(os.path.abspath(p)))\n' +
    'g=runpy.run_path(p, run_name="fg_qa_tests")\n' +
    'for k,v in list(g.items()):\n' +
    '    if k.startswith("test") and inspect.isfunction(v) and not any(x.default is x.empty for x in inspect.signature(v).parameters.values()): v()\n' +
    'cases=[v for v in g.values() if isinstance(v,type) and issubclass(v,unittest.TestCase)]\n' +
    's=unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(c) for c in cases])\n' +
    'sys.exit(0 if not s.countTestCases() or unittest.TextTestRunner(verbosity=0).run(s).wasSuccessful() else 1)\n';
// A command the sandbox does not have (a test framework that is not installed) says nothing about the code under test.
const _QA_RUNNER_MISSING_RE = /command not found|: not found\b|Cannot find (?:module|package) '(?:node:test|vitest|jest|mocha|pytest)'|No module named '?pytest/i;

const _shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function findProjectTests(named: string[] = []): Promise<string[]> {
    const found = new Set<string>();
    for (const fp of named) {
        const base = fp.replace(/\.[^.]+$/, '');
        const name = fp.split('/').pop()!.replace(/\.[^.]+$/, '');
        for (const c of [`${base}.test.js`, `${base}.spec.js`, `tests/${name}.test.js`, `__tests__/${name}.js`]) {
            try { await agentReadFile(c); found.add(c); break; } catch {}
        }
    }
    let all: Array<{ name: string }> = [];
    try { all = (await agentListFiles()) || []; } catch {}
    const conv = all.map(f => f?.name).filter((n): n is string => !!n && _QA_TEST_FILE_RE.test(n) && !_QA_NOT_SOURCE_RE.test(n) && !n.startsWith('local/') && !/['"$`\\]/.test(n))
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const n of conv) found.add(n);
    const py = [...found].filter(f => f.endsWith('.py')).slice(0, _QA_PY_TEST_FILES_MAX);
    return [...found].filter(f => !f.endsWith('.py') || py.includes(f)).slice(0, _QA_TEST_FILES_MAX);
}

// One command that runs every file on its own, so the result names the files that failed. The shape is the one
// _tailKeepStatus already relies on ($(…), $?, printf), which the in-browser shell runs too.
function _testCommand(files: string[]): string {
    const lines = ['fg_qa_failed=""'];
    for (const f of files) {
        const run = f.endsWith('.py') ? `python3 -c ${_shq(_QA_PY_RUNNER)} ${_shq(f)}` : `node ${_shq(f)}`;
        lines.push(`fg_qa_out=$(${run} 2>&1); fg_qa_rc=$?; if [ $fg_qa_rc -ne 0 ]; then fg_qa_failed="$fg_qa_failed ${f}"; printf '%s\\n' "== ${f} (exit $fg_qa_rc)" "$fg_qa_out" | tail -n 15; fi`);
    }
    lines.push(`if [ -n "$fg_qa_failed" ]; then echo "FAILED:$fg_qa_failed"; exit 1; fi; echo "${files.length} test file(s) passed"`);
    return lines.join('\n');
}

// A failure the agent was already shown for this task, met again unchanged at its next "done", is accepted as unverified:
// it may predate the task, and the completion gates follow the same rule (one bounce, then the agent's reason stands).
const _qaBounced = new Map<string, string>();
const _bouncedBefore = (taskPath: string, gate: string, sig: string): boolean => {
    const key = `${gate}\u0000${taskPath}`;
    if (_qaBounced.get(key) === sig) return true;
    _qaBounced.set(key, sig);
    return false;
};

async function gate_test_runner(taskPath, content) {
    if (!getQaTestRunner()) return { blocks: false, outcome: 'skipped', detail: 'Test runner is turned off' };
    if (!_hasBashOrCode())  return { blocks: false, outcome: 'skipped', detail: 'No sandbox — skipping tests' };

    const fileSec  = _mdSection(content, 'Files');
    const filePaths = fileSec
        ? [...fileSec.matchAll(/`([^`]+\.[a-z]{1,5})`/g)].map(m => m[1])
        : [];

    let cmd: string | null = null;
    try {
        const pkg = JSON.parse(await agentReadFile('package.json'));
        // `npm init` writes a test script that always fails ("Error: no test specified").
        if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) cmd = _tailKeepStatus('npm test', 40);
    } catch {}
    const testFiles = cmd ? [] : await findProjectTests(filePaths);
    if (!cmd && !testFiles.length) return { blocks: false, outcome: 'skipped', detail: 'No test files found in the project' };
    if (!cmd) cmd = _testCommand(testFiles);

    try {
        // A test run that never returns (the in-browser node hung on the second start after a test that replaced
        // globalThis.location, AE-11) would hold the task for the tool's 10 minutes; the gate gives up after a minute and a half.
        let timer: any;
        const res    = await Promise.race([
            executeToolAsync('execute_code', { language: 'bash', code: cmd }, null),
            new Promise<any>(r => { timer = setTimeout(() => r({ exit_code: null, error: `the tests did not finish within ${_QA_TEST_TIMEOUT_MS / 1000} s` }), _QA_TEST_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        const output = ((res.stdout || '') + (res.stderr || '') + (res.error ? `\n${res.error}` : '')).slice(0, _QA_OUTPUT_MAX);
        if (res.exit_code == null && res.error) return { blocks: false, outcome: 'unknown', detail: `Tests could not be run: ${String(res.error).slice(0, 160)}` };
        if (res.exit_code !== 0) {
            const failed = /FAILED:(.*)$/m.exec(output)?.[1].trim().split(/\s+/) ?? [];
            if (res.exit_code === 127 || _QA_RUNNER_MISSING_RE.test(output)) return { blocks: false, outcome: 'unknown', detail: `The tests need a tool this sandbox lacks: ${(output.split('\n').find(l => _QA_RUNNER_MISSING_RE.test(l)) || '').trim().slice(0, 160)}` };
            const which = failed.length ? failed.join(', ') : 'the test command';
            // What the first failing file printed (its header is "== <file> (exit N)"): the first line, or for a Python traceback the
            // exception at its end. Without a header, the first error-looking line.
            const lines = output.split('\n');
            const hdr = lines.findIndex(l => /^== .+ \(exit \d+\)$/.test(l));
            const block = hdr < 0 ? [] : lines.slice(hdr + 1, (i => i < 0 ? undefined : hdr + 1 + i)(lines.slice(hdr + 1).findIndex(l => /^== |^FAILED:/.test(l)))).filter(l => l.trim());
            const first = (/^Traceback/.test(block[0] ?? '') ? block[block.length - 1] : block[0])?.trim().slice(0, 200)
                || lines.find(l => /error|fail|assert/i.test(l) && !/^FAILED:/.test(l))?.trim().slice(0, 200) || 'see the task file';
            if (_bouncedBefore(taskPath, 'test-runner', failed.join(' ') || first))
                return { blocks: false, outcome: 'unknown', detail: `${which} still fail${failed.length === 1 ? 's' : ''} (accepted on the second attempt): ${first}` };
            const ts = new Date().toISOString().slice(0, 16) + 'Z';
            await appendGateNote(taskPath, `## QA: Test Failures (${ts})\nCommand: ${testFiles.length ? `each of ${testFiles.join(', ')}` : cmd}\n${output}`);
            return { blocks: true, reason: `Tests failed: ${which}. ${first}. Fix the code (or the test, if this task changed the behaviour it checks), run it, then set the status again. If the failure was there before this task and is not yours, say so in the summary and set the status again.` };
        }
    } catch (e) {
        return { blocks: false, outcome: 'unknown', detail: `Test runner error: ${e.message}` };
    }
    return { blocks: false };
}

// Loads the project's page the way check_page does and refuses "done" while it reports errors. No gate loaded the page: in the
// Autopilot exploration of 2026-10-27 three of ten projects ended with a page that drew nothing (a module that lost its exports,
// a call to a function main.js no longer imported, a TypeError at start-up) while every task was done. Browser only; the page
// is the root index.html (else the only .html file at the root). Errors already bounced once for this task are accepted.
async function gate_page_check(taskPath) {
    if (!getQaTestRunner()) return { blocks: false, outcome: 'skipped', detail: 'Test runner is turned off' };
    if (typeof runPageCheck !== 'function' || runtime.hasNativeExec) return { blocks: false, outcome: 'skipped', detail: 'No browser page check here' };
    let names: string[] = [];
    try { names = ((await agentListFiles()) || []).map((f: any) => f?.name).filter(Boolean); } catch {}
    const roots = names.filter(n => /^[^/]+\.html?$/i.test(n));
    const page = roots.find(n => /^index\.html?$/i.test(n)) ?? (roots.length === 1 ? roots[0] : null);
    if (!page) return { blocks: false, outcome: 'skipped', detail: 'No page at the project root' };
    let r: any;
    try { r = await runPageCheck(page, { waitMs: 1500 }); }
    catch (e) { return { blocks: false, outcome: 'unknown', detail: `Page check error: ${(e as any)?.message ?? e}` }; }
    if (r?.error) return { blocks: false, outcome: 'unknown', detail: `Page check: ${String(r.error).slice(0, 160)}` };
    const errors: string[] = (r?.errors ?? []).map((e: any) => String(e.text ?? e)).slice(0, 3);
    // No error but nothing on the page either (no text, no media, canvases transparent): its start-up code did not run.
    if (!errors.length && r?.blank) errors.push('The page shows nothing: no text and no drawing after it loaded, so its start-up code probably does not run (a function that is defined but no longer called, a script that only exports).');
    if (!errors.length) return r?.loaded === false ? { blocks: false, outcome: 'unknown', detail: `${page}: ${r.summary}` } : { blocks: false };
    if (_bouncedBefore(taskPath, 'page-check', errors.join('\n')))
        return { blocks: false, outcome: 'unknown', detail: `${page} still reports errors (accepted on the second attempt): ${errors[0].slice(0, 160)}` };
    const ts = new Date().toISOString().slice(0, 16) + 'Z';
    await appendGateNote(taskPath, `## QA: Page Errors (${ts})\n${page}:\n${errors.map(e => `- ${e.slice(0, 300)}`).join('\n')}`);
    return { blocks: true, reason: `${page} reports ${errors.length > 1 ? `${errors.length} errors` : 'an error'} when it loads: ${errors.map(e => e.slice(0, 200)).join(' | ')}. Find the cause (check_page shows the details), fix it, then set the status again. If the error was there before this task and is not yours, say so in the summary and set the status again.` };
}


// What earlier tasks built must survive a later task (autopilot exploration AE-12, 2026-10-28: task 004 rewrote index.html from scratch,
// the search box of the done task 001 was gone, and every later gate passed). At the start of a task the identifiers of the project's
// source files are noted (HTML ids, declared functions and classes, exported names); at "done", those the task removed and an earlier
// done task's file mentions are named, once. A removal that is meant stands when the status is set again.
const _SRC_RE = /\.(?:html?|m?[jt]sx?|css|py|vue|svelte)$/i;
const _taskStartIds = new Map<string, Map<string, Set<string>>>();
export function sourceIdentifiers(path: string, text: string): Set<string> {
    const ids = new Set<string>();
    const add = (re: RegExp) => { for (const m of text.matchAll(re)) if (m[1] && m[1].length >= 3) ids.add(m[1]); };
    if (/\.(?:html?|vue|svelte|[jt]sx)$/i.test(path)) add(/\bid\s*=\s*["']([\w-]+)["']/g);
    if (/\.(?:m?[jt]sx?|html?|vue|svelte)$/i.test(path)) {
        add(/\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)/g);
        add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
        add(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g);
    }
    if (/\.py$/i.test(path)) add(/^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm);
    return ids;
}
async function _projectIdentifiers(): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    let names: string[] = [];
    try { names = ((await agentListFiles()) || []).map((f: any) => f?.name).filter((n: any) => typeof n === 'string' && _SRC_RE.test(n) && !/^(?:fg-tasks|node_modules|\.git)\//.test(n)); } catch {}
    for (const n of names.slice(0, 300)) {
        let t = '';
        try { t = await agentReadFile(n); } catch { continue; }
        if (t.length > 400_000) continue;
        out.set(n, sourceIdentifiers(n, t));
    }
    return out;
}
async function noteTaskStart(taskPath: string): Promise<void> {
    try { _taskStartIds.set(taskPath, await _projectIdentifiers()); } catch {}
}
const _GENERIC_IDS = new Set(['main', 'init', 'start', 'setup', 'update', 'render', 'draw', 'loop', 'run', 'app', 'root', 'game', 'data', 'handle',
    'click', 'value', 'item', 'items', 'list', 'test', 'tests', 'helper', 'utils', 'content', 'container', 'wrapper', 'output', 'input', 'result', 'state',
    'reset', 'load', 'save', 'show', 'hide', 'toggle', 'tick', 'step', 'config', 'options', 'index', 'default', 'error', 'status', 'button', 'header', 'footer']);
// The words of an identifier: searchBox, search-box and search_box are "search" and "box".
const _idWords = (id: string): string[] => id.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_-]+/).map(w => w.toLowerCase()).filter(w => w.length >= 4);
async function gate_kept_features(taskPath) {
    const before = _taskStartIds.get(taskPath);
    if (!before) return { blocks: false, outcome: 'skipped', detail: 'No record of the files at the start of this task' };
    const now = await _projectIdentifiers();
    const removed: Array<{ file: string; id: string }> = [];
    for (const [file, ids] of before) {
        const cur = now.get(file);
        if (!cur) continue;   // a removed file is the task's visible decision, and the page and test gates see what it breaks
        for (const id of ids) if (!cur.has(id) && ![...now.values()].some(set => set.has(id))) removed.push({ file, id });
    }
    if (!removed.length) return { blocks: false };
    let tasks: any[] = [];
    try { tasks = typeof loadTaskFiles === 'function' ? await loadTaskFiles() : []; } catch {}
    const doneOthers: Array<{ t: any; text: string }> = [];
    for (const t of tasks.filter((t: any) => t.path !== taskPath && canonTaskStatus(t.fm?.status) === 'done').slice(0, 200)) {
        let text = ''; try { text = (await agentReadFile(t.path)).toLowerCase(); } catch {}
        if (text) doneOthers.push({ t, text });
    }
    const hits: string[] = [];
    const has = (text: string, w: string) => new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`).test(text);
    for (const { file, id } of removed) {
        // The identifier itself, or all of its words ("searchBox" for a task about a "search box"); a generic single word says nothing.
        const words = _idWords(id), whole = id.toLowerCase();
        if (words.length <= 1 && _GENERIC_IDS.has(whole)) continue;
        const found = doneOthers.find(({ text }) => has(text, whole) || (words.length >= 2 && words.every(w => has(text, w))));
        const owner = found?.t;
        if (owner) hits.push(`${id} (${file}; task ${owner.fm?.id ? '#' + owner.fm.id + ' ' : ''}"${owner.fm?.title ?? owner.path}")`);
        if (hits.length >= 6) break;
    }
    if (!hits.length) return { blocks: false };
    if (_bouncedBefore(taskPath, 'kept-features', hits.join('|')))
        return { blocks: false, outcome: 'unknown', detail: `Removed what earlier done tasks mention (accepted on the second attempt): ${hits.join(', ').slice(0, 200)}` };
    const ts = new Date().toISOString().slice(0, 16) + 'Z';
    await appendGateNote(taskPath, `## QA: Removed Earlier Work (${ts})\n${hits.map(h => `- ${h}`).join('\n')}`);
    return { blocks: true, reason: `This task removed what earlier finished tasks built or mention: ${hits.join(', ')}. A rewrite of a file must keep the earlier features: put them back. If removing them is what the task asks for, say so in the summary and set the status again.` };
}

async function gate_regression_guard(taskPath) {
    if (!getQaRegressionGuard()) return { blocks: false, outcome: 'skipped', detail: 'Regression guard is turned off' };
    if (!_hasBashOrCode())       return { blocks: false, outcome: 'skipped', detail: 'No sandbox — skipping regression guard' };

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
    if (!cmd) return { blocks: false, outcome: 'skipped', detail: 'No build command detected — skipping' };

    try {
        const res = await executeToolAsync('execute_code', { language: 'bash', code: _tailKeepStatus(cmd, 30) }, null);
        if (res.exit_code !== 0) {
            const ts  = new Date().toISOString().slice(0, 16) + 'Z';
            const out = ((res.stdout || '') + (res.stderr || '')).slice(0, _QA_OUTPUT_MAX);
            await appendGateNote(taskPath, `## QA: Regression Guard (${ts})\nCommand: ${cmd}\nExit: ${res.exit_code}\n${out}`);
            return { blocks: true, reason: `Regression: \`${cmd}\` failed (exit ${res.exit_code})` };
        }
    } catch (e) {
        return { blocks: false, outcome: 'unknown', detail: `Regression guard error: ${e.message}` };
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
    'page-check':         gate_page_check,
    'regression-guard':   gate_regression_guard,
    'kept-features':      gate_kept_features,
};


// Tasks whose "done" went through the completion gates (or needed none), so a runner can tell that from a
// status an agent wrote straight into the task file with write_file / replace_in_file / the shell.
const _gatesPassedDone = new Set<string>();
export const forgetGatePass = (taskPath: string): void => { _gatesPassedDone.delete(taskPath); };
export const gatesPassedDone = (taskPath: string): boolean => _gatesPassedDone.has(taskPath);

async function transitionTask(taskPath, toStatus) {
    const r = await _transitionTask(taskPath, toStatus);
    if (r.transitioned && canonTaskStatus(toStatus) === 'done') _gatesPassedDone.add(taskPath);
    if (r.transitioned && canonTaskStatus(toStatus) === 'in-progress' && getQaEnabled()) await noteTaskStart(taskPath);   // for kept-features
    return r;
}

async function _transitionTask(taskPath, toStatus) {
    if (!getQaEnabled()) {
        await setTaskStatus(taskPath, toStatus);
        return { transitioned: true };
    }

    let content: string;
    try { content = await agentReadFile(taskPath); }
    catch (e) {
        // A task that does not exist yet is created in the requested state; one that could not be read has gates that were not evaluated, so it does not move (codex R126).
        if (_isMissingFile(e)) { await setTaskStatus(taskPath, toStatus); return { transitioned: true }; }
        return { transitioned: false, reason: `The task file could not be read (${(e as any)?.message ?? e}), so its gates were not checked. Nothing was changed; try again.` };
    }

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
    // A move to done from a state the workflow has no gates for (todo, open, blocked …) is judged like the move from in-progress: leaving it
    // gateless let a task be completed with every check skipped by jumping straight to done (codex R33-001).
    const gateNames = workflowGates[gateKey] ?? (toStatus === 'done' ? workflowGates['in-progress->done'] : undefined) ?? [];
    const passed: string[] = [], unknown: Array<{ gate: string; detail?: string }> = [], skipped: string[] = [];

    const failures = [];
    let stale: string | null = null;
    for (const gateName of gateNames) {
        const gateFn = GATES[gateName];
        if (!gateFn) continue;

        let result: { blocks: boolean; reason?: string; detail?: string; outcome?: 'unknown' | 'skipped' | 'stale' };
        try   { result = await gateFn(taskPath, content); }
        catch (e) { result = { blocks: false, outcome: 'unknown', detail: `Gate error: ${e.message}` }; }

        const ts = new Date().toISOString().slice(0, 16) + 'Z';
        if (result.outcome === 'stale') { stale = result.detail || 'The task changed while it was being checked.'; break; }
        if (result.blocks) {
            await appendGateNote(taskPath, `## Gate: ${gateName} FAILED (${ts})\n${result.reason || ''}`);
            failures.push({ gate: gateName, reason: result.reason });
        } else if (result.outcome === 'unknown') {
            unknown.push({ gate: gateName, detail: result.detail });
        } else if (result.outcome === 'skipped') {
            skipped.push(gateName);
        } else {
            passed.push(gateName);
        }
    }

    if (stale) return { transitioned: false, reason: stale };

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

    // A gate that could not decide is not a pass. The task may still move (a flaky reviewer must not
    // strand the board), but the file, the memory log and the tool answer all say it was not verified.
    if (unknown.length && toStatus === 'done') {
        try {
            const latest = await agentReadFile(taskPath);
            await agentWriteFile(taskPath, _setFrontmatterField(latest, 'qa', 'unverified'));
        } catch {}
    }
    else if (toStatus === 'done' && /^qa:[ \t]*unverified[ \t]*$/m.test(content)) {
        try { await agentWriteFile(taskPath, _setFrontmatterField(await agentReadFile(taskPath), 'qa', 'verified')); } catch {}
    }
    await setTaskStatus(taskPath, toStatus);
    await appendMemoryLog(taskPath, fromStatus, toStatus, passed, unknown.map(u => u.gate), skipped);
    try { await refreshTasks(); } catch {}
    return unknown.length
        ? { transitioned: true, unverified: unknown.map(u => `${u.gate}${u.detail ? ` (${u.detail})` : ''}`) }
        : { transitioned: true };
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { setTaskStatus, _updateLedgerRow, transitionTask, forgetGatePass, gatesPassedDone });
