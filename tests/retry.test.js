// Tests for retry.ts — the withRetry driver, error classification, backoff policy,
// and Retry-After parsing. Delays are forced to 0 via onRetry's numeric override so
// the suite stays fast.
import { describe, it, expect, afterEach } from 'vitest';
import {
    withRetry, isTransient, retryDelay, parseContextOverflow, _parseRetryAfter, fmtDelay,
    _httpErrorFromResponse,
} from '../retry.ts';

afterEach(() => localStorage.clear());

describe('withRetry — driver behavior', () => {
    it('retries transient errors and returns the eventual success', async () => {
        let n = 0;
        const result = await withRetry(
            async () => { if (++n < 3) throw new Error('HTTP 503 service unavailable'); return 'ok'; },
            () => 0 /* zero delay */);
        expect(result).toBe('ok');
        expect(n).toBe(3);
    });
    it('throws non-transient errors immediately', async () => {
        let n = 0;
        await expect(withRetry(async () => { n++; throw new Error('model not found'); }, () => 0))
            .rejects.toThrow('model not found');
        expect(n).toBe(1);
    });
    it('propagates a USER abort (softStopPending) without retrying', async () => {
        // Only a genuine user/soft-stop abort is fatal. This is the softStopPending branch.
        let n = 0;
        const abort = new DOMException('Aborted', 'AbortError');
        window.setSoftStopPending(true);
        try {
            await expect(withRetry(async () => { n++; throw abort; }, () => 0))
                .rejects.toThrow('Aborted');
            expect(n).toBe(1);
        } finally { window.setSoftStopPending(false); }
    });

    it('RETRIES an AbortError when softStopPending is false (timeout, not user abort)', async () => {
        // AbortSignal.any propagates a timeout reason as AbortError in some Chrome versions
        // ("The user aborted a request."), so treating every AbortError as fatal sent the
        // turn to the outer executeWorkers retry loop and stalled for 3x90s. Bounded here by
        // maxAttempts — the old test used the Infinity default and simply hung.
        let n = 0;
        const abort = new DOMException('Aborted', 'AbortError');
        await expect(withRetry(async () => { n++; throw abort; }, () => 0, 3))
            .rejects.toThrow('Aborted');
        expect(n).toBe(3);
    });
    it('respects maxAttempts', async () => {
        let n = 0;
        await expect(withRetry(async () => { n++; throw new Error('HTTP 500'); }, () => 0, 2))
            .rejects.toThrow('HTTP 500');
        expect(n).toBe(2);
    });
    it('onRetry returning false bails out', async () => {
        let n = 0;
        await expect(withRetry(async () => { n++; throw new Error('HTTP 500'); }, () => false))
            .rejects.toThrow('HTTP 500');
        expect(n).toBe(1);
    });
    it('isTransientOverride supplements the generic classifier', async () => {
        let n = 0;
        const result = await withRetry(
            async () => { if (++n < 2) throw new Error('weird custom failure'); return 'ok'; },
            () => 0, Infinity, e => /weird custom/.test(e.message));
        expect(result).toBe('ok');
    });

    // onFailure: the only hook that sees every failed attempt, including non-transient ones
    // that never reach onRetry at all — this is what feeds the request-failure raw-capture.
    it('onFailure fires for a non-transient error that never reaches onRetry', async () => {
        const seen = [];
        let onRetryCalls = 0;
        await expect(withRetry(
            async () => { throw new Error('model not found'); },
            () => { onRetryCalls++; return 0; },
            Infinity, null,
            e => seen.push(e.message),
        )).rejects.toThrow('model not found');
        expect(seen).toEqual(['model not found']);
        expect(onRetryCalls).toBe(0); // confirms onRetry is genuinely skipped for non-transient errors
    });

    it('onFailure fires once per attempt for a transient error that does retry', async () => {
        const seen = [];
        let n = 0;
        await withRetry(
            async () => { if (++n < 3) throw new Error('HTTP 503'); return 'ok'; },
            () => 0, Infinity, null,
            e => seen.push(e.message),
        );
        expect(seen).toEqual(['HTTP 503', 'HTTP 503']);
    });

    it('a throwing onFailure callback does not break the retry loop', async () => {
        let n = 0;
        const result = await withRetry(
            async () => { if (++n < 2) throw new Error('HTTP 503'); return 'ok'; },
            () => 0, Infinity, null,
            () => { throw new Error('logging backend down'); },
        );
        expect(result).toBe('ok');
    });
});

