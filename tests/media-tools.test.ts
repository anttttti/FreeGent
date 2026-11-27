// The shell commands over the pinned tools: how a command line becomes files in and files out, and that a tool that fails verification does not run.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ffmpegCalls: any[] = [];
const duck = { registered: [] as string[], queries: [] as string[], files: new Map<string, Uint8Array>() };
vi.mock('../exec-sandbox/tools', () => ({
    runFfmpeg: async (args: string[], files: Record<string, Uint8Array>, opts: any) => {
        ffmpegCalls.push({ args, files: Object.keys(files), opts });
        return opts.probe ? { code: 0, files: {}, stdout: '{"streams":[]}', stderr: '' }
            : { code: 0, files: { 'work/out.wav': new Uint8Array([1, 2, 3]) }, stdout: '', stderr: 'size=1kB' };
    },
    loadTool: async (name: string) => name === 'duckdb' ? {
        registerFile: async (n: string) => { duck.registered.push(n); },
        query: async (sql: string) => { duck.queries.push(sql); return /^select/i.test(sql) ? [{ a: 1, b: 'x,y' }, { a: 22, b: null }] : [{ Count: 2 }]; },
        readFile: async (n: string) => { const f = duck.files.get(n); if (!f) throw new Error('no such file'); return f; },
    } : { recognize: async () => ({ text: 'HELLO\n', confidence: 90 }) },
}));
import { mediaToolCmds } from '../shiro/commands/media-tools';

const cmd = (name: string) => mediaToolCmds.find(c => c.name === name)!;
function ctxWith(args: string[], files: Record<string, Uint8Array | string> = {}, stdin = '') {
    const store = new Map(Object.entries(files));
    const abs = (p: string, cwd: string) => p.startsWith('/') ? p : `${cwd}/${p}`;
    const fs: any = {
        resolvePath: abs,
        stat: async (p: string) => { if (!store.has(p)) throw new Error('ENOENT'); return { isFile: () => true }; },
        readFile: async (p: string) => store.get(p),
        writeFile: async (p: string, d: any) => { store.set(p, d); },
        mkdir: async () => {},
    };
    return { ctx: { args, fs, cwd: '/work', env: {}, stdin, stdout: '', stderr: '', shell: {} as any }, store };
}

beforeEach(() => { ffmpegCalls.length = 0; duck.registered.length = 0; duck.queries.length = 0; duck.files.clear(); });

describe('ffmpeg and ffprobe commands', () => {
    it('stage the input by its path, name the output by its path, and write what the run produced', async () => {
        const { ctx, store } = ctxWith(['-y', '-i', 'in.mp4', '-ar', '16000', '-t', '0.5', 'out.wav'], { '/work/in.mp4': new Uint8Array([9]) });
        expect(await cmd('ffmpeg').exec(ctx)).toBe(0);
        expect(ffmpegCalls[0].args).toEqual(['-y', '-i', '/work/in.mp4', '-ar', '16000', '-t', '0.5', '/work/out.wav']);   // 16000 and 0.5 are values, not files
        expect(ffmpegCalls[0].files).toEqual(['work/in.mp4']);
        expect([...store.get('/work/out.wav') as Uint8Array]).toEqual([1, 2, 3]);
        expect(ctx.stderr).toContain('size=1kB');
    });
    it('ffprobe prints the report and leaves no file behind', async () => {
        const { ctx, store } = ctxWith(['-of', 'json', 'in.mp4'], { '/work/in.mp4': new Uint8Array([9]) });
        expect(await cmd('ffprobe').exec(ctx)).toBe(0);
        expect(ffmpegCalls[0].opts).toEqual({ probe: true });
        expect(ctx.stdout).toBe('{"streams":[]}\n');
        expect([...store.keys()]).toEqual(['/work/in.mp4']);
    });
});

describe('duckdb command', () => {
    it('makes the workspace files it names readable, runs each statement and prints rows as a table, CSV or JSON', async () => {
        const { ctx } = ctxWith(["select a, b from 'x.csv'; select 1"], { '/work/x.csv': 'a,b\n1,2\n' });
        expect(await cmd('duckdb').exec(ctx)).toBe(0);
        expect(duck.registered).toEqual(['x.csv']);
        expect(duck.queries).toEqual(["select a, b from 'x.csv'", 'select 1']);
        expect(ctx.stdout).toContain('a  | b');
        const csv = ctxWith(['-csv', "select a, b from 'x.csv'"], { '/work/x.csv': 'a,b\n' });
        await cmd('duckdb').exec(csv.ctx);
        expect(csv.ctx.stdout).toBe('a,b\n1,"x,y"\n22,\n');
        const json = ctxWith(['-json', 'select 1']);
        await cmd('duckdb').exec(json.ctx);
        expect(JSON.parse(json.ctx.stdout)).toEqual([{ a: 1, b: 'x,y' }, { a: 22, b: null }]);
    });
    it('writes the file a COPY … TO statement made', async () => {
        duck.files.set('o.parquet', new Uint8Array([7, 7]));
        const { ctx, store } = ctxWith(["copy (select 1) to 'o.parquet' (format parquet)"]);
        await cmd('duckdb').exec(ctx);
        expect([...store.get('/work/o.parquet') as Uint8Array]).toEqual([7, 7]);
    });
});

describe('tesseract command', () => {
    it('prints to stdout or writes <base>.txt, and refuses another language instead of reading it wrongly', async () => {
        const a = ctxWith(['p.png', 'stdout'], { '/work/p.png': new Uint8Array([1]) });
        await cmd('tesseract').exec(a.ctx);
        expect(a.ctx.stdout).toBe('HELLO\n');
        const b = ctxWith(['p.png', 'out'], { '/work/p.png': new Uint8Array([1]) });
        await cmd('tesseract').exec(b.ctx);
        expect(b.store.get('/work/out.txt')).toBe('HELLO\n');
        const c = ctxWith(['p.png', 'stdout', '-l', 'fin'], { '/work/p.png': new Uint8Array([1]) });
        expect(await cmd('tesseract').exec(c.ctx)).toBe(1);
        expect(c.ctx.stderr).toMatch(/only the English/);
    });
});
