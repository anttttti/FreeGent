// Tests for model-router.ts — cooldown state machine, selection, rotation, and
// endpoint construction. Direct module imports; cooldown maps are module state, so
// tests clean up the keys they touch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    _endpointCooldown, _endpointHits, _endpointNeedsProbe,
    _markCooldown, _markFlatCooldown, _isCoolingDown, getCooldownRemaining,
    _anyFreeSpec, _nextRotationSpec, specToEndpoint, getRateLimitFallbackEndpoint,
    _switchToFreeModel,
    _isRateLimit, _isServerError,
    recordSuccess,
} from '../model-router.ts';

// getActiveMainModelList/saveMainModelList are plain globals from config.ts (loaded into
// window by tests/setup.js), not exports of model-router.ts — see its no-import module header.

const KEY = 'testprov|test-model';
const EP  = { provider: 'testprov', model: 'test-model' };

afterEach(() => {
    _endpointCooldown.delete(KEY);
    _endpointHits.delete(KEY);
    _endpointNeedsProbe.delete(KEY);
    localStorage.clear();
});

describe('cooldown state machine', () => {
    it('exponential backoff: consecutive marks grow the delay', () => {
        // recordSuccess must be called before each _markCooldown so the backoff path
        // is taken (hadSuccess=true). Without it, the penalty path applies both times
        // and both cooldowns land at the same RATE_LIMIT_PENALTY_MS value, making
        // second === first instead of second > first.
        recordSuccess(EP);
        _markCooldown(EP);
        const first = _endpointCooldown.get(KEY) - Date.now();
        recordSuccess(EP);
        _markCooldown(EP);
        const second = _endpointCooldown.get(KEY) - Date.now();
        expect(second).toBeGreaterThan(first);
        expect(_isCoolingDown(EP)).toBe(true);
        expect(getCooldownRemaining(KEY)).toBeGreaterThan(0);
    });
    it('expiry clears state and flags the endpoint for probing', () => {
        _endpointCooldown.set(KEY, Date.now() - 1000); // already expired
        expect(_isCoolingDown(EP)).toBe(false);
        expect(_endpointCooldown.has(KEY)).toBe(false);
        expect(_endpointNeedsProbe.has(KEY)).toBe(true);
    });
    it('flat cooldown uses the short custom-endpoint base', () => {
        _markFlatCooldown({ provider: 'custom', model: 'm' });
        const rem = getCooldownRemaining('custom|m');
        expect(rem).toBeGreaterThan(0);
        expect(rem).toBeLessThanOrEqual(6);
        _endpointCooldown.delete('custom|m');
    });
});

describe('error classifiers', () => {
    it('classifies rate limits vs server errors', () => {
        expect(_isRateLimit('HTTP 429 too many requests')).toBe(true);
        expect(_isRateLimit('HTTP 500')).toBe(false);
        expect(_isServerError('HTTP 502: bad gateway')).toBe(true);
        expect(_isServerError('connection refused')).toBe(true);
        expect(_isServerError('invalid json')).toBe(false);
    });
});

// getMainModelList() validates specs against the catalog — register the fakes as
// custom models (same trick headless-runner uses for arbitrary --model values).
function registerFakeModels(...specs) {
    localStorage.setItem('fg_custom_models', JSON.stringify(specs.map(s => {
        const [provider, model] = s.split('|');
        return { provider, model, label: model, released: '', contextK: 8, params: 0,
                 media: ['text'], tools: true, thinking: false, note: 'test' };
    })));
    localStorage.setItem('fg_main_models', JSON.stringify(specs));
}

describe('selection & rotation', () => {
    it('_anyFreeSpec skips the current key and cooled-down candidates', () => {
        registerFakeModels('groq|a', 'groq|b', 'groq|c');
        _endpointCooldown.set('groq|b', Date.now() + 60_000);
        expect(_anyFreeSpec('groq|a')).toBe('groq|c');
        _endpointCooldown.delete('groq|b');
    });
    it('_nextRotationSpec counts steps in the INJECTED state object', () => {
        localStorage.setItem('fg_endpoint_rotation', 'true');
        localStorage.setItem('fg_rotation_step_n', '2');
        registerFakeModels('groq|a', 'groq|b');
        const rot = { step: 0 };
        expect(_nextRotationSpec('groq|a', rot)).toBeNull(); // step 1 of 2
        expect(rot.step).toBe(1);
        expect(_nextRotationSpec('groq|a', rot)).toBeNull(); // step 2 of 2
        const next = _nextRotationSpec('groq|a', rot);        // exceeds N → switch
        expect(next).toBe('groq|b');
        expect(rot.step).toBe(0); // reset after switch
    });
});

