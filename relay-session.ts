// relay-session.ts — the Worker's page-fetch path (GET <worker>?url=…) needs a session token from a Cloudflare
// Turnstile check (cf-worker/worker.js, "Relay sessions"). This wraps window.fetch: a ?url= request that comes back
// 401 with X-FG-Session-Required runs the challenge with the site key the Worker sent, trades the Turnstile token for
// a session token (POST <worker>/session), and is sent again once with X-FG-Session. Only the Routed privacy level
// reaches a Worker, so the Turnstile script loads only there, and only when a fetch first needs it. The header is
// added only for a Worker that asked for it, so an older Worker without it in its CORS list keeps working.

const TURNSTILE_JS = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const CHALLENGE_TIMEOUT_MS = 120_000;   // long enough for the visitor to click the checkbox when one is shown

const _sessions = new Map<string, string>();            // Worker origin -> session token
const _pending = new Map<string, Promise<string>>();    // Worker origin -> challenge in progress (shared by parallel fetches)
let _script: Promise<any> | null = null;

/** The Worker origin of a page-fetch request (`GET <origin>/?url=…` on another origin), or null for anything else. */
export function relayOrigin(input: any, init?: any): string | null {
    if (typeof input !== 'string' && !(input instanceof URL)) return null;
    if (init?.method && String(init.method).toUpperCase() !== 'GET') return null;
    try {
        const u = new URL(String(input), window.location.href);
        if (u.origin === window.location.origin || !u.searchParams.has('url')) return null;
        return u.origin;
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

// Runs the challenge. "interaction-only" keeps the widget invisible unless Cloudflare wants a click.
async function _solve(siteKey: string): Promise<string> {
    const turnstile = await _loadTurnstile();
    const box = document.createElement('div');
    box.className = 'relay-check';
    document.body.appendChild(box);
    let id: string | undefined;
    try {
        return await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out')), CHALLENGE_TIMEOUT_MS);
            const fail = (why: string) => { clearTimeout(timer); reject(new Error(why)); };
            id = turnstile.render(box, {
                sitekey: siteKey,
                appearance: 'interaction-only',
                callback: (token: string) => { clearTimeout(timer); resolve(token); },
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
        p = (async () => {
            const token = await _solve(siteKey);
            const resp = await send.call(window, `${origin}/session`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || typeof data.session !== 'string') throw new Error(data.error || `HTTP ${resp.status}`);
            _sessions.set(origin, data.session);
            return data.session as string;
        })().finally(() => _pending.delete(origin));
        _pending.set(origin, p);
    }
    return p;
}

function _refusal(why: string): Response {
    const error = `Cloudflare's check for page fetches through the Worker could not run (${why}). `
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
        const send = () => {
            const session = _sessions.get(origin);
            if (!session) return inner.call(window, input, init);
            const headers = new Headers(init?.headers);
            headers.set('X-FG-Session', session);
            return inner.call(window, input, { ...init, headers });
        };
        const resp = await send();
        if (resp.status !== 401 || resp.headers.get('X-FG-Session-Required') !== '1') return resp;
        const siteKey = await resp.clone().json().then((d: any) => String(d?.turnstileSiteKey || ''), () => '');
        if (!siteKey) return resp;
        _sessions.delete(origin);
        try { await _session(origin, siteKey, inner); }
        catch (e: any) { return _refusal(String(e?.message || e)); }
        return send();
    } as typeof fetch;
}

/** Tests: forget sessions and the loaded script. */
export function _resetRelaySessions(): void { _sessions.clear(); _pending.clear(); _script = null; }
