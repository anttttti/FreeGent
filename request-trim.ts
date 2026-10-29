// A step's request is the whole conversation as sent, so each step of a long run holds a larger copy of the history than the one
// before: a few hundred steps were hundreds of MB of strings nobody opens (the WebUI's step panes reached 79 MB of text in one
// Autopilot task chat). The latest steps keep theirs whole; older ones keep their start. Shared by the TUI store and the WebUI.
export const KEEP_WHOLE_REQUESTS = 24;
export const KEPT_REQUEST_CHARS = 6000;

// The kept start of an old step's request or prompt, or the text itself when it is short enough already.
export function trimKeptRequest(v: string): string {
    if (v.length <= KEPT_REQUEST_CHARS + 200) return v;
    return `${v.slice(0, KEPT_REQUEST_CHARS)}\n… [${(v.length - KEPT_REQUEST_CHARS).toLocaleString('en-US')} more characters dropped to save memory]`;
}

// Newest-last list of the steps whose text is still whole. touch() moves a step to the end (one entry per step, so evicting an
// old position cannot trim a step still being updated) and trims the steps that fall off the front.
export function requestKeeper<T>(trim: (step: T) => void, keep = KEEP_WHOLE_REQUESTS): { touch(step: T): void } {
    const whole: T[] = [];
    return {
        touch(step: T) {
            const at = whole.indexOf(step);
            if (at >= 0 && at === whole.length - 1) return;
            if (at >= 0) whole.splice(at, 1);
            whole.push(step);
            while (whole.length > keep) trim(whole.shift()!);
        },
    };
}

// The saved copy of a chat's messages (a string, rewritten after every turn) keeps the start of each step's Request and Prompt pane, the
// four newest included: those are whole on the page for inspection, but in the saved copy they were 292 of a 23-step task chat's 428 kB,
// most of a task's storage (autopilot exploration AE-19, 2026-10-28: 3.4 MB per task). A pane's text is HTML-escaped, so it holds no
// literal "</pre>", and the cut is moved back before an unfinished entity.
const _SAVED_PANE_RE = /(<pre\b[^>]*\bdata-tab-name="(?:Request|Prompt)"[^>]*>)([\s\S]*?)(<\/pre>)/g;
// 1500 characters: every request starts with the same system prompt and tool list, so more of it says nothing new about a step.
export const SAVED_PANE_CHARS = 1500;
export function trimSavedPanes(html: string, keep = SAVED_PANE_CHARS): string {
    if (html.length < keep * 4) return html;
    return html.replace(_SAVED_PANE_RE, (m, open, body, close) => {
        if (body.length <= keep + 200) return m;
        let cut = keep;
        const amp = body.lastIndexOf('&', cut);
        if (amp >= 0 && body.indexOf(';', amp) >= cut) cut = amp;
        return `${open}${body.slice(0, cut)}\n… [${(body.length - cut).toLocaleString('en-US')} more characters not kept in the saved chat]${close}`;
    });
}
