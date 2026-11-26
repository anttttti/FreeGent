// A search hit inside a base64 run is dropped (images, data: URLs); a match that itself holds a character base64 does not use is not inside one
// (Sol 6.2 review of 45f5b87: `!Q|Q` on 200 A's and `!QQ` lost the last Q).
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
const W = globalThis as any;

describe('search_workspace and base64 runs', () => {
    it('a regex whose match includes a non-base64 character is found', async () => {
        await W.agentWriteFile('blob.txt', 'A'.repeat(200) + '!QQ\n');
        const r = await W.executeToolAsync('search_workspace', { pattern: '!Q|Q', is_regex: true }, null);
        expect(JSON.stringify(r)).toContain('blob.txt');
    });
    it('a plain run of data with the pattern inside it is still dropped', async () => {
        await W.agentWriteFile('data.txt', 'A'.repeat(100) + 'needle' + 'B'.repeat(100) + '\n');
        const r = await W.executeToolAsync('search_workspace', { pattern: 'needle' }, null);
        expect(JSON.stringify(r)).not.toContain('data.txt');
    });
});
