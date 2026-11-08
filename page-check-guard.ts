// page-check-guard.ts — FreeGent: a tool call that takes the browser tab down, check_page above all.
//
// check_page runs the page in an iframe of the app's own tab, and WebKit runs that frame in the app's process: a page that hangs or
// runs out of memory crashes the tab with it. The tab came back with the task's chat empty and nothing logged (the chat was saved only
// when a turn ended, the task log is sent when the task ends), and the next run loaded the same page and crashed again. While a check
// runs, sessionStorage (kept across this tab's reload, as runner.ts's run state is) holds what the check was doing: the page, how far
// it got, the page's last console lines and a heartbeat, which stops when a hung page freezes the tab. A normal unload clears it.
// Found at start-up, it means the tab died during that check: the crash is recorded, the agent is told on its next turn, and
// check_page refuses that same content.
// Every other tool call is marked the same way (what ran, since when): Python or `node -e` in the browser shell runs on the sandbox
// frame's own thread, which WebKit shares with the app, so an endless loop there freezes the tab as a page does, and a run that uses
// ever more memory can take it down anywhere. Such a crash is logged and the agent told what was running and for how long.
import { hashContent } from './local-sync.js';
import { SESSION_ID, redactForLog } from './dev-log.js';
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
    runner?: boolean;   // an Autopilot / task run was going (its next task turn is told, whatever chat it is in)
    told?: boolean;     // the agent has been told
}

const _isRunner = (): boolean => { try { return !!(globalThis as any).isRunnerRunning?.(); } catch { return false; } };
let _cur: PageCheckCrash | null = null;
let _beat: ReturnType<typeof setInterval> | null = null;
function _write(): void { try { if (_cur) sessionStorage.setItem(RUNNING, JSON.stringify(_cur)); } catch {} }
// One heartbeat while anything is marked: it stops when a hung call freezes the app.
function _tick(): void {
    const now = Date.now();
    if (_cur) { _cur.beat = now; _write(); }
    if (_calls.size) _writeCalls(now);
    if (!_cur && !_calls.size && _beat) { clearInterval(_beat); _beat = null; }
}
function _startBeat(): void { if (!_beat) _beat = setInterval(_tick, 500); }

/** `content` is what the check runs: the page with its workspace files inlined and the check's own steps (tabs.ts pageCheckContent). */
export function beginPageCheck(path: string, content: string, chatId: string | null): void {
    const now = Date.now();
    _cur = { path, hash: hashContent(content), chatId, session: SESSION_ID, version: FG_VERSION, t: now, beat: now,
             stage: 'while the page loaded (its start-up scripts were running)', lines: [], runner: _isRunner() };
    _write();
    _startBeat();
}

/** What the check is doing now, and/or one console line from the page. */
export function notePageCheck({ stage, line }: { stage?: string; line?: string }): void {
    if (!_cur) return;
    if (stage) _cur.stage = stage;
    // Redacted now: after a reload a locked key vault no longer gives the values to redact them with.
    if (line) _cur.lines = [..._cur.lines, redactForLog(String(line).slice(0, 400)).slice(0, 200)].slice(-LINES);
    _cur.beat = Date.now();
    _write();
}

export function endPageCheck(): void {
    _cur = null;
    try { sessionStorage.removeItem(RUNNING); } catch {}
}

