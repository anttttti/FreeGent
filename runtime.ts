// runtime.ts — FreeGent: what the current runtime can do, in one place.
//
// The headless runner (fg-run, benchmarks, the TUI) installs globalThis.nativeExec so execute_code
// runs real bash/python3/node processes; the browser app never does. Code used to test that with
// `typeof nativeExec === 'function'` wherever it needed to know "headless?", "can I show an image?"
// or "can I open a page?". Those questions are named here. Every getter reads the global at call
// time, never at module load, because the runner installs it after the modules load.

const g = globalThis as any;

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
    /** Run code natively. Callers check hasNativeExec first. */
    nativeExec(language: string, code: string, opts?: { timeoutMs?: number }): Promise<any> { return g.nativeExec(language, code, opts); },
};
