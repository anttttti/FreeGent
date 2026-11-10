// completion-gates.ts — FreeGent: the one-shot checks made when a reply declares COMPLETED.
//
// Each gate looks at what the run has actually done and, at most once (its own counter in `ps`), answers
// with a nudge instead of letting the turn end. They used to be five inline blocks in runTurn, each
// repeating the same preconditions and ordered only by their position in a 1,250-line function. As a
// table the order is explicit and a gate can be tested with a plain context object, no model loop.
//
// A gate is "once": the nudge is delivered, the counter set, and a second COMPLETED passes (the agent
// may have a reason). BLOCKED declarations are not bounced, with one exception: blocked_untried_fix (a fix
// task, BLOCKED, nothing tried).
import { _BLOCKED_DECLARATION_RE, _TERMINAL_RE, _isComplete } from './turn-protocol.js';
import { runtime } from './runtime.js';
import { suppliedFiles, overwrittenSupplied, isQuestionOnlyTask, inventedDataPaths, taskChangesData, testFixtures } from './detectors.js';

export interface GateContext {
    text: string;                     // the reply that declared COMPLETED
    step: number;
    loopMax: number;
    softStopPending: boolean;
    ps: any;                          // per-turn counters (syntaxCheck, fixtureCheck, ...)
    editedPaths: Set<string>;         // files written by tools this turn
    shellWrites: Set<string>;         // paths a shell command redirected into
    editsThisRun: boolean;
    editEvents: number;
    stateChanged: boolean;            // a successful command changed the system without writing a reported file (detectors.changesState)
    reactiveFired: Set<string>;
    firstUserText: string;            // the first user message (lists the supplied files)
    task: string;                     // the original task text
    editRequired: boolean;            // taskPolicy.editRequired(): benchmark runs only (bench-policy.ts)
    changeRequired: boolean;          // taskPolicy.changeRequired(): graded on the system's state afterwards; benchmark runs only
    gradedTestIds: () => string[];    // taskPolicy.gradedTestIds(task): benchmark runs only
    isScratchPath: (p: string) => boolean;
    brokenFiles: (paths: Iterable<string>) => Promise<string[]>;   // parse errors of these files (tools.ts brokenFileReport)
    shellCommands?: string[];         // the bash commands that ran successfully this turn, in order
    taskIds?: () => Promise<Set<string> | null>;   // ids (as numbers) of the task files on the board: what the reply may name; null: this run has no board
    planning?: boolean;   // Cowork, and this chat wrote numbered task files: it planned the board (fg-tasks writes are not in editedPaths)
    noCriteria?: () => Promise<string[]>;   // task files on the board that have no ## Acceptance Criteria list
    taskText?: () => Promise<string>;   // the text of every task file on the board, lower case
}
export interface GateHit { name: string; text: string; force: boolean }
export interface CompletionGate { name: string; run(c: GateContext): GateHit | null | Promise<GateHit | null> }

/** The preconditions every gate shares: a real COMPLETED, not a BLOCKED, with a step left to act on the nudge. */
export function completionDeclared(c: GateContext): boolean {
    return _isComplete(c.text) && !_BLOCKED_DECLARATION_RE.test(c.text) && c.step < c.loopMax - 1 && !c.softStopPending;
}

// A file changed this run that no longer parses. Chat log 45cdc500 (task 107): an edit left render.js unparseable, check_page and a
// test both failed to load it, the agent called that "pre-existing" and marked the task done with a game that did not start. The
// edit result reports a parse error at once; this is the second look, at the end, over every file the run changed (workers too).
const brokenSyntax: CompletionGate = {
    name: 'broken_syntax',
    async run(c) {
        if (!completionDeclared(c) || c.ps.syntaxCheck || !c.editedPaths.size) return null;
        const broken = await c.brokenFiles([...c.editedPaths].filter(p => !c.isScratchPath(p)));
        if (!broken.length) return null;
        c.ps.syntaxCheck = 1;
        const one = broken.length === 1;
        return { name: 'broken_syntax', force: true,
            text: `You declared COMPLETED, but ${one ? 'a file' : `${broken.length} files`} you changed in this run no longer parse${one ? 's' : ''}:\n${broken.slice(0, 3).join('\n')}${broken.length > 3 ? `\n(and ${broken.length - 3} more)` : ''}\n` +
                `${one ? 'It was' : 'They were'} changed in this run, so do not call the error pre-existing until you have checked that your change did not cause it: anything that loads ${one ? 'this file' : 'these files'} (the page, an import, a test) fails. ` +
                `Fix it, or call undo_write on the path to restore the previous version, check that it parses, then reply COMPLETED.` };
    },
};

// Users, groups and sudoers.d files the agent created to try its fix, which the task never asked for: they stay in the system the task is
// judged on (AgentBench OS 40 and 41, v0.99). Once; the second COMPLETED passes.
const testFixturesLeft: CompletionGate = {
    name: 'test_fixtures_left',
    run(c) {
        if (!completionDeclared(c) || c.ps.fixtureCheck) return null;
        const left = testFixtures(c.task, c.shellCommands ?? []);
        if (!left.length) return null;
        c.ps.fixtureCheck = 1;
        return { name: 'test_fixtures_left', force: true,
            text: `You declared COMPLETED, but this run created ${left.slice(0, 4).join(', ')} to test with, and the task did not ask for it. Remove ${left.length > 1 ? 'them' : 'it'} (userdel -r, groupdel, rm), check that the fix itself still works, then reply COMPLETED.` };
    },
};

