// dev-log.ts — FreeGent: developer logging to the Cloudflare Worker, on only while a Developer key
// is saved (Settings → API Credentials). Two streams, joined by SESSION_ID:
//   • console errors / warnings / uncaught errors → POST /errlog (batched, key required)
//   • a finished or failed Task's chat log        → POST /log     (sendTaskLog, called by runner.ts)
import { DEFAULT_CF_WORKER, getDevKey } from './proxy.js';
import { getPrivacyLevel } from './privacy.js';
import { redactText } from './secrets.js';
import { FG_VERSION } from './build-info.js';

function _randomId(): string {
    const b = new Uint8Array(6);
    try { crypto.getRandomValues(b); } catch { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** One ID per page load. Carried by every error-log batch and every task chat log. */
export const SESSION_ID: string = _randomId();

function devLoggingOn(): boolean { return !!getDevKey() && getPrivacyLevel() === 'routed'; }

interface DevLogEntry { ts: string; level: 'error' | 'warn'; source: string; text: string; count?: number; }

const MAX_TEXT = 2000;
const MAX_QUEUE = 200;
const FLUSH_MS = 3000;
let _queue: DevLogEntry[] = [];
let _timer: ReturnType<typeof setTimeout> | null = null;
let _installed = false;
let _sending = false;
const _origFetch = () => window.fetch.bind(window);

// Every saved credential-looking localStorage value (same name rule as convo-log's
// storedSecretValues, without its MCP headers: importing convo-log here would be a cycle). Cached briefly.
let _secrets: string[] = []; let _secretsAt = 0;
function _storedSecrets(): string[] {
    if (Date.now() - _secretsAt < 30_000) return _secrets;
    const vals: string[] = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) || '';
            if (/key|token|secret|password/i.test(k)) { const v = (localStorage.getItem(k) || '').replace(/^"|"$/g, ''); if (v) vals.push(v); }
        }
    } catch {}
    _secrets = vals; _secretsAt = Date.now();
    return vals;
}

function _stringify(a: unknown): string {
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
}

/** Queue one entry (no-op without a Developer key). Same message twice in a row is counted, not repeated. */
export function devLogEntry(level: 'error' | 'warn', source: string, text: string): void {
    if (!devLoggingOn()) return;
    const clean = redactText(String(text), [getDevKey(), ..._storedSecrets()]).slice(0, MAX_TEXT);
    const last = _queue[_queue.length - 1];
    if (last && last.level === level && last.source === source && last.text === clean) { last.count = (last.count || 1) + 1; return; }
    if (_queue.length >= MAX_QUEUE) _queue.shift();
    _queue.push({ ts: new Date().toISOString(), level, source, text: clean });
    if (!_timer) _timer = setTimeout(() => { void flushDevLog(); }, FLUSH_MS);
}

/** Send what is queued. A failed send puts the entries back (bounded) and never logs through console. */
export async function flushDevLog(): Promise<void> {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_sending || !_queue.length || !devLoggingOn()) return;
    const batch = _queue; _queue = []; _sending = true;
    try {
        const r = await _origFetch()(`${DEFAULT_CF_WORKER}/errlog`, {
            method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-FG-Dev-Key': getDevKey() }, keepalive: true,
            body: JSON.stringify({ sessionId: SESSION_ID, version: FG_VERSION, url: location.origin + location.pathname, entries: batch }),
        });
        if (!r.ok) throw new Error(String(r.status));
    } catch {
        _queue = batch.concat(_queue).slice(-MAX_QUEUE);
    } finally { _sending = false; }
}

/** Hook console.error / console.warn, window 'error' and 'unhandledrejection'. Idempotent. */
export function installDevLog(): void {
    if (_installed || typeof window === 'undefined') return;
    _installed = true;
    for (const level of ['error', 'warn'] as const) {
        const orig = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            try { devLogEntry(level, 'console', args.map(_stringify).join(' ')); } catch {}
            orig(...args);
        };
    }
    window.addEventListener('error', (e: ErrorEvent) => {
        devLogEntry('error', 'window.onerror', `${e.message}${e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''}${e.error?.stack ? '\n' + e.error.stack : ''}`);
    });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        devLogEntry('error', 'unhandledrejection', _stringify(e.reason));
    });
    window.addEventListener('pagehide', () => { void flushDevLog(); });
}

/** Test seam. */
export function _resetDevLogForTest(): void { _secretsAt = 0; _queue = []; _sending = false; if (_timer) { clearTimeout(_timer); _timer = null; } }
export function _devLogQueueForTest(): DevLogEntry[] { return _queue; }

/** Send a Task's chat log (done / failed / blocked / stopped). Needs a Developer key; never throws.
 *  `build` returns the redacted chat JSON so this module does not depend on convo-log. */
export async function sendTaskLog(task: { id: string; title: string; path: string }, outcome: string, reason: string,
                                  chatId: string | null, build: (chatId: string) => Promise<string>): Promise<void> {
    if (!devLoggingOn() || !chatId) return;
    try {
        const chat = JSON.parse(await build(chatId));
        const body = JSON.stringify({ devSession: SESSION_ID, task: { ...task, outcome, reason: String(reason || '').slice(0, 500) }, ...chat });
        await _origFetch()(`${DEFAULT_CF_WORKER}/log`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-FG-Dev-Key': getDevKey() }, body });
    } catch (e) {
        devLogEntry('warn', 'dev-log', `task log not sent: ${(e as any)?.message ?? e}`);
    }
}
