// Tests for detectors.ts — the loop-health detector module shared by runTurn and
// runWorkerTurn. _updateStuckDetector has behavioral coverage in
// loop-protocol.test.js; this file covers the module directly, headlined by
// _checkTextResponse (the runaway gate — previously untested despite catching the
// v0.10 陪着 repetition loops) and the fingerprint helpers.
import { describe, it, expect } from 'vitest';

describe('_checkTextResponse — runaway/quality gate', () => {
    it('flags >80% single-character repetition (the 陪着 loop signature)', () => {
        const r = window._checkTextResponse('陪着'.repeat(200), 3, 60);
        expect(r?.action).toBe('runaway');
        expect(r.truncated.length).toBeLessThanOrEqual(100);
    });
    it('does not flag indented code (whitespace excluded from the frequency count)', () => {
        const code = '    const x = 1;\n    const y = 2;\n'.repeat(10);
        expect(window._checkTextResponse(code, 3, 60)).toBeNull();
    });
    it('flags a >30k-char response with no tool calls', () => {
        const r = window._checkTextResponse('word '.repeat(7000), 3, 60);
        expect(r?.action).toBe('runaway');
        expect(r.truncated).toMatch(/truncated: response was/);
    });
    // The anti-narration gate was reverted with the rest of the v0.20/v0.21 enforcement
    // changes (31db758, "Revert ... to v0.18 harness baseline"). _checkTextResponse is now
    // only a runaway/low-entropy gate; narration without a tool call is caught downstream by
    // missing_state_line in _STEP_CHECKS (see tests/runTurn.test.ts, autonomous mode).
    it('no longer flags plain narration — that gate was deliberately reverted', () => {
        expect(window._checkTextResponse('Let me read the config file to check the settings.', 3, 60)).toBeNull();
    });
    it('never fires on the final step (caller falls through to terminal handling)', () => {
        expect(window._checkTextResponse('陪着'.repeat(200), 59, 60)).toBeNull();
    });
    it('returns runaway on first and second consecutive bad response', () => {
        const state = { count: 0 };
        const r1 = window._checkTextResponse('陪着'.repeat(200), 3, 60, state);
        expect(r1?.action).toBe('runaway');
        expect(state.count).toBe(1);
        const r2 = window._checkTextResponse('陪着'.repeat(200), 4, 60, state);
        expect(r2?.action).toBe('runaway');
        expect(state.count).toBe(2);
    });
    it('escalates to bail on the third consecutive bad response', () => {
        const state = { count: 2 };  // already seen 2 consecutive runaways
        const r = window._checkTextResponse('陪着'.repeat(200), 5, 60, state);
        expect(r?.action).toBe('bail');
        expect(state.count).toBe(3);
    });
    it('resets the counter after a clean response', () => {
        const state = { count: 2 };
        window._checkTextResponse('A clean response with a tool call result.', 5, 60, state);
        expect(state.count).toBe(0);
    });
    it('garbledState defaults to a fresh counter (no shared state between calls)', () => {
        // Each call without a garbledState arg gets its own ephemeral counter — stays 'runaway'
        const r = window._checkTextResponse('陪着'.repeat(200), 3, 60);
        expect(r?.action).toBe('runaway');
    });
});

describe('_fpTrunc — signature fingerprinting', () => {
    const fp = s => JSON.stringify({ v: s }, window._fpTrunc);
    it('passes short strings through verbatim', () => {
        expect(fp('short')).toContain('short');
    });
    it('collapses long strings but distinguishes ANY single-char difference', () => {
        const base = 'x'.repeat(600);
        const midDiff = base.slice(0, 300) + 'Y' + base.slice(301);
        const tailDiff = base.slice(0, 599) + 'Z';
        expect(fp(base)).not.toBe(fp(midDiff));
        expect(fp(base)).not.toBe(fp(tailDiff));
        expect(fp(base)).toBe(fp('x'.repeat(600)));  // identical stays identical
        expect(fp(base).length).toBeLessThan(base.length); // actually collapsed
    });
});

describe('_updateStuckDetector — worker-local seen maps', () => {
    it('evicts only stalled paths from the passed-in maps on a 3x repeat', () => {
        const seen = { rf: new Map([['a.txt:1:9', 'full'], ['b.txt::', 'full']]), lf: new Set(['a.txt']) };
        let hashes = [];
        let msg = null;
        for (let i = 0; i < 3; i++)
            ({ resultHashes: hashes, stuckMsg: msg } = window._updateStuckDetector('SIG', new Set(['a.txt']), hashes, seen));
        expect(msg).toBeTruthy();
        expect(seen.rf.has('a.txt:1:9')).toBe(false); // stalled path evicted
        expect(seen.rf.has('b.txt::')).toBe(true);    // unrelated path kept
    });
});
