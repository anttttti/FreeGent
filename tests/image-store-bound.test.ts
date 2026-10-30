// codex R189: the inline image store kept every image a page ever wrote, read or generated, with no bound.
import { describe, it, expect } from 'vitest';
const W = window as any;

describe('inline image store', () => {
    it('keeps the newest images within its budget and drops the oldest first', () => {
        for (const k of Object.keys(W._pyodideImageStore)) delete W._pyodideImageStore[k];
        const big = 'data:image/png;base64,' + 'A'.repeat(10_000_000);
        for (let i = 0; i < 8; i++) W.rememberImage(`img_${i}`, big);
        const keys = Object.keys(W._pyodideImageStore);
        expect(keys.length).toBeLessThan(8);
        expect(keys).toContain('img_7');
        expect(keys).not.toContain('img_0');
        // rewriting a path moves it to the newest place instead of counting it twice
        W.rememberImage('img_4', big);
        W.rememberImage('img_8', big);
        expect(Object.keys(W._pyodideImageStore)).toContain('img_4');
    });
    it('a read_file of an image goes through the store', async () => {
        W.agentReadFile = async () => 'data:image/png;base64,iVBOR';
        const r = await W.executeToolAsync('read_file', { path: 'pics/a.png' }, null);
        expect(r.display).toBe('[IMAGE:img_pics_a_png]');
        expect(W._pyodideImageStore.img_pics_a_png).toBe('data:image/png;base64,iVBOR');
    });
});
