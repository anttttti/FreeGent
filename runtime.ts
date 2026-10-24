// runtime.ts — FreeGent: what the current runtime can do, in one place.
//
// The headless runner (fg-run, benchmarks, the TUI) installs globalThis.nativeExec so execute_code
// runs real bash/python3/node processes; the browser app never does. Code used to test that with
// `typeof nativeExec === 'function'` wherever it needed to know "headless?", "can I show an image?"
// or "can I open a page?". Those questions are named here. Every getter reads the global at call
// time, never at module load, because the runner installs it after the modules load.

import { killRunningNative } from './native-running.js';

const g = globalThis as any;
let nativeRunning = 0;

// The guards and tool behaviours added by the 2026-10 review, as named for FG_DISABLE_GUARDS.
export const REVIEW_GUARDS = ['no_edit_complete', 'failed_check_complete', 'invented_data',
    'replace_decode', 'replace_region', 'lookalike_escalation', 'negative_probe', 'call_norm'];

export const runtime = {
    /** execute_code runs natively (headless runs, bench containers): real processes in the workspace. */
    get hasNativeExec(): boolean { return typeof g.nativeExec === 'function'; },
    /** No browser UI: no chat DOM, no iframe sandbox, no images to display. */
    get headless(): boolean { return this.hasNativeExec; },
    /** Browser pages (iframe sandbox, check_page, inline images) are available. */
    get hasBrowserUi(): boolean { return !this.headless; },
    /** Benchmark policy, not a capability: file tools refuse to edit test files. Set by a runner whose
     *  grader discards test-file changes (SWE-bench: FG_PROTECT_TESTS=1); never on for ordinary runs. */
    get protectTests(): boolean { return this.hasNativeExec && g.process?.env?.FG_PROTECT_TESTS === '1'; },
    /** Task policy, not a capability: the task is solved by editing files, so a COMPLETED with no edit is
     *  bounced once. Set by the runner that knows (SWE-bench: FG_EDIT_REQUIRED=1); never inferred from
     *  the wording of a benchmark's prompt. */
    get editRequired(): boolean { return g.process?.env?.FG_EDIT_REQUIRED === '1'; },
    /** Task policy, not a capability: the task is graded on the state of the system afterwards (AgentBench OS
     *  tasks with a check script: "fix it", "make X work"), so a reply that changed nothing cannot be right.
     *  Set by the runner from the task's grader (FG_CHANGE_REQUIRED=1); never inferred from the prompt wording. */
    get changeRequired(): boolean { return g.process?.env?.FG_CHANGE_REQUIRED === '1'; },
    /** Experiment switch, never set in ordinary runs: FG_DISABLE_GUARDS=name,name (or `review`, the set added
     *  by the v0.70 review) turns single guards off so their effect can be measured against the same build. */
    guardOff(name: string): boolean {
        const v = g.process?.env?.FG_DISABLE_GUARDS;
        if (!v) return false;
        const list = String(v).split(',').map((x: string) => x.trim());
        return list.includes(name) || (list.includes('review') && REVIEW_GUARDS.includes(name));
    },
    /** Run code natively. Callers check hasNativeExec first. */
    /** Native executions running now. Stop-after-this-step (agent-core stopAfterStep) must not abort a step while one runs:
     *  the abort detached the command, which kept going and wrote its files after the next turn had started. */
    get nativeBusy(): boolean { return nativeRunning > 0; },
    /** End the commands running natively (a hard Stop). Only commands run by the built-in executor are registered; an executor of another kind cannot be cancelled. */
    killNative(): number { return killRunningNative(); },
    async nativeExec(language: string, code: string, opts?: { timeoutMs?: number }): Promise<any> {
        nativeRunning++;
        try { return await g.nativeExec(language, code, opts); } finally { nativeRunning--; }
    },
};
