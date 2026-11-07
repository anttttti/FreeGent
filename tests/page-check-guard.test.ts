// A page that crashed the tab under check_page (page-check-guard.ts): recorded at the next start-up, and that same content is refused
// instead of crashing the tab again; a normal unload is not a crash.
import { describe, it, expect, beforeEach } from 'vitest';
import { beginPageCheck, endPageCheck, notePageCheck, takePageCheckCrash, crashedBefore, takeCrashNote, beginToolCall, endToolCall, takeToolCrash } from '../page-check-guard.ts';
import '../tabs.ts';

const W = window as any;

describe('check_page crash guard', () => {
    beforeEach(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.clear(); localStorage.clear(); });   // pagehide: a fresh page holds no calls

    it('a check the tab died in is recorded once, for that content only', () => {
        beginPageCheck('game/index.html', '<p>v1</p>', 'chat-1');
        const c = takePageCheckCrash();
        expect(c).toMatchObject({ path: 'game/index.html', chatId: 'chat-1' });
        expect(takePageCheckCrash()).toBeNull();
        expect(crashedBefore('game/index.html', '<p>v1</p>')).not.toBeNull();
        expect(crashedBefore('game/index.html', '<p>v2</p>')).toBeNull();
        expect(crashedBefore('other.html', '<p>v1</p>')).toBeNull();
    });

    it('the agent is told once what the check was doing, when the app stopped answering and what the page logged', () => {
        const t0 = Date.now();
        beginPageCheck('index.html', 'x', 'chat-1');
        notePageCheck({ line: 'log: level 1 built' });
        notePageCheck({ line: 'error: Uncaught RangeError: Maximum call stack size exceeded' });
        notePageCheck({ stage: 'during the action {"click":"#start"}' });
        const marker = JSON.parse(sessionStorage.getItem('fg_check_page_running')!);
        sessionStorage.setItem('fg_check_page_running', JSON.stringify({ ...marker, t: t0, beat: t0 + 2300 }));
        takePageCheckCrash();
        expect(takeCrashNote({ chatId: 'other-chat' })).toBe('');   // another chat's turn is not told
        const note = takeCrashNote({ chatId: 'chat-1' });
        expect(note).toContain('2.3 s after the page started loading, during the action {"click":"#start"}');
        expect(note).toContain('log: level 1 built');
        expect(note).toContain('Maximum call stack size exceeded');
        expect(takeCrashNote({ chatId: 'chat-1' })).toBe('');
    });

    it('any tool call the tab died in is reported once, with what ran and for how long; a finished call is not', () => {
        const t0 = Date.now();
        const done = beginToolCall('read_file', 'read:a.txt', 'chat-2');
        beginToolCall('execute_code', 'exec(python): while True: pass', 'chat-2');
        endToolCall(done);
        const m = JSON.parse(sessionStorage.getItem('fg_tools_running')!);
        sessionStorage.setItem('fg_tools_running', JSON.stringify({ ...m, calls: m.calls.map((c: any) => ({ ...c, t: t0 })), beat: t0 + 12300 }));
        const c = takeToolCrash();
        expect(c!.calls.map(x => x.name)).toEqual(['execute_code']);
        expect(c!.chatId).toBe('chat-2');
        expect(takeToolCrash()).toBeNull();
        const note = takeCrashNote({ chatId: 'chat-2' });
        expect(note).toContain('exec(python): while True: pass — running for 12.3 s when the app last responded');
        expect(takeCrashNote({ chatId: 'chat-2' })).toBe('');
    });

    it('a crash during an Autopilot run is told to its next task turn, which is in a new chat', () => {
        const prev = (globalThis as any).isRunnerRunning;
        try {
            (globalThis as any).isRunnerRunning = () => true;
            beginToolCall('execute_code', 'exec(python): big()', 'task-chat-1');
            takeToolCrash();
            expect(takeCrashNote({ chatId: 'my-chat', runner: false })).toBe('');
            expect(takeCrashNote({ chatId: 'task-chat-2', runner: true })).toContain('exec(python): big()');
        } finally { (globalThis as any).isRunnerRunning = prev; }
    });

    it('a check_page crash is reported by its own record, not again as a tool call', () => {
        beginToolCall('check_page', 'check:index.html', null);
        beginPageCheck('index.html', 'x', null);
        const page = takePageCheckCrash();
        expect(takeToolCrash(page)).toBeNull();
    });

    it('a finished check or a normal unload leaves nothing', () => {
        beginPageCheck('index.html', 'x', null);
        endPageCheck();
        expect(takePageCheckCrash()).toBeNull();
        beginPageCheck('index.html', 'x', null);
        beginToolCall('execute_code', 'exec(python)', null);
        window.dispatchEvent(new Event('pagehide'));
        expect(takePageCheckCrash()).toBeNull();
        expect(takeToolCrash()).toBeNull();
    });

    it('runPageCheck refuses the content that crashed before saving or loading anything', async () => {
        const prev = { read: W.agentReadFile, save: W.saveHistory };
        let saved = 0;
        try {
            W.agentReadFile = async () => '<html><body><script>for(;;){}</script></body></html>';
            W.saveHistory = () => { saved++; };
            beginPageCheck('index.html', await W.agentReadFile(), null);
            takePageCheckCrash();
            const r = await W.runPageCheck('index.html');
            expect(r.error).toMatch(/crashed or was killed while check_page ran "index.html"[\s\S]*not loaded again/);
            expect(saved).toBe(0);
        } finally { W.agentReadFile = prev.read; W.saveHistory = prev.save; }
    });
});
