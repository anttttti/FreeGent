// Review 2026-10-14: (1) a local server that stays down is reported after a bounded wait, not retried
// until the task's wall clock ends; (2) a cloud endpoint that refuses with HTTP 403 repeatedly is
// skipped for a long while when there is somewhere to go.
import { _makeOAIRetryHandler, SAME_ENDPOINT_WAIT_LIMIT_MS } from '../retry.ts';
import { REFUSAL_LIMIT, _isCoolingDown, recordSuccess, getCooldownRemaining } from '../model-router.ts';

function handler(ep: any, extra: any = {}) {
    let cur = ep;
    const notes: string[] = [];
    const h = _makeOAIRetryHandler({
        getEp: () => cur, setEp: (e: any) => { cur = e; }, onNote: (n: string) => notes.push(n), ...extra,
    });
    return { h, notes, ep: () => cur };
}
const err = (m: string) => Object.assign(new Error(m), {});

describe('local endpoint with nothing to rotate to', () => {
    it('stops retrying after the wait limit', () => {
        const { h, notes } = handler({ provider: 'vllm', model: 'm-bounds', url: 'http://x/v1' });
        let waited = 0, n = 0, out: any = 0;
        for (; n < 1000; n++) {
            out = h(n, err('HTTP 500: engine dead'), 5000);
            if (out === false) break;
            waited += out;
        }
        expect(out).toBe(false);
        expect(waited).toBeLessThanOrEqual(SAME_ENDPOINT_WAIT_LIMIT_MS);
        expect(waited).toBeGreaterThan(SAME_ENDPOINT_WAIT_LIMIT_MS / 2);
        expect(notes.at(-1)).toMatch(/giving up/);
    });
});

describe('repeated HTTP 403 from a cloud endpoint', () => {
    const KEY = 'tokenharbor|haiku-x';
    beforeEach(() => {
        (window as any).getActiveMainModelList = () => [KEY, 'openrouter|other-x'];
    });
    afterEach(() => { delete (window as any).getActiveMainModelList; });

    it('is skipped for a long cooldown after REFUSAL_LIMIT answers, and rotated away from', () => {
        const ep = { provider: 'tokenharbor', model: 'haiku-x' };
        const { h, notes, ep: cur } = handler(ep);
        let last: any;
        // the loop comes back to this endpoint each time its short cooldown ends
        for (let i = 0; i < REFUSAL_LIMIT; i++) { cur().provider = 'tokenharbor'; cur().model = 'haiku-x'; last = h(i, err('HTTP 403: request refused, contact support'), 1000); }
        expect(notes.join('\n')).toMatch(/refused \d+ times/);
        expect(last).toBe(0);
        expect(cur().model).toBe('other-x');
        expect(getCooldownRemaining(KEY)).toBeGreaterThan(25 * 60);
    });

    it('a success clears the count', () => {
        const ep = { provider: 'tokenharbor', model: 'haiku-y' };
        (window as any).getActiveMainModelList = () => ['tokenharbor|haiku-y', 'openrouter|other-y'];
        const notes: string[] = [];
        // the endpoint is always the one under test: rotation targets are taken, the loop returns here
        const h = _makeOAIRetryHandler({ getEp: () => ep, setEp: () => {}, onNote: (n: string) => notes.push(n) });
        for (let i = 0; i < REFUSAL_LIMIT - 1; i++) h(i, err('HTTP 403: refused'), 1000);
        recordSuccess(ep);
        h(9, err('HTTP 403: refused'), 1000);
        expect(notes.some(n => /refused \d+ times/.test(n))).toBe(false);
        expect(getCooldownRemaining('tokenharbor|haiku-y')).toBeLessThan(10 * 60);
        h(10, err('HTTP 403: refused'), 1000);
        h(11, err('HTTP 403: refused'), 1000);
        expect(notes.some(n => /refused \d+ times/.test(n))).toBe(true);
    });
});
