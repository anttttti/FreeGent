// exec-sandbox/tools.ts: a downloaded file runs only when it is the pinned one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadTool, TOOLS } from '../exec-sandbox/tools';

afterEach(() => vi.unstubAllGlobals());

describe('pinned tools', () => {
    it('refuse a file whose length or SHA-256 is not the pin, and say which tools exist for an unknown name', async () => {
        const wrongLength = new TextEncoder().encode('console.log("evil")');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => wrongLength.buffer })));
        await expect(loadTool('pdf-lib')).rejects.toThrow(/length mismatch/);
        const sameLength = new Uint8Array(TOOLS['pdf-lib'].files.js.length).fill(97);   // right size, wrong bytes
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => sameLength.buffer })));
        await expect(loadTool('pdf-lib')).rejects.toThrow(/SHA-256 mismatch/);
        await expect(loadTool('nope')).rejects.toThrow(/available: pdf-lib/);
    });
});
