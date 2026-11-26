// codex R297-R301, R305: dd on bytes.
import { describe, it, expect, vi, beforeAll } from 'vitest';
const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));
import { getShell } from '../shiro/shell-singleton';
let sh: any;
const run = async (cmd: string) => { const r = await sh.exec(cmd); return { out: r.stdout, err: r.stderr, code: r.exitCode ?? 0 }; };
const bytes = (p: string) => { const f = files.get(p)!; return f.encoding === 'base64' ? new Uint8Array(Buffer.from(f.content, 'base64')) : new TextEncoder().encode(f.content); };
const put = (p: string, b: number[]) => files.set(p, { content: Buffer.from(b).toString('base64'), encoding: 'base64' });
beforeAll(async () => { sh = await getShell(); });

describe('dd', () => {
    it('copies invalid UTF-8 unchanged (R301)', async () => {
        put('in.bin', [0x41, 0xff, 0xfe, 0x42, 0xc3]);
        expect((await run('dd if=in.bin of=out.bin status=none')).code).toBe(0);
        expect([...bytes('out.bin')]).toEqual([0x41, 0xff, 0xfe, 0x42, 0xc3]);
    });
    it('conv=ucase changes ASCII letters only (R298)', async () => {
        put('u.bin', [0x61, 0xdf, 0x7a, 0xe9]);
        await run('dd if=u.bin of=U.bin conv=ucase status=none');
        expect([...bytes('U.bin')]).toEqual([0x41, 0xdf, 0x5a, 0xe9]);
    });
    it('conv=notrunc keeps the rest of the output (R297)', async () => {
        files.set('big.txt', { content: 'abcdefgh', encoding: null }); files.set('two.txt', { content: 'XY', encoding: null });
        await run('dd if=two.txt of=big.txt bs=1 seek=2 conv=notrunc status=none');
        expect(new TextDecoder().decode(bytes('big.txt'))).toBe('abXYefgh');
        await run('dd if=two.txt of=big.txt bs=1 seek=2 status=none');
        expect(new TextDecoder().decode(bytes('big.txt'))).toBe('abXY');
    });
    it('reads more than 64 KiB of random data (R299)', async () => {
        const r = await run('dd if=/dev/urandom of=r.bin bs=1M count=1 status=none');
        expect(r.code).toBe(0);
        expect(bytes('r.bin').length).toBe(1024 * 1024);
    });
    it('reports the records copied, not the count asked for (R300)', async () => {
        files.set('s.txt', { content: '12345', encoding: null });
        const r = await run('dd if=s.txt of=o.txt bs=2 count=10');
        expect(r.err).toMatch(/^2\+1 records in\n2\+1 records out\n5 bytes copied/);
    });
    // X005: input and output block sizes are separate; the expected files are GNU dd 8.32's own results for the same command lines.
    it('counts skip and count in input blocks and seek in output blocks, whatever the order of ibs, obs and bs', async () => {
        const out = async (args: string) => {
            files.set('in.txt', { content: 'abcdefghijklmnop', encoding: null }); files.set('o.txt', { content: 'ABCDEFGHIJKL', encoding: null });
            await run(`dd if=in.txt of=o.txt ${args} status=none`);
            return new TextDecoder().decode(bytes('o.txt'));
        };
        expect(await out('ibs=2 obs=4 count=2')).toBe('abcd');
        expect(await out('obs=4 ibs=2 count=2')).toBe('abcd');
        expect(await out('obs=4 count=1')).toBe('abcdefghijklmnop');          // the one input block is the default 512 bytes
        expect(await out('ibs=4 skip=1 count=2')).toBe('efghijkl');
        expect(await out('ibs=2 obs=4 skip=2 count=1 seek=1 conv=notrunc')).toBe('ABCDefGHIJKL');
        expect(await out('bs=4 ibs=2 count=3')).toBe('abcdefghijkl');         // bs= overrides ibs=
        expect(bytes('o.txt').length).toBe(12);
        expect((await out('ibs=2 count=2 seek=1')).length).toBe(516);         // seek counts default 512-byte output blocks
    });
    it('refuses a malformed size (R305)', async () => {
        files.set('k.txt', { content: 'keep me intact', encoding: null });
        const r = await run('dd if=/dev/zero of=k.txt bs=4banana count=1');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/invalid number: '4banana'/);
        expect(files.get('k.txt')!.content).toBe('keep me intact');
    });
});

describe('dd block sizes (00eb2e1#9)', () => {
    it('count= is in input blocks: ibs=2 obs=4 count=1 copies two bytes', async () => {
        files.set('long.txt', { content: 'abcdefgh', encoding: null });
        await run('dd if=long.txt of=cnt.txt ibs=2 obs=4 count=1 status=none');
        expect(files.get('cnt.txt')!.content).toBe('ab');
    });
});
