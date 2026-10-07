// repeat-guard.test.ts — a tool call that keeps returning the same result (digits ignored) is
// refused after REPEAT_LIMIT repeats and the turn ends after a few refusals; calls whose results
// change keep running. Stuck nudges give advice for the tool that repeated.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { REPEAT_LIMIT, REPEAT_WINDOW, newRepeatGuard, _callSig, _resultSig, _repeatRefused, _repeatCount, _updateRepeatGuard, _updateStuckDetector, _creditProgress, PROGRESS_CREDITS_MAX, REPEAT_REFUSALS_BEFORE_STOP } from '../detectors.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

describe('repeat guard helpers', () => {
    it('ignores digits in results (PIDs, timestamps) but not other changes', () => {
        const a = _resultSig([{ name: 'execute_code', result: { stdout: 'root 647 20.0 bash -c ps aux | grep postgres' } }]);
        const b = _resultSig([{ name: 'execute_code', result: { stdout: 'root 673 14.2 bash -c ps aux | grep postgres' } }]);
        const c = _resultSig([{ name: 'execute_code', result: { stdout: 'postgres: server started' } }]);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    it('refuses only once a call has repeated REPEAT_LIMIT times with the same result', () => {
        const sig = _callSig([{ name: 'execute_code', args: { code: 'ps aux' } }]);
        let g = newRepeatGuard();
        for (let i = 0; i < REPEAT_LIMIT; i++) {
            expect(_repeatRefused(g, sig)).toBe(false);
            g = _updateRepeatGuard(g, sig, 'same');
        }
        expect(_repeatRefused(g, sig)).toBe(true);
        expect(_repeatRefused(g, _callSig([{ name: 'execute_code', args: { code: 'ls' } }]))).toBe(false);
    });

    it('is not reset by a variant slipped between repeats (v0.55 OS task 38)', () => {
        const ls  = _callSig([{ name: 'execute_code', args: { code: 'find / -perm -4000 | xargs ls -l' } }]);
        const lsd = _callSig([{ name: 'execute_code', args: { code: 'find / -perm -4000 | xargs ls -ld' } }]);
        let g = newRepeatGuard();
        for (let i = 0; i < REPEAT_LIMIT; i++) {
            g = _updateRepeatGuard(g, ls, 'same');
            if (i % 3 === 2) g = _updateRepeatGuard(g, lsd, 'same-d');
        }
        expect(_repeatCount(g, ls)).toBe(REPEAT_LIMIT);
        expect(_repeatRefused(g, ls)).toBe(true);
    });

    it('forgets repeats that fall out of the window, and counts only the latest result', () => {
        const sig = _callSig([{ name: 'execute_code', args: { code: 'ps aux' } }]);
        let g = newRepeatGuard();
        for (let i = 0; i < REPEAT_LIMIT - 1; i++) g = _updateRepeatGuard(g, sig, 'same');
        g = _updateRepeatGuard(g, sig, 'changed');
        expect(_repeatRefused(g, sig)).toBe(false);
        for (let i = 0; i < REPEAT_WINDOW; i++) g = _updateRepeatGuard(g, `other${i}`, 'x');
        expect(_repeatCount(g, sig)).toBe(0);
    });
});

describe('stuck nudge text', () => {
    it('gives command advice for execute_code, not file-reading advice', () => {
        const sig = JSON.stringify([{ n: 'execute_code', res: { stdout: 'x' } }]);
        let r: any = { resultHashes: [] };
        for (let i = 0; i < 3; i++) r = _updateStuckDetector(sig, new Set(), r.resultHashes);
        expect(r.stuckMsg).toMatch(/running the same command again/);
        expect(r.stuckMsg).toMatch(/already answers the task, give the answer now/);
        expect(r.stuckMsg).not.toMatch(/start_line/);
    });
});

describe('runTurn with a looping call', () => {
    beforeEach(() => {
        localStorage.clear();
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['execute_code']);
        W.setOpenaiHistory([{ role: 'user', content: 'Wait for postgres, then load the CSV.' }]);
    });
    const psCall = (i: number) => ({ tool_calls: [{ id: `p${i}`, type: 'function', function: { name: 'execute_code', arguments: '{"language":"bash","code":"ps aux | grep postgres"}' } }] });

    it('stops executing after REPEAT_LIMIT identical results and ends the turn', async () => {
        let pid = 600;
        const exec = vi.fn(async () => ({ stdout: `root ${pid++} 0.0 grep postgres`, stderr: '', exit_code: 0 }));
        W.nativeExec = exec;
        W.fetch = makeReplayFetch(Array.from({ length: 20 }, (_, i) => psCall(i)));
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(exec).toHaveBeenCalledTimes(REPEAT_LIMIT);
        expect(result).toMatch(/stopped|BLOCKED/);
        const refusals = W.openaiHistory.filter((m: any) => m.role === 'tool' && String(m.content).includes('Not executed: this exact call already ran'));
        expect(refusals.length).toBeGreaterThan(0);
        // A model that already has the answer is told to give it, not only to declare BLOCKED.
        expect(refusals[0].content).toContain('If the output you already have answers the task, give that answer now');
    });

    it('refuses a looping call even when the model alternates in a variant', async () => {
        const exec = vi.fn(async () => ({ stdout: '-rwsr-xr-x 1 root root /usr/bin/find', stderr: '', exit_code: 0 }));
        W.nativeExec = exec;
        const lsdCall = (i: number) => ({ tool_calls: [{ id: `d${i}`, type: 'function', function: { name: 'execute_code', arguments: '{"language":"bash","code":"ls -ld /usr/bin/find"}' } }] });
        W.fetch = makeReplayFetch(Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? lsdCall(i) : psCall(i))));
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(result).toMatch(/stopped|BLOCKED/);
        expect(exec.mock.calls.length).toBeLessThan(30);
    });

    it('lets the model answer after a stuck nudge (no forced tool call)', async () => {
        W.nativeExec = vi.fn(async () => ({ stdout: '-rwsr-xr-x 1 root root /usr/bin/find', stderr: '', exit_code: 0 }));
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([psCall(0), psCall(1), psCall(2), { content: '/usr/bin/find has SUID.\nCOMPLETED' }],
            { onRequest: b => bodies.push(b) });
        const ep = { provider: 'vllm', url: 'http://vllm.test/v1/chat/completions', model: 'm', key: '' };
        await W.runTurn(ep, NULL_RENDER_ADAPTER);
        const stuckAt = W.openaiHistory.findIndex((m: any) => m.role === 'user' && String(m.content).includes('produced identical results'));
        expect(stuckAt).toBeGreaterThan(-1);
        expect(bodies[3].tool_choice).not.toBe('required');
    });

    it('keeps running a repeated call whose results change', async () => {
        let n = 0;
        const exec = vi.fn(async () => ({ stdout: ['starting', 'initializing', 'recovering', 'waiting'][n++ % 4] + ' postgres', stderr: '', exit_code: 0 }));
        W.nativeExec = exec;
        W.fetch = makeReplayFetch([...Array.from({ length: 12 }, (_, i) => psCall(i)), { content: 'Loaded.\nCOMPLETED' }]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(exec).toHaveBeenCalledTimes(12);
    });
});

