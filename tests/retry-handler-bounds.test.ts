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

describe('a local endpoint that answers with a web page (opencode §44)', () => {
    it('is reported after CUSTOM_CLIENT_ERROR_ATTEMPTS answers, not retried for the whole wait limit', async () => {
        const { decodeOAIResponse } = await import('../stream-decode.ts');
        const resp: any = { headers: { get: () => 'text/html; charset=utf-8' }, json: async () => { throw new Error('Unexpected end of JSON input'); } };
        const e: any = await decodeOAIResponse(resp, () => {}).catch((x: any) => x);
        expect(e.message).toMatch(/answered with a web page/);
        (window as any).getActiveMainModelList = () => ['custom|m-html'];
        const { h, notes } = handler({ provider: 'custom', model: 'm-html', url: 'http://x/v1' });
        const outs = [0, 1, 2].map(n => h(n, e, 5000));
        expect(outs.slice(0, 2).every(o => o === 5000)).toBe(true);
        expect(outs[2]).toBe(false);
        expect(notes.at(-1)).toMatch(/not retrying/);
        delete (window as any).getActiveMainModelList;
    });
});

describe('429 from every model in the pool (retry-storm regression, self-analysis T10/T29)', () => {
    // A v0.71.29 session logged 5,149 failed requests with a median gap of 19 ms and 3,080 in one minute. At HEAD two models that
    // always answer 429 without a retry-after are switched once (a zero wait to the sibling is the rotation) and then waited out:
    // a zero wait is never followed by another zero, so the pool cannot ping-pong, and a simulated hour produces a handful of requests.
    it('never answers two 429s in a row with no wait, so requests per simulated hour are bounded', () => {
        (window as any).getActiveMainModelList = () => ['openrouter|rate-a', 'groq|rate-b'];
        try {
            const { h } = handler({ provider: 'openrouter', model: 'rate-a', url: 'http://x/v1' });
            let clock = 0, requests = 0, previous = 1;
            while (clock < 3_600_000 && requests < 20_000) {
                requests++;
                const wait = h(requests - 1, err('HTTP 429: Rate limit exceeded'), 1000);
                expect(typeof wait).toBe('number');
                expect(wait as number).toBeGreaterThanOrEqual(0);
                expect(previous === 0 && wait === 0, `two zero waits in a row at request ${requests}`).toBe(false);
                previous = wait as number;
                clock += wait as number;
            }
            expect(requests).toBeLessThan(200);          // a 19 ms loop would make 190,000 in the hour
        } finally { delete (window as any).getActiveMainModelList; }
    });
});

describe('HTTP 410 (a model that has reached its end of life)', () => {
    // Chat log b1fd2d32 (v0.96.52): "[nvidia|moonshotai/kimi-k3] HTTP 410: The model 'moonshotai/kimi-k3' has reached its end of life on 2026-10-15".
    // Only 401/404 were treated as "the model is gone"; 410 Gone is that by definition.
    it('is "gone" for a cloud provider (paused, rotated away from), not for a local server', async () => {
        const { isModelGone } = await import('../retry.ts');
        const msg = "[nvidia|moonshotai/kimi-k3] HTTP 410: The model 'moonshotai/kimi-k3' has reached its end of life on 2026-10-15";
        expect(isModelGone(err(msg), { provider: 'nvidia', model: 'moonshotai/kimi-k3' })).toBe(true);
        expect(isModelGone(err(msg), { provider: 'vllm', model: 'm', url: 'http://localhost:8000/v1' })).toBe(false);
        expect(isModelGone(err('HTTP 4100: x'), { provider: 'nvidia', model: 'm' })).toBe(false);
    });
    it('the retry handler pauses the model and rotates to the next one', () => {
        (window as any).getActiveMainModelList = () => ['nvidia|moonshotai/kimi-k3', 'openrouter|other-410'];
        // Both in one tool format: a rotation never changes it (codex R209, tests/model-gone-rotation.test.ts); kimi-k3 is fn-tag in the table.
        const savedFmt = (window as any).getModelToolFormat;
        (window as any).getModelToolFormat = () => 'fn-tag';
        try {
            const { h, notes, ep } = handler({ provider: 'nvidia', model: 'moonshotai/kimi-k3' });
            const out = h(0, err("HTTP 410: The model 'moonshotai/kimi-k3' has reached its end of life"), 1000);
            expect(out).toBe(0);
            expect(notes.join('\n')).toMatch(/paused: HTTP 410/);
            expect(ep().model).toBe('other-410');
        } finally { delete (window as any).getActiveMainModelList; (window as any).getModelToolFormat = savedFmt; }
    });
});

