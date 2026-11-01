import { describe, it, expect, afterEach, vi } from 'vitest';
import { _endpointCooldown, _markCooldown, getCooldownRemaining, isAccountQuotaError, parseQuotaResetMs,
    knownLimitWaitMs, recordRequest, recordRateLimitHeaders } from '../model-router.ts';
import { _httpErrorFromResponse } from '../retry.ts';

const MSG = `HTTP 429: You've used this period's free allowance. Your next rolling 7-day period starts on 20 Oct 2026 at 04:23 UTC. Use the paid model 'deepseek-v4.1-flash' to keep going`;
const NOW = Date.UTC(2026, 9, 17, 4, 17, 36);

afterEach(() => { for (const k of [..._endpointCooldown.keys()]) _endpointCooldown.delete(k); });

describe('APInex and MoonMath quota policies', () => {
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
    const apinex = { provider: 'apinex', model: 'free/glm-5.3-flash' };

    it('enforces APInex account RPM before sending, even when requests alternate models', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
        const other = { provider: 'apinex', model: 'free/deepseek-v4.1-flash' };
        for (let i = 0; i < 15; i++) { expect(knownLimitWaitMs(apinex)).toBe(0); recordRequest(i % 2 ? other : apinex); }
        expect(knownLimitWaitMs(other)).toBe(60_250);
        expect(getCooldownRemaining('apinex|free/glm-5.3-flash')).toBe(61);
        expect(knownLimitWaitMs({ provider: 'moonmath', model: 'glm-5.3-flash' })).toBe(0);
        vi.advanceTimersByTime(60_250);
        expect(knownLimitWaitMs(other)).toBe(0);
    });

    it('learns a higher account RPM from response headers and resets counters when storage is cleared', () => {
        recordRateLimitHeaders(apinex, new Headers({ 'x-ratelimit-limit': '30' }));
        for (let i = 0; i < 15; i++) recordRequest(apinex);
        expect(knownLimitWaitMs(apinex)).toBe(0);
        for (let i = 0; i < 15; i++) recordRequest(apinex);
        expect(knownLimitWaitMs(apinex)).toBeGreaterThan(0);
        localStorage.clear();
        expect(knownLimitWaitMs(apinex)).toBe(0);
    });

    it.each([25_000, null])('shares APInex RPM cooldown across models, using the advertised wait %s', (wait) => {
        const err = new Error('HTTP 429: Rate limit exceeded for this key');
        _markCooldown(apinex, wait, err);
        const expected = (wait ?? 60_000) / 1000;
        expect(getCooldownRemaining('apinex|free/deepseek-v4.1-flash')).toBe(expected);
        expect(getCooldownRemaining('apinex|free/glm-5.3-flash')).toBe(expected);
        expect(getCooldownRemaining('moonmath|glm-5.3-flash')).toBe(0);
    });

    it('does not cool usable free models when an APInex route requires a subscription', () => {
        const err = new Error('HTTP 402: This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to use it.');
        _markCooldown({ provider: 'apinex', model: 'free/claude-opus-4.6' }, null, err);
        expect(getCooldownRemaining('apinex|free/claude-opus-4.6')).toBe(86_400);
        expect(getCooldownRemaining('apinex|free/glm-5.3-flash')).toBe(0);
        expect(getCooldownRemaining('apinex|free/deepseek-v4.1-flash')).toBe(0);
    });

    it('uses the named reset for an exhausted MoonMath budget across its Flash models', () => {
        _markCooldown({ provider: 'moonmath', model: 'glm-5.3-flash' }, null,
            new Error('HTTP 402: Spend quota or plan budget exhausted; resets in 2 hours'));
        expect(getCooldownRemaining('moonmath|glm-5.3-flash')).toBe(7_200);
        expect(getCooldownRemaining('moonmath|deepseek-v4.1-flash')).toBe(7_200);
        expect(getCooldownRemaining('apinex|free/glm-5.3-flash')).toBe(0);
    });

    it('keeps paid APInex routes outside a free-allowance cooldown, which lasts until the 00:00 UTC reset', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T22:00:00Z'));
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'apinex', model: 'glm-5.3', label: 'Paid route' }]));
        _markCooldown(apinex, 60_000, new Error('HTTP 402: Free allowance exhausted'));
        expect(getCooldownRemaining('apinex|free/deepseek-v4.1-flash')).toBe(2 * 3_600 + 60);
        expect(getCooldownRemaining('apinex|glm-5.3')).toBe(0);
    });

    it('waits for 00:00 UTC on spent MoonMath Free usage, but re-checks a per-key spend limit hourly', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T22:00:00Z'));
        _markCooldown({ provider: 'moonmath', model: 'glm-5.3-flash' }, null, new Error('HTTP 402: Spend quota or plan budget exhausted'));
        expect(getCooldownRemaining('moonmath|deepseek-v4.1-flash')).toBe(2 * 3_600 + 60);
        _endpointCooldown.clear();
        _markCooldown({ provider: 'moonmath', model: 'glm-5.3-flash' }, null,
            new Error('HTTP 402: This API key has reached its spend limit. Create a new API key or use another key.'));
        expect(getCooldownRemaining('moonmath|glm-5.3-flash')).toBe(3_600);
        expect(getCooldownRemaining('moonmath|deepseek-v4.1-flash')).toBe(3_600);
    });

    it('retries a MoonMath parallel-request refusal after seconds, not its Retry-After minute, and leaves the other model alone', () => {
        const err = new Error('HTTP 429: The Free plan runs a limited number of requests at once. Wait for one to finish, or add a usage pack or plan.');
        _markCooldown({ provider: 'moonmath', model: 'glm-5.3-flash' }, 60_000, err);
        expect(getCooldownRemaining('moonmath|glm-5.3-flash')).toBe(5);
        expect(getCooldownRemaining('moonmath|deepseek-v4.1-flash')).toBe(0);
    });

    it('shares APInex wallet/key allowance refusals with paid routes and honors a temporary reservation wait', () => {
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'apinex', model: 'glm-5.3', label: 'Paid route' }]));
        _markCooldown(apinex, 30_000, new Error('HTTP 402: Insufficient spendable balance or API-key allowance'));
        expect(getCooldownRemaining('apinex|free/deepseek-v4.1-flash')).toBe(30);
        expect(getCooldownRemaining('apinex|glm-5.3')).toBe(30);
    });

    it('cools paid APInex routes too when the account-wide RPM window is exhausted', () => {
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'apinex', model: 'glm-5.3', label: 'Paid route' }]));
        _markCooldown(apinex, 25_000, new Error('HTTP 429: rate limit exceeded'));
        expect(getCooldownRemaining('apinex|glm-5.3')).toBe(25);
    });

    it('reads APInex reset timestamps and preserves the original error message and Retry-After precedence', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
        const headers = { 'x-ratelimit-reset': String(Date.now() / 1000 + 25) };
        const body = JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } });
        const err = await _httpErrorFromResponse(new Response(body, { status: 429, headers }));
        expect(err.message).toBe('HTTP 429: Rate limit exceeded');
        expect(err.retryAfterMs).toBe(25_000);
        const precedence = await _httpErrorFromResponse(new Response(body, { status: 429,
            headers: { ...headers, 'retry-after': '5' } }));
        expect(precedence.retryAfterMs).toBe(5_000);
    });

    it('shortens the Retry-After of a MoonMath parallel-request refusal', async () => {
        const body = JSON.stringify({ error: { message: 'The Free plan runs a limited number of requests at once. Wait for one to finish, or add a usage pack or plan.', type: 'rate_limit_error' } });
        const err = await _httpErrorFromResponse(new Response(body, { status: 429, headers: { 'retry-after': '60' } }));
        expect(err.retryAfterMs).toBe(5_000);
    });
});

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
