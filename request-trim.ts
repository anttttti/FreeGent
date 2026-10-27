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
