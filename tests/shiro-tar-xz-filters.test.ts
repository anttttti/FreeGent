// tar -xJ shares xzDecompress, so the filters and integrity checks apply to archives too (tasks/059).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));
import { getShell } from '../shiro/shell-singleton';

const have = (cmd: string) => spawnSync(cmd, ['--version']).status === 0;
let sh: any;
const run = async (cmd: string) => {
    const r = await sh.exec(cmd);
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    return { out: lf(r.stdout), err: lf(r.stderr), code: r.exitCode ?? 0 };
};
const archive = (xzArgs: string[]): Buffer => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-xz-'));
    try {
        writeFileSync(join(dir, 'note.txt'), 'task 059: filtered xz inside tar\n');
        writeFileSync(join(dir, 'prog.bin'), readFileSync(execFileSync('sh', ['-c', 'command -v ls']).toString().trim()).subarray(0, 20000));
        const tar = execFileSync('tar', ['-C', dir, '-cf', '-', 'note.txt', 'prog.bin'], { maxBuffer: 1 << 26 });
        return execFileSync('xz', ['-c', ...xzArgs], { input: tar, maxBuffer: 1 << 26 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe.skipIf(!have('xz') || !have('tar'))('tar -xJf with filtered / SHA-256 xz', () => {
    beforeAll(async () => { sh = await getShell(); });

    it('extracts archives compressed with BCJ, Delta and SHA-256', async () => {
        for (const [name, args] of [['x86', ['--x86', '--lzma2=preset=1']], ['sha256', ['--check=sha256']], ['delta+sha256', ['--delta=dist=2', '--check=sha256', '--lzma2=preset=1']]] as const) {
            files.set(`${name}.tar.xz`, { content: archive([...args]).toString('base64'), encoding: 'base64' });
            const r = await run(`tar -xJf ${name}.tar.xz && cat note.txt && wc -c < prog.bin`);
            expect(r, name).toEqual({ out: 'task 059: filtered xz inside tar\n20000\n', err: '', code: 0 });
            await run('rm -f note.txt prog.bin');
        }
    });

    it('refuses an archive whose SHA-256 digest was damaged, extracting nothing', async () => {
        const good = archive(['--check=sha256']);
        // The digest sits just before the index: block data, padding, 32-byte check, then the index and footer.
        const footerBackward = good.readUInt32LE(good.length - 8);   // index size, stored as (n/4 - 1)
        const indexSize = (footerBackward + 1) * 4;
        const bad = Buffer.from(good);
        bad[good.length - 12 - indexSize - 32] ^= 0x01;
        files.set('bad.tar.xz', { content: bad.toString('base64'), encoding: 'base64' });
        const r = await run('tar -xJf bad.tar.xz');
        expect(r.code).not.toBe(0);
        expect(r.err).toMatch(/SHA-256|checksum|corrupt/i);
    });

    it('the xz command reports the same failure with a nonzero exit, and decodes the good stream', async () => {
        const good = archive(['--check=sha256']);
        files.set('ok.tar.xz', { content: good.toString('base64'), encoding: 'base64' });
        expect((await run('xz -dc ok.tar.xz | wc -c')).code).toBe(0);
        expect((await run('xz -t ok.tar.xz')).code).toBe(0);
        const indexSize = (good.readUInt32LE(good.length - 8) + 1) * 4;
        const bad = Buffer.from(good); bad[good.length - 12 - indexSize - 32] ^= 0x01;
        files.set('digest.tar.xz', { content: bad.toString('base64'), encoding: 'base64' });
        for (const cmd of ['xz -dc digest.tar.xz', 'xz -t digest.tar.xz']) {
            const r = await run(cmd);
            expect(r.code, cmd).not.toBe(0);
            expect(r.err, cmd).toMatch(/SHA-256|checksum|corrupt/i);
        }
    });
});
