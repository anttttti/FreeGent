// Workers (run_workers) and their staging: a worker's file tools write into its own staging, which
// run_workers commits when the worker is done; execute_code runs on the workspace. The code a
// worker runs must see the worker's own edits, and what the code writes must show in the worker's
// own read_file / list_files and survive the commit. Parallel workers must not disturb each
// other's runs. Worker contexts are built as run_workers builds them (workers.ts), on both backends
// (tests/tool-backends.ts).
import { LazySnapshot } from '../workers';
import { BACKENDS } from './tool-backends';

const W = globalThis as any;
type Ctx = { snapshot: LazySnapshot; staging: Map<string, string | null>; depth: number };
const newWorker = async (): Promise<Ctx> =>
    ({ snapshot: new LazySnapshot((await W.agentListFiles()).filter((f: any) => !f.isLocal)), staging: new Map(), depth: 0 });
const tool = (ctx: Ctx, name: string, args: any) => W.executeToolAsync(name, args, ctx);
const run = async (ctx: Ctx, language: string, code: string) => {
    const r = await tool(ctx, 'execute_code', { language, code });
    if (r?.error || r?.exit_code) throw new Error(`${language}: ${JSON.stringify(r).slice(0, 400)}`);
    return String(r.stdout ?? '');
};
/** run_workers' commit of one worker (workers.ts): staged content written, null deleted. */
const commit = async (ctx: Ctx) => {
    for (const [p, c] of ctx.staging) {
        if (c === null) await W.agentDeleteFile(p).catch(() => {});
        else await W.agentWriteFile(p, c);
    }
};
const listed = async (ctx: Ctx, path = '') => (await tool(ctx, 'list_files', { path })).files.map((f: any) => f.name).sort();

const READ_BOTH: Record<string, string> = {
    python:     'print(open("new.py").read() + open("old.py").read(), end="")',
    bash:       'cat new.py old.py',
    javascript: 'const fs = require("fs"); process.stdout.write(fs.readFileSync("new.py", "utf8") + fs.readFileSync("old.py", "utf8"));',
};

