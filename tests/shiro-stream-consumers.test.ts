// stream/consumers in the browser shell against Node's own (Z013): a character split across chunks, a leading BOM, and chunks that are views into a larger buffer.
import { describe, it, expect } from 'vitest';
import { text, json, buffer, arrayBuffer } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { createStreamModule } from '../shiro/node-compat/modules/stream';

const shim = createStreamModule().consumers;
async function* gen(chunks: any[]) { for (const c of chunks) yield c; }
const enc = (s: string) => new TextEncoder().encode(s);
const cases: [string, () => any[]][] = [
    ['a character split across two chunks', () => { const b = enc('é€😀'); return [b.slice(0, 2), b.slice(2, 4), b.slice(4)]; }],
    ['a leading BOM', () => [Uint8Array.from([0xef, 0xbb, 0xbf]), enc('{"a":1}')]],
    ['views into a larger buffer', () => { const big = enc('xxHELLOyy'); return [big.subarray(2, 7)]; }],
    ['strings and bytes mixed', () => ['ab', enc('cd')]],
];

describe('stream consumers', () => {
    for (const [name, make] of cases) it(`${name}: text, buffer and arrayBuffer equal Node's`, async () => {
        expect(await shim.text(gen(make()))).toBe(await text(Readable.from(make(), { objectMode: false })));
        expect([...(await shim.buffer(gen(make())))]).toEqual([...(await buffer(Readable.from(make())))]);
        expect([...new Uint8Array(await shim.arrayBuffer(gen(make())))]).toEqual([...new Uint8Array(await arrayBuffer(Readable.from(make())))]);
    });
    it('json decodes the whole stream once', async () => {
        const b = enc('{"k":"é€"}');
        expect(await shim.json(gen([b.slice(0, 7), b.slice(7)]))).toEqual({ k: 'é€' });
        expect(await json(Readable.from([b.slice(0, 7), b.slice(7)]))).toEqual({ k: 'é€' });
    });
});
