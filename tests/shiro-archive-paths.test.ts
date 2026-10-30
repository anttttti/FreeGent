// codex R273/R285/R286/R289: archive members whose names leave the extraction directory: npm's tarball extractor joined them as given,
// tar's hardlink sources and its legacy format skipped the ".." check, and unzip took "/x" as absolute, outside its -d directory.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));
import { getShell } from '../shiro/shell-singleton';
import { memberPath } from '../shiro/utils/archive-path';

const py = (code: string): Buffer => execFileSync('python3', ['-c', code], { maxBuffer: 1 << 24 });
const hasPy = spawnSync('python3', ['--version']).status === 0;
let sh: any;
const run = async (cmd: string) => { const r = await sh.exec(cmd); return { out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr.replace(/\r\n/g, '\n'), code: r.exitCode ?? 0 }; };
const put = (name: string, b: Buffer) => files.set(name, { content: b.toString('base64'), encoding: 'base64' });

describe('memberPath', () => {
    it('keeps names inside the directory', () => {
        expect(memberPath('/abs/x.txt')).toBe('abs/x.txt');
        expect(memberPath('./a//b/')).toBe('a/b');
        expect(memberPath('package/../../AGENTS.md')).toBeNull();
        expect(memberPath('..')).toBeNull();
        expect(memberPath('')).toBeNull();
    });
});

describe.skipIf(!hasPy)('extractors keep members inside the destination', () => {
    beforeAll(async () => { sh = await getShell(); });
    it('tar: a hard link to a file above -C is not followed (R286)', async () => {
        files.set('private.txt', { content: 'SECRET', encoding: null });
        put('link.tar', py(`import tarfile,io,sys
b=io.BytesIO(); t=tarfile.open(fileobj=b,mode='w')
i=tarfile.TarInfo('copy.txt'); i.type=tarfile.LNKTYPE; i.linkname='../private.txt'; t.addfile(i)
t.close(); sys.stdout.buffer.write(b.getvalue())`));
        await run('mkdir -p out');
        const r = await run('tar -xf link.tar -C out');
        expect(r.err).toMatch(/leaves the extraction directory/);
        expect(files.has('out/copy.txt')).toBe(false);
    });
    it('tar: the legacy format refuses ".." names (R285)', async () => {
        files.set('old.tar', { content: 'FLUFFY-TAR-V1\nFILE:../escaped.txt\nSIZE:1\nTYPE:file\nDATA-START\nX\nDATA-END\n', encoding: null });
        await run('mkdir -p sub');
        const r = await run('tar -xf old.tar -C sub');
        expect(r.err).toMatch(/contains '\.\.'/);
        expect(files.has('escaped.txt')).toBe(false);
    });
    it('unzip: an absolute member name lands inside -d (R289)', async () => {
        put('abs.zip', py(`import zipfile,io,sys
b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); zi=zipfile.ZipInfo('x'); zi.filename='/project.txt'; z.writestr(zi,'Z'); z.close(); sys.stdout.buffer.write(b.getvalue())`));
        const r = await run('unzip -o abs.zip -d nested');
        expect(r.err).toMatch(/stripped absolute path spec/);
        expect(files.has('nested/project.txt')).toBe(true);
        expect(files.has('project.txt')).toBe(false);
    });
    it('npm: a package tarball member with ".." is refused (R273)', async () => {
        const { extractTarToFS } = await import('../shiro/utils/tar-utils');
        const tar = py(`import tarfile,io,sys
b=io.BytesIO(); t=tarfile.open(fileobj=b,mode='w')
d=b'owned'; i=tarfile.TarInfo('package/../../AGENTS.md'); i.size=len(d); t.addfile(i,io.BytesIO(d))
t.close(); sys.stdout.buffer.write(b.getvalue())`);
        const written: string[] = [];
        const fsw: any = { mkdir: async () => {}, writeFile: async (p: string) => { written.push(p); }, exists: async () => false };
        await expect(extractTarToFS(new Uint8Array(tar), '/workspace/node_modules/evil', fsw)).rejects.toThrow(/leaves the package directory/);
        expect(written).toEqual([]);
    });
});

// codex R287: decompression kept every decoded chunk, without a ceiling.
describe('decompression has a ceiling', () => {
    it('transformBytes stops past its limit', async () => {
        const { transformBytes } = await import('../shiro/utils/streams');
        const big = new Uint8Array(2 * 1024 * 1024);
        const id = new TransformStream<Uint8Array, Uint8Array>();
        await expect(transformBytes(id as any, big, 1024 * 1024)).rejects.toThrow(/expands to more than 1 MB/);
        expect((await transformBytes(new TransformStream() as any, new Uint8Array(10), 1024)).length).toBe(10);
    });
});

// codex R290/R291/R294/R296: zip replaced a corrupt archive, put the archive into itself and with -m deleted it (or files it skipped),
// and unzip extracted a trailing -d into the current directory.
describe('zip / unzip edge cases', () => {
    beforeAll(async () => { sh = await getShell(); });
    it('zip refuses a corrupt archive instead of replacing it (R290)', async () => {
        files.set('bad.zip', { content: 'junk', encoding: null }); files.set('a.txt', { content: 'a', encoding: null });
        const r = await run('zip -q bad.zip a.txt');
        expect(r.code).toBe(3);
        expect(files.get('bad.zip')!.content).toBe('junk');
    });
    it('zip -m * leaves out the archive itself and keeps it (R296)', async () => {
        for (const k of [...files.keys()]) files.delete(k);
        files.set('w/x.txt', { content: 'x', encoding: null });
        await run('cd /workspace/w && zip -q arch.zip x.txt');
        files.set('w/y.txt', { content: 'y', encoding: null });
        const r = await run('cd /workspace/w && zip -q -m arch.zip *');
        expect(r.code).toBe(0);
        expect(files.has('w/arch.zip')).toBe(true);
        expect(files.has('w/y.txt')).toBe(false);
        const l = await run('cd /workspace/w && unzip -l arch.zip');
        expect(l.out).not.toMatch(/\d\d:\d\d\s+arch\.zip/);
    });
    it('zip -m -u removes only the files it put in (R294)', async () => {
        for (const k of [...files.keys()]) files.delete(k);
        files.set('u/old.txt', { content: 'old', encoding: null });
        await run('cd /workspace/u && zip -q arch.zip old.txt');
        files.set('u/new.txt', { content: 'new', encoding: null });
        await run('cd /workspace/u && zip -q -m -u arch.zip old.txt new.txt');
        expect(files.has('u/old.txt')).toBe(true);   // not newer than its archived copy: skipped, so kept
        expect(files.has('u/new.txt')).toBe(false);
    });
    it('unzip -d without a directory is an error (R291)', async () => {
        files.set('t.zip', files.get('u/arch.zip')!);
        const r = await run('unzip -o t.zip -d');
        expect(r.code).toBe(10);
        expect(r.err).toMatch(/must specify directory/);
    });
});
