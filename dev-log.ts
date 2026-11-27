// dev-log.ts — FreeGent: developer logging to the Cloudflare Worker, on only while a Developer key
// is saved (Settings → Credentials). Two streams, joined by SESSION_ID:
//   • console errors / warnings / uncaught errors → POST /errlog (batched, key required)
//   • a finished or failed Task's chat log        → POST /log     (sendTaskLog, called by runner.ts)
import { DEFAULT_CF_WORKER, getDevKey, isDefaultWorkerUrl } from './proxy.js';
import { getPrivacyLevel } from './privacy.js';
import { redactText } from './secrets.js';
import { storedCredentialValues } from './stored-credentials.js';
import { credentialsVersion } from './key-vault.js';
import { FG_VERSION } from './build-info.js';

function _randomId(): string {
    const b = new Uint8Array(6);
    try { crypto.getRandomValues(b); } catch { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** One ID per page load. Carried by every error-log batch and every task chat log. */
export const SESSION_ID: string = _randomId();

/** The device, coarsely, for the uploads: browser and OS with major versions, phone or not, whether WebAssembly exists, and the device memory where the browser reports it (Chromium).
 *  Not the user agent string. Missing in the reports until now, so a tab crash or a "Load failed" could not be told from an old iPad or a desktop. */
export function describeDevice(ua: string, maxTouch = 0, mem?: number, wasm = true): { browser: string; os: string; mobile: boolean; wasm: boolean; memGb?: number } {
    const v = (re: RegExp) => ua.match(re)?.[1];
    const browser = v(/\b(?:Edg|EdgA|EdgiOS)\/(\d+)/) ? `Edge ${v(/\b(?:Edg|EdgA|EdgiOS)\/(\d+)/)}`
        : v(/\b(?:Firefox|FxiOS)\/(\d+)/) ? `Firefox ${v(/\b(?:Firefox|FxiOS)\/(\d+)/)}`
        : v(/\b(?:Chrome|CriOS)\/(\d+)/) ? `Chrome ${v(/\b(?:Chrome|CriOS)\/(\d+)/)}`
        : v(/\bVersion\/(\d+)[\d.]* .*Safari\//) ? `Safari ${v(/\bVersion\/(\d+)[\d.]* .*Safari\//)}`
        : 'other';
    const ipad = /\biPad\b/.test(ua) || (/\bMacintosh\b/.test(ua) && maxTouch > 1);   // iPadOS 13+ reports a Mac
    const os = /\b(?:iPhone|iPod)\b/.test(ua) || ipad ? `${ipad ? 'iPadOS' : 'iOS'}${v(/\bOS (\d+)_/) ? ' ' + v(/\bOS (\d+)_/) : ''}`
        : /\bAndroid\b/.test(ua) ? `Android${v(/\bAndroid (\d+)/) ? ' ' + v(/\bAndroid (\d+)/) : ''}`
        : /\bCrOS\b/.test(ua) ? 'ChromeOS' : /\bWindows\b/.test(ua) ? 'Windows' : /\bMac OS X\b/.test(ua) ? 'macOS' : /\bLinux\b/.test(ua) ? 'Linux' : 'other';
    return { browser, os, mobile: /\b(?:iPhone|iPod|Android)\b.*\bMobile\b|\biPhone\b|\biPod\b|\biPad\b/.test(ua) || ipad, wasm, ...(typeof mem === 'number' ? { memGb: mem } : {}) };
}
let _device: ReturnType<typeof describeDevice> | null = null;
function _deviceInfo() {
    if (_device) return _device;
    try { _device = describeDevice(navigator.userAgent || '', navigator.maxTouchPoints || 0, (navigator as any).deviceMemory, typeof WebAssembly === 'object'); }
    catch { _device = { browser: 'other', os: 'other', mobile: false, wasm: false }; }
    return _device;
}

/** A self-hosted Worker is configured (Settings → Privacy): the saved Developer key is that Worker's, not FreeGent's, so nothing is uploaded to proxy.freegent.ai with it. */
function _ownWorker(): boolean {
    try {
        const v = (localStorage.getItem('fg_search_proxy') || '').trim();
        return !!v && !isDefaultWorkerUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`);   // FreeGent's own Worker entered by hand is still FreeGent's
    } catch { return false; }
}

function devLoggingOn(): boolean { return !!getDevKey() && getPrivacyLevel() === 'routed' && !_ownWorker(); }

interface DevLogEntry { ts: string; level: 'error' | 'warn'; source: string; text: string; count?: number; }

const MAX_TEXT = 2000;
const MAX_QUEUE = 200;
const FLUSH_MS = 3000;
let _queue: DevLogEntry[] = [];
let _timer: ReturnType<typeof setTimeout> | null = null;
let _installed = false;
let _sending = false;
const _origFetch = () => window.fetch.bind(window);

// Every saved credential value (stored-credentials.ts's one list), cached until a credential or the key
// lock changes (credentialsVersion), and for 30 s at most.
let _secrets: string[] = []; let _secretsAt = 0; let _secretsVer = -1;
function _storedSecrets(): string[] {
    if (_secretsVer === credentialsVersion() && Date.now() - _secretsAt < 30_000) return _secrets;
    _secrets = storedCredentialValues(); _secretsAt = Date.now(); _secretsVer = credentialsVersion();
    return _secrets;
}

function _stringify(a: unknown): string {
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
}

/** `text` with the Developer key and every saved credential replaced, as everything sent to the Worker must be. */
export function redactForLog(text: string): string { return redactText(String(text ?? ''), [getDevKey(), ..._storedSecrets()]); }

/** Queue one entry (no-op without a Developer key). Same message twice in a row is counted, not repeated. */
export function devLogEntry(level: 'error' | 'warn', source: string, text: string): void {
    if (!devLoggingOn()) return;
    const clean = redactForLog(text).slice(0, MAX_TEXT);
    const last = _queue[_queue.length - 1];
    if (last && last.level === level && last.source === source && last.text === clean) { last.count = (last.count || 1) + 1; return; }
    if (_queue.length >= MAX_QUEUE) _queue.shift();
    _queue.push({ ts: new Date().toISOString(), level, source, text: clean });
    if (!_timer) _timer = setTimeout(() => { void flushDevLog(); }, FLUSH_MS);
}

let _failedSends = 0;
/** Send what is queued. A failed send puts the entries back (bounded) and never logs through console. */
export async function flushDevLog(): Promise<void> {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_sending || !_queue.length || !devLoggingOn()) return;
    const batch = _queue; _queue = []; _sending = true;
    let ok = false;
    try {
        const r = await _origFetch()(`${DEFAULT_CF_WORKER}/errlog`, {
            method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-FG-Dev-Key': getDevKey() }, keepalive: true,
            body: JSON.stringify({ sessionId: SESSION_ID, version: FG_VERSION, url: location.origin + location.pathname, device: _deviceInfo(), entries: batch }),
        });
        if (!r.ok) throw new Error(String(r.status));
        ok = true;
    } catch {
        _queue = batch.concat(_queue).slice(-MAX_QUEUE);
    } finally {
        _sending = false;
        // Entries queued during a send whose timer fired meanwhile (flush returned early) still need a timer (explorations N015); not after a failure, so a down server is not retried in a loop.
        if (ok) _failedSends = 0;
        if (ok && _queue.length && !_timer) _timer = setTimeout(() => { void flushDevLog(); }, FLUSH_MS);
        // After a failure the entries wait for the next entry's timer; with none coming (the same warning repeated is counted, not queued) they stayed for good. A few spaced retries, then
        // it waits again, so a server that is down is not hit in a loop (review of 71928f3).
        else if (!ok && _queue.length && !_timer && _failedSends++ < 3) _timer = setTimeout(() => { void flushDevLog(); }, 60_000);
    }
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
export function _resetDevLogForTest(): void { _failedSends = 0; _secretsAt = 0; _queue = []; _sending = false; if (_timer) { clearTimeout(_timer); _timer = null; } }
export function _devLogQueueForTest(): DevLogEntry[] { return _queue; }

/** Send a Task's chat log (done / failed / blocked / stopped). Needs a Developer key; never throws.
 *  `build` returns the redacted chat JSON so this module does not depend on convo-log. */
export async function sendTaskLog(task: { id: string; title: string; path: string }, outcome: string, reason: string,
                                  chatId: string | null, build: (chatId: string) => Promise<string>): Promise<void> {
    if (!devLoggingOn() || !chatId) return;
    try {
        const chat = JSON.parse(await build(chatId));
        if (!devLoggingOn()) return;   // the Developer key was removed while the chat was being built (explorations 2026-11-10 N026)
        // `build` redacts the chat only: the task's own fields are text from the run too (a crash's reason quotes the code that ran).
        const body = JSON.stringify({ devSession: SESSION_ID, device: _deviceInfo(), task: { id: redactForLog(task.id), title: redactForLog(task.title), path: redactForLog(task.path),
            outcome, reason: redactForLog(String(reason || '')).slice(0, 500) }, ...chat });
        await _origFetch()(`${DEFAULT_CF_WORKER}/log`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-FG-Dev-Key': getDevKey() }, body });
    } catch (e) {
        devLogEntry('warn', 'dev-log', `task log not sent: ${(e as any)?.message ?? e}`);
    }
}
