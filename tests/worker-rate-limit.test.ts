// Worker rate limits: providers that answer 429 with no body produce a bare "[…] HTTP 429", which
// isTransient() did not match — withRetry threw at once and workers died on the first rate limit
// (console log 2026-09-27: "[worker:researcher:step8] callOAI threw: [nvidia|…] HTTP 429").
import { describe, it, expect, beforeAll } from 'vitest';
import { isTransient } from '../retry.ts';

let W: any;
beforeAll(async () => { W = await import('../workers.ts'); });

describe('worker rate limits', () => {
    it('treats a bare HTTP 429 / 402 as transient', () => {
        expect(isTransient(new Error('[nvidia|nvidia/nemotron-3-ultra-550b-a55b] HTTP 429'))).toBe(true);
        expect(isTransient(new Error('[openrouter|x] HTTP 402'))).toBe(true);
        expect(isTransient(new Error('[openrouter|x] HTTP 400: bad request'))).toBe(false);
    });

    it('waits out a short cooldown but gives up on an hours-long one', () => {
        const notes: string[] = [];
        const shortWait = W._capWorkerRetryWait(() => 20_000, (m: string) => notes.push(m));
        expect(shortWait(0, new Error('HTTP 429'), 1500)).toBe(20_000);
        const dailyQuota = W._capWorkerRetryWait(() => 34_494_000, (m: string) => notes.push(m));
        expect(dailyQuota(0, new Error('HTTP 429'), 1500)).toBe(false);
        expect(notes.at(-1)).toMatch(/rate-limited — next one free in 575 min/);
        // Rotation (0) and bail (false) pass through unchanged.
        expect(W._capWorkerRetryWait(() => 0, () => {})(0, null, 1500)).toBe(0);
        expect(W._capWorkerRetryWait(() => false, () => {})(0, null, 1500)).toBe(false);
    });
});
