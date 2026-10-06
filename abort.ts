// abort.ts — FreeGent: composing the user's Stop signal with timeouts, in one place.
//
// Every network call the agent starts should honour Stop (activeAbortController.signal) *and* have
// a hard timeout. Pass the user signal explicitly so this module stays free of app state.

function anySignal(signals: AbortSignal[]): AbortSignal {
    if (signals.length === 1) return signals[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
    // Old Safari: no AbortSignal.any.
    const ctrl = new AbortController();
    for (const s of signals) {
        if (s.aborted) { ctrl.abort(s.reason); break; }
        s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
    }
    return ctrl.signal;
}

function timeoutSignal(ms: number): AbortSignal {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
    return ctrl.signal;
}

/**
 * A signal that aborts when `user` aborts or after `timeoutMs`, whichever comes first.
 * Either may be omitted; with neither, returns undefined (no signal).
 */
export function combineSignals(user?: AbortSignal | null, timeoutMs?: number): AbortSignal | undefined {
    const parts: AbortSignal[] = [];
    if (user) parts.push(user);
    if (timeoutMs && timeoutMs > 0) parts.push(timeoutSignal(timeoutMs));
    return parts.length ? anySignal(parts) : undefined;
}

/**
 * Two-phase abort for streamed responses: the timeout covers only connection establishment and
 * is released by `clear()` once headers arrive, so it cannot kill a long SSE body read. The user
 * signal stays active throughout.
 */
export function connectSignal(user: AbortSignal | null | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('signal timed out', 'TimeoutError')), timeoutMs);
    return { signal: user ? anySignal([user, ctrl.signal]) : ctrl.signal, clear: () => clearTimeout(timer) };
}
