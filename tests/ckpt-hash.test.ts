import { describe, it, expect } from 'vitest';
import { hashContent } from '../local-sync.ts';

// The checkpoint's change detector must tell same-length edits apart: `Aa` and `BB` collide under h = 31*h + c.
describe('checkpoint content hash', () => {
    it('differs for same-length edits that the old 31-multiplier hash could not tell apart', () => {
        expect(hashContent('x = Aa;')).not.toBe(hashContent('x = BB;'));
        expect(hashContent('abc')).toBe(hashContent('abc'));
    });
});