// Answering from data the agent wrote itself. AgentBench OS tasks 43, 47 and 52 (v0.70) were failed after
// the agent overwrote the supplied file1.log / file1.txt / logfile.txt with its own text; no other OS task
// wrote to a supplied file (3 of 60, replayed). Also a pure question with new data files.
const inventedData: CompletionGate = {
    name: 'invented_data',
    run(c) {
        if (!completionDeclared(c) || c.ps.inventedDataCheck) return null;
        const supplied = suppliedFiles(c.firstUserText);
        const written = new Set<string>([...c.editedPaths, ...c.shellWrites]);
        // Not for a task whose fix is a code edit, or that asks for the data itself to be changed: its supplied files are meant to change.
        const codeTask = c.editRequired || c.gradedTestIds().length > 0 || taskChangesData(c.task);
        const over = supplied.size && !codeTask ? overwrittenSupplied(written, supplied) : [];
        const made = isQuestionOnlyTask(c.task) ? inventedDataPaths(written, c.isScratchPath) : [];
        const flag = [...new Set([...over, ...made])];
        if (!flag.length) return null;
        c.ps.inventedDataCheck = 1;
        return { name: 'invented_data', force: true,
            text: `You wrote to data files yourself: ${flag.slice(0, 5).join(', ')}${over.length ? ' (supplied with the task)' : ''}. An answer computed from text you wrote is not an answer about the real data. If the task asks about files that were already there, restore or ignore your changes, compute the answer from the real contents, and reply COMPLETED with it. If the task really asked you to create or change these files, reply COMPLETED again.` };
    },
};

// A reply that lists tasks the board does not have: the chat planned "Task 002: ... Task 005" in prose, wrote only 001, and Autopilot then finished the
// trivial 001 and said "All tasks complete" with the project unbuilt (kanbanflow 2026-11-08, 3 of 8 planning turns). Once; the second COMPLETED passes.
// The files the request names (calc.js, test_calc.mjs, index.html) that no task file mentions: a plan that leaves one out ends "All tasks complete"
// with that file never written (kanbanflow 2026-11-08, WebKit: 4 of 12 runs). Only in the planning turn.
async function planCoverage(c: GateContext): Promise<GateHit | null> {
    if (c.ps.planCover || !c.taskText || !c.planning) return null;
    const asked = [...new Set([...c.task.matchAll(/\b([\w./-]+\.(?:js|mjs|ts|py|html|css|json))\b/g)].map(m => m[1].toLowerCase()))].filter(f => !f.startsWith('fg-tasks/'));
    const text = await c.taskText();
    if (!text) return null;
    const left = asked.filter(f => !text.includes(f) && !text.includes(f.split('/').pop()!));
    // A task without criteria makes the completeness and review gates vacuous (kanbanflow 2026-11-08: criteria-less plans in 7 of 52 runs).
    const bare = c.noCriteria ? await c.noCriteria() : [];
    if (!left.length && !bare.length) return null;
    c.ps.planCover = 1;
    const parts = [
        left.length ? `no task covers ${left.slice(0, 5).join(', ')}, which the request asks for. Add the missing task(s) as fg-tasks/NNN-slug.md, or put the file in an existing task's description` : '',
        bare.length ? `${bare.slice(0, 5).join(', ')} ha${bare.length > 1 ? 've' : 's'} no "## Acceptance Criteria" list, so nothing can check ${bare.length > 1 ? 'they are' : 'it is'} done. Add "- [ ]" items to ${bare.length > 1 ? 'each' : 'it'}` : '',
    ].filter(Boolean);
    return { name: 'planned_tasks_missing', force: true,
        text: `You declared COMPLETED, but ${parts.join('; and ')}. Then reply COMPLETED.` };
}

const plannedTasksMissing: CompletionGate = {
    name: 'planned_tasks_missing',
    async run(c) {
        if (!completionDeclared(c) || (c.ps.planCheck ?? 0) >= 2 || !c.taskIds) return null;
        const coverage = await planCoverage(c);
        if (coverage) return coverage;
        const named = [...c.text.matchAll(/\bTask\s+#?0*(\d{1,3})\s*[:\-–—]|fg-tasks\/0*(\d{1,3})-[\w.-]+\.md|`0*(\d{3})`\s*[:\-–—]/gi)].map(m => String(+(m[1] ?? m[2] ?? m[3])));
        if (!named.length) return null;
        const have = await c.taskIds();
        if (!have) return null;
        if (have.size && c.ps.planCheck) return null;   // a board with tasks is asked once; an empty one twice (the plan was pasted into the reply as text)
        const missing = [...new Set(named)].filter(id => !have.has(id));
        if (!missing.length) return null;
        c.ps.planCheck = (c.ps.planCheck ?? 0) + 1;
        return { name: 'planned_tasks_missing', force: true,
            text: `You declared COMPLETED, but your reply names task${missing.length > 1 ? 's' : ''} ${missing.map(id => '#' + id.padStart(3, '0')).join(', ')} and there ${missing.length > 1 ? 'are no such task files' : 'is no such task file'} (the board has ${have.size ? [...have].map(id => '#' + id.padStart(3, '0')).join(', ') : 'none'}). Write each missing one now as fg-tasks/NNN-slug.md with status: open and an ## Acceptance Criteria list (one write_file each), or say the plan is only what exists. Then reply COMPLETED.` };
    },
};

/** In the order they are tried; the first to answer ends the step with a nudge. */
export const COMPLETION_GATES: CompletionGate[] = [brokenSyntax, testFixturesLeft, inventedData, plannedTasksMissing];   // bench-policy.ts appends no_edit_complete, no_change_fix and blocked_untried_fix for a benchmark run

export async function runCompletionGates(c: GateContext): Promise<GateHit | null> {
    for (const g of COMPLETION_GATES) {
        if (runtime.guardOff(g.name)) continue;   // experiment switch (FG_DISABLE_GUARDS)
        const hit = await g.run(c);
        if (hit) return hit;
    }
    return null;
}
