import { describe, it, expect, afterEach } from 'vitest';
import { _endpointCooldown, _markCooldown, getCooldownRemaining, isAccountQuotaError, parseQuotaResetMs } from '../model-router.ts';

const MSG = `HTTP 429: You've used this period's free allowance. Your next rolling 7-day period starts on 20 Oct 2026 at 04:23 UTC. Use the paid model 'deepseek-v4.1-flash' to keep going`;
const NOW = Date.UTC(2026, 9, 17, 4, 17, 36);

afterEach(() => { for (const k of [..._endpointCooldown.keys()]) _endpointCooldown.delete(k); });

describe('quota reset times in error messages', () => {
    it('reads a dated UTC reset', () => {
        expect(parseQuotaResetMs(MSG, NOW)).toBe(Date.UTC(2026, 9, 20, 4, 23) - NOW);
    });
    it('reads an ISO timestamp and a relative duration, and ignores messages naming none', () => {
        expect(parseQuotaResetMs('quota resets at 2026-10-17T06:00:00Z', NOW)).toBe(Date.UTC(2026, 9, 17, 6) - NOW);
        expect(parseQuotaResetMs('free limit reached, resets in 2 hours 30 minutes', NOW)).toBe(150 * 60_000);
        expect(parseQuotaResetMs('HTTP 429 rate limited', NOW)).toBeNull();
        expect(parseQuotaResetMs('resets on 1 Jan 2020 at 00:00 UTC', NOW)).toBeNull();   // already past
    });
    it('only account-wide quota messages count as account quota', () => {
        expect(isAccountQuotaError(MSG)).toBe(true);
        expect(isAccountQuotaError('HTTP 402: insufficient balance')).toBe(true);
        expect(isAccountQuotaError('HTTP 429: too many requests, slow down')).toBe(false);
    });
});

describe('a per-account quota error cools down the provider\'s other free models', () => {
    it('uses the named reset for the model and its free siblings, and leaves paid and other providers alone', () => {
        const free = ['deepseek-v4.1-flash:free', 'mimo-v2.6-flash:free', 'deepseek-v4-flash:free'];
        const err: any = new Error(MSG); err.retryAfterMs = 3_600_000;
        _markCooldown({ provider: 'tokenharbor', model: free[0] }, err.retryAfterMs, err);
        const week = Math.ceil((Date.UTC(2026, 9, 20, 4, 23) - Date.now()) / 1000);
        for (const m of free) {
            const left = getCooldownRemaining(`tokenharbor|${m}`);
            expect(left).toBeGreaterThan(0);
            if (Date.now() < Date.UTC(2026, 9, 20)) expect(Math.abs(left - week)).toBeLessThan(5);
        }
        expect(getCooldownRemaining('openrouter|nvidia/nemotron-3.5-super-vl:free')).toBe(0);
        expect(getCooldownRemaining('nous|meituan/longcat-2.5-preview:free')).toBe(0);
    });
    it('an ordinary rate limit only cools the model that was refused', () => {
        const err: any = new Error('HTTP 429: too many requests'); err.retryAfterMs = 30_000;
        _markCooldown({ provider: 'tokenharbor', model: 'mimo-v2.5:free' }, 30_000, err);
        expect(getCooldownRemaining('tokenharbor|mimo-v2.6-flash:free')).toBe(0);
    });
});
