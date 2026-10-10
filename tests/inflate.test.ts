import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from '../inflate.js';

describe('inflate fallback', () => {
    it('decodes gzip output (dynamic, fixed, stored)', () => {
        const big = new TextEncoder().encode(JSON.stringify({ a: Array.from({ length: 5000 }, (_, i) => ({ i, s: 'x'.repeat(i % 50) })) }));
        for (const input of [big, new TextEncoder().encode('hi'), new Uint8Array(0), new Uint8Array(randomBytes(70000))]) {
            for (const level of [0, 1, 9]) {
                expect(Buffer.from(gunzipSync(new Uint8Array(gzipSync(input, { level }))))).toEqual(Buffer.from(input));
            }
        }
    });
});
