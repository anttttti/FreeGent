// shiro/utils/bytes.ts and the shell's workspace filesystem (fg-filesystem.ts): file and pipe
// data round-trip byte for byte — CRLF, BOM, Latin-1 and binary included. The end-to-end
// comparison with real bash is scripts/shell-diff.sh (fixtures/enc).
import { vi } from 'vitest';
import { bytesToText, textToBytes, normalizeBytes, byteChar, toDisplayText, isTextBytes } from '../shiro/utils/bytes';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));
import { FWFileSystem } from '../shiro/fg-filesystem';

const samples: Record<string, number[]> = {
    utf8:    [...new TextEncoder().encode('café 中文 😀 💀')],
    crlf:    [97, 13, 10, 98, 13, 10, 13, 99],
    bom:     [0xef, 0xbb, 0xbf, 104, 105],
    latin1:  [99, 97, 102, 0xe9, 10],
    binary:  [...Array(256).keys()],
    broken:  [0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0xed, 0xa0, 0x80, 0xc0, 0xaf],
};

describe('bytesToText / textToBytes', () => {
    it.each(Object.keys(samples))('round-trips %s exactly', name => {
        const bytes = Uint8Array.from(samples[name]);
        expect([...textToBytes(bytesToText(bytes))]).toEqual(samples[name]);
    });

    it('decodes valid UTF-8 to its characters, BOM included, and escapes only invalid bytes', () => {
        expect(bytesToText(Uint8Array.from(samples.bom))).toBe('﻿hi');
        expect(bytesToText(Uint8Array.from(samples.latin1))).toBe('caf\udce9\n');
        // a valid pair whose low half lies in the escape range is a character, not a byte
        expect([...textToBytes('💀')]).toEqual([0xf0, 0x9f, 0x92, 0x80]);
    });

    it('turns escaped bytes that form UTF-8 into characters, and shows the rest as U+FFFD', () => {
        expect(normalizeBytes(byteChar(0xc3) + byteChar(0xa9))).toBe('é');
        expect(normalizeBytes(byteChar(0xe9))).toBe('\udce9');
        expect(toDisplayText('caf\udce9')).toBe('caf�');
    });

    it('isTextBytes: UTF-8 without NULs', () => {
        expect(isTextBytes(Uint8Array.from(samples.utf8))).toBe(true);
        expect(isTextBytes(Uint8Array.from(samples.latin1))).toBe(false);
        expect(isTextBytes(Uint8Array.from([97, 0, 98]))).toBe(false);
    });
});

describe('FWFileSystem keeps workspace bytes', () => {
    beforeEach(() => files.clear());

    it.each(Object.keys(samples))('writes, reads, copies and appends %s exactly', async name => {
        const fs = new FWFileSystem();
        const bytes = Uint8Array.from(samples[name]);
        await fs.writeFile('/workspace/f', bytes);
        expect([...(await fs.readFile('/workspace/f') as Uint8Array)]).toEqual(samples[name]);
        expect((await fs.stat('/workspace/f')).size).toBe(bytes.length);
        // as text (cat, pipes) and back (redirects)
        await fs.writeFile('/workspace/g', await fs.readFile('/workspace/f', 'utf8') as string);
        expect([...(await fs.readFile('/workspace/g') as Uint8Array)]).toEqual(samples[name]);
        await fs.appendFile('/workspace/g', 'x\n');
        expect([...(await fs.readFile('/workspace/g') as Uint8Array)]).toEqual([...samples[name], 120, 10]);
    });

    it('stores UTF-8 text as text records and everything else as base64', async () => {
        const fs = new FWFileSystem();
        await fs.writeFile('/workspace/t.txt', Uint8Array.from(samples.crlf));
        await fs.writeFile('/workspace/l.txt', Uint8Array.from(samples.latin1));
        expect(files.get('t.txt')).toEqual({ content: 'a\r\nb\r\n\rc', encoding: null });
        expect(files.get('l.txt')!.encoding).toBe('base64');
    });
});
