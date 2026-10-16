import { describe, it, expect, vi, afterEach } from 'vitest';
import { markModelRefusesImages, modelRefusesImages, clearImageRefusals, stripImageParts } from '../payload-builder.ts';
import { IMAGE_REFUSAL_RE } from '../retry.js';

afterEach(() => { clearImageRefusals(); vi.useRealTimers(); });

describe('a model that refuses images', () => {
    it('is recognised from the server wording', () => {
        expect(IMAGE_REFUSAL_RE.test('HTTP 400: At most 0 image(s) may be provided in one prompt. (parameter=image)')).toBe(true);
        expect(IMAGE_REFUSAL_RE.test('HTTP 400: maximum context length is 30000 tokens')).toBe(false);
    });
    it('is remembered, expires after ten minutes, and is cleared when the model list changes', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
        markModelRefusesImages('custom|m');
        expect(modelRefusesImages('custom|m')).toBe(true);
        vi.setSystemTime(new Date('2026-10-17T00:09:00Z'));
        expect(modelRefusesImages('custom|m')).toBe(true);
        vi.setSystemTime(new Date('2026-10-17T00:11:00Z'));
        expect(modelRefusesImages('custom|m')).toBe(false);
        markModelRefusesImages('custom|m'); (globalThis as any).clearImageRefusals();
        expect(modelRefusesImages('custom|m')).toBe(false);
    });
    it('sends the image as a text note', () => {
        const out = stripImageParts([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }, { type: 'text', text: 'hi' }] }, { role: 'assistant', content: 'ok' }]);
        expect(JSON.stringify(out)).not.toContain('data:x');
        expect(out[0].content[0]).toEqual({ type: 'text', text: '[image omitted: this model does not accept images]' });
        expect(out[1].content).toBe('ok');
    });
});
