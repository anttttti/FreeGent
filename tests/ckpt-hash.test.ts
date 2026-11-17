import { describe, it, expect } from 'vitest';
import { hashContent } from '../local-sync.ts';

// The checkpoint's change detector must tell same-length edits apart: `Aa` and `BB` collide under h = 31*h + c.
describe('checkpoint content hash', () => {
    it('differs for same-length edits that the old 31-multiplier hash could not tell apart', () => {
        expect(hashContent('x = Aa;')).not.toBe(hashContent('x = BB;'));
        expect(hashContent('abc')).toBe(hashContent('abc'));
    });
    // The sync base (IndexedDB) stores these strings: a changed function makes every file look edited at the next sync (refcompare 2026-11-17, RC-10: a retyped file changed one constant and nothing failed).
    it('keeps its values, because saved sync bases hold them', () => {
        expect(['', 'abc', 'x = Aa;'].map(hashContent)).toEqual(['wvjl67o803:0', '1dtlchkfkb1:3', '157hzdoyk26:7']);
    });
});
