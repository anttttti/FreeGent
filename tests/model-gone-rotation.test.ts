// TUI report: "Director [kilo:minimax/…] 1.3s ✗ HTTP 404: The requested model '…' does not exist" ended the turn on the first failure
// while the rest of the model pool worked. withRetry treats "does not exist" as a permanent configuration error and threw before
// the retry handler (which pauses a dead cloud model and rotates to the next one) ever ran.
import { withRetry, isModelGone, _makeOAIRetryHandler } from '../retry.ts';
import { specToEndpoint } from '../model-router.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEAD = 'kilo|minimax/minimax-m3.1-flash:free', GOOD = 'groq|llama-good';
const msg404 = "[kilo|minimax/minimax-m3.1-flash:free] HTTP 404: The requested model 'minimax/minimax-m3.1-flash:free' does not exist. Please use an exact model id as listed on /api/gateway/models.";
const gone = () => Object.assign(new Error(msg404), { status: 404 });

let paused: string[], pool: string[];
beforeEach(() => {
    paused = []; pool = [DEAD, GOOD];
    const W: any = window;
    W.getActiveMainModelList = () => pool.filter(k => !paused.includes(k));
    W.getPausedMainModels = () => paused;
    W.savePausedMainModels = (l: string[]) => { paused = l; };
});
afterEach(() => { const W: any = window; delete W.getActiveMainModelList; delete W.getPausedMainModels; delete W.savePausedMainModels; });

function run(opts: { override: boolean; ep?: string }) {
    let cur: any = specToEndpoint(opts.ep ?? DEAD);
    const notes: string[] = [], used: string[] = [];
    const handler = _makeOAIRetryHandler({ getEp: () => cur, setEp: (e: any) => { cur = e; }, onNote: (n: string) => notes.push(n) });
    const p = withRetry(async () => {
        used.push(`${cur.provider}|${cur.model}`);
        if (`${cur.provider}|${cur.model}` === DEAD) throw gone();
        return 'ok';
    }, handler, Infinity, opts.override ? (e: any) => isModelGone(e, cur) : null);
    return { p, notes, used };
}

describe('a cloud model that answers HTTP 404 "does not exist"', () => {
    it('is classified as gone for a cloud provider, not for a local server', () => {
        expect(isModelGone(gone(), { provider: 'kilo', model: 'x' })).toBe(true);
        expect(isModelGone(gone(), { provider: 'custom', model: 'x' })).toBe(false);
        expect(isModelGone(gone(), { provider: 'vllm', model: 'x' })).toBe(false);
        expect(isModelGone(new Error('HTTP 429: slow down'), { provider: 'kilo', model: 'x' })).toBe(false);
    });
    it('without the override the turn ends on the first failure (the reported behaviour)', async () => {
        const r = run({ override: false });
        await expect(r.p).rejects.toThrow(/does not exist/);
        expect(r.used).toEqual([DEAD]);
    });
    it('with it, the model is paused and the request goes to the next model in the pool at once', async () => {
        const r = run({ override: true });
        await expect(r.p).resolves.toBe('ok');
        expect(r.used).toEqual([DEAD, GOOD]);
        expect(paused).toEqual([DEAD]);
        expect(r.notes.join('\n')).toMatch(/paused/);
    });
    it('with nowhere to go, the error is reported as before', async () => {
        pool = [DEAD];
        const r = run({ override: true });
        await expect(r.p).rejects.toThrow(/does not exist/);
        expect(r.used).toEqual([DEAD]);
    });
    it('a local endpoint\'s 404 is still permanent: no retry, no pause', async () => {
        let cur: any = { provider: 'custom', model: 'm', url: 'http://x/v1' };
        let calls = 0;
        const handler = _makeOAIRetryHandler({ getEp: () => cur, setEp: (e: any) => { cur = e; }, onNote: () => {} });
        await expect(withRetry(async () => { calls++; throw gone(); }, handler, Infinity, () => false)).rejects.toThrow();
        expect(calls).toBe(1);
        expect(paused).toEqual([]);
    });
});

describe('the callers pass it', () => {
    const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');
    it('the main loop, the worker loop and the auxiliary call all let the retry handler see a gone model', () => {
        expect(src('llm-loops.ts')).toMatch(/isModelGone\(e, activeEndpoint \?\? oaiEndpoint\(\)\)/);
        expect(src('workers.ts')).toMatch(/!explicitModel && isModelGone\(e, endpoint \?\? oaiEndpoint\(\)\)/);
        expect(src('workers.ts')).toMatch(/isCustomEndpoint\(ep\) \|\| isModelGone\(e, ep\)/);
    });
});
