// hermes C17: the model's merge answer is the first JSON object in its reply, wherever braces appear around it.
import { describe, it, expect, beforeAll } from 'vitest';
beforeAll(async () => { await import('../workers.ts'); });
describe('_firstJsonObject', () => {
    it('finds the object when prose with braces follows or precedes it', async () => {
        const { _firstJsonObject } = await import('../workers.ts');
        const merged = { 'a.txt': 'line1\nline2', 'b.js': 'const x = { y: 1 };' };
        const json = JSON.stringify(merged);
        for (const text of [json, `Here you go:\n${json}`, `${json}\nNote: I kept both {versions} of the loop.`, `Use {curly} braces. ${json} Done {really}.`, '```json\n' + json + '\n```'])
            expect(_firstJsonObject(text), text.slice(0, 40)).toEqual(merged);
    });
    it('braces inside strings do not end the object, and a broken first brace does not stop the search', async () => {
        const { _firstJsonObject } = await import('../workers.ts');
        expect(_firstJsonObject('{"f.js": "if (a) { b(); } // }"} trailing')).toEqual({ 'f.js': 'if (a) { b(); } // }' });
        expect(_firstJsonObject('a {not json} then {"ok": true}')).toEqual({ ok: true });
    });
    it('null when there is none', async () => {
        const { _firstJsonObject } = await import('../workers.ts');
        expect(_firstJsonObject('no object here')).toBeNull();
        expect(_firstJsonObject('{"unterminated": ')).toBeNull();
    });
    it('stays fast on a reply full of unmatched braces (hermes §26: was 5.8 s for 60k)', async () => {
        const { _firstJsonObject } = await import('../workers.ts');
        const t0 = Date.now();
        expect(_firstJsonObject('x'.repeat(60_000) + '{'.repeat(60_000))).toBeNull();
        expect(_firstJsonObject('{'.repeat(60_000) + '}')).toBeNull();
        expect(_firstJsonObject('{"a":1}' + '{'.repeat(60_000))).toEqual({ a: 1 });
        expect(Date.now() - t0).toBeLessThan(1000);
    });
});
