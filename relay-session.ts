// relay-session.ts — the Worker's page-fetch path (GET <worker>?url=…) and its guest quota (a keyless model call
// POSTed to the Worker) need a session token from a Cloudflare Turnstile check (cf-worker/worker.js, "Relay
// sessions"). This wraps window.fetch: such a request that comes back 401 with X-FG-Session-Required runs the
// challenge with the site key the Worker sent, trades the Turnstile token for a session token (POST
// <worker>/session), and is sent again once with X-FG-Session. Only the Routed privacy level reaches a Worker, so the
// Turnstile script loads only there, and only when a request first needs it. The header is added only for a Worker
// that asked for it, so an older Worker without it in its CORS list keeps working.

const TURNSTILE_JS = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// The whole session setup (script load, challenge, /session exchange): long enough for the visitor to click the checkbox when one is
// shown. It bounded only the widget, so a script that never loaded or a /session reply that never came hung every fetch to that Worker (codex DR-08).
const CHALLENGE_TIMEOUT_MS = 120_000;

const _sessions = new Map<string, string>();            // Worker origin -> session token
const _pending = new Map<string, Promise<string>>();    // Worker origin -> challenge in progress (shared by parallel fetches)
let _script: Promise<any> | null = null;

/** The origin of a request that a Worker may answer with "session required": a page fetch (`GET <origin>/?url=…`)
 *  or a POST with a string body (a model call), on another origin; null for anything else, which passes untouched.
 *  Other hosts never send X-FG-Session-Required, and the header goes only to an origin that asked for it. */
export function relayOrigin(input: any, init?: any): string | null {
    if (typeof input !== 'string' && !(input instanceof URL)) return null;
    const method = String(init?.method || 'GET').toUpperCase();
    try {
        const u = new URL(String(input), window.location.href);
        if (u.origin === window.location.origin) return null;
        if (method === 'GET' ? u.searchParams.has('url') : method === 'POST' && typeof init?.body === 'string') return u.origin;
        return null;
    } catch { return null; }
}

function _loadTurnstile(): Promise<any> {
    const w = window as any;
    if (w.turnstile) return Promise.resolve(w.turnstile);
    _script ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = TURNSTILE_JS;
        s.async = true;
        s.onload = () => w.turnstile ? resolve(w.turnstile) : reject(new Error('Turnstile did not start'));
        s.onerror = () => { _script = null; reject(new Error('challenges.cloudflare.com could not be loaded')); };
        document.head.appendChild(s);
    });
    return _script;
}

/** `p`, or a rejection with the signal's reason as soon as it aborts (no signal: `p`). */
function _until<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) return p;
    return new Promise<T>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
        p.then(v => { signal.removeEventListener('abort', stop); resolve(v); }, e => { signal.removeEventListener('abort', stop); reject(e); });
    });
}

// Runs the challenge. "interaction-only" keeps the widget invisible unless Cloudflare wants a click.
async function _solve(siteKey: string, deadline: AbortSignal): Promise<string> {
    let turnstile: any;
    try { turnstile = await _until(_loadTurnstile(), deadline); }
    catch (e) { if (deadline.aborted) _script = null; throw e; }   // a load that never finished is tried afresh next time
    const box = document.createElement('div');
    box.className = 'relay-check';
    document.body.appendChild(box);
    let id: string | undefined;
    try {
        return await new Promise<string>((resolve, reject) => {
            const fail = (why: string) => reject(new Error(why));
            deadline.addEventListener('abort', () => fail('timed out'), { once: true });
            id = turnstile.render(box, {
                sitekey: siteKey,
                appearance: 'interaction-only',
                callback: (token: string) => resolve(token),
                'error-callback': (code: string) => { fail(`error ${code}`); return true; },
                'timeout-callback': () => fail('the check expired'),
                'unsupported-callback': () => fail('this browser is not supported'),
            });
        });
    } finally {
        try { if (id !== undefined) turnstile.remove(id); } catch {}
        box.remove();
    }
}

function _session(origin: string, siteKey: string, send: typeof fetch): Promise<string> {
    let p = _pending.get(origin);
    if (!p) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(new Error('timed out')), CHALLENGE_TIMEOUT_MS);
        p = (async () => {
            const token = await _solve(siteKey, ctl.signal);
            const resp: Response = await _until(send.call(window, `${origin}/session`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: ctl.signal,
            }), ctl.signal);
            const data: any = await _until(resp.json().catch(() => ({})), ctl.signal);
            if (!resp.ok || typeof data.session !== 'string') throw new Error(data.error || `HTTP ${resp.status}`);
            _sessions.set(origin, data.session);
            return data.session as string;
        })().finally(() => { clearTimeout(timer); _pending.delete(origin); });
        _pending.set(origin, p);
    }
    return p;
}

function _refusal(why: string): Response {
    const error = `Cloudflare's check for requests through FreeGent's Worker could not run (${why}). `
        + 'Allow challenges.cloudflare.com in your content blocker, or switch Settings → Privacy to Provider-only.';
    return new Response(JSON.stringify({ error }), {
        status: 401, statusText: 'Session check failed', headers: { 'Content-Type': 'application/json', 'X-FG-Proxy-Error': '1' },
    });
}

export function installRelaySession(): void {
    const w = window as any;
    if (w._fgRelaySession) return;
    w._fgRelaySession = true;
    const inner = window.fetch;
    window.fetch = async function (input: any, init?: any) {
        const origin = relayOrigin(input, init);
        if (!origin) return inner.call(window, input, init);
        let used: string | undefined;   // the session this request went out with, to tell a refusal of the current one from a late reply about an older one
        const send = () => {
            const session = _sessions.get(origin);
            used = session;
            if (!session) return inner.call(window, input, init);
            const headers = new Headers(init?.headers);
            headers.set('X-FG-Session', session);
            return inner.call(window, input, { ...init, headers });
        };
        const resp = await send();
        if (resp.status !== 401 || resp.headers.get('X-FG-Session-Required') !== '1') return resp;
        const siteKey = await resp.clone().json().then((d: any) => String(d?.turnstileSiteKey || ''), () => '');
        if (!siteKey) return resp;
        // A late refusal of an older (or no) session must not discard the replacement a newer request has since obtained: that cost a second challenge (exploration O010).
        if (_sessions.get(origin) !== undefined && _sessions.get(origin) !== used) return send();
        _sessions.delete(origin);
        // The caller's own cancellation ends its wait at once; the shared setup goes on for the other fetches waiting on it (codex DR-07).
        try { await _until(_session(origin, siteKey, inner), init?.signal); }
        catch (e: any) { if (init?.signal?.aborted) throw e; return _refusal(String(e?.message || e)); }
        return send();
    } as typeof fetch;
}

/** Tests: forget sessions and the loaded script. */
export function _resetRelaySessions(): void { _sessions.clear(); _pending.clear(); _script = null; }