function _crashed(): PageCheckCrash[] {
    try { const v = JSON.parse(localStorage.getItem(CRASHED) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function _save(list: PageCheckCrash[]): void { try { localStorage.setItem(CRASHED, JSON.stringify(list.slice(-KEEP))); } catch {} }

/** The recorded crash of this very check of `path` (same content, as beginPageCheck takes it), if there is one. */
export function crashedBefore(path: string, content: string): PageCheckCrash | null {
    const h = hashContent(content);
    return _crashed().find(c => c.path === path && c.hash === h) ?? null;
}

/** A check that took its separate check window down (the tab and the chats lived): recorded like a tab crash, so the unchanged page is not loaded again. */
export function recordIsolatedPageCrash(path: string, content: string, info: { chatId: string | null; t: number; beat: number; stage: string; lines: string[] }): PageCheckCrash {
    const m: PageCheckCrash = { path, hash: hashContent(content), chatId: info.chatId, session: SESSION_ID, version: FG_VERSION, t: info.t, beat: info.beat, stage: info.stage,
        lines: info.lines.slice(-LINES), runner: _isRunner(), told: true };   // told: the check's own answer carries it
    _save([..._crashed().filter(c => !(c.path === path && c.hash === m.hash)), m]);
    return m;
}

/** Whether any check of this page (whatever its content then) is known to have crashed. */
export function pathCrashedBefore(path: string): boolean { return _crashed().some(c => c.path === path); }

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
        + 'strings or DOM that keep growing. Fix it before running check_page on this page again: the unchanged page (with the same scripts, styles and check steps) is not loaded again.';
}

// ── Every tool call ────────────────────────────────────────────────────────
const TOOLS_RUNNING = 'fg_tools_running';
const TOOL_CRASHES = 'fg_tool_crashes';

export interface ToolCallMark { name: string; label: string; t: number; sig?: string; ws?: number; }
export interface ToolCrash { calls: ToolCallMark[]; chatId: string | null; session: string; version: string; beat: number; runner?: boolean; told?: boolean; }

const _calls = new Map<number, ToolCallMark>();
let _seq = 0;
let _callsChat: string | null = null;
let _callsRunner = false;
function _writeCalls(beat = Date.now()): void {
    try {
        if (!_calls.size) { sessionStorage.removeItem(TOOLS_RUNNING); return; }
        const m: ToolCrash = { calls: [..._calls.values()], chatId: _callsChat, session: SESSION_ID, version: FG_VERSION, beat, runner: _callsRunner };
        sessionStorage.setItem(TOOLS_RUNNING, JSON.stringify(m));
    } catch {}
}

/** Mark a tool call as running (until endToolCall with the returned id). `label` says what it runs. */
export function beginToolCall(name: string, label: string, chatId: string | null, same?: { sig: string; ws: number }): number {
    const id = ++_seq;
    _calls.set(id, { name, label: redactForLog(String(label).slice(0, 400)).slice(0, 200), t: Date.now(), ...(same ? { sig: same.sig, ws: same.ws } : {}) });
    _callsChat = chatId;
    _callsRunner = _isRunner();
    _writeCalls();
    _startBeat();
    return id;
}
/** Say which step a running call is in (a task's completion gates take a minute or more); a crash report then names it. */
export function noteToolStage(name: string, stage: string): void {
    let changed = false;
    for (const c of _calls.values()) if (c.name === name) { c.label = `${c.label.replace(/ \[[^\]]*\]$/, '')} [${stage}]`; changed = true; }
    if (changed) _writeCalls();
}
export function endToolCall(id: number): void { if (_calls.delete(id)) _writeCalls(); }

/** At start-up: the tool calls this tab was running when it died, recorded for the agent (marker cleared); null when none.
 *  A check_page call reported by takePageCheckCrash (which says more) is left out. */
export function takeToolCrash(pageCheck: PageCheckCrash | null = null): ToolCrash | null {
    let m: ToolCrash | null = null;
    try { m = JSON.parse(sessionStorage.getItem(TOOLS_RUNNING) || 'null'); } catch {}
    try { sessionStorage.removeItem(TOOLS_RUNNING); } catch {}
    if (!m || !Array.isArray(m.calls)) return null;
    const calls = m.calls.filter(c => c && typeof c.name === 'string' && !(pageCheck && c.name === 'check_page'));
    if (!calls.length) return null;
    const crash: ToolCrash = { ...m, calls, beat: Number(m.beat) || Math.max(...calls.map(c => c.t)), told: false };
    try {
        const list: ToolCrash[] = JSON.parse(localStorage.getItem(TOOL_CRASHES) || '[]');
        localStorage.setItem(TOOL_CRASHES, JSON.stringify([...(Array.isArray(list) ? list : []), crash].slice(-KEEP)));
    } catch {}
    return crash;
}

/** A budget for recoveries the app starts by itself after a crash: true (and counted) while fewer than `max` were made in the last hour under this key. */
export function spendAutoRecovery(key: string, max = 3, windowMs = 3_600_000): boolean {
    try {
        const now = Date.now();
        const list = (JSON.parse(localStorage.getItem(key) || '[]') as number[]).filter(t => now - t < windowMs);
        if (list.length >= max) return false;
        localStorage.setItem(key, JSON.stringify([...list, now]));
        return true;
    } catch { return false; }
}

/** True at start-up when the tab that died had a tool call or a page check running (the markers are cleared by a reload or navigation, so they mean a crash or a kill). Read before
 *  takePageCheckCrash / takeToolCrash, which consume them. */
export function tabDiedInToolCall(): boolean {
    try { return !!(sessionStorage.getItem(TOOLS_RUNNING) || sessionStorage.getItem(RUNNING)); } catch { return false; }
}

/** The signature of a call: its tool and arguments. Two calls with the same one are the same command. */
export const toolSig = (name: string, args: unknown): string => hashContent(`${name}\u0000${JSON.stringify(args ?? null)}`);

/** A recorded tab crash in a call with this signature, made when the workspace was in the same state (`ws`: its newest file time), or null.
 *  The same command on files that have changed since is a new attempt; on files that have not, it is the crash again (kanbanflow logs: the same
 *  `node test_imports.mjs && …` took the tab down four times in four minutes after the note said not to run it unchanged). */
export function sameCallCrashed(sig: string, ws: number): { at: number; seconds: number } | null {
    try {
        const list = JSON.parse(localStorage.getItem(TOOL_CRASHES) || '[]') as ToolCrash[];
        for (const c of [...list].reverse()) for (const x of c.calls || []) if (x.sig === sig && x.ws === ws) return { at: x.t, seconds: Math.round(((c.beat || x.t) - x.t) / 1000) };
    } catch {}
    return null;
}

/** How many recorded tab crashes were in a tool call whose label contains `part` (e.g. "task:138-x.md → done [gate test-runner]"). */
export function toolCrashCount(part: string): number {
    try { return (JSON.parse(localStorage.getItem(TOOL_CRASHES) || '[]') as ToolCrash[]).filter(c => c.calls?.some(x => String(x.label).includes(part))).length; } catch { return 0; }
}

export function describeToolCrash(c: ToolCrash): string {
    const at = Math.min(...c.calls.map(x => x.t));
    const calls = c.calls.map(x => `  ${x.label} — running for ${Math.max(0, Math.round((c.beat - x.t) / 100) / 10)} s when the app last responded`).join('\n');
    return `The browser tab crashed or was killed while ${c.calls.length === 1 ? 'this tool call was' : 'these tool calls were'} running (${new Date(at).toISOString().slice(0, 16)}Z):\n${calls}\n`
        + `${c.calls.length === 1 ? 'Its result' : 'Their results'} never came back, and the step is not in the chat. A run that never ends (an endless loop, `
        + 'a wait for input that never comes) or uses ever more memory is the usual cause. Do not run it again unchanged: bound the loop, '
        + 'or work on the data in smaller pieces.';
}

/** Crashes the agent of this turn has not been told about, as one note (marked told), or ''. A crash belongs to the chat it happened in;
 *  one during an Autopilot / task run also to the run's next task turn, which is in a new chat. Another chat's turn is not told. */
export function takeCrashNote({ chatId = null as string | null, runner = false } = {}): string {
    const mine = (c: { chatId: string | null; runner?: boolean; told?: boolean }) => !c.told && (!c.chatId || c.chatId === chatId || (!!c.runner && runner));
    const list = _crashed();
    const fresh = list.filter(mine);
    if (fresh.length) _save(list.map(c => mine(c) ? { ...c, told: true } : c));
    let tools: ToolCrash[] = [];
    try { const v = JSON.parse(localStorage.getItem(TOOL_CRASHES) || '[]'); if (Array.isArray(v)) tools = v; } catch {}
    const freshTools = tools.filter(mine);
    if (freshTools.length) { try { localStorage.setItem(TOOL_CRASHES, JSON.stringify(tools.map(c => mine(c) ? { ...c, told: true } : c))); } catch {} }
    return [...fresh.map(describePageCheckCrash), ...freshTools.map(describeToolCrash)].join('\n\n');
}

// A reload, navigation or closed tab is not a crash.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => {
    endPageCheck();
    _calls.clear();
    try { sessionStorage.removeItem(TOOLS_RUNNING); } catch {}
});