describe('getRateLimitFallbackEndpoint', () => {
    it('returns a genuinely-free main-list model beyond index 0', () => {
        registerFakeModels('groq|a', 'groq|b', 'groq|c');
        const fb = getRateLimitFallbackEndpoint();
        expect(fb.model).toBe('b'); // first free candidate after index 0
    });
    it('returns null when the only fallback candidates are all cooling', () => {
        registerFakeModels('groq|a', 'groq|b', 'groq|c');
        _endpointCooldown.set('groq|b', Date.now() + 60_000);
        _endpointCooldown.set('groq|c', Date.now() + 30_000);
        // The actual bug: this used to fall through to "least-bad cooling-down candidate" and
        // return it as if it were a real fallback — indistinguishable from a genuinely-free one to
        // callers, which switch to it immediately with no delay. Confirmed as the mechanism behind
        // rapid, no-delay retries against a model that was never actually usable.
        expect(getRateLimitFallbackEndpoint()).toBeNull();
        _endpointCooldown.delete('groq|b'); _endpointCooldown.delete('groq|c');
    });
});

describe('_switchToFreeModel', () => {
    // updateActiveModelDisplay lives in settings-ui.ts, which tests/setup.js doesn't load —
    // only reached on the true-return (switch actually happened) path.
    it('promotes the first genuinely-free model to the front of the main list', () => {
        window.updateActiveModelDisplay = vi.fn();
        registerFakeModels('groq|a', 'groq|b', 'groq|c');
        _endpointCooldown.set('groq|a', Date.now() + 60_000);
        _endpointCooldown.set('groq|b', Date.now() + 30_000);
        expect(_switchToFreeModel()).toBe(true);
        expect(getActiveMainModelList()[0]).toBe('groq|c');
        _endpointCooldown.delete('groq|a'); _endpointCooldown.delete('groq|b');
    });
    // The actual bug: this used to default to workerList[0] unconditionally and only
    // override it if a free candidate turned up — so with every model cooling down,
    // it still promoted a still-cooling model to the front AND persisted that choice via
    // saveMainModelList(), making every subsequent turn keep preferring an unusable model.
    it('returns false and leaves the main list untouched when no model is free', () => {
        registerFakeModels('groq|a', 'groq|b', 'groq|c');
        _endpointCooldown.set('groq|a', Date.now() + 60_000);
        _endpointCooldown.set('groq|b', Date.now() + 60_000);
        _endpointCooldown.set('groq|c', Date.now() + 30_000);
        expect(_switchToFreeModel()).toBe(false);
        expect(getMainModelList()).toEqual(['groq|a', 'groq|b', 'groq|c']);
        _endpointCooldown.delete('groq|a'); _endpointCooldown.delete('groq|b'); _endpointCooldown.delete('groq|c');
    });
    it('returns false when all models are paused (active list empty)', () => {
        registerFakeModels('groq|a', 'groq|b');
        localStorage.setItem('fg_paused_main', JSON.stringify(['groq|a', 'groq|b']));
        expect(_switchToFreeModel()).toBe(false);
    });
});

describe('specToEndpoint', () => {
    it('builds provider endpoints from spec strings', () => {
        const ep = specToEndpoint('groq|llama-x');
        expect(ep.provider).toBe('groq');
        expect(ep.model).toBe('llama-x');
        expect(ep.url).toContain('groq.com');
    });
    it('google specs carry the OAI-compat URL and key', () => {
        localStorage.setItem('fg_gemini_key', 'gk-test');
        const ep = specToEndpoint('google|gemini-x');
        expect(ep.provider).toBe('google');
        expect(ep.model).toBe('gemini-x');
        expect(ep.url).toContain('generativelanguage.googleapis.com');
        expect(ep.key).toBe('gk-test');
    });
    it('unknown provider prefix falls back to custom with the CONFIGURED model (anti-404-loop)', () => {
        const ep = specToEndpoint('anthropic|claude-hallucinated');
        expect(ep.provider).toBe('custom');
        expect(ep.model).not.toBe('claude-hallucinated');
    });
});
