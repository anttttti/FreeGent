// execute_code JavaScript sees the same /workspace as bash and Python (exec-sandbox/js-fs.ts).
import { describe, it, expect } from 'vitest';
import { createWorkspaceFs, path } from '../exec-sandbox/js-fs';

const ws = () => createWorkspaceFs({ 'a.txt': 'A', 'src/app.js': 'code', 'src/lib/util.js': 'u' });

describe('execute_code JavaScript fs', () => {
    it('reads a file by relative, ./, absolute and .. paths alike', () => {
        const { fs } = ws();
        for (const p of ['a.txt', './a.txt', '/workspace/a.txt', 'src/../a.txt', '/workspace/src/../a.txt'])
            expect(fs.readFileSync(p, 'utf8')).toBe('A');
        expect(fs.readFileSync(path.join('src', 'lib', 'util.js'))).toBe('u');
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
        expect(fs.readFileSync('/tmp/scratch.txt')).toBe('tmp');
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

    it('throws ENOENT for missing files', () => {
        const { fs } = ws();
        expect(() => fs.readFileSync('missing.txt')).toThrow(/ENOENT/);
    });
});