// v0.61 AutomationBench hr-5075: 97 /search calls whose queries differed and whose replies didn't.
describe('endpoint repeat guard', () => {
    const search = (q: string) => [{ name: 'fetch_url', args: { url: `http://gw:8080/search?query=${q}` } }];
    const post = (b: any) => [{ name: 'fetch_url', args: { method: 'POST', url: 'http://gw:8080/execute', body: b } }];
    const run = (calls: any[], res: string, g: any) => _updateRepeatGuard(g, _callSig(calls), res, _pathSig(calls));

    it('keys a GET by endpoint without its query, and leaves POSTs and other tools alone', async () => {
        const { _pathSig } = await import('../detectors.ts');
        expect(_pathSig(search('a'))).toBe(_pathSig(search('totally different'))!);
        expect(_pathSig(search('a'))).toBe('GET|http://gw:8080/search');
        expect(_pathSig(post({ tool: 't' }))).toBeNull();
        expect(_pathSig([{ name: 'execute_code', args: { code: 'ls' } }])).toBeNull();
        expect(_pathSig([{ name: 'fetch_url', args: { url: 'not a url' } }])).toBeNull();
    });

    it('refuses the endpoint once rephrased queries keep returning the same result', async () => {
        const { _pathSig, _pathRepeatRefused, PATH_REPEAT_LIMIT } = await import('../detectors.ts');
        let g = newRepeatGuard();
        const sig = _pathSig(search('x'));
        for (let i = 0; i < PATH_REPEAT_LIMIT; i++) {
            expect(_pathRepeatRefused(g, sig)).toBe(false);
            g = _updateRepeatGuard(g, _callSig(search(`q${i}`)), 'same tool list', sig);   // every exact call differs
            expect(_repeatRefused(g, _callSig(search(`q${i + 1}`)))).toBe(false);          // the exact-call guard never fires
        }
        expect(_pathRepeatRefused(g, sig)).toBe(true);
    });

    it('does not refuse an endpoint whose results change', async () => {
        const { _pathSig, _pathRepeatRefused } = await import('../detectors.ts');
        let g = newRepeatGuard();
        for (let i = 0; i < 12; i++) g = _updateRepeatGuard(g, _callSig(search(`q${i}`)), `result ${'x'.repeat(i)}`, _pathSig(search('q')));
        expect(_pathRepeatRefused(g, _pathSig(search('q')))).toBe(false);
    });

    it('a turn of reworded searches is refused and then ends instead of running to the step cap', async () => {
        W._sessionToolFilter = new Set(['fetch_url']);
        let served = 0;
        const llm = makeReplayFetch([
            ...Array.from({ length: 14 }, (_, i) => ({
                tool_calls: [{ id: `s${i}`, type: 'function', function: { name: 'fetch_url', arguments: JSON.stringify({ url: `http://gw.example:8080/search?query=word${i}` }) } }],
            })),
            { content: 'Done.\nCOMPLETED' },
        ]);
        W.fetch = vi.fn(async (url: any, init: any) => {
            if (String(url).includes('gw.example')) { served++; return new Response('{"tools":["salesforce_lead_update"]}', { status: 200, headers: { 'content-type': 'application/json' } }); }
            return (llm as any)(url, init);
        });
        const out = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        console.log('SERVED', served, String(out).slice(0, 120).replace(/\n/g, ' '));
        expect(served).toBeGreaterThanOrEqual(5);
        expect(served).toBeLessThan(14);
    });
});

