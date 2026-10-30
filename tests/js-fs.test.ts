// execute_code JavaScript sees the same /workspace as bash and Python (exec-sandbox/js-fs.ts).
import { describe, it, expect } from 'vitest';
import { createWorkspaceFs, path } from '../exec-sandbox/js-fs';

const ws = () => createWorkspaceFs({ 'a.txt': 'A', 'src/app.js': 'code', 'src/lib/util.js': 'u' });

describe('execute_code JavaScript fs', () => {
    it('reads a file by relative, ./, absolute and .. paths alike', () => {
        const { fs } = ws();
        for (const p of ['a.txt', './a.txt', '/workspace/a.txt', 'src/../a.txt', '/workspace/src/../a.txt'])
            expect(fs.readFileSync(p, 'utf8')).toBe('A');
        expect(fs.readFileSync(path.join('src', 'lib', 'util.js'), 'utf8')).toBe('u');
    });

    it('lists directories by any path form', () => {
        const { fs } = ws();
        expect(fs.readdirSync('/workspace')).toEqual(['a.txt', 'src']);
        expect(fs.readdirSync('.')).toEqual(['a.txt', 'src']);
        expect(fs.readdirSync('/workspace/src')).toEqual(['app.js', 'lib']);
        expect(fs.statSync('src').isDirectory()).toBe(true);
        expect(fs.statSync('/workspace/a.txt').isFile()).toBe(true);
        expect(fs.existsSync('/workspace/src/lib')).toBe(true);
        expect(fs.existsSync('nope.txt')).toBe(false);
    });

    it('records writes and deletions as workspace names', () => {
        const { fs, written, deleted } = ws();
        fs.mkdirSync('out');
        fs.writeFileSync('/workspace/out/b.txt', 'B');
        fs.appendFileSync('./a.txt', '+');
        fs.unlinkSync('/workspace/src/app.js');
        fs.renameSync('src/lib/util.js', 'util2.js');
        expect(written).toEqual({ 'out/b.txt': 'B', 'a.txt': 'A+', 'util2.js': 'u' });
        expect([...deleted].sort()).toEqual(['src/app.js', 'src/lib/util.js']);
        expect(fs.existsSync('src/app.js')).toBe(false);
    });

    it('rm -r removes a directory tree', () => {
        const { fs, deleted } = ws();
        fs.rmSync('/workspace/src', { recursive: true });
        expect([...deleted].sort()).toEqual(['src/app.js', 'src/lib/util.js']);
        expect(fs.existsSync('src')).toBe(false);
    });

    it('keeps paths outside /workspace out of the workspace', () => {
        const { fs, written } = ws();
        fs.writeFileSync('/tmp/scratch.txt', 'tmp');
        expect(fs.readFileSync('/tmp/scratch.txt', 'utf8')).toBe('tmp');
        expect(written).toEqual({});
    });

    it('has fs.promises and a /workspace cwd for path.resolve', async () => {
        const { fs } = ws();
        await fs.promises.writeFile('p.txt', 'P');
        expect(await fs.promises.readFile('/workspace/p.txt', 'utf8')).toBe('P');
        expect(path.resolve('x/y.js')).toBe('/workspace/x/y.js');
        expect(path.resolve('/tmp', 'z')).toBe('/tmp/z');
        expect(path.relative('/workspace/src', '/workspace/a.txt')).toBe('../a.txt');
        expect(path.extname('archive.tar.gz')).toBe('.gz');
        expect(path.extname('.bashrc')).toBe('');
    });

    it('reads binary files as bytes, or as text with an encoding, and writes bytes back', () => {
        const { fs, written } = createWorkspaceFs({ 'img.bin': { base64: btoa('\x00\x01hi') } });
        const bytes = fs.readFileSync('img.bin') as Uint8Array;
        expect([...bytes]).toEqual([0, 1, 104, 105]);
        expect(fs.readFileSync('/workspace/img.bin', 'utf8')).toBe('\x00\x01hi');
        expect(fs.statSync('img.bin').size).toBe(4);
        fs.writeFileSync('out.bin', new Uint8Array([255, 0]));
        expect(written['out.bin']).toEqual(new Uint8Array([255, 0]));
    });

    it('throws ENOENT for missing files', () => {
        const { fs } = ws();
        expect(() => fs.readFileSync('missing.txt')).toThrow(/ENOENT/);
    });

    it('file names that are also Object.prototype members are ordinary names (codex campaign 6, cases 039-040)', () => {
        const { fs, written } = createWorkspaceFs(Object.fromEntries([['constructor', 'C'], ['__proto__', 'P'], ['ordinary.txt', 'O']]));
        for (const name of ['toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
            expect(fs.existsSync(name), name).toBe(false);
            expect(() => fs.readFileSync(name), name).toThrow(/ENOENT/);
        }
        expect(fs.readFileSync('constructor', 'utf8')).toBe('C');
        expect(fs.readFileSync('__proto__', 'utf8')).toBe('P');
        expect(fs.readdirSync('.').sort()).toEqual(['__proto__', 'constructor', 'ordinary.txt']);
        fs.writeFileSync('__proto__', 'P2');
        expect(Object.entries(written)).toEqual([['__proto__', 'P2']]);
        fs.unlinkSync('constructor');
        expect(fs.existsSync('constructor')).toBe(false);
    });
});

// codex R191/R192: the sandbox's path helpers normalised before splitting and used a regex for the extension, so extname('foo.') was ''
// and basename('a/') was ''. They are Node's now, here and in the in-browser shell's `path` module.
describe('path.basename / dirname / extname agree with Node', async () => {
    const { posix } = await import('node:path');
    const { createPathModule } = await import('../shiro/node-compat/modules/path.ts');
    const shiroPath = createPathModule({ fs: { resolvePath: (a: string) => a }, cwd: '/' } as any);
    const cases = ['', '/', '//', 'a', 'a/', 'a//', '/a', '//a', 'a/b', 'a//b/', '/workspace/..', '.', '..', '...', 'foo.', 'foo..', 'foo.bar.', '.env', '..foo', 'a/b/.hidden', 'x.tar.gz'];
    it.each([['execute_code', path], ['shell', shiroPath]] as const)('%s', (_, p: any) => {
        for (const c of cases) {
            expect([c, p.basename(c)]).toEqual([c, posix.basename(c)]);
            expect([c, p.dirname(c)]).toEqual([c, posix.dirname(c)]);
            expect([c, p.extname(c)]).toEqual([c, posix.extname(c)]);
            for (const s of ['a', '.gz', 'foo.', '.']) expect([c, s, p.basename(c, s)]).toEqual([c, s, posix.basename(c, s)]);
        }
    });
});

describe('codex R193: changes are reported against the files the run was given', () => {
    it('create-then-delete is no change; delete-then-recreate is a write; overwrite-then-delete is a deletion', () => {
        const w = ws();
        w.fs.writeFileSync('ephemeral.txt', 'x'); w.fs.unlinkSync('ephemeral.txt');
        w.fs.unlinkSync('a.txt'); w.fs.writeFileSync('a.txt', 'again');
        w.fs.writeFileSync('src/app.js', 'new'); w.fs.unlinkSync('src/app.js');
        expect([...w.deleted]).toEqual(['src/app.js']);
        expect(Object.keys(w.written)).toEqual(['a.txt']);
    });
});

// codex R211: mkdirSync ignored its options: a missing parent and an existing directory both succeeded.
describe('mkdirSync follows Node', async () => {
    const nodeFs = await import('node:fs'), { mkdtempSync } = nodeFs, { join } = await import('node:path'), { tmpdir } = await import('node:os');
    const outcome = (f: () => any) => { try { const r = f(); return r === undefined ? 'undefined' : 'path'; } catch (e: any) { return e.code; } };
    const steps: [string, any][] = [['a', undefined], ['a', undefined], ['b/c', undefined], ['b/c', { recursive: true }], ['b/c', { recursive: true }], ['b', { recursive: true }], ['f.txt', undefined], ['f.txt/x', { recursive: true }]];
    it('gives the same result as node:fs for each step of one sequence', () => {
        const real = mkdtempSync(join(tmpdir(), 'fg-mkdir-'));
        nodeFs.writeFileSync(join(real, 'f.txt'), 'x');
        const v = createWorkspaceFs({ 'f.txt': 'x' });
        for (const [p, o] of steps) expect([p, o, outcome(() => v.fs.mkdirSync(p, o))]).toEqual([p, o, outcome(() => nodeFs.mkdirSync(join(real, p), o))]);
        nodeFs.rmSync(real, { recursive: true, force: true });
    });
});
