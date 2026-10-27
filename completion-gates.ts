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
import type { Verification } from './verification.js';
import { suppliedFiles, overwrittenSupplied, isQuestionOnlyTask, inventedDataPaths, taskChangesData } from './detectors.js';

export interface GateContext {
    text: string;                     // the reply that declared COMPLETED
    step: number;
    loopMax: number;
    softStopPending: boolean;
    ps: any;                          // per-turn counters (scratchOnlyCheck, verifCheck, ...)
    workflowMode: boolean;
    editedPaths: Set<string>;         // files written by tools this turn
    shellWrites: Set<string>;         // paths a shell command redirected into
    editsThisRun: boolean;
    editEvents: number;
    verdict: Verification;            // verification.ts state of the change
    stateChanged: boolean;            // a successful command changed the system without writing a reported file (detectors.changesState)
    reactiveFired: Set<string>;
    firstUserText: string;            // the first user message (lists the supplied files)
    task: string;                     // the original task text
    editRequired: boolean;            // taskPolicy.editRequired(): benchmark runs only (bench-policy.ts)
    changeRequired: boolean;          // taskPolicy.changeRequired(): graded on the system's state afterwards; benchmark runs only
    gradedTestIds: () => string[];    // taskPolicy.gradedTestIds(task): benchmark runs only
    isScratchPath: (p: string) => boolean;
    envConfigEdits: (task: string, edited: Iterable<string>) => Promise<string[]>;
    brokenFiles: (paths: Iterable<string>) => Promise<string[]>;   // parse errors of these files (tools.ts brokenFileReport)
}
export interface GateHit { name: string; text: string; force: boolean }
export interface CompletionGate { name: string; run(c: GateContext): GateHit | null | Promise<GateHit | null> }

/** The preconditions every gate shares: a real COMPLETED, not a BLOCKED, with a step left to act on the nudge. */
export function completionDeclared(c: GateContext): boolean {
    return _isComplete(c.text) && !_BLOCKED_DECLARATION_RE.test(c.text) && c.step < c.loopMax - 1 && !c.softStopPending;
}

// Every file changed this run is a repro/debug/temp file, so the fix itself is not in place (SWE-bench
// v0.55 astropy-12907: a sed that matched nothing, then COMPLETED with only repro scripts in the patch).
// A second COMPLETED is accepted: the scratch files may be the deliverable.
const scratchOnly: CompletionGate = {
    name: 'scratch_only_edits',
    run(c) {
        if (!completionDeclared(c) || c.ps.scratchOnlyCheck) return null;
        if (!c.editedPaths.size || ![...c.editedPaths].every(c.isScratchPath)) return null;
        c.ps.scratchOnlyCheck = 1;
        return { name: 'scratch_only_edits', force: false,
            text: `You declared COMPLETED, but the only files changed this turn are scratch files: ${[...c.editedPaths].slice(0, 6).join(', ')}. No project file was modified, so if the task was to change the code, the fix is not applied — read the file (or check \`git diff\` where git works) and apply it, then remove the scratch files. If these files are the deliverable, reply COMPLETED again.` };
    },
};

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

// The last check after the final change failed (not an import/collection failure: those are not counted
// as checks, verification.ts). v0.70 Lite: 11 of 69 tasks ended with a real failing check; the graded-test
// gate covers tasks that list their tests, this covers the rest.
const failedCheck: CompletionGate = {
    name: 'failed_check_complete',
    run(c) {
        if (!completionDeclared(c) || c.ps.verifCheck || c.reactiveFired.has('graded_test')) return null;
        if (c.verdict !== 'failed_verification') return null;
        c.ps.verifCheck = 1;
        return { name: 'failed_check_complete', force: true,
            text: 'You declared COMPLETED, but the last test or build check you ran after your final change failed. Look at its output: if the failure is caused by your change, fix it and re-run the check; if it is unrelated to your change (an existing failure, the environment), say so explicitly in your final reply and give the evidence. Then reply COMPLETED.' };
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

// Test-environment workarounds in the change set: a rewritten conftest.py / pytest.ini / setup.cfg that
// made tests run locally ships with the fix and can break every graded test (v0.58 xarray-5131). Skipped
// when the task names the file; a COMPLETED repeated with no edits in between passes; new edits earn a
// second bounce (v0.59 flask-4045 restored conftest.py after the first, then rewrote it).
const envConfig: CompletionGate = {
    name: 'env_config_edits',
    async run(c) {
        if (!c.workflowMode || !completionDeclared(c)) return null;
        const n = c.ps.envConfigCheck ?? 0;
        if (n >= 2 || (n ? !(c.editEvents > (c.ps.envConfigAt ?? 0)) : false)) return null;
        const cfg = await c.envConfigEdits(c.task, c.editedPaths);
        if (!cfg.length) return null;
        c.ps.envConfigCheck = n + 1;
        c.ps.envConfigAt = c.editEvents;
        return { name: 'env_config_edits', force: false,
            text: `You changed test or packaging configuration${cfg.some(f => f.endsWith('/')) ? ', or added a new top-level package (a stand-in for a missing dependency)' : ''}: ${cfg.slice(0, 6).join(', ')}. The graded tests run in their own prepared environment and these edits ship with your change — a modified conftest.py or pytest.ini can break every graded test, and a stub package hides the real one. Unless the task asks for these changes, restore them (\`git checkout -- <file>\`, or delete a file or folder you created), keep only the fix itself, then reply COMPLETED again. If local tests can't run without them, check the fix with a short script instead.` };
    },
};

/** In the order they are tried; the first to answer ends the step with a nudge. */
export const COMPLETION_GATES: CompletionGate[] = [scratchOnly, brokenSyntax, failedCheck, inventedData, envConfig];   // bench-policy.ts appends no_edit_complete, no_change_fix and blocked_untried_fix for a benchmark run

export async function runCompletionGates(c: GateContext): Promise<GateHit | null> {
    for (const g of COMPLETION_GATES) {
        if (runtime.guardOff(g.name)) continue;   // experiment switch (FG_DISABLE_GUARDS)
        const hit = await g.run(c);
        if (hit) return hit;
    }
    return null;
}
