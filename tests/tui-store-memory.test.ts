// A long TUI session (2.4 h, a 4 GB heap, then out of memory): old steps no longer hold their whole request.
import { describe, it, expect } from 'vitest';
import * as Store from '../tui-store.ts';

describe('step requests', () => {
    it('only the latest steps keep their whole request', () => {
        const t = Store.addTurn();
        const big = 'x'.repeat(100_000);
        const steps = Array.from({ length: 40 }, (_, i) => { const s = Store.addStep(t, 'Director ' + i); Store.patchStep(s, { request: big + i }); return s; });
        expect(steps[0].request!.length).toBeLessThan(7000);
        expect(steps[0].request).toContain('more characters dropped');
        expect(steps[39].request!.length).toBeGreaterThan(100_000);
        expect(steps[39 - 20].request!.length).toBeGreaterThan(100_000);
    });
});