describe.each(BACKENDS)('$name', be => {
    beforeEach(async () => {
        await be.setup();
        await W.agentWriteFile('old.py', 'OLD\n');
        await W.agentWriteFile('gone.txt', 'still here\n');
    }, 120_000);
    afterEach(() => be.teardown());

    describe("a worker's code sees the worker's own edits", () => {
        it.each(Object.keys(READ_BOTH))('%s runs the staged new and edited files', async language => {
            const w = await newWorker();
            await tool(w, 'write_file', { path: 'new.py', content: 'NEW\n' });
            await tool(w, 'write_file', { path: 'old.py', content: 'EDITED\n' });
            expect(await run(w, language, READ_BOTH[language])).toBe('NEW\nEDITED\n');
        });

        it('a file the worker deleted is gone for its code', async () => {
            const w = await newWorker();
            await tool(w, 'delete_file', { path: 'gone.txt' });
            expect(await run(w, 'python', 'import os\nprint(os.path.exists("gone.txt"))')).toBe('False\n');
            expect(await run(w, 'bash', '[ -e gone.txt ] && echo there || echo gone')).toBe('gone\n');
        });

        it('runs the edit the worker made with replace_in_file and append_file', async () => {
            const w = await newWorker();
            await tool(w, 'replace_in_file', { path: 'old.py', old_string: 'OLD', new_string: 'print("replaced")' });
            await tool(w, 'append_file', { path: 'old.py', content: 'print("appended")' });
            expect(await run(w, 'python', 'exec(open("old.py").read())')).toBe('replaced\nappended\n');
        });
    });

    describe("what a worker's code writes", () => {
        it.each([
            ['python', 'import os\nopen("made.txt", "w").write("made\\n")\nopen("old.py", "w").write("CHANGED\\n")\nos.remove("gone.txt")'],
            ['bash', 'echo made > made.txt; echo CHANGED > old.py; rm gone.txt'],
            ['javascript', 'const fs = require("fs"); fs.writeFileSync("made.txt", "made\\n"); fs.writeFileSync("old.py", "CHANGED\\n"); fs.unlinkSync("gone.txt");'],
        ])('by %s shows in the worker\'s read_file and list_files', async (language, code) => {
            const w = await newWorker();
            await run(w, language, code);
            expect((await tool(w, 'read_file', { path: 'made.txt' })).content).toBe('made\n');
            expect((await tool(w, 'read_file', { path: 'old.py' })).content).toBe('CHANGED\n');
            expect((await tool(w, 'read_file', { path: 'gone.txt' })).error).toBeTruthy();
            expect(await listed(w)).toEqual(['made.txt', 'old.py']);
        });

        it('survives the commit: an edit by the worker\'s file tools, then by its code, commits the code\'s version', async () => {
            const w = await newWorker();
            await tool(w, 'write_file', { path: 'gen.py', content: 'VALUE = 1\n' });
            await run(w, 'python', 'open("gen.py", "w").write("VALUE = 2\\n")\nopen("out.txt", "w").write("result\\n")');
            await commit(w);
            expect((await be.stored('gen.py'))?.toString()).toBe('VALUE = 2\n');
            expect((await be.stored('out.txt'))?.toString()).toBe('result\n');
        });

        it('a binary file the code makes is listed for the worker and left as is by the commit', async () => {
            const w = await newWorker();
            await run(w, 'python', 'open("img.bin", "wb").write(bytes(range(256)))');
            expect(await listed(w)).toContain('img.bin');
            await commit(w);
            expect([...(await be.stored('img.bin'))!]).toEqual([...Array(256).keys()]);
        });
    });

    describe('parallel workers', () => {
        it("one worker's bash call does not move another's working directory mid-run", async () => {
            const a = await newWorker(), b = await newWorker();
            await run(a, 'bash', 'mkdir -p sub');
            await Promise.all([
                run(a, 'bash', 'cd sub && sleep 0.3 && echo a > out.txt'),
                (async () => { await new Promise(r => setTimeout(r, 100)); await run(b, 'bash', 'echo b > out-b.txt'); })(),
            ]);
            expect((await be.stored('sub/out.txt'))?.toString()).toBe('a\n');
            expect(await be.stored('out.txt')).toBeNull();
            expect((await be.stored('out-b.txt'))?.toString()).toBe('b\n');
        });

        it("both workers' code runs land, and each worker sees its own", async () => {
            const a = await newWorker(), b = await newWorker();
            await Promise.all([
                run(a, 'python', 'open("from-a.txt", "w").write("a\\n")'),
                run(b, 'javascript', 'require("fs").writeFileSync("from-b.txt", "b\\n")'),
                run(b, 'bash', 'echo b2 > from-b2.txt'),
            ]);
            expect((await tool(a, 'read_file', { path: 'from-a.txt' })).content).toBe('a\n');
            expect((await tool(b, 'read_file', { path: 'from-b.txt' })).content).toBe('b\n');
            expect((await tool(b, 'read_file', { path: 'from-b2.txt' })).content).toBe('b2\n');
            await commit(a); await commit(b);
            for (const [n, c] of [['from-a.txt', 'a\n'], ['from-b.txt', 'b\n'], ['from-b2.txt', 'b2\n']])
                expect((await be.stored(n))?.toString(), n).toBe(c);
        });

        it("a worker's staged edits are its own until it runs code or commits", async () => {
            const a = await newWorker(), b = await newWorker();
            await tool(a, 'write_file', { path: 'old.py', content: 'A\n' });
            expect((await tool(b, 'read_file', { path: 'old.py' })).content).toBe('OLD\n');
            expect((await be.stored('old.py'))?.toString()).toBe('OLD\n');
        });
    });
});
