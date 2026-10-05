// The polyfills must behave like the natives they stand in for. Each is checked by deleting the
// native, loading the module, and comparing — so the fallback itself is what runs.
describe('polyfills', () => {
    const saved: Record<string, any> = {};
    beforeAll(async () => {
        for (const [o, n] of [[Array.prototype, 'at'], [Array.prototype, 'findLast'], [Array.prototype, 'findLastIndex'], [String.prototype, 'at'], [String.prototype, 'replaceAll'], [Object, 'hasOwn']] as any) {
            saved[`${o === Object ? 'O' : o === Array.prototype ? 'A' : 'S'}.${n}`] = o[n];
            delete o[n];
        }
        await import('../polyfills.ts');
    });
    it('Array findLast / findLastIndex / at', () => {
        expect([1, 2, 3, 4].findLast(x => x % 2)).toBe(3);
        expect([1, 2].findLast(x => x > 5)).toBeUndefined();
        expect([1, 2, 3, 2].findLastIndex(x => x === 2)).toBe(3);
        expect([1, 2, 3].at(-1)).toBe(3);
        expect([1, 2, 3].at(0)).toBe(1);
        expect([1, 2, 3].at(-4)).toBeUndefined();
        expect('abc'.at(-1)).toBe('c');
    });
    it('replaceAll and hasOwn', () => {
        expect('a.b.c'.replaceAll('.', '-')).toBe('a-b-c');
        expect('a$b$'.replaceAll('$', '$$')).toBe('a$b$');   // "$$" in the replacement means one "$", natively too
        expect('a.b'.replaceAll('.', (m: string) => m + m)).toBe('a..b');
        expect('aXbX'.replaceAll(/x/gi, '_')).toBe('a_b_');
        expect(() => 'a'.replaceAll(/a/, 'b')).toThrow(TypeError);
        expect(Object.hasOwn({ a: 1 }, 'a')).toBe(true);
        expect(Object.hasOwn({}, 'toString')).toBe(false);
    });
});