describe('classification & policy', () => {
    it('isTransient: 5xx/timeouts yes; config errors and thought-signature no', () => {
        expect(isTransient(new Error('HTTP 502 bad gateway'))).toBe(true);
        expect(isTransient(new Error('Stream idle timeout'))).toBe(true);
        expect(isTransient(new Error('model not found'))).toBe(false);
        expect(isTransient(new Error('thought_signature validation failed'))).toBe(false);
    });
    it('retryDelay: fixed mode reads localStorage; rate limits back off harder', () => {
        localStorage.setItem('fg_retry_mode', 'fixed');
        localStorage.setItem('fg_retry_fixed_ms', '5000');
        expect(retryDelay(3, new Error('HTTP 500'))).toBe(5000);
        localStorage.clear();
        expect(retryDelay(0, new Error('HTTP 429'))).toBeGreaterThan(retryDelay(0, new Error('HTTP 500')));
    });
    it('parseContextOverflow extracts headroom (sign tells recover vs compact)', () => {
        const e = new Error("maximum context length is 30000 tokens. However, you requested at least 29000 input tokens");
        expect(parseContextOverflow(e)).toBe(30000 - 29000 - 256);
        expect(parseContextOverflow(new Error('HTTP 500'))).toBeNull();
    });
    it('fmtDelay renders human units', () => {
        expect(fmtDelay(30_000)).toBe('30s');
        expect(fmtDelay(120_000)).toBe('2m');
    });
});

describe('_parseRetryAfter — header formats', () => {
    const resp = headers => ({ headers: { get: k => headers[k] ?? null } });
    it('numeric seconds', () => {
        expect(_parseRetryAfter(resp({ 'retry-after': '30' }))).toBe(30_000);
    });
    it('Groq-style duration strings', () => {
        expect(_parseRetryAfter(resp({ 'retry-after': '1m30s' }))).toBe(90_000);
        expect(_parseRetryAfter(resp({ 'x-ratelimit-reset-requests': '2h' }))).toBe(7_200_000);
    });
    it('HTTP-date fallback and absent headers', () => {
        const future = new Date(Date.now() + 60_000).toUTCString();
        const ms = _parseRetryAfter(resp({ 'retry-after': future }));
        expect(ms).toBeGreaterThan(50_000);
        expect(_parseRetryAfter(resp({}))).toBeNull();
    });
});

// ── _httpErrorFromResponse — the fix for bare "HTTP 400" swallowing retryable detail ──
describe('_httpErrorFromResponse — extracts provider error detail instead of a bare status', () => {
    const mockResp = (status, body, headers = {}) => ({
        status,
        headers: { get: k => headers[k] ?? null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    it('extracts OpenAI-style {error:{message}}', async () => {
        const e = await _httpErrorFromResponse(mockResp(400, { error: { message: 'invalid request: bad schema' } }));
        expect(e.message).toBe('HTTP 400: invalid request: bad schema');
        expect(e.status).toBe(400);
    });

    it('extracts generic {message} / {detail} shapes', async () => {
        expect((await _httpErrorFromResponse(mockResp(400, { message: 'oops' }))).message).toBe('HTTP 400: oops');
        expect((await _httpErrorFromResponse(mockResp(400, { detail: 'oops2' }))).message).toBe('HTTP 400: oops2');
    });

    it('unwraps OpenRouter-style nested error.metadata.raw', async () => {
        const body = { error: { message: 'top', metadata: { raw: JSON.stringify({ error: { message: 'rate limited by upstream' } }) } } };
        const e = await _httpErrorFromResponse(mockResp(400, body));
        expect(e.message).toContain('rate limited by upstream');
    });

    it('falls back to a raw text snippet when the body is not JSON', async () => {
        const e = await _httpErrorFromResponse(mockResp(400, 'plain text failure detail'));
        expect(e.message).toBe('HTTP 400: plain text failure detail');
    });

    it('falls back to a bare status when the body is truly empty — no detail to extract', async () => {
        const e = await _httpErrorFromResponse(mockResp(400, ''));
        expect(e.message).toBe('HTTP 400');
    });

    it('prepends the optional prefix', async () => {
        const e = await _httpErrorFromResponse(mockResp(400, ''), '[nvidia|nemotron]');
        expect(e.message).toBe('[nvidia|nemotron] HTTP 400');
    });

    it('picks up retryAfterMs from headers when present', async () => {
        const e = await _httpErrorFromResponse(mockResp(429, '', { 'retry-after': '30' }));
        expect(e.retryAfterMs).toBe(30_000);
    });

    it('the extracted detail is what makes isTransient() classify it correctly (the actual bug)', async () => {
        // Before this fix, callLLMComplete's bare "HTTP 400" could never match isTransient's
        // patterns regardless of the real underlying cause — the detail never reached it.
        const e = await _httpErrorFromResponse(mockResp(400, { error: { message: 'rate limit exceeded, please retry' } }));
        expect(isTransient(e)).toBe(true);
    });
});
