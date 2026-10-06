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
    /** Run code natively. Callers check hasNativeExec first. */
    nativeExec(language: string, code: string): Promise<any> { return g.nativeExec(language, code); },
};
