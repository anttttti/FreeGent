import { describe, it, expect } from 'vitest';
import { createHmac as nodeHmac, createHash as nodeHash } from 'node:crypto';
import { createCryptoModule } from '../shiro/node-compat/modules/crypto';
import { sha256 as sha256sync } from '../shiro/commands/checksums';
import { sha1sync, fnvHash } from '../shiro/commands/jseval/crypto';
import { createFakeBuffer } from '../shiro/node-compat/buffer';

// Night exploration N011-N013: the shell's crypto returned digests it did not compute, kept the caller's buffer instead of its bytes, and ignored fill ranges.
const c: any = createCryptoModule({ sha256sync, sha1sync, fnvHash, FakeBuffer: createFakeBuffer() } as any);

describe('shell crypto', () => {
    it('HMAC matches Node for short, block-sized and long keys', () => {
        for (const algo of ['sha256', 'sha1']) for (const key of ['k', 'x'.repeat(64), 'y'.repeat(200)])
            expect(c.createHmac(algo, key).update('a message').update('!').digest('hex')).toBe(nodeHmac(algo, key).update('a message!').digest('hex'));
    });
    it('refuses a digest it cannot compute instead of inventing one', () => {
        expect(() => c.createHash('sha512')).toThrow(/not supported/);
        expect(() => c.createHmac('sha512', 'k')).toThrow(/Invalid digest/);
        expect(c.createHash('SHA256').update('abc').digest('hex')).toBe(nodeHash('sha256').update('abc').digest('hex'));
    });
    it('hashes the bytes given to update(), not the buffer the caller goes on to reuse', () => {
        const buf = new Uint8Array([1, 2, 3]); const h = c.createHash('sha256'); h.update(buf); buf.fill(9);
        expect(h.digest('hex')).toBe(nodeHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'));
    });
    it('randomBytes may exceed 64 KiB, and randomFillSync fills only the range asked for', () => {
        expect(c.randomBytes(200_000).length).toBe(200_000);
        const b = new Uint8Array(200_000); c.randomFillSync(b, 100, 70_000);
        expect([...b.subarray(0, 100)].every(x => x === 0)).toBe(true);
        expect([...b.subarray(70_100)].every(x => x === 0)).toBe(true);
        expect([...b.subarray(100, 70_100)].some(x => x !== 0)).toBe(true);
    });
});
