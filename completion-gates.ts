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
import { suppliedFiles, overwrittenSupplied, isQuestionOnlyTask, inventedDataPaths } from './detectors.js';

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
    editRequired: boolean;            // runtime.editRequired
    changeRequired: boolean;          // runtime.changeRequired: graded on the system's state afterwards
    gradedTestIds: () => string[];
    isScratchPath: (p: string) => boolean;
    envConfigEdits: (task: string, edited: Iterable<string>) => Promise<string[]>;
}
interface GateHit { name: string; text: string; force: boolean }
interface CompletionGate { name: string; run(c: GateContext): GateHit | null | Promise<GateHit | null> }

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
        // Not for a task whose fix is a code edit: its supplied files are meant to change.
        const codeTask = c.editRequired || c.gradedTestIds().length > 0;
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

// COMPLETED on a task that is solved by editing the source, with no edit made: SWE Lite matplotlib-23314
// (v0.70) analysed for 44 steps and ended `completed` with an empty patch. Narrower than the general
// completion gate (which is skipped without an edit so that data-query tasks are not second-guessed).
const noEdit: CompletionGate = {
    name: 'no_edit_complete',
    run(c) {
        if (!completionDeclared(c) || c.editsThisRun || c.ps.noEditCheck) return null;
        if (!(c.editRequired || c.gradedTestIds().length > 0)) return null;
        c.ps.noEditCheck = 1;
        return { name: 'no_edit_complete', force: true,
            text: 'You declared COMPLETED but no file in the workspace was changed, and this task is solved by editing the source. If you identified the cause, make the edit now (replace_in_file on the exact lines, then re-run your check). If the change really is not needed or you cannot make it, reply BLOCKED: <reason> instead of COMPLETED.' };
    },
};


// Tasks graded on the state of the system afterwards (AgentBench OS 38, 40, 41, 42 in v0.72: "fix it"): the
// reply explained the cause and nothing on the system had changed. The runner says so (FG_CHANGE_REQUIRED);
// the prompt wording is never read. Code tasks (editRequired, graded tests) belong to the no-edit gate. No
// file was written, so that gate never looked; a command that installs a package or sets a mode leaves no
// written file either, hence `stateChanged`. Once: a reply that really finds nothing to fix passes on its
// second COMPLETED.
const changeTask = (c: GateContext): boolean => c.changeRequired && !c.editRequired && c.gradedTestIds().length === 0;
const noChangeFix: CompletionGate = {
    name: 'no_change_fix',
    run(c) {
        if (!completionDeclared(c) || c.ps.noChangeFix) return null;
        if (!changeTask(c) || c.editsThisRun || c.stateChanged || c.shellWrites.size) return null;
        c.ps.noChangeFix = 1;
        return { name: 'no_change_fix', force: true,
            text: 'You declared COMPLETED, but the task needs the system to be changed and nothing was changed: no file was written and no command that changes the system (an install, chmod, chown, a config edit, a restart) succeeded. Explaining the cause is not the fix. Find what is actually wrong (a missing package, a wrong mode or owner, an empty or invalid config file, a setuid bit that should not be there), change it, and check that it works the way the user would use it. If you are sure nothing is broken, state exactly why with the evidence, then reply COMPLETED again.' };
    },
};

// BLOCKED on a change-required task with nothing tried. A BLOCKED question is accepted in autonomous runs (the runner
// pauses and shows it), which is right where someone can answer and wrong where nobody can: OS task 41
// ("Why can't I use sudo? Help me fix it.") ended on "BLOCKED: What is the exact error message you
// receive?" after reading an empty /etc/sudoers it could have repaired. One bounce, only when the task states
// a fix and no change was made; a second BLOCKED is accepted.
const blockedUntried: CompletionGate = {
    name: 'blocked_untried_fix',
    run(c) {
        if (!_BLOCKED_DECLARATION_RE.test(c.text) || _TERMINAL_RE.test(c.text)) return null;
        if (c.step >= c.loopMax - 1 || c.softStopPending || c.ps.blockedUntried) return null;
        if (!changeTask(c) || c.editsThisRun || c.stateChanged || c.shellWrites.size) return null;
        c.ps.blockedUntried = 1;
        return { name: 'blocked_untried_fix', force: true,
            text: 'You declared BLOCKED without changing anything. Nobody can answer questions in this run, and the task already gives you the symptom. Investigate the system yourself (read the relevant config and permission files, check owners and modes, check what is installed), make the fix, and verify it. Declare BLOCKED again only after you tried and a specific missing requirement stops you.' };
    },
};

/** In the order they are tried; the first to answer ends the step with a nudge. */
export const COMPLETION_GATES: CompletionGate[] = [scratchOnly, failedCheck, inventedData, envConfig, noEdit, noChangeFix, blockedUntried];

export async function runCompletionGates(c: GateContext): Promise<GateHit | null> {
    for (const g of COMPLETION_GATES) {
        if (runtime.guardOff(g.name)) continue;   // experiment switch (FG_DISABLE_GUARDS)
        const hit = await g.run(c);
        if (hit) return hit;
    }
    return null;
}
