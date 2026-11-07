// A page that crashed the tab under check_page (page-check-guard.ts): recorded at the next start-up, and that same content is refused
// instead of crashing the tab again; a normal unload is not a crash.
import { describe, it, expect, beforeEach } from 'vitest';
import { beginPageCheck, endPageCheck, notePageCheck, takePageCheckCrash, crashedBefore, takePageCheckCrashNote } from '../page-check-guard.ts';
import '../tabs.ts';

const W = window as any;

describe('check_page crash guard', () => {
    beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

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
        const note = takePageCheckCrashNote();
        expect(note).toContain('2.3 s after the page started loading, during the action {"click":"#start"}');
        expect(note).toContain('log: level 1 built');
        expect(note).toContain('Maximum call stack size exceeded');
        expect(takePageCheckCrashNote()).toBe('');
    });

    it('a finished check or a normal unload leaves nothing', () => {
        beginPageCheck('index.html', 'x', null);
        endPageCheck();
        expect(takePageCheckCrash()).toBeNull();
        beginPageCheck('index.html', 'x', null);
        window.dispatchEvent(new Event('pagehide'));
        expect(takePageCheckCrash()).toBeNull();
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