// AutomationBench simple-3139: five empty `partnership` searches poisoned /search, and the next
// search (`email`, the useful one) was refused before the server could answer.
describe('untried-query escape (endpoint guard)', () => {
    const search = (q: string) => [{ name: 'fetch_url', args: { url: `http://gw:8080/search?query=${q}` } }];
    const sigOf = (q: string) => _callSig(search(q));
    const EP = 'GET|http://gw:8080/search';
    const poisoned = async (n = 5, result = '{"tools":[]}') => {
        let g = newRepeatGuard();
        for (let i = 0; i < n; i++) g = _updateRepeatGuard(g, sigOf(`partnership${i}`), result, EP);
        return g;
    };

    it('lets a query not yet tried through an endpoint that is at its limit', async () => {
        const { _pathRepeatRefused } = await import('../detectors.ts');
        const g = await poisoned();
        expect(_pathRepeatRefused(g, EP)).toBe(true);                       // no callSig: old behaviour
        expect(_pathRepeatRefused(g, EP, sigOf('email'))).toBe(false);      // untried query: allowed
    });

    it('still refuses a query that was already tried', async () => {
        const { _pathRepeatRefused } = await import('../detectors.ts');
        const g = await poisoned();
        expect(_pathRepeatRefused(g, EP, sigOf('partnership3'))).toBe(true);
    });

    it('allows PATH_NOVEL_ESCAPES probes per endpoint and then refuses', async () => {
        const { _pathRepeatRefused, PATH_NOVEL_ESCAPES } = await import('../detectors.ts');
        let g = await poisoned();
        for (let i = 0; i < PATH_NOVEL_ESCAPES; i++) {
            expect(_pathRepeatRefused(g, EP, sigOf(`probe${i}`))).toBe(false);
            g = _updateRepeatGuard(g, sigOf(`probe${i}`), '{"tools":[]}', EP);       // probes return the same empty result
        }
        expect(_pathRepeatRefused(g, EP, sigOf('one-more'))).toBe(true);
    });

    it('a probe that returns something new restarts the endpoint', async () => {
        const { _pathRepeatRefused, _pathRepeatCount } = await import('../detectors.ts');
        let g = await poisoned();
        g = _updateRepeatGuard(g, sigOf('email'), '{"tools":["email_send"]}', EP);
        expect(_pathRepeatCount(g, EP)).toBe(1);
        expect(_pathRepeatRefused(g, EP, sigOf('another'))).toBe(false);
        expect(_pathRepeatRefused(g, EP)).toBe(false);
    });

    it('does not spend the allowance on calls that were never at the limit', async () => {
        let g = newRepeatGuard();
        for (let i = 0; i < 3; i++) g = _updateRepeatGuard(g, sigOf(`q${i}`), 'same', EP);
        expect(g.pathEscapes ?? {}).toEqual({});
    });

    describe('in a turn', () => {
        beforeEach(() => {
            localStorage.clear();
            W.mainAgentRole = null;
            localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
            localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
            W._sessionToolFilter = new Set(['fetch_url']);
            W.setOpenaiHistory([{ role: 'user', content: 'Schedule the partnership meeting.' }]);
        });
        const call = (q: string, i: number) => ({ tool_calls: [{ id: `s${i}`, type: 'function', function: { name: 'fetch_url', arguments: JSON.stringify({ url: `http://gw.example:8080/search?query=${q}` }) } }] });
        const gateway = (llm: any, served: string[]) => vi.fn(async (url: any, init: any) => {
            if (String(url).includes('gw.example')) {
                const target = decodeURIComponent(String(url));   // the app routes fetch_url through a proxy URL
                served.push(target);
                const body = target.includes('query=email') ? '{"tools":["email_send"]}' : '{"tools":[]}';
                return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return llm(url, init);
        });

        it('runs the useful query after five empty ones (simple-3139)', async () => {
            const served: string[] = [];
            const llm = makeReplayFetch([...[0, 1, 2, 3, 4].map(i => call(`partnership${i}`, i)), call('email', 5), { content: 'Found email_send.\nCOMPLETED' }]);
            W.fetch = gateway(llm, served);
            await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
            expect(served.some(u => u.includes('query=email'))).toBe(true);
            expect(JSON.stringify(W.openaiHistory)).toContain('email_send');
        });

        it('still stops a turn of reworded queries that never change the result', async () => {
            const served: string[] = [];
            const llm = makeReplayFetch([...Array.from({ length: 14 }, (_, i) => call(`word${i}`, i)), { content: 'Done.\nCOMPLETED' }]);
            W.fetch = gateway(llm, served);
            await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
            // 5 to reach the limit + 2 allowed probes, then refusals until the stop.
            expect(served.length).toBe(7);
        });
    });
});

// AutomationBench finance-4071 stopped at step 23 of 100 after a few refusals although later steps
// kept producing new results.
describe('progress credit', () => {
    const refusedAt = (n: number) => ({ ...newRepeatGuard(), refused: n });

    it('forgives one refusal for a clean step with a result the turn has not seen', () => {
        const g = _creditProgress(refusedAt(2), 'brand new result', true);
        expect(g.refused).toBe(1);
        expect(g.credits).toBe(1);
    });

    it('gives nothing for a failed step, a seen result, or when nothing was refused', () => {
        expect(_creditProgress(refusedAt(2), 'new', false).refused).toBe(2);
        const once = _creditProgress(refusedAt(2), 'same result', true);
        expect(_creditProgress(once, 'same result', true).refused).toBe(1);   // second time it is not new
        expect(_creditProgress(refusedAt(0), 'new', true).refused).toBe(0);
    });

    it('a failed novel result is still remembered, so it cannot earn credit later', () => {
        const g = _creditProgress(refusedAt(2), 'error text', false);
        expect(_creditProgress(g, 'error text', true).refused).toBe(2);
    });

    it('forgives at most PROGRESS_CREDITS_MAX refusals per turn', () => {
        let g = refusedAt(2);
        for (let i = 0; i < 20; i++) g = { ..._creditProgress(g, `result ${'x'.repeat(i)}`, true), refused: 2 };   // refused topped up each time
        expect(g.credits).toBe(PROGRESS_CREDITS_MAX);
    });

    it('does not reopen the v0.55 loophole: an interleaved variant earns credit once, not every time', () => {
        let g = refusedAt(2);
        for (let i = 0; i < 6; i++) g = _creditProgress(g, 'ls -ld output (always the same)', true);
        expect(g.refused).toBe(1);   // one credit in total
    });

    describe('in a turn', () => {
        beforeEach(() => {
            localStorage.clear();
            W.mainAgentRole = null;
            localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
            localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
            W._sessionToolFilter = new Set(['execute_code']);
            W.setOpenaiHistory([{ role: 'user', content: 'Wait for postgres, then load the CSV.' }]);
        });
        const run = (code: string, i: number) => ({ tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code }) } }] });

        it('a turn with real progress between refusals is not ended by them', async () => {
            // 8 identical runs, 2 refused repeats, 2 new commands (2 credits), 2 more refused repeats, then the answer.
            const seq = [
                ...Array.from({ length: 8 }, (_, i) => run('ps aux | grep postgres', i)),
                run('ps aux | grep postgres', 8), run('ps aux | grep postgres', 9),
                run('echo alpha', 10), run('echo beta', 11),
                run('ps aux | grep postgres', 12), run('ps aux | grep postgres', 13),
                { content: 'Loaded.\nCOMPLETED' },
            ];
            let n = 0;
            W.nativeExec = vi.fn(async () => ({ stdout: n++ < 8 ? 'root grep postgres' : `distinct output ${'y'.repeat(n)}`, stderr: '', exit_code: 0 }));
            W.fetch = makeReplayFetch(seq);
            const out = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
            const refusals = W.openaiHistory.filter((m: any) => m.role === 'tool' && String(m.content).includes('Not executed'));
            expect(refusals.length).toBe(4);
            expect(refusals.length).toBeGreaterThan(REPEAT_REFUSALS_BEFORE_STOP);   // would have stopped at the 3rd without credit
            expect(String(out)).toContain('Loaded');
        });
    });
});
