// page-check-guard.ts — FreeGent: a page that takes the browser tab down under check_page.
//
// check_page runs the page in an iframe of the app's own tab, and WebKit runs that frame in the app's process: a page that hangs or
// runs out of memory crashes the tab with it. The tab came back with the task's chat empty and nothing logged (the chat was saved only
// when a turn ended, the task log is sent when the task ends), and the next run loaded the same page and crashed again. While a check
// runs, sessionStorage (kept across this tab's reload, as runner.ts's run state is) holds what the check was doing: the page, how far
// it got, the page's last console lines and a heartbeat, which stops when a hung page freezes the tab. A normal unload clears it.
// Found at start-up, it means the tab died during that check: the crash is recorded, the agent is told on its next turn, and
// check_page refuses that same content.
import { hashContent } from './local-sync.js';
import { SESSION_ID } from './dev-log.js';
import { FG_VERSION } from './build-info.js';

const RUNNING = 'fg_check_page_running';
const CRASHED = 'fg_check_page_crashed';
const KEEP = 20;
const LINES = 8;

export interface PageCheckCrash {
    path: string; hash: string; chatId: string | null; session: string; version: string;
    t: number;          // when the check started loading the page
    beat: number;       // the app's last heartbeat during the check
    stage: string;      // what the check was doing then
    lines: string[];    // the page's last console lines / errors
    told?: boolean;     // the agent has been told
}

let _cur: PageCheckCrash | null = null;
let _beat: ReturnType<typeof setInterval> | null = null;
function _write(): void { try { if (_cur) sessionStorage.setItem(RUNNING, JSON.stringify(_cur)); } catch {} }

export function beginPageCheck(path: string, html: string, chatId: string | null): void {
    const now = Date.now();
    _cur = { path, hash: hashContent(html), chatId, session: SESSION_ID, version: FG_VERSION, t: now, beat: now,
             stage: 'while the page loaded (its start-up scripts were running)', lines: [] };
    _write();
    if (_beat) clearInterval(_beat);
    _beat = setInterval(() => { if (_cur) { _cur.beat = Date.now(); _write(); } }, 500);
}

/** What the check is doing now, and/or one console line from the page. */
export function notePageCheck({ stage, line }: { stage?: string; line?: string }): void {
    if (!_cur) return;
    if (stage) _cur.stage = stage;
    if (line) _cur.lines = [..._cur.lines, String(line).slice(0, 200)].slice(-LINES);
    _cur.beat = Date.now();
    _write();
}

export function endPageCheck(): void {
    if (_beat) { clearInterval(_beat); _beat = null; }
    _cur = null;
    try { sessionStorage.removeItem(RUNNING); } catch {}
}

function _crashed(): PageCheckCrash[] {
    try { const v = JSON.parse(localStorage.getItem(CRASHED) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function _save(list: PageCheckCrash[]): void { try { localStorage.setItem(CRASHED, JSON.stringify(list.slice(-KEEP))); } catch {} }

/** The recorded crash of this very content of `path`, if there is one. */
export function crashedBefore(path: string, html: string): PageCheckCrash | null {
    const h = hashContent(html);
    return _crashed().find(c => c.path === path && c.hash === h) ?? null;
}

/** At start-up: the check this tab was running when it died, recorded (and the marker cleared); null when there was none. */
export function takePageCheckCrash(): PageCheckCrash | null {
    let m: PageCheckCrash | null = null;
    try { m = JSON.parse(sessionStorage.getItem(RUNNING) || 'null'); } catch {}
    endPageCheck();
    if (!m || typeof m.path !== 'string' || typeof m.hash !== 'string') return null;
    m = { ...m, beat: Number(m.beat) || m.t, stage: String(m.stage || ''), lines: Array.isArray(m.lines) ? m.lines : [], told: false };
    _save([..._crashed().filter(c => !(c.path === m!.path && c.hash === m!.hash)), m]);
    return m;
}

/** What is known about a crash, for the agent and the log. */
export function describePageCheckCrash(c: PageCheckCrash): string {
    const secs = Math.max(0, Math.round(((c.beat || c.t) - c.t) / 100) / 10);
    const lines = c.lines?.length
        ? ` The page's last console output before that:\n${c.lines.map(l => `  ${l}`).join('\n')}`
        : ' The page wrote nothing to the console before that.';
    return `The browser tab crashed or was killed while check_page ran "${c.path}" (${new Date(c.t).toISOString().slice(0, 16)}Z). `
        + `The app's last sign of life was ${secs} s after the page started loading, ${c.stage}: a page that hangs freezes the app at that moment, `
        + `one that runs out of memory takes it down later.${lines}\n`
        + 'Look in the code that runs at that point for an endless loop or recursion, a loop whose exit never comes true, or arrays, '
        + 'strings or DOM that keep growing. Fix it before running check_page on this page again: the unchanged page is not loaded again.';
}

/** Crashes the agent has not been told about, as one note (marked told), or ''. */
export function takePageCheckCrashNote(): string {
    const list = _crashed();
    const fresh = list.filter(c => !c.told);
    if (!fresh.length) return '';
    _save(list.map(c => ({ ...c, told: true })));
    return fresh.map(describePageCheckCrash).join('\n\n');
}

// A reload, navigation or closed tab is not a crash.
if (typeof window !== 'undefined') window.addEventListener('pagehide', endPageCheck);
