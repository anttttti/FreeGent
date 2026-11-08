import { describe, it, expect, beforeEach } from 'vitest';
import { wantsCheckWindow, checkIsolationMode } from '../check-window.ts';
import { recordIsolatedPageCrash, pathCrashedBefore, crashedBefore } from '../page-check-guard.ts';

// A page that took the tab down is checked in the separate window next time (when there is one); the others stay in the tab.
describe('when check_page uses the separate window', () => {
    beforeEach(() => localStorage.clear());
    it('auto: only a page whose check crashed before; always and off as set', () => {
        expect(checkIsolationMode()).toBe('auto');
        expect(wantsCheckWindow('index.html')).toBe(false);
        recordIsolatedPageCrash('index.html', 'fingerprint-1', { chatId: null, t: 1, beat: 2, stage: 's', lines: [] });
        expect(wantsCheckWindow('index.html')).toBe(true);
        expect(wantsCheckWindow('other.html')).toBe(false);
        localStorage.setItem('fg_check_isolation', 'always'); expect(wantsCheckWindow('other.html')).toBe(true);
        localStorage.setItem('fg_check_isolation', 'off'); expect(wantsCheckWindow('index.html')).toBe(false);
    });
    it('a check that took the window down is not repeated on the same page content, and is on a changed one', () => {
        recordIsolatedPageCrash('index.html', 'fingerprint-1', { chatId: null, t: 1, beat: 2, stage: 's', lines: ['error: x'] });
        expect(pathCrashedBefore('index.html')).toBe(true);
        expect(crashedBefore('index.html', 'fingerprint-1')?.lines).toEqual(['error: x']);
        expect(crashedBefore('index.html', 'fingerprint-2')).toBeNull();
    });
});
