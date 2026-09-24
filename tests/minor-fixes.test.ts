// minor-fixes.test.ts — turn-protocol guards use the configured step limit; the "User's device"
// prompt section is omitted when there is no real screen (headless / JSDOM).
import { describe, it, expect, afterEach } from 'vitest';
import { _handleTurnState } from '../turn-protocol.ts';
import { _buildDeviceContext } from '../system-prompt.ts';

const adapter = () => ({ pushNudge: () => {}, spliceFromSecondLast: () => {}, histLen: () => 2 });

describe('turn protocol step limit', () => {
    afterEach(() => localStorage.clear());
    it('does not bounce an empty COMPLETED on the configured last step', async () => {
        localStorage.setItem('fg_agent_max_rounds', '5');
        const ps = { finalCheck: 0, cont: 0, saved: null, substCheck: 0, checkFires: {} };
        const last = await _handleTurnState('COMPLETED', 4, ps, adapter());   // step 4 of 5
        expect(last.kind).toBe('return');
        const early = await _handleTurnState('COMPLETED', 1, { ...ps }, adapter());
        expect(early.kind).toBe('continue');
    });
});

describe('device context', () => {
    it('is omitted without a real screen', () => {
        const mm = (window as any).matchMedia;
        (window as any).matchMedia = () => ({ matches: false });   // reach the screen check
        try {
        expect(screen.width).toBe(0);           // JSDOM
        expect(_buildDeviceContext()).toBe('');
        } finally { (window as any).matchMedia = mm; }
    });
    it('is included when the screen has a size', () => {
        const w = Object.getOwnPropertyDescriptor(screen, 'width'), h = Object.getOwnPropertyDescriptor(screen, 'height');
        Object.defineProperty(screen, 'width', { value: 1920, configurable: true });
        Object.defineProperty(screen, 'height', { value: 1080, configurable: true });
        const mm = (window as any).matchMedia;
        (window as any).matchMedia = () => ({ matches: false });   // JSDOM has no matchMedia
        try { expect(_buildDeviceContext()).toContain("## User's device"); }
        finally {
            (window as any).matchMedia = mm;
            if (w) Object.defineProperty(screen, 'width', w); else delete (screen as any).width;
            if (h) Object.defineProperty(screen, 'height', h); else delete (screen as any).height;
        }
    });
});
