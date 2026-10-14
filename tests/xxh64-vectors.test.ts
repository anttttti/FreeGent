// XXH64 (seed 0) known vectors, after the BigInt literals were replaced by lazily built BigInt() values.
import { describe, it, expect } from 'vitest';
import { xxh64 } from '../shiro/commands/checksums.ts';

const hex = (s: string) => xxh64(new TextEncoder().encode(s)).toString(16).padStart(16, '0');
describe('xxh64', () => {
    it('matches the reference vectors across the code paths (empty, <4, <8, <32, >=32 bytes)', () => {
        expect(hex('')).toBe('ef46db3751d8e999');
        expect(hex('a')).toBe('d24ec4f1a98c6e5b');
        expect(hex('abc')).toBe('44bc2cf5ad770999');
        expect(hex('Nobody inspects the spammish repetition')).toBe('fbcea83c8a378bf1');
    });
});
