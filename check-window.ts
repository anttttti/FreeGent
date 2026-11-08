// check-window.ts — check_page in a separate window, for a page that takes the tab down.
//
// check_page loads the page in a hidden frame of the FreeGent tab. A page that loops for ever or grows without end takes the whole tab with it, chats included
// (uploaded logs: check_page crashed the tab; the iframe is not a process boundary in every browser). A window opened with `noopener` is its own browsing context group,
// so its own process in current browsers: public/fg-check-window.html, same origin, builds the same sandboxed frame there and relays messages over a BroadcastChannel.
//
// The in-tab frame stays the default. The window is used when a check of this page crashed before ("auto", the setting fg_check_isolation), always ("always") or never
// ("off"); a browser lets a script open a window only from a click, so FreeGent shows a small bar with one button, and the window then stays open for the next checks.
// Without the window (declined, blocked, a phone), the check runs in the tab as before, and a page whose check crashed is not loaded again (page-check-guard).

import { pathCrashedBefore } from './page-check-guard.js';

const CHANNEL = 'fg-check';
const BEAT_STALE_MS = 3000;

let _ch: BroadcastChannel | null = null;
let _lastBeat = 0;
let _onFrame: ((d: any, id: number) => void) | null = null;
let _loadId = 0;

function _channel(): BroadcastChannel | null {
    if (_ch) return _ch;
    if (typeof BroadcastChannel === 'undefined') return null;
    _ch = new BroadcastChannel(CHANNEL);
    _ch.onmessage = (e: MessageEvent) => {
        const d = e.data || {};
        if (d.kind === 'beat' || d.kind === 'hello') _lastBeat = Date.now();
        else if (d.kind === 'from-frame' && d.id === _loadId) _onFrame?.(d.data, d.id);
    };
    return _ch;
}

export function checkIsolationMode(): 'auto' | 'always' | 'off' {
    try { const v = localStorage.getItem('fg_check_isolation'); return v === 'always' || v === 'off' ? v : 'auto'; } catch { return 'auto'; }
}

/** Whether this check should try the separate window. */
export function wantsCheckWindow(path: string): boolean {
    const m = checkIsolationMode();
    return m === 'always' || (m === 'auto' && pathCrashedBefore(path));
}

/** The window answered within the last few seconds. */
export const checkWindowAlive = (): boolean => Date.now() - _lastBeat < BEAT_STALE_MS;

async function _ping(ms: number): Promise<boolean> {
    const ch = _channel(); if (!ch) return false;
    if (checkWindowAlive()) return true;
    ch.postMessage({ kind: 'ping' });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { await new Promise(r => setTimeout(r, 50)); if (checkWindowAlive()) return true; }
    return false;
}

let _declinedAt = 0;

// One bar, one button: the click is the user activation the browser asks for before it lets a page open a window.
function _askToOpen(): Promise<boolean> {
    return new Promise(resolve => {
        const bar = document.createElement('div');
        bar.id = 'fg-check-window-bar';
        bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:10px;z-index:2147483100;background:#222;color:#fff;border-radius:8px;padding:10px 14px;'
            + 'font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center;max-width:92vw';
        const msg = document.createElement('span');
        msg.textContent = 'A page being checked crashed the browser before. Run its checks in a separate window so the chats stay safe?';
        const yes = document.createElement('button'); yes.textContent = 'Open check window';
        const no = document.createElement('button'); no.textContent = 'Not now';
        for (const b of [yes, no]) b.style.cssText = 'cursor:pointer;border:0;border-radius:5px;padding:5px 10px;font:inherit;background:#4c8dff;color:#fff';
        no.style.background = '#555';
        bar.append(msg, yes, no);
        let done = false;
        const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(timer); bar.remove(); resolve(v); };
        yes.onclick = () => {
            let w: Window | null = null;
            try { w = window.open(new URL('fg-check-window.html', document.baseURI).href, '_blank', 'noopener,popup,width=520,height=420'); } catch {}
            finish(true);
            void w;   // noopener: the handle is always null; the window says hello over the channel
        };
        no.onclick = () => finish(false);
        const timer = setTimeout(() => finish(false), 25000);   // nobody there (an unattended run): the check goes on in the tab
        document.body.appendChild(bar);
    });
}

/** The separate window, opened if need be (asking once); null when it is not available and the check must run in the tab. */
export async function ensureCheckWindow(): Promise<boolean> {
    if (!_channel()) return false;
    if (await _ping(1000)) return true;
    if (Date.now() - _declinedAt < 10 * 60_000) return false;   // asked recently and refused or ignored
    const asked = await _askToOpen();
    if (!asked) { _declinedAt = Date.now(); return false; }
    if (await _ping(4000)) return true;
    _declinedAt = Date.now();   // blocked
    return false;
}

export interface CheckWindowSession {
    send(data: any): void;
    close(): void;
}

/** Load `content` in the window; `onFrame` gets each message the page's check script posts. */
export function loadInCheckWindow(path: string, content: string, onFrame: (d: any) => void): CheckWindowSession {
    const ch = _channel()!;
    const id = ++_loadId;
    _onFrame = onFrame;
    ch.postMessage({ kind: 'load', id, path, content });
    return {
        send: data => ch.postMessage({ kind: 'to-frame', id, data }),
        close: () => { _onFrame = null; ch.postMessage({ kind: 'unload', id }); },
    };
}