// Self-analysis P1 2026-10-29: a CLI run's endpoint is `custom|m`, its model list holds `openai|m` (the same server), and every reply was cut
// off at the output cap; "rotating" to `openai|m` resent the request at once, 551 times in 29 minutes, without a step or a compaction.
describe('rotation never goes to the endpoint it is leaving', () => {
    const cutOff = () => Object.assign(new Error('TruncatedResponse(tool_call_cut_off:256)'), { isTruncated: true, outputCapHit: { tokens: 256, toolCall: true, maxTokens: 256 } });
    afterEach(() => { delete (window as any).getActiveMainModelList; localStorage.clear(); });

    it('a cut-off reply leaves withRetry when the only other entry is the same server and model', () => {
        localStorage.setItem('fg_openai_url', 'http://127.0.0.1:8795/v1');
        (window as any).getActiveMainModelList = () => ['openai|m-same'];
        const { h, ep } = handler({ provider: 'custom', model: 'm-same', url: 'http://127.0.0.1:8795/v1/chat/completions' });
        expect(h(0, cutOff(), 1000)).toBe(false);
        expect(ep().provider).toBe('custom');
    });

    it('still rotates to a different model', () => {
        (window as any).getActiveMainModelList = () => ['kilo|other-model-x'];
        const { h, ep } = handler({ provider: 'kilo', model: 'cut-model-x', url: 'https://api.kilo.ai/api/gateway/chat/completions' });
        expect(h(0, cutOff(), 1000)).toBe(0);
        expect(ep().model).toBe('other-model-x');
    });

    it('gives up after MAX_INSTANT_RETRIES immediate retries of one request, however the next model is chosen', async () => {
        const { MAX_INSTANT_RETRIES } = await import('../retry.ts');
        // every rotation finds a fresh free model (a long pool): each one is legitimate, together they are a loop
        let k = 0;
        (window as any).getActiveMainModelList = () => [`kilo|pool-${k}`, `kilo|pool-${k + 1}`];
        const { h, notes } = handler({ provider: 'kilo', model: 'pool-0', url: 'https://api.kilo.ai/api/gateway/chat/completions' });
        let n = 0, out: any = 0;
        for (; n < 200; n++) { out = h(n, cutOff(), 1000); if (out !== 0) break; k++; }
        expect(out).toBe(false);
        expect(n).toBe(MAX_INSTANT_RETRIES);
        expect(notes.at(-1)).toMatch(/immediate retries/);
    });
});

// Autopilot exploration 2026-10-28, AE-13: five minutes of outage read as a bare "Running…". withRetry counts the failed model requests in a
// row (the runner shows them from three on); a cut-off reply is not a failure to reach the model, and a success ends the run.
describe('modelFailureRun', () => {
    it('counts failures across requests, ignores cut-off replies, and resets on success', async () => {
        const { withRetry, modelFailureRun, clearModelFailureRun } = await import('../retry.ts');
        clearModelFailureRun();
        let n = 0;
        const seen: number[] = [];
        await withRetry(async () => { if (++n <= 3) throw new Error('HTTP 502 Bad Gateway'); return 'ok'; },
            () => { seen.push(modelFailureRun().n); return 0; }, 10, () => true);
        expect(seen).toEqual([1, 2, 3]);
        expect(modelFailureRun().n).toBe(0);
        await withRetry(async () => { throw Object.assign(new Error('TruncatedResponse(x)'), { isTruncated: true }); }, () => false, 2, () => true).catch(() => {});
        expect(modelFailureRun().n).toBe(0);
    });
});
